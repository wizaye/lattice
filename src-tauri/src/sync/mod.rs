//! BYOC sync layer — slice B.
//!
//! Provider-agnostic façade over GitHub + Google Drive + (later)
//! OneDrive + Dropbox.  See `docs/byoc-plan.md` for the full design.
//!
//! Hard product rule, enforced everywhere in this module:
//!   - Lattice has no server.  No `auth.lattice.dev`.  No proxy.
//!   - OAuth flows run entirely inside the desktop app.  PKCE +
//!     loopback redirect (Drive) OR Device Code Flow (GitHub) —
//!     both work fine for public clients without a secret.
//!   - Tokens live in the OS keychain ONLY (via `keyring-rs`).
//!     Never on disk, never in logs, never in the Zustand store.
//!   - User vault data flows direct from this machine to the
//!     provider's API.  We are not on the network path.

pub mod clients;
pub mod error;
pub mod github;
pub mod gdrive;
pub mod keychain;
pub mod manifest;
pub mod oauth;
pub mod onedrive;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

pub use error::SyncError;

/// Stable enum for both IPC + keychain account-name keying.
/// Serialised as kebab-case so frontend strings match the
/// `BYOC_PROVIDERS` array in `ChangesPanel.tsx`.
#[derive(Copy, Clone, Debug, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderId {
    Github,
    Gdrive,
    Onedrive,
}

impl ProviderId {
    pub fn as_str(&self) -> &'static str {
        match self {
            ProviderId::Github => "github",
            ProviderId::Gdrive => "gdrive",
            ProviderId::Onedrive => "onedrive",
        }
    }
}

/// Static description for the picker UI.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub id: ProviderId,
    pub label: &'static str,
    /// Whether the underlying client id is baked in (i.e. the user
    /// can actually connect right now in this build).  False on dev
    /// builds where `LATTICE_*_CLIENT_ID` wasn't set at compile time.
    pub configured: bool,
    /// Whether this provider supports `pull` today.  Drive is
    /// push-only in slice B — the kebab menu uses this flag to hide
    /// the "Pull only" item and the sync-now flow uses it to skip
    /// the pull leg entirely (otherwise every Drive sync would fail
    /// with `NotImplemented` from the pull path).
    pub supports_pull: bool,
    /// Whether the remote has a publicly browsable URL.  Drive's
    /// `appDataFolder` is sandboxed and not exposed in the user's
    /// Drive UI, so we hide the "Open remote" menu item there.
    pub has_browsable_remote: bool,
    /// Free-form note for the UI tooltip.
    pub note: Option<String>,
}

/// Connection state for a single (vault, provider) pair.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub connected: bool,
    pub account_label: Option<String>,
    /// Provider-specific remote handle.  For GitHub this is the
    /// `owner/repo` slug.  For Drive this is the remote `appDataFolder`
    /// project (`lattice-vault`).
    pub remote_label: Option<String>,
    pub last_sync_at: Option<i64>,
    pub last_error: Option<String>,
}

