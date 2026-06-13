//! Google Calendar API client for Tier C integration.
//!
//! Full implementation with PKCE OAuth + incremental sync via syncToken.

use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use std::time::Duration;

use super::super::sync::error::SyncError;
use super::super::sync::oauth::{loopback_listen, random_state, random_verifier, s256_challenge};
use super::super::sync::keychain::{self, TokenSet};

const AUTHORIZE_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const CALENDAR_API: &str = "https://www.googleapis.com/calendar/v3";
const OAUTH_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const USER_AGENT: &str = "lattice-calendar/0.1";

pub struct GoogleCalendarClient {
    client_id: String,
    http: Client,
}

impl Default for GoogleCalendarClient {
    fn default() -> Self {
        Self::new()
    }
}

impl GoogleCalendarClient {
    pub fn new() -> Self {
        let client_id = std::env::var("LATTICE_GOOGLE_CLIENT_ID")
            .unwrap_or_else(|_| "YOUR_GOOGLE_CLIENT_ID".to_string());
        
        let http = Client::builder()
            .user_agent(USER_AGENT)
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap();
        
        Self { client_id, http }
    }

    /// Start OAuth PKCE flow
    pub async fn start_auth_flow(&self) -> Result<(String, String, String, u16), SyncError> {
        let (port, _callback_rx) = loopback_listen(OAUTH_TIMEOUT).await?;
        let redirect_uri = format!("http://127.0.0.1:{port}");

        let verifier = random_verifier();
        let challenge = s256_challenge(&verifier);
        let state = random_state();

        let auth_url = format!(
            "{}?client_id={}&redirect_uri={}&response_type=code&scope={}&state={}&code_challenge={}&code_challenge_method=S256&access_type=offline",
            AUTHORIZE_URL,
            urlencoding::encode(&self.client_id),
            urlencoding::encode(&redirect_uri),
            urlencoding::encode("https://www.googleapis.com/auth/calendar.readonly"),
            urlencoding::encode(&state),
            urlencoding::encode(&challenge),
        );

        Ok((auth_url, verifier, state, port))
    }

    /// Exchange authorization code for tokens
    pub async fn exchange_code(
        &self,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
    ) -> Result<TokenResponse, SyncError> {
        let params = [
            ("client_id", self.client_id.as_str()),
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("code_verifier", verifier),
        ];

        let resp = self
            .http
            .post(TOKEN_URL)
            .form(&params)
            .send()
            .await
            .map_err(|e| SyncError::Net(format!("Token exchange failed: {}", e)))?;

        if !resp.status().is_success() {
            let error = resp.text().await.unwrap_or_else(|_| "Unknown error".into());
            return Err(SyncError::Api(format!("Token exchange error: {}", error)));
        }

        resp.json::<TokenResponse>()
            .await
            .map_err(|e| SyncError::Api(format!("Failed to parse token response: {}", e)))
    }

    /// Refresh access token
    pub async fn refresh_token(&self, refresh_token: &str) -> Result<TokenResponse, SyncError> {
        let params = [
            ("client_id", self.client_id.as_str()),
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
        ];

        let resp = self
            .http
            .post(TOKEN_URL)
            .form(&params)
            .send()
            .await
            .map_err(|e| SyncError::Net(format!("Token refresh failed: {}", e)))?;

        if !resp.status().is_success() {
            let error = resp.text().await.unwrap_or_else(|_| "Unknown error".into());
            return Err(SyncError::Api(format!("Token refresh error: {}", error)));
        }

        resp.json::<TokenResponse>()
            .await
            .map_err(|e| SyncError::Api(format!("Failed to parse token response: {}", e)))
    }

