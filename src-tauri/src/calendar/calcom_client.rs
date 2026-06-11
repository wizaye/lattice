//! Cal.com API client for developer/OSS calendar integration.
//!
//! Simple API key authentication - no OAuth required.

use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use std::time::Duration;

use super::super::sync::error::SyncError;
use super::super::sync::keychain::{self, TokenSet};

const CALCOM_API_BASE: &str = "https://api.cal.com/v2";
const USER_AGENT: &str = "lattice-calendar/0.1";

/// Cal.com API client
pub struct CalComClient {
    http: Client,
}

impl Default for CalComClient {
    fn default() -> Self {
        Self::new()
    }
}

impl CalComClient {
    pub fn new() -> Self {
        let http = Client::builder()
            .user_agent(USER_AGENT)
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap();
        
        Self { http }
    }

    /// List bookings in time range
    pub async fn list_bookings(
        &self,
        api_key: &str,
        start: &str,
        end: &str,
    ) -> Result<Vec<CalComBooking>, SyncError> {
        let url = format!(
            "{}/bookings?startTime={}&endTime={}",
            CALCOM_API_BASE,
            urlencoding::encode(start),
            urlencoding::encode(end)
        );

        let resp = self
            .http
            .get(&url)
            .header("Authorization", format!("Bearer {}", api_key))
            .send()
            .await
            .map_err(|e| SyncError::Net(format!("Cal.com bookings API failed: {}", e)))?;

        if resp.status() == StatusCode::UNAUTHORIZED {
            return Err(SyncError::Oauth("Invalid Cal.com API key".into()));
        }

        if !resp.status().is_success() {
            let error = resp.text().await.unwrap_or_else(|_| "Unknown error".into());
            return Err(SyncError::Api(format!("Cal.com API error: {}", error)));
        }

        let response: CalComResponse = resp
            .json()
            .await
            .map_err(|e| SyncError::Api(format!("Failed to parse Cal.com response: {}", e)))?;

        Ok(response.bookings)
    }

    /// Get event types (available booking slots)
    pub async fn list_event_types(&self, api_key: &str) -> Result<Vec<CalComEventType>, SyncError> {
        let url = format!("{}/event-types", CALCOM_API_BASE);

        let resp = self
            .http
            .get(&url)
            .header("Authorization", format!("Bearer {}", api_key))
            .send()
            .await
            .map_err(|e| SyncError::Net(format!("Cal.com event types API failed: {}", e)))?;

        if !resp.status().is_success() {
            return Ok(vec![]); // Gracefully handle errors
        }

        let response: EventTypesResponse = resp
            .json()
            .await
            .map_err(|e| SyncError::Api(format!("Failed to parse event types: {}", e)))?;

        Ok(response.event_types)
    }
}

// ── DTOs ─────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct CalComResponse {
    bookings: Vec<CalComBooking>,
}

#[derive(Debug, Deserialize)]
struct EventTypesResponse {
    event_types: Vec<CalComEventType>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalComBooking {
    pub id: i64,
    pub title: String,
    #[serde(rename = "startTime")]
    pub start_time: String,
    #[serde(rename = "endTime")]
    pub end_time: String,
    #[serde(default)]
    pub attendees: Vec<CalComAttendee>,
    pub location: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalComAttendee {
    pub email: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalComEventType {
    pub id: i64,
    pub title: String,
    pub length: i32,
    pub slug: String,
}

// ── Tauri Commands ──────────────────────────────────────────────────────

#[tauri::command]
pub async fn calcom_set_api_key(vault_path: String, api_key: String) -> Result<(), String> {
    use std::path::Path;
    // Store API key in OS keychain using a custom provider ID
    keychain::store(
        Path::new(&vault_path),
        super::super::sync::ProviderId::Github,
        &TokenSet {
            access_token: api_key,
            refresh_token: None,
            expires_at: None,
            scope: String::new(),
            token_type: "Bearer".to_string(),
        },
    )
    .map_err(|e| format!("Failed to store API key: {}", e))
}

#[tauri::command]
pub async fn calcom_is_connected(vault_path: String) -> Result<bool, String> {
    use std::path::Path;
    match keychain::load(Path::new(&vault_path), super::super::sync::ProviderId::Github) {
        Ok(Some(_)) => Ok(true),
        _ => Ok(false),
    }
}

#[tauri::command]
pub async fn calcom_sync_calendar(vault_path: String) -> Result<usize, String> {
    use std::path::Path;
    let client = CalComClient::new();
    
    let tokens = keychain::load(Path::new(&vault_path), super::super::sync::ProviderId::Github)
        .map_err(|e| format!("Failed to get API key: {}", e))?
        .ok_or_else(|| "Cal.com not connected".to_string())?;
    
    // Get bookings for next 30 days
    let now = chrono::Utc::now();
    let end = now + chrono::Duration::days(30);
    let start_str = now.to_rfc3339();
    let end_str = end.to_rfc3339();
    
    let bookings = client
        .list_bookings(&tokens.access_token, &start_str, &end_str)
        .await
        .map_err(|e| format!("Failed to fetch bookings: {}", e))?;
    
    // TODO: Convert bookings to CalEvent and store in local calendar database
    
    Ok(bookings.len())
}
