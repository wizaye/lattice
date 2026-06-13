//! Outlook + Teams provider (Microsoft Graph, Tier A).
//!
//! ## Auth flow
//! PKCE + loopback redirect (reuses `crate::sync::oauth` helpers).
//! App registration: public client (desktop), multi-tenant unless
//! `LATTICE_ENTRA_TENANT_ID` is set at build time.
//!
//! Required scopes:
//!   `User.Read Calendars.Read OnlineMeetings.Read offline_access`
//!
//! ## Build-time gating
//! `LATTICE_ENTRA_CLIENT_ID` must be set at compile time.  When
//! absent, every public function returns a "not configured" error so
//! the UI can render a "build with Entra client ID" hint instead of a
//! generic failure.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::Deserialize;

use crate::sync::oauth::{loopback_listen, random_state, random_verifier, s256_challenge};

use super::tokenstore::{self, CalTokenSet};
use super::CalEvent;
use super::CalSource;

// ── Build-time configuration ─────────────────────────────────────────────

const CLIENT_ID: Option<&str> = option_env!("LATTICE_ENTRA_CLIENT_ID");
const TENANT_ID: &str = match option_env!("LATTICE_ENTRA_TENANT_ID") {
    Some(id) => id,
    None => "common",
};
const AUTH_BASE: &str = "https://login.microsoftonline.com";
const GRAPH_BASE: &str = "https://graph.microsoft.com/v1.0";
const SCOPES: &str =
    "User.Read Calendars.Read OnlineMeetings.Read offline_access";

pub fn is_configured() -> bool {
    CLIENT_ID.is_some()
}

fn client_id() -> Result<&'static str, String> {
    CLIENT_ID.ok_or_else(|| {
        "Outlook provider not configured: rebuild Lattice with \
         LATTICE_ENTRA_CLIENT_ID set"
            .into()
    })
}