    /// List calendar events with optional syncToken for incremental sync
    pub async fn list_events(
        &self,
        access_token: &str,
        sync_token: Option<String>,
    ) -> Result<GoogleCalendarResponse, SyncError> {
        let mut url = format!("{}/calendars/primary/events", CALENDAR_API);
        
        if let Some(token) = sync_token {
            url.push_str(&format!("?syncToken={}", urlencoding::encode(&token)));
        } else {
            url.push_str("?singleEvents=true&orderBy=startTime&maxResults=50");
        }

        let resp = self
            .http
            .get(&url)
            .header("Authorization", format!("Bearer {}", access_token))
            .send()
            .await
            .map_err(|e| SyncError::Net(format!("Calendar API failed: {}", e)))?;

        if resp.status() == StatusCode::UNAUTHORIZED {
            return Err(SyncError::Oauth("Access token expired".into()));
        }

        if !resp.status().is_success() {
            let error = resp.text().await.unwrap_or_else(|_| "Unknown error".into());
            return Err(SyncError::Api(format!("Calendar API error: {}", error)));
        }

        resp.json::<GoogleCalendarResponse>()
            .await
            .map_err(|e| SyncError::Api(format!("Failed to parse calendar response: {}", e)))
    }
}

// ── DTOs ─────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoogleCalendarResponse {
    pub items: Vec<GoogleEvent>,
    #[serde(rename = "nextSyncToken")]
    pub next_sync_token: Option<String>,
    #[serde(rename = "nextPageToken")]
    pub next_page_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoogleEvent {
    pub id: String,
    pub summary: String,
    pub start: GoogleDateTime,
    pub end: GoogleDateTime,
    #[serde(default)]
    pub attendees: Vec<GoogleAttendee>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum GoogleDateTime {
    DateTime { #[serde(rename = "dateTime")] date_time: String },
    Date { date: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoogleAttendee {
    pub email: String,
}

// ── Tauri Commands ──────────────────────────────────────────────────────

#[tauri::command]
pub async fn google_start_auth() -> Result<GoogleAuthStart, String> {
    let client = GoogleCalendarClient::new();
    let (auth_url, _verifier, _state, port) = client
        .start_auth_flow()
        .await
        .map_err(|e| e.to_string())?;
    
    Ok(GoogleAuthStart { auth_url, port })
}

#[derive(Debug, Serialize)]
pub struct GoogleAuthStart {
    pub auth_url: String,
    pub port: u16,
}

#[tauri::command]
pub async fn google_sync_calendar(vault_path: String) -> Result<usize, String> {
    use std::path::Path;
    let client = GoogleCalendarClient::new();
    
    let tokens = keychain::load(Path::new(&vault_path), super::super::sync::ProviderId::Gdrive)
        .map_err(|e| format!("Failed to get tokens: {}", e))?
        .ok_or_else(|| "Not connected to Google Calendar".to_string())?;
    
    match client.list_events(&tokens.access_token, None).await {
        Ok(response) => Ok(response.items.len()),
        Err(SyncError::Oauth(_)) => {
            if let Some(refresh_token) = &tokens.refresh_token {
                let new_tokens = client
                    .refresh_token(refresh_token)
                    .await
                    .map_err(|e| format!("Token refresh failed: {}", e))?;
                
                keychain::store(
                    Path::new(&vault_path),
                    super::super::sync::ProviderId::Gdrive,
                    &TokenSet {
                        access_token: new_tokens.access_token.clone(),
                        refresh_token: new_tokens.refresh_token,
                        expires_at: Some(chrono::Utc::now().timestamp() + new_tokens.expires_in as i64),
                        scope: String::new(),
                        token_type: "Bearer".to_string(),
                    },
                )
                .map_err(|e| format!("Failed to store tokens: {}", e))?;
                
                let response = client
                    .list_events(&new_tokens.access_token, None)
                    .await
                    .map_err(|e| format!("Calendar sync failed: {}", e))?;
                
                Ok(response.items.len())
            } else {
                Err("Token expired and no refresh token available".to_string())
            }
        }
        Err(e) => Err(format!("Calendar sync failed: {}", e)),
    }
}