/// Returned by `auth_complete`.  Frontend shows this in the connected row.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub display_name: String,
    pub account_email: Option<String>,
    pub remote_label: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushResult {
    pub uploaded_objects: u32,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub message: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullResult {
    pub downloaded_objects: u32,
    pub head: Option<String>,
    pub branch: Option<String>,
    /// Conflict markers if a fast-forward wasn't possible.  Empty on success.
    pub conflicts: Vec<String>,
    pub message: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub push: PushResult,
    pub pull: PullResult,
}

/// The provider-agnostic contract.  Adapters know how to do four
/// things; everything else lives in `mod.rs`.
#[async_trait]
pub trait SyncProvider: Send + Sync {
    #[allow(dead_code)] // exposed for future logging / multi-provider diagnostics
    fn id(&self) -> ProviderId;
    fn display_name(&self) -> &'static str;

    /// Whether the OAuth client id is baked in.  Drives the UI
    /// "Connect" vs "Not configured" affordance.
    fn configured(&self) -> bool;

    /// Whether `pull` is wired up today.  Default is `true`; adapters
    /// that ship in push-only mode (e.g. Drive in slice B) override
    /// this to `false` so `byoc_sync_now` knows to skip the pull leg
    /// instead of always returning `NotImplemented`.
    fn supports_pull(&self) -> bool {
        true
    }

    /// Whether the remote backing this provider is publicly browsable
    /// (i.e. there's a meaningful URL to open in the system browser).
    /// GitHub repos = yes, Drive `appDataFolder` = no.  Default true.
    fn has_browsable_remote(&self) -> bool {
        true
    }

    /// Full OAuth dance.  Blocks until the user completes consent
    /// in their browser (5-minute timeout).  Stashes tokens in the
    /// keychain on success.  Idempotent — re-connecting overwrites
    /// the existing token.
    async fn connect(&self, app: AppHandle, vault: &Path) -> Result<AccountInfo, SyncError>;

    /// Wipe tokens + sync-config from this (provider, vault).  Idempotent.
    async fn disconnect(&self, vault: &Path) -> Result<(), SyncError>;

    /// Cheap keychain probe + sync-config read.  Does NOT validate
    /// the token is still good — `push` / `pull` will surface a 401.
    async fn status(&self, vault: &Path) -> Result<ProviderStatus, SyncError>;

    async fn push(&self, vault: &Path) -> Result<PushResult, SyncError>;

    async fn pull(&self, vault: &Path) -> Result<PullResult, SyncError>;
}

/// Factory.  One adapter per call — they're tiny structs with no per-instance state.
fn provider(id: ProviderId) -> Arc<dyn SyncProvider> {
    match id {
        ProviderId::Github => Arc::new(github::GithubProvider::new()),
        ProviderId::Gdrive => Arc::new(gdrive::GdriveProvider::new()),
        ProviderId::Onedrive => Arc::new(onedrive::OneDriveProvider::new(
            option_env!("LATTICE_ONEDRIVE_CLIENT_ID").unwrap_or("").to_string(),
        )),
    }
}

// ── shared helpers ─────────────────────────────────────────────────

/// Resolve + validate a vault path.  Rejects empty / non-directory
/// inputs (including the frontend `__mock__` sentinel) before any
/// network or keychain work.  Mirrors `git::vault_dir`.
fn vault_dir(path: &str) -> Result<PathBuf, SyncError> {
    if path.is_empty() {
        return Err(SyncError::BadInput("vault path is empty".into()));
    }
    let p = PathBuf::from(path);
    if !p.is_dir() {
        return Err(SyncError::BadInput(format!(
            "vault path is not a directory: {path:?}"
        )));
    }
    Ok(p)
}

// ── IPC commands ───────────────────────────────────────────────────

#[tauri::command]
pub fn byoc_list_providers() -> Vec<ProviderInfo> {
    [ProviderId::Github, ProviderId::Gdrive, ProviderId::Onedrive]
        .into_iter()
        .map(|id| {
            let p = provider(id);
            ProviderInfo {
                id,
                label: p.display_name(),
                configured: p.configured(),
                supports_pull: p.supports_pull(),
                has_browsable_remote: p.has_browsable_remote(),
                note: if p.configured() {
                    None
                } else {
                    Some(format!(
                        "Set LATTICE_{}_CLIENT_ID at build time to enable this adapter.",
                        match id {
                            ProviderId::Github => "GITHUB",
                            ProviderId::Gdrive => "GOOGLE",
                            ProviderId::Onedrive => "ONEDRIVE",
                        }
                    ))
                },
            }
        })
        .collect()
}

#[tauri::command]
pub async fn byoc_status(
    vault_path: String,
    provider: ProviderId,
) -> Result<ProviderStatus, String> {
    let vault = vault_dir(&vault_path).map_err(|e| e.to_string())?;
    self::provider(provider)
        .status(&vault)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn byoc_connect(
    app: AppHandle,
    vault_path: String,
    provider: ProviderId,
) -> Result<AccountInfo, String> {
    let vault = vault_dir(&vault_path).map_err(|e| e.to_string())?;
    self::provider(provider)
        .connect(app, &vault)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn byoc_disconnect(
    vault_path: String,
    provider: ProviderId,
) -> Result<(), String> {
    let vault = vault_dir(&vault_path).map_err(|e| e.to_string())?;
    self::provider(provider)
        .disconnect(&vault)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn byoc_push(
    vault_path: String,
    provider: ProviderId,
) -> Result<PushResult, String> {
    let vault = vault_dir(&vault_path).map_err(|e| e.to_string())?;
    self::provider(provider)
        .push(&vault)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn byoc_pull(
    vault_path: String,
    provider: ProviderId,
) -> Result<PullResult, String> {
    let vault = vault_dir(&vault_path).map_err(|e| e.to_string())?;
    self::provider(provider)
        .pull(&vault)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn byoc_sync_now(
    vault_path: String,
    provider: ProviderId,
) -> Result<SyncResult, String> {
    let vault = vault_dir(&vault_path).map_err(|e| e.to_string())?;
    let p = self::provider(provider);
    // Push-only providers (e.g. Drive in slice B) skip the pull leg
    // entirely — otherwise every sync would fail with NotImplemented.
    // We surface a synthetic PullResult so the UI still has a
    // pull.message to show, but the busy/last-error state is driven
    // entirely by the push outcome.
    if !p.supports_pull() {
        let push = p.push(&vault).await.map_err(|e| e.to_string())?;
        return Ok(SyncResult {
            push,
            pull: PullResult {
                downloaded_objects: 0,
                head: None,
                branch: None,
                conflicts: Vec::new(),
                message: "Pull not supported by this provider yet — push-only sync".into(),
            },
        });
    }
    // Pull first, then push.  This avoids the common "non-fast-forward"
    // push failure when the remote has commits the local doesn't (e.g.
    // the GitHub repo was auto-init'd with a README, or another machine
    // pushed since our last sync).  Pull is FF-only, so a non-trivial
    // remote-ahead state still bubbles up as a merge conflict in the
    // PullResult; push is only attempted when pull succeeds cleanly.
    let pull = p.pull(&vault).await.map_err(|e| e.to_string())?;
    if !pull.conflicts.is_empty() {
        // Don't push on top of an unresolved merge — that produces an
        // even worse error.  Surface the pull state and stop.
        return Ok(SyncResult {
            push: PushResult {
                uploaded_objects: 0,
                head: pull.head.clone(),
                branch: pull.branch.clone(),
                message: "Push skipped — resolve pull conflicts first".into(),
            },
            pull,
        });
    }
    let push = p.push(&vault).await.map_err(|e| e.to_string())?;
    Ok(SyncResult { push, pull })
}

// ── secondary IPC: storage transparency + reveal helpers ──────────

/// Where do this (vault, provider)'s tokens live on disk?
///
/// UI surfaces this in the connected-row so the user can:
///   - Verify we're NOT storing in Windows Credential Manager.
///   - Reveal the encrypted file in Explorer (handy for backups /
///     audits / "should I worry about uninstalling Lattice?").
#[tauri::command]
pub fn byoc_storage_info(
    vault_path: String,
    provider: ProviderId,
) -> Result<keychain::StorageDescriptor, String> {
    let vault = vault_dir(&vault_path).map_err(|e| e.to_string())?;
    Ok(keychain::storage_descriptor(&vault, provider))
}

/// Resolve the public browser URL for the remote backing this
/// (vault, provider).  Returns `None` if the provider hasn't been
/// connected yet (no manifest with a remote_label).  Frontend calls
/// `shell.open()` on the returned URL.
#[tauri::command]
pub fn byoc_remote_url(
    vault_path: String,
    provider: ProviderId,
) -> Result<Option<String>, String> {
    let vault = vault_dir(&vault_path).map_err(|e| e.to_string())?;
    let m = manifest::load(&vault, provider).map_err(|e| e.to_string())?;
    let url = m.and_then(|m| {
        let label = m.remote_label?;
        match provider {
            ProviderId::Github => Some(format!("https://github.com/{label}")),
            // Drive's appDataFolder is sandboxed — the user can't
            // browse to it.  Return None so the UI hides / disables
            // the "Open remote" affordance entirely.
            ProviderId::Gdrive => None,
            // OneDrive's AppFolder is similarly sandboxed.
            ProviderId::Onedrive => None,
        }
    });
    Ok(url)
}

/// Resolve the on-disk manifest path so the UI can offer
/// "Reveal local manifest" alongside the token-storage reveal.
#[tauri::command]
pub fn byoc_manifest_path(
    vault_path: String,
    provider: ProviderId,
) -> Result<PathBuf, String> {
    let vault = vault_dir(&vault_path).map_err(|e| e.to_string())?;
    Ok(vault
        .join(".lattice")
        .join(format!("sync-manifest.{}.json", provider.as_str())))
}
