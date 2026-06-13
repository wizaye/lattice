//! Apple Calendar integration
//! 
//! macOS: Uses EventKit via Swift sidecar (future work)
//! Windows/Linux: CalDAV with iCloud app-specific password

use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use std::path::Path;

use super::super::sync::error::SyncError;
use super::super::sync::keychain::{self, TokenSet};

/// CalDAV client for iCloud Calendar
pub struct AppleCalendarClient {
    client: Client,
    caldav_url: String,
}

impl Default for AppleCalendarClient {
    fn default() -> Self {
        Self::new()
    }
}

impl AppleCalendarClient {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
            caldav_url: "https://caldav.icloud.com".to_string(),
        }
    }

    /// Set app-specific password for iCloud CalDAV
    pub async fn authenticate(
        &self,
        username: &str,
        app_password: &str,
    ) -> Result<(), SyncError> {
        // Test authentication with PROPFIND
        let response = self
            .client
            .request(
                reqwest::Method::from_bytes(b"PROPFIND").unwrap(),
                format!("{}/", self.caldav_url),
            )
            .basic_auth(username, Some(app_password))
            .header("Depth", "0")
            .send()
            .await
            .map_err(|e| SyncError::Net(e.to_string()))?;

        if response.status() == StatusCode::MULTI_STATUS {
            Ok(())
        } else {
            Err(SyncError::Oauth(format!(
                "CalDAV auth failed: {}",
                response.status()
            )))
        }
    }

    /// List calendar events via CalDAV
    pub async fn list_events(
        &self,
        username: &str,
        password: &str,
        start: &str,
        end: &str,
    ) -> Result<Vec<CalDavEvent>, SyncError> {
        // REPORT request to query calendar events
        let query = format!(
            r#"<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="{}" end="{}"/>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>"#,
            start, end
        );

        let response = self
            .client
            .request(
                reqwest::Method::from_bytes(b"REPORT").unwrap(),
                format!("{}/calendars/{}/", self.caldav_url, username),
            )
            .basic_auth(username, Some(password))
            .header("Content-Type", "application/xml; charset=utf-8")
            .header("Depth", "1")
            .body(query)
            .send()
            .await
            .map_err(|e| SyncError::Net(e.to_string()))?;

        if response.status() != StatusCode::MULTI_STATUS {
            return Err(SyncError::Api(format!(
                "CalDAV REPORT failed: {}",
                response.status()
            )));
        }

        let body = response
            .text()
            .await
            .map_err(|e| SyncError::Net(e.to_string()))?;

        // Parse iCal data from XML response
        parse_caldav_response(&body)
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CalDavEvent {
    pub uid: String,
    pub summary: String,
    pub dtstart: String,
    pub dtend: String,
    pub description: Option<String>,
    pub location: Option<String>,
}

/// Parse CalDAV XML response containing iCal data
fn parse_caldav_response(xml: &str) -> Result<Vec<CalDavEvent>, SyncError> {
    // Simplified parser - in production use quick-xml
    let mut events = Vec::new();
    
    // Extract calendar-data blocks
    for cal_data in xml.split("<C:calendar-data>").skip(1) {
        if let Some(ical) = cal_data.split("</C:calendar-data>").next() {
            if let Ok(event) = parse_ical(ical) {
                events.push(event);
            }
        }
    }
    
    Ok(events)
}

/// Parse iCal VEVENT component
fn parse_ical(ical: &str) -> Result<CalDavEvent, SyncError> {
    let mut uid = String::new();
    let mut summary = String::new();
    let mut dtstart = String::new();
    let mut dtend = String::new();
    let mut description = None;
    let mut location = None;

    for line in ical.lines() {
        let line = line.trim();
        if line.starts_with("UID:") {
            uid = line[4..].to_string();
        } else if line.starts_with("SUMMARY:") {
            summary = line[8..].to_string();
        } else if line.starts_with("DTSTART:") || line.starts_with("DTSTART;") {
            dtstart = line.split(':').nth(1).unwrap_or("").to_string();
        } else if line.starts_with("DTEND:") || line.starts_with("DTEND;") {
            dtend = line.split(':').nth(1).unwrap_or("").to_string();
        } else if line.starts_with("DESCRIPTION:") {
            description = Some(line[12..].to_string());
        } else if line.starts_with("LOCATION:") {
            location = Some(line[9..].to_string());
        }
    }

    if uid.is_empty() || summary.is_empty() {
        return Err(SyncError::Api("Invalid iCal event".to_string()));
    }

    Ok(CalDavEvent {
        uid,
        summary,
        dtstart,
        dtend,
        description,
        location,
    })
}

// ── Tauri Commands ──────────────────────────────────────────────────────

/// Set Apple Calendar app-specific password
#[tauri::command]
pub async fn apple_set_credentials(
    vault_path: String,
    username: String,
    password: String,
) -> Result<(), String> {
    let client = AppleCalendarClient::new();
    
    // Test authentication
    client
        .authenticate(&username, &password)
        .await
        .map_err(|e| format!("Authentication failed: {}", e))?;
    
    // Store credentials in keychain
    keychain::store(
        Path::new(&vault_path),
        super::super::sync::ProviderId::Github,
        &TokenSet {
            access_token: format!("{}:{}", username, password),
            refresh_token: None,
            expires_at: None,
            scope: String::new(),
            token_type: "Basic".to_string(),
        },
    )
    .map_err(|e| format!("Failed to store credentials: {}", e))?;
    
    Ok(())
}

/// Check if Apple Calendar is connected
#[tauri::command]
pub async fn apple_is_connected(vault_path: String) -> Result<bool, String> {
    match keychain::load(Path::new(&vault_path), super::super::sync::ProviderId::Github) {
        Ok(Some(_)) => Ok(true),
        _ => Ok(false),
    }
}

/// Sync Apple Calendar events
#[tauri::command]
pub async fn apple_sync_calendar(vault_path: String) -> Result<usize, String> {
    let client = AppleCalendarClient::new();
    
    let tokens = keychain::load(Path::new(&vault_path), super::super::sync::ProviderId::Github)
        .map_err(|e| format!("Failed to get credentials: {}", e))?
        .ok_or_else(|| "Apple Calendar not connected".to_string())?;
    
    // Extract username:password from access_token
    let parts: Vec<&str> = tokens.access_token.split(':').collect();
    if parts.len() != 2 {
        return Err("Invalid credentials format".to_string());
    }
    let (username, password) = (parts[0], parts[1]);
    
    // Query events for next 30 days
    let start = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let end = (chrono::Utc::now() + chrono::Duration::days(30))
        .format("%Y%m%dT%H%M%SZ")
        .to_string();
    
    let events = client
        .list_events(username, password, &start, &end)
        .await
        .map_err(|e| format!("Sync failed: {}", e))?;
    
    Ok(events.len())
}
