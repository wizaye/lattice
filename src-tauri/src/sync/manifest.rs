//! Per-provider sync manifest, stored at
//! `<vault>/.lattice/sync-manifest.<provider>.json`.
//!
//! Purpose: a tiny piece of metadata that survives across runs so
//! we don't re-upload blobs we've already pushed, and so we can
//! tell the user when they last successfully synced.
//!
//! NOT a secret — fine to write to disk.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::error::SyncError;
use super::ProviderId;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SyncManifest {
    #[serde(default = "schema_v1")]
    pub schema: u32,
    /// Provider id as `kebab-case` string, redundant with the
    /// filename but useful for sanity checks if the file gets moved.
    pub provider: String,
    /// Last commit sha we pushed.  None on fresh connect.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_head: Option<String>,
    /// Last commit sha the provider claims to hold.  Updated after
    /// a successful pull.  For GitHub this is the same as
    /// `local_head` after a successful push.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_head: Option<String>,
    /// Set of object SHAs (BLAKE3 hex for Drive blob-store overlay,
    /// or git object id for GitHub).  Used so push knows what to
    /// skip.  Stored as `Vec<String>` because `HashSet<String>`
    /// doesn't deserialise from JSON arrays without a custom impl.
    #[serde(default)]
    pub uploaded_objects: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_sync_at: Option<i64>,
    /// Provider-specific cursor (Drive `startPageToken`, etc.).
    /// Opaque to this module.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_delta_cursor: Option<String>,
    /// Provider-specific remote handle (GitHub owner/repo slug,
    /// Drive folder id, etc.).  Opaque to this module.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_label: Option<String>,
    /// Provider-specific account label, useful for the connected
    /// row UI even when the keychain entry's gone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_label: Option<String>,
}

fn schema_v1() -> u32 {
    1
}

fn manifest_path(vault: &Path, provider: ProviderId) -> PathBuf {
    vault
        .join(".lattice")
        .join(format!("sync-manifest.{}.json", provider.as_str()))
}

pub fn load(vault: &Path, provider: ProviderId) -> Result<Option<SyncManifest>, SyncError> {
    let path = manifest_path(vault, provider);
    if !path.exists() {
        return Ok(None);
    }
    let blob = fs::read_to_string(&path)?;
    let manifest: SyncManifest = serde_json::from_str(&blob)?;
    Ok(Some(manifest))
}

pub fn save(vault: &Path, provider: ProviderId, manifest: &SyncManifest) -> Result<(), SyncError> {
    let dir = vault.join(".lattice");
    fs::create_dir_all(&dir)?;
    let path = manifest_path(vault, provider);
    let blob = serde_json::to_string_pretty(manifest)?;
    // Atomic-ish write: stage to .tmp then rename.  Avoids a torn
    // file if the process dies mid-write.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, blob.as_bytes())?;
    fs::rename(&tmp, &path)?;
    Ok(())
}

/// Remove the manifest (idempotent — no-op if absent).
#[allow(dead_code)] // disconnect() will wire this once provider revoke endpoints land
pub fn delete(vault: &Path, provider: ProviderId) -> Result<(), SyncError> {
    let path = manifest_path(vault, provider);
    if path.exists() {
        fs::remove_file(&path)?;
    }
    Ok(())
}

pub fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn round_trip() {
        let dir = TempDir::new().unwrap();
        let m = SyncManifest {
            schema: 1,
            provider: "github".into(),
            local_head: Some("abc".into()),
            remote_head: Some("abc".into()),
            uploaded_objects: vec!["a".into(), "b".into()],
            last_sync_at: Some(123),
            last_delta_cursor: None,
            remote_label: Some("foo/bar".into()),
            account_label: Some("alice".into()),
        };
        save(dir.path(), ProviderId::Github, &m).unwrap();
        let loaded = load(dir.path(), ProviderId::Github).unwrap().unwrap();
        assert_eq!(loaded.local_head, Some("abc".into()));
        assert_eq!(loaded.uploaded_objects, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(loaded.remote_label, Some("foo/bar".into()));
    }

    #[test]
    fn load_missing_returns_none() {
        let dir = TempDir::new().unwrap();
        assert!(load(dir.path(), ProviderId::Github).unwrap().is_none());
    }
}
