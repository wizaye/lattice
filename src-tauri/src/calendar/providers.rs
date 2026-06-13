//! Calendar provider adapter infrastructure.
//!
//! This module defines the trait that all calendar providers implement
//! and provides stub implementations for network providers (Outlook,
//! Cal.com, Google, Apple) that will be filled in as each provider's
//! OAuth flow + API client lands.
//!
//! The local provider is fully implemented in `mod.rs`.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::{CalEvent, CalSource};

/// Result type for provider operations.
pub type ProviderResult<T> = Result<T, ProviderError>;

/// Errors that can occur during provider operations.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderError {
    pub code: ProviderErrorCode,
    pub message: String,
    /// Optional HTTP status code for network errors
    pub status_code: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderErrorCode {
    /// Provider not yet implemented
    NotImplemented,
    /// Authentication required or failed
    AuthRequired,
    /// Token expired, refresh needed
    TokenExpired,
    /// Network request failed
    NetworkError,
    /// API rate limit exceeded
    RateLimited,
    /// Invalid request or parameters
    InvalidRequest,
    /// Provider-specific error
    ProviderError,
}

impl ProviderError {
    pub fn not_implemented(provider: &str) -> Self {
        Self {
            code: ProviderErrorCode::NotImplemented,
            message: format!("{} provider integration ships in the next slice", provider),
            status_code: None,
        }
    }

    pub fn auth_required(provider: &str) -> Self {
        Self {
            code: ProviderErrorCode::AuthRequired,
            message: format!("{} requires authentication - connect in Settings → Calendar", provider),
            status_code: None,
        }
    }
}

/// Authentication state for a provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderAuth {
    pub provider: CalSource,
    /// User identifier (email, username, etc.)
    pub user_id: String,
    /// Access token (stored in OS keychain in production)
    #[serde(skip)]
    pub access_token: Option<String>,
    /// Refresh token (stored in OS keychain in production)
    #[serde(skip)]
    pub refresh_token: Option<String>,
    /// Token expiry timestamp
    pub expires_at: Option<DateTime<Utc>>,
    /// Whether the token needs refresh
    pub needs_refresh: bool,
}

/// Provider capability flags.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct ProviderCapabilities {
    /// Can read events from the provider
    pub read: bool,
    /// Can create events on the provider
    pub write: bool,
    /// Supports incremental sync (delta tokens)
    pub incremental_sync: bool,
    /// Supports meeting notes generation
    pub meeting_notes: bool,
    /// Supports transcripts
    pub transcripts: bool,
}

/// Request parameters for listing events.
#[derive(Debug, Clone)]
pub struct ListEventsRequest {
    /// Optional start time (UTC)
    pub from: Option<DateTime<Utc>>,
    /// Optional end time (UTC)
    pub to: Option<DateTime<Utc>>,
    /// Delta token from previous sync (for incremental refresh)
    pub delta_token: Option<String>,
    /// Next page token for pagination
    pub next_token: Option<String>,
}

/// Response from listing events.
#[derive(Debug, Clone)]
pub struct ListEventsResponse {
    /// Retrieved events
    pub events: Vec<CalEvent>,
    /// Delta token for next incremental sync
    pub delta_token: Option<String>,
    /// Next page token if more results available
    pub next_token: Option<String>,
    /// Collection ETag (if supported)
    pub collection_etag: Option<String>,
}

/// Trait that all calendar providers implement.
#[async_trait::async_trait]
pub trait CalendarProvider: Send + Sync {
    /// Provider identifier
    fn source(&self) -> CalSource;

    /// Provider capabilities
    fn capabilities(&self) -> ProviderCapabilities;

    /// Check if the provider is authenticated
    async fn is_authenticated(&self) -> bool;

    /// Get current authentication state
    async fn get_auth(&self) -> ProviderResult<Option<ProviderAuth>>;

    /// List events in the given time range
    async fn list_events(
        &self,
        request: ListEventsRequest,
    ) -> ProviderResult<ListEventsResponse>;

    /// Create a new event (if write capability is supported)
    async fn create_event(&self, event: CalEvent) -> ProviderResult<CalEvent> {
        let _ = event;
        Err(ProviderError::not_implemented(&format!("{:?}", self.source())))
    }

    /// Update an existing event (if write capability is supported)
    async fn update_event(&self, event: CalEvent) -> ProviderResult<CalEvent> {
        let _ = event;
        Err(ProviderError::not_implemented(&format!("{:?}", self.source())))
    }

