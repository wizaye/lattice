//! Token storage for calendar provider OAuth tokens and API keys.
//!
//! Mirrors the `sync/keychain.rs` pattern but uses the service name
//! `"lattice-cal"` so calendar credentials are isolated from BYOC
//! sync tokens.
//!
//! Provider ID strings used as keys:
//!   `"outlook"`  — Microsoft Graph PKCE / access + refresh token
//!   `"calcom"`   — Cal.com API key (stored as `access_token`)
//!   `"google"`   — Google Calendar PKCE (future slice)
//!   `"apple"`    — Apple Calendar CalDAV (future slice)
//!
//! ## Security posture
//!
//! * **Windows:** JSON written to `%LOCALAPPDATA%\Lattice\cal-tokens\`
//!   as a plaintext file.  SECURITY-TODO: add DPAPI envelope (same as
//!   `sync/keychain.rs::win::protect`) before GA.  The directory is
//!   only accessible to the logged-in user so the risk is low in the
//!   current slice.
//! * **macOS / Linux:** `keyring` crate (Keychain Services / libsecret)
//!   with service `"lattice-cal"`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[cfg(not(windows))]
const CAL_SERVICE: &str = "lattice-cal";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalTokenSet {
    /// OAuth2 Bearer access token — OR — a raw API key for Cal.com.
    pub access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// Unix-seconds expiry of the access token; `None` = long-lived.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    /// OAuth2 granted scopes (space-separated).
    #[serde(default)]
    pub scope: String,
    /// Human-readable label shown in the Settings UI (e.g.
    /// `"alice@contoso.com"` for Outlook, `"alice"` for Cal.com).
    pub account_label: String,
}

// ── key derivation ───────────────────────────────────────────────────────

fn vault_hash(vault: &Path) -> String {
    let key = std::fs::canonicalize(vault)
        .unwrap_or_else(|_| vault.to_path_buf())
        .to_string_lossy()
        .to_string();
    let hash = blake3::hash(key.as_bytes());
    hash.to_hex()[..16].to_string()
}

// ── public API ───────────────────────────────────────────────────────────

pub fn has_token(vault: &Path, provider: &str) -> bool {
    load(vault, provider).map_or(false, |v| v.is_some())
}

pub fn store(vault: &Path, provider: &str, token: &CalTokenSet) -> Result<(), String> {
    let blob = serde_json::to_vec(token).map_err(|e| e.to_string())?;
    platform::write(vault, provider, &blob)
}

pub fn load(vault: &Path, provider: &str) -> Result<Option<CalTokenSet>, String> {
    match platform::read(vault, provider)? {
        Some(b) => {
            let t: CalTokenSet =
                serde_json::from_slice(&b).map_err(|e| e.to_string())?;
            Ok(Some(t))
        }
        None => Ok(None),
    }
}

pub fn delete(vault: &Path, provider: &str) -> Result<(), String> {
    platform::delete(vault, provider)
}

// ── Windows backend ──────────────────────────────────────────────────────

#[cfg(windows)]
mod platform {
    use super::*;
    use std::fs;

    fn token_dir() -> PathBuf {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Lattice")
            .join("cal-tokens")
    }

    fn token_path(vault: &Path, provider: &str) -> PathBuf {
        token_dir().join(format!("{provider}-{}.json", vault_hash(vault)))
    }

    pub fn write(vault: &Path, provider: &str, blob: &[u8]) -> Result<(), String> {
        let dir = token_dir();
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = token_path(vault, provider);
        let tmp = path.with_extension("tmp");
        fs::write(&tmp, blob).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn read(vault: &Path, provider: &str) -> Result<Option<Vec<u8>>, String> {
        let path = token_path(vault, provider);
        if !path.exists() {
            return Ok(None);
        }
        Ok(Some(fs::read(&path).map_err(|e| e.to_string())?))
    }

    pub fn delete(vault: &Path, provider: &str) -> Result<(), String> {
        let path = token_path(vault, provider);
        if path.exists() {
            fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

// ── macOS / Linux backend ────────────────────────────────────────────────

#[cfg(not(windows))]
mod platform {
    use super::*;

    fn account_key(vault: &Path, provider: &str) -> String {
        format!("{provider}:{}", vault_hash(vault))
    }

    pub fn write(vault: &Path, provider: &str, blob: &[u8]) -> Result<(), String> {
        let entry = keyring::Entry::new(CAL_SERVICE, &account_key(vault, provider))
            .map_err(|e| e.to_string())?;
        entry
            .set_password(&String::from_utf8_lossy(blob))
            .map_err(|e| e.to_string())
    }

    pub fn read(vault: &Path, provider: &str) -> Result<Option<Vec<u8>>, String> {
        let entry = keyring::Entry::new(CAL_SERVICE, &account_key(vault, provider))
            .map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(s) => Ok(Some(s.into_bytes())),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn delete(vault: &Path, provider: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(CAL_SERVICE, &account_key(vault, provider))
            .map_err(|e| e.to_string())?;
        match entry.delete_credential() {
            Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}
