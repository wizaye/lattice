//! Cal.com provider (Tier B) — API-key auth + v2 bookings.
//!
//! No build-time gating needed (API key is user-supplied at runtime).
//!
//! Cal.com v2 API reference: https://cal.com/docs/api-reference/v2/

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::Deserialize;

use super::tokenstore::{self, CalTokenSet};
use super::CalEvent;
use super::CalSource;

const API_BASE: &str = "https://api.cal.com/v2";
const API_VERSION: &str = "2024-08-13";

pub fn is_configured() -> bool {
    true // no build-time client ID needed — API key is user-supplied
}

pub fn get_status(vault: &Path) -> String {
    match tokenstore::load(vault, "calcom") {
        Ok(Some(t)) => format!("Connected as @{}", t.account_label),
        Ok(None) => "Not connected".into(),
        Err(e) => format!("Token error: {e}"),
    }
}

// ── API response types ───────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct CalcomMeResp {
    status: String,
    data: Option<CalcomMeData>,
    error: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct CalcomMeData {
    username: Option<String>,
    email: Option<String>,
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CalcomBookingsResp {
    status: String,
    data: Option<CalcomBookingsData>,
    error: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum CalcomBookingsData {
    Object { bookings: Vec<CalcomBooking> },
    List(Vec<CalcomBooking>),
}

#[derive(Debug, Deserialize)]
struct CalcomBooking {
    uid: String,
    title: Option<String>,
    start: Option<String>,
    end: Option<String>,
    status: Option<String>,
    attendees: Option<Vec<CalcomAttendee>>,
    #[serde(rename = "meetingUrl")]
    meeting_url: Option<String>,
    location: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CalcomAttendee {
    name: Option<String>,
    email: Option<String>,
}

// ── Auth: API key ────────────────────────────────────────────────────────

/// Verify `api_key` with Cal.com and persist it.  Returns the stored
/// token set so the caller can update the provider list immediately.
pub async fn connect(vault: &Path, api_key: String) -> Result<CalTokenSet, String> {
    // Verify the key by calling /me.
    let resp = reqwest::Client::new()
        .get(format!("{API_BASE}/me"))
        .bearer_auth(&api_key)
        .header("cal-api-version", API_VERSION)
        .send()
        .await
        .map_err(|e| format!("Cal.com /me request: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Cal.com API key rejected (HTTP {status}): {body}"));
    }

    let me: CalcomMeResp = resp
        .json()
        .await
        .map_err(|e| format!("Cal.com /me parse: {e}"))?;

    if me.status != "success" {
        let err = me
            .error
            .map(|v| v.to_string())
            .unwrap_or_else(|| "unknown error".into());
        return Err(format!("Cal.com /me returned error: {err}"));
    }

    let account_label = me
        .data
        .and_then(|d| d.username.or(d.email).or(d.name))
        .unwrap_or_else(|| "cal.com user".into());

    let token_set = CalTokenSet {
        access_token: api_key,
        refresh_token: None,
        expires_at: None,
        scope: String::new(),
        account_label,
    };

    tokenstore::store(vault, "calcom", &token_set)?;
    Ok(token_set)
}

pub fn disconnect(vault: &Path) -> Result<(), String> {
    tokenstore::delete(vault, "calcom")
}

// ── Event fetch ──────────────────────────────────────────────────────────

pub async fn fetch_events(
    vault: &Path,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Result<Vec<CalEvent>, String> {
    let token_set = tokenstore::load(vault, "calcom")?
        .ok_or("Cal.com not connected")?;

    let after_start = from.format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let before_start = to.format("%Y-%m-%dT%H:%M:%SZ").to_string();

    let url = format!(
        "{API_BASE}/bookings?limit=100&afterStart={after_start}&beforeStart={before_start}"
    );

    let resp = reqwest::Client::new()
        .get(&url)
        .bearer_auth(&token_set.access_token)
        .header("cal-api-version", API_VERSION)
        .send()
        .await
        .map_err(|e| format!("Cal.com bookings request: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Cal.com bookings failed: {body}"));
    }

    let page: CalcomBookingsResp = resp
        .json()
        .await
        .map_err(|e| format!("Cal.com bookings parse: {e}"))?;

    if page.status != "success" {
        let err = page
            .error
            .map(|v| v.to_string())
            .unwrap_or_else(|| "unknown error".into());
        return Err(format!("Cal.com bookings error: {err}"));
    }

    let bookings = match page.data {
        Some(CalcomBookingsData::Object { bookings }) => bookings,
        Some(CalcomBookingsData::List(list)) => list,
        None => return Ok(Vec::new()),
    };

    Ok(bookings
        .into_iter()
        .filter_map(booking_to_cal)
        .collect())
}

fn booking_to_cal(b: CalcomBooking) -> Option<CalEvent> {
    // Skip cancelled bookings.
    if b.status.as_deref() == Some("cancelled") {
        return None;
    }

    let start: DateTime<Utc> = b
        .start
        .as_deref()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.with_timezone(&Utc))?;

    let end: DateTime<Utc> = b
        .end
        .as_deref()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(|| start + chrono::Duration::hours(1));

    let attendees = b
        .attendees
        .unwrap_or_default()
        .into_iter()
        .filter_map(|a| a.name.or(a.email))
        .collect();

    let meeting_url = b.meeting_url.or(b.location);

    Some(CalEvent {
        id: format!("calcom:{}", b.uid),
        source: CalSource::CalCom,
        start,
        end,
        title: b.title.unwrap_or_else(|| "Cal.com booking".into()),
        body_md: None,
        attendees,
        meeting_url,
        teams_meeting_id: None,
        note_path: None,
        etag: None,
    })
}