// ── Graph API response types ─────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct GraphUser {
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    mail: Option<String>,
    #[serde(rename = "userPrincipalName")]
    user_principal_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GraphEventList {
    value: Vec<GraphEvent>,
    #[serde(rename = "@odata.nextLink")]
    next_link: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GraphEvent {
    id: String,
    subject: Option<String>,
    #[serde(rename = "bodyPreview")]
    body_preview: Option<String>,
    start: GraphDateTime,
    end: GraphDateTime,
    attendees: Option<Vec<GraphAttendee>>,
    #[serde(rename = "isOnlineMeeting")]
    is_online_meeting: Option<bool>,
    #[serde(rename = "onlineMeeting")]
    online_meeting: Option<GraphOnlineMeeting>,
    #[serde(rename = "onlineMeetingProvider")]
    online_meeting_provider: Option<String>,
    #[serde(rename = "webLink")]
    web_link: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GraphDateTime {
    #[serde(rename = "dateTime")]
    date_time: String,
    #[serde(rename = "timeZone")]
    time_zone: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GraphAttendee {
    #[serde(rename = "emailAddress")]
    email_address: GraphEmailAddress,
}

#[derive(Debug, Deserialize)]
struct GraphEmailAddress {
    name: Option<String>,
    address: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GraphOnlineMeeting {
    #[serde(rename = "joinUrl")]
    join_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    scope: Option<String>,
}

// ── Auth flow ────────────────────────────────────────────────────────────

/// Run the PKCE authorization flow.  Opens the user's default browser
/// to the Microsoft login page and waits for the loopback redirect.
///
/// Returns the connected [`CalTokenSet`] on success so the caller can
/// stamp it into the provider list immediately without a round-trip.
pub async fn connect(vault: &Path, app: &tauri::AppHandle) -> Result<CalTokenSet, String> {
    let client_id = client_id()?;

    let verifier = random_verifier();
    let challenge = s256_challenge(&verifier);
    let state = random_state();

    // Start loopback listener (5-minute window for the user to log in).
    let (port, cb_rx) = loopback_listen(Duration::from_secs(300))
        .await
        .map_err(|e| format!("loopback listener: {e}"))?;

    let redirect_uri = format!("http://localhost:{port}");
    let scope_encoded = urlencoding::encode(SCOPES);
    let redirect_encoded = urlencoding::encode(&redirect_uri);

    let auth_url = format!(
        "{AUTH_BASE}/{TENANT_ID}/oauth2/v2.0/authorize\
         ?client_id={client_id}\
         &response_type=code\
         &redirect_uri={redirect_encoded}\
         &scope={scope_encoded}\
         &state={state}\
         &code_challenge={challenge}\
         &code_challenge_method=S256\
         &prompt=select_account"
    );

    // Open system browser.
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(&auth_url, None::<&str>)
        .map_err(|e| format!("could not open browser: {e}"))?;

    // Await the redirect callback.
    let cb = cb_rx
        .await
        .map_err(|_| "PKCE callback channel dropped".to_string())?
        .map_err(|e| format!("PKCE callback error: {e}"))?;

    if cb.state != state {
        return Err("PKCE state mismatch — possible CSRF".into());
    }

    // Exchange the code for tokens.
    let tokens = exchange_code(client_id, &cb.code, &verifier, &redirect_uri).await?;

    // Fetch the user's display name / email.
    let user = get_me(&tokens.access_token).await?;
    let account_label = user
        .mail
        .or(user.user_principal_name)
        .unwrap_or_else(|| user.display_name.unwrap_or_else(|| "Outlook".into()));

    let now_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;

    let token_set = CalTokenSet {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: tokens.expires_in.map(|s| now_unix + s as i64),
        scope: tokens.scope.unwrap_or_default(),
        account_label,
    };

    tokenstore::store(vault, "outlook", &token_set)?;
    Ok(token_set)
}

async fn exchange_code(
    client_id: &str,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<TokenResponse, String> {
    let params: HashMap<&str, &str> = [
        ("grant_type", "authorization_code"),
        ("client_id", client_id),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("code_verifier", verifier),
    ]
    .into();

    let resp = reqwest::Client::new()
        .post(format!("{AUTH_BASE}/{TENANT_ID}/oauth2/v2.0/token"))
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("token exchange request failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("token exchange failed: {body}"));
    }

    resp.json::<TokenResponse>()
        .await
        .map_err(|e| format!("token exchange parse failed: {e}"))
}

pub async fn refresh_if_needed(vault: &Path) -> Result<String, String> {
    let token_set = tokenstore::load(vault, "outlook")?
        .ok_or("Outlook not connected")?;

    // Check if the token has expired (with a 60-second buffer).
    let now_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    if let Some(exp) = token_set.expires_at {
        if now_unix < exp - 60 {
            return Ok(token_set.access_token);
        }
    } else {
        // No expiry stamp — treat as valid.
        return Ok(token_set.access_token);
    }

    // Refresh.
    let refresh = token_set
        .refresh_token
        .as_deref()
        .ok_or("Outlook refresh token missing — please reconnect")?;

    let client_id = client_id()?;
    let scope_encoded = urlencoding::encode(SCOPES);
    let params: HashMap<&str, &str> = [
        ("grant_type", "refresh_token"),
        ("client_id", client_id),
        ("refresh_token", refresh),
        ("scope", SCOPES),
    ]
    .into();

    let resp = reqwest::Client::new()
        .post(format!("{AUTH_BASE}/{TENANT_ID}/oauth2/v2.0/token"))
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("refresh request failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("token refresh failed: {body}"));
    }

    let new_tokens: TokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("refresh parse failed: {e}"))?;

    let updated = CalTokenSet {
        access_token: new_tokens.access_token.clone(),
        refresh_token: new_tokens
            .refresh_token
            .or(token_set.refresh_token),
        expires_at: new_tokens.expires_in.map(|s| now_unix + s as i64),
        scope: new_tokens.scope.unwrap_or(token_set.scope),
        account_label: token_set.account_label,
    };
    tokenstore::store(vault, "outlook", &updated)?;

    let _ = scope_encoded; // suppress unused warning
    Ok(new_tokens.access_token)
}

async fn get_me(access_token: &str) -> Result<GraphUser, String> {
    reqwest::Client::new()
        .get(format!("{GRAPH_BASE}/me"))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("Graph /me request: {e}"))?
        .json::<GraphUser>()
        .await
        .map_err(|e| format!("Graph /me parse: {e}"))
}

pub async fn disconnect(vault: &Path) -> Result<(), String> {
    tokenstore::delete(vault, "outlook")
}

pub fn get_status(vault: &Path) -> String {
    if !is_configured() {
        return "Not configured (build with LATTICE_ENTRA_CLIENT_ID)".into();
    }
    match tokenstore::load(vault, "outlook") {
        Ok(Some(t)) => format!("Connected as {}", t.account_label),
        Ok(None) => "Not connected".into(),
        Err(e) => format!("Token error: {e}"),
    }
}

// ── Event fetch ──────────────────────────────────────────────────────────

/// Fetch calendar events from Graph in the given UTC window.
/// Automatically refreshes an expired access token.
pub async fn fetch_events(
    vault: &Path,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Result<Vec<CalEvent>, String> {
    let access_token = refresh_if_needed(vault).await?;

    let from_str = from.format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let to_str = to.format("%Y-%m-%dT%H:%M:%SZ").to_string();

    let filter = format!("start/dateTime ge '{from_str}' and end/dateTime le '{to_str}'");
    let filter_encoded = urlencoding::encode(&filter);

    let select =
        "id,subject,start,end,attendees,isOnlineMeeting,onlineMeeting,bodyPreview,webLink";
    let url = format!(
        "{GRAPH_BASE}/me/calendar/events\
         ?$filter={filter_encoded}\
         &$select={select}\
         &$top=100\
         &$orderby=start/dateTime"
    );

    let mut all_events: Vec<CalEvent> = Vec::new();
    let mut next_url: Option<String> = Some(url);

    while let Some(url) = next_url {
        let resp = reqwest::Client::new()
            .get(&url)
            .bearer_auth(&access_token)
            .header("Prefer", "outlook.timezone=\"UTC\"")
            .send()
            .await
            .map_err(|e| format!("Graph events request: {e}"))?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Graph events failed: {body}"));
        }

        let page: GraphEventList = resp
            .json()
            .await
            .map_err(|e| format!("Graph events parse: {e}"))?;

        for ev in page.value {
            if let Some(cal_event) = graph_event_to_cal(ev) {
                all_events.push(cal_event);
            }
        }
        next_url = page.next_link;
    }

    Ok(all_events)
}

fn graph_event_to_cal(ev: GraphEvent) -> Option<CalEvent> {
    let start = parse_graph_dt(&ev.start)?;
    let end = parse_graph_dt(&ev.end)?;

    let attendees = ev
        .attendees
        .unwrap_or_default()
        .into_iter()
        .filter_map(|a| {
            a.email_address
                .name
                .or(a.email_address.address)
        })
        .collect();

    let meeting_url = ev
        .online_meeting
        .and_then(|om| om.join_url)
        .or(ev.web_link);

    Some(CalEvent {
        id: format!("ms:{}", ev.id),
        source: CalSource::Outlook,
        start,
        end,
        title: ev.subject.unwrap_or_else(|| "(no title)".into()),
        body_md: ev.body_preview,
        attendees,
        meeting_url,
        teams_meeting_id: None,
        note_path: None,
        etag: None,
    })
}

fn parse_graph_dt(dt: &GraphDateTime) -> Option<DateTime<Utc>> {
    // Graph returns UTC strings (we send `Prefer: outlook.timezone="UTC"`)
    // in the form "2026-06-15T10:00:00.0000000".  Try multiple formats.
    let s = dt.date_time.trim();
    // Truncate fractional seconds to 3 digits for chrono compatibility.
    let normalized = if s.len() > 19 {
        format!("{}", &s[..19])
    } else {
        s.to_string()
    };
    let with_z = format!("{normalized}Z");
    DateTime::parse_from_rfc3339(&with_z)
        .map(|dt| dt.with_timezone(&Utc))
        .ok()
}

// ── Meeting note generator ───────────────────────────────────────────────

/// Create a meeting note in `<vault>/Meetings/YYYY-MM-DD HHmm <slug>.md`.
/// Returns the vault-relative path of the created (or existing) file.
pub async fn create_meeting_note(
    vault: &Path,
    event: &CalEvent,
) -> Result<String, String> {
    use chrono::TimeZone;

    let start_local: chrono::DateTime<chrono::Local> =
        chrono::Local.from_utc_datetime(&event.start.naive_utc());

    let date_str = start_local.format("%Y-%m-%d").to_string();
    let time_str = start_local.format("%H%M").to_string();

    // Build a safe slug from the title: lowercase, spaces→hyphens,
    // strip non-alphanumeric-or-hyphen chars, cap at 60 chars.
    let slug: String = event
        .title
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let slug = &slug[..slug.len().min(60)];

    let filename = format!("{date_str} {time_str} {slug}.md");
    let dir = vault.join("Meetings");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create Meetings/: {e}"))?;
    let path = dir.join(&filename);
    let rel = format!("Meetings/{filename}");

    if path.exists() {
        return Ok(rel);
    }

    let attendees_md = if event.attendees.is_empty() {
        "_(none)_".into()
    } else {
        event
            .attendees
            .iter()
            .map(|a| format!("- {a}"))
            .collect::<Vec<_>>()
            .join("\n")
    };

    let join_section = match &event.meeting_url {
        Some(url) => format!("\n**Join:** [{url}]({url})\n"),
        None => String::new(),
    };

    let body = format!(
        "---\n\
         type: meeting\n\
         date: {date_str}\n\
         title: {title}\n\
         source: outlook\n\
         ---\n\
         \n\
         # {title}\n\
         \n\
         **Date:** {date_str} {time_str}\n\
         {join_section}\n\
         ## Attendees\n\
         \n\
         {attendees_md}\n\
         \n\
         ## Agenda\n\
         \n\
         - \n\
         \n\
         ## Notes\n\
         \n\
         - \n\
         \n\
         ## Action items\n\
         \n\
         - [ ] \n",
        title = event.title,
    );

    std::fs::write(&path, body).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(rel)
}
