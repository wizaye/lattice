//! BYOC sync errors.  Mapped to plain strings at the IPC boundary
//! (Tauri wants `Result<T, String>`), but the typed enum makes
//! provider-internal control flow far easier (e.g. classifying a
//! 401 vs a network error vs a token expired).

use std::fmt;

#[derive(Debug)]
pub enum SyncError {
    /// Caller-side mistake: bad path, missing required field, etc.
    BadInput(String),
    /// User cancelled (e.g. closed the browser window before consent).
    Cancelled,
    /// OAuth flow failed (provider returned an error, state mismatch,
    /// timeout, etc.).  String body for the UI.
    Oauth(String),
    /// Keychain read/write failed.
    Keychain(String),
    /// HTTP / network failure.
    Net(String),
    /// Provider returned a non-2xx response.  Carries the status +
    /// body for the diagnostic.
    Api(String),
    /// Local git subprocess failed.
    Git(String),
    /// Local filesystem read/write failed.
    Io(String),
    /// Sync-config / manifest serde failure.
    Manifest(String),
    /// Adapter not yet implemented in this build.
    NotImplemented(String),
}

impl fmt::Display for SyncError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SyncError::BadInput(s) => write!(f, "bad input: {s}"),
            SyncError::Cancelled => write!(f, "cancelled by user"),
            SyncError::Oauth(s) => write!(f, "oauth error: {s}"),
            SyncError::Keychain(s) => write!(f, "keychain error: {s}"),
            SyncError::Net(s) => write!(f, "network error: {s}"),
            SyncError::Api(s) => write!(f, "api error: {s}"),
            SyncError::Git(s) => write!(f, "git error: {s}"),
            SyncError::Io(s) => write!(f, "io error: {s}"),
            SyncError::Manifest(s) => write!(f, "manifest error: {s}"),
            SyncError::NotImplemented(s) => write!(f, "not implemented: {s}"),
        }
    }
}

impl std::error::Error for SyncError {}

impl From<std::io::Error> for SyncError {
    fn from(e: std::io::Error) -> Self {
        SyncError::Io(e.to_string())
    }
}

impl From<reqwest::Error> for SyncError {
    fn from(e: reqwest::Error) -> Self {
        SyncError::Net(e.to_string())
    }
}

impl From<serde_json::Error> for SyncError {
    fn from(e: serde_json::Error) -> Self {
        SyncError::Manifest(e.to_string())
    }
}