    /// Delete an event (if write capability is supported)
    async fn delete_event(&self, event_id: &str) -> ProviderResult<()> {
        let _ = event_id;
        Err(ProviderError::not_implemented(&format!("{:?}", self.source())))
    }

    /// Refresh authentication token
    async fn refresh_token(&self) -> ProviderResult<ProviderAuth> {
        Err(ProviderError::not_implemented(&format!("{:?}", self.source())))
    }
}

// ── Stub Provider Implementations ──────────────────────────────────────

/// Outlook + Teams provider stub (Tier A).
/// Full implementation ships in the next slice with Entra ID PKCE auth.
pub struct OutlookProvider;

#[async_trait::async_trait]
impl CalendarProvider for OutlookProvider {
    fn source(&self) -> CalSource {
        CalSource::Outlook
    }

    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            read: true,
            write: true,
            incremental_sync: true,
            meeting_notes: true,
            transcripts: true,
        }
    }

    async fn is_authenticated(&self) -> bool {
        false
    }

    async fn get_auth(&self) -> ProviderResult<Option<ProviderAuth>> {
        Ok(None)
    }

    async fn list_events(
        &self,
        _request: ListEventsRequest,
    ) -> ProviderResult<ListEventsResponse> {
        Err(ProviderError::not_implemented("Outlook"))
    }
}

/// Cal.com provider stub (Tier B).
/// Full implementation ships in the next slice with API key auth.
pub struct CalComProvider;

#[async_trait::async_trait]
impl CalendarProvider for CalComProvider {
    fn source(&self) -> CalSource {
        CalSource::CalCom
    }

    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            read: true,
            write: true,
            incremental_sync: false,
            meeting_notes: true,
            transcripts: false,
        }
    }

    async fn is_authenticated(&self) -> bool {
        false
    }

    async fn get_auth(&self) -> ProviderResult<Option<ProviderAuth>> {
        Ok(None)
    }

    async fn list_events(
        &self,
        _request: ListEventsRequest,
    ) -> ProviderResult<ListEventsResponse> {
        Err(ProviderError::not_implemented("Cal.com"))
    }
}

/// Google Calendar provider stub (Tier C).
/// Full implementation ships in the next slice with PKCE OAuth.
pub struct GoogleCalendarProvider;

#[async_trait::async_trait]
impl CalendarProvider for GoogleCalendarProvider {
    fn source(&self) -> CalSource {
        CalSource::Google
    }

    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            read: true,
            write: true,
            incremental_sync: true,
            meeting_notes: false,
            transcripts: false,
        }
    }

    async fn is_authenticated(&self) -> bool {
        false
    }

    async fn get_auth(&self) -> ProviderResult<Option<ProviderAuth>> {
        Ok(None)
    }

    async fn list_events(
        &self,
        _request: ListEventsRequest,
    ) -> ProviderResult<ListEventsResponse> {
        Err(ProviderError::not_implemented("Google Calendar"))
    }
}

/// Apple Calendar provider stub (Tier C).
/// Full implementation ships in the next slice with EventKit (macOS) / CalDAV.
pub struct AppleCalendarProvider;

#[async_trait::async_trait]
impl CalendarProvider for AppleCalendarProvider {
    fn source(&self) -> CalSource {
        CalSource::Apple
    }

    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            read: true,
            write: true,
            incremental_sync: false,
            meeting_notes: false,
            transcripts: false,
        }
    }

    async fn is_authenticated(&self) -> bool {
        false
    }

    async fn get_auth(&self) -> ProviderResult<Option<ProviderAuth>> {
        Ok(None)
    }

    async fn list_events(
        &self,
        _request: ListEventsRequest,
    ) -> ProviderResult<ListEventsResponse> {
        Err(ProviderError::not_implemented("Apple Calendar"))
    }
}

/// Provider registry - returns the appropriate provider for a source.
pub fn get_provider(source: CalSource) -> Box<dyn CalendarProvider> {
    match source {
        CalSource::Outlook => Box::new(OutlookProvider),
        CalSource::CalCom => Box::new(CalComProvider),
        CalSource::Google => Box::new(GoogleCalendarProvider),
        CalSource::Apple => Box::new(AppleCalendarProvider),
        CalSource::Local => {
            // Local provider is handled directly in mod.rs
            // This shouldn't be called for Local source
            panic!("Local provider should not use the trait-based provider system")
        }
    }
}
