//! Google Drive adapter — PKCE + loopback redirect for auth, plus
//! a content-addressed blob-store overlay in `appDataFolder` for
//! push.  Pull is intentionally NOT implemented in this first
//! iteration — see `pull()` below.
//!
//! Why `appDataFolder`?  It's a Drive feature that gives every
//! desktop app its own private folder, invisible in the user's
//! normal Drive UI.  Perfect for "Lattice's sync state lives
//! here; please don't touch it."
//!
//! Layout (per vault):
//!   appDataFolder/
//!     ├── manifest.json        — HEAD + branch tips (JSON)
//!     ├── refs-heads-main.txt  — 40-char sha (text)
//!     └── obj-<blake3>.bin     — zlib blob, addressed by content hash

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use walkdir::WalkDir;

use super::clients::{GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET};
use super::error::SyncError;
use super::keychain::{self, TokenSet};
use super::manifest::{self, now_unix};
use super::oauth;
use super::{AccountInfo, ProviderId, ProviderStatus, PullResult, PushResult, SyncProvider};

const AUTHORIZE_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const USERINFO_URL: &str = "https://openidconnect.googleapis.com/v1/userinfo";
#[allow(dead_code)] // reserved for the upcoming pull / list / delete operations
const FILES_API: &str = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_API: &str = "https://www.googleapis.com/upload/drive/v3/files";
const SCOPES: &str = "https://www.googleapis.com/auth/drive.appdata openid email";
const USER_AGENT: &str = "lattice-byoc/0.1";

/// 5 minutes from URL-open to browser-callback.  Longer than the
/// default just to be polite to users on flaky networks.
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(5 * 60);

pub struct GdriveProvider;

impl GdriveProvider {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl SyncProvider for GdriveProvider {
    fn id(&self) -> ProviderId {
        ProviderId::Gdrive
    }

    fn display_name(&self) -> &'static str {
        "Google Drive"
    }

    fn configured(&self) -> bool {
        GOOGLE_CLIENT_ID.is_some()
    }

    /// Drive is push-only in slice B.  `pull()` returns
    /// `NotImplemented`; this flag tells the sync orchestrator to
    /// skip the pull leg entirely so `byoc_sync_now` actually works.
    fn supports_pull(&self) -> bool {
        false
    }

    /// `appDataFolder` is sandboxed — it doesn't appear in the user's
    /// Drive UI, so there's no useful URL to open.  The UI hides the
    /// "Open remote in browser" menu item when this is false.
    fn has_browsable_remote(&self) -> bool {
        false
    }

    async fn connect(&self, _app: AppHandle, vault: &Path) -> Result<AccountInfo, SyncError> {
        let client_id = GOOGLE_CLIENT_ID.ok_or_else(|| {
            SyncError::Oauth(
                "Google client id missing — set LATTICE_GOOGLE_CLIENT_ID at build time".into(),
            )
        })?;

        // 1. Bind loopback, get the (port, callback receiver).
        let (port, callback_rx) = oauth::loopback_listen(CALLBACK_TIMEOUT).await?;
        let redirect_uri = format!("http://127.0.0.1:{port}");

        // 2. Generate PKCE pair + CSRF state.
        let verifier = oauth::random_verifier();
        let challenge = oauth::s256_challenge(&verifier);
        let state = oauth::random_state();

        // 3. Open the authorize URL.
        let authorize = build_authorize_url(client_id, &redirect_uri, &challenge, &state);
        if let Err(e) = tauri_plugin_opener::open_url(&authorize, None::<String>) {
            return Err(SyncError::Oauth(format!(
                "could not open browser for Google consent: {e}"
            )));
        }

        // 4. Wait for the browser to redirect back.
        let cb = callback_rx
            .await
            .map_err(|e| SyncError::Oauth(format!("loopback channel dropped: {e}")))??;
        if cb.state != state {
            return Err(SyncError::Oauth("state mismatch — possible CSRF".into()));
        }

        // 5. Exchange the code for tokens.
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(Duration::from_secs(30))
            .build()?;
        let token_set = exchange_code(&http, client_id, &cb.code, &redirect_uri, &verifier).await?;

        // 6. Fetch user info for the connected-row label.
        let user: GoogleUser = http
            .get(USERINFO_URL)
            .bearer_auth(&token_set.access_token)
            .send()
            .await?
            .error_for_status()
            .map_err(|e| SyncError::Api(format!("GET /userinfo: {e}")))?
            .json()
            .await?;

        // 7. Persist token + manifest.
        keychain::store(vault, ProviderId::Gdrive, &token_set)?;
        let mut m = manifest::load(vault, ProviderId::Gdrive)?.unwrap_or_default();
        m.schema = 1;
        m.provider = "gdrive".into();
        m.remote_label = Some("appDataFolder".into());
        m.account_label = Some(user.email.clone().unwrap_or_else(|| "google".into()));
        manifest::save(vault, ProviderId::Gdrive, &m)?;

        Ok(AccountInfo {
            display_name: user.name.unwrap_or_else(|| "Google".into()),
            account_email: user.email,
            remote_label: Some("appDataFolder".into()),
        })
    }

    async fn disconnect(&self, vault: &Path) -> Result<(), SyncError> {
        keychain::delete(vault, ProviderId::Gdrive)?;
        if let Some(mut m) = manifest::load(vault, ProviderId::Gdrive)? {
            m.last_sync_at = None;
            manifest::save(vault, ProviderId::Gdrive, &m)?;
        }
        Ok(())
    }

    async fn status(&self, vault: &Path) -> Result<ProviderStatus, SyncError> {
        let connected = keychain::load(vault, ProviderId::Gdrive)?.is_some();
        let m = manifest::load(vault, ProviderId::Gdrive)?;
        Ok(ProviderStatus {
            connected,
            account_label: m.as_ref().and_then(|m| m.account_label.clone()),
            remote_label: m.as_ref().and_then(|m| m.remote_label.clone()),
            last_sync_at: m.as_ref().and_then(|m| m.last_sync_at),
            last_error: None,
        })
    }

    async fn push(&self, vault: &Path) -> Result<PushResult, SyncError> {
        let token = require_token(vault)?;
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(Duration::from_secs(60))
            .build()?;

        // 1. Collect every loose object under .lattice/git/objects/**
        //    (the vault's local git store).  If there's no git store
        //    yet, return early — nothing to push.
        let objects_dir = vault.join(".lattice").join("git").join("objects");
        if !objects_dir.is_dir() {
            // Fall back to .git/objects (when vault is a real git
            // worktree rather than the Lattice-managed mirror).
            let alt = vault.join(".git").join("objects");
            if !alt.is_dir() {
                return Ok(PushResult {
                    uploaded_objects: 0,
                    head: None,
                    branch: None,
                    message: "vault has no git store yet".into(),
                });
            }
        }
        let real_objects_dir = if objects_dir.is_dir() {
            objects_dir
        } else {
            vault.join(".git").join("objects")
        };

        let local_blobs = collect_loose_objects(&real_objects_dir)?;

        // 2. Diff against manifest.
        let mut m = manifest::load(vault, ProviderId::Gdrive)?.unwrap_or_default();
        let uploaded: HashSet<String> = m.uploaded_objects.iter().cloned().collect();
        let to_upload: Vec<_> = local_blobs
            .into_iter()
            .filter(|(hash, _)| !uploaded.contains(hash))
            .collect();

        // 3. Upload each new object.
        let mut count = 0u32;
        for (hash, path) in &to_upload {
            let body = fs::read(path)?;
            upload_file(
                &http,
                &token.access_token,
                &format!("obj-{hash}.bin"),
                "application/octet-stream",
                body,
            )
            .await?;
            m.uploaded_objects.push(hash.clone());
            count += 1;
        }

        // 4. Upload the current branch ref + manifest blob.
        let head_value = head_sha(vault).ok();
        if let Some(head) = head_value.as_deref() {
            upload_file(
                &http,
                &token.access_token,
                "refs-heads-main.txt",
                "text/plain",
                head.as_bytes().to_vec(),
            )
            .await?;
        }
        let blob = serde_json::to_vec_pretty(&RemoteManifest {
            head: head_value.clone(),
            uploaded: m.uploaded_objects.clone(),
        })?;
        upload_file(
            &http,
            &token.access_token,
            "manifest.json",
            "application/json",
            blob,
        )
        .await?;

        // 5. Persist local manifest.
        m.local_head = head_value.clone();
        m.remote_head = head_value.clone();
        m.last_sync_at = Some(now_unix());
        manifest::save(vault, ProviderId::Gdrive, &m)?;

        Ok(PushResult {
            uploaded_objects: count,
            head: head_value,
            branch: current_branch(vault).ok(),
            message: format!("Uploaded {count} new object(s) to appDataFolder"),
        })
    }

    async fn pull(&self, _vault: &Path) -> Result<PullResult, SyncError> {
        // First iteration: push-only.  Pull requires walking remote
        // manifest, fetching missing objects, validating ancestry,
        // and running `git update-ref` — all doable but worth its
        // own slice.  Returning a clear error so the UI knows.
        Err(SyncError::NotImplemented(
            "Google Drive pull is shipping in a follow-up slice".into(),
        ))
    }
}

// ── helpers ─────────────────────────────────────────────────────────

fn require_token(vault: &Path) -> Result<TokenSet, SyncError> {
    keychain::load(vault, ProviderId::Gdrive)?
        .ok_or_else(|| SyncError::BadInput("Google Drive not connected for this vault".into()))
}

#[derive(Debug, Serialize, Deserialize)]
struct RemoteManifest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    head: Option<String>,
    #[serde(default)]
    uploaded: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct GoogleUser {
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GoogleTokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    token_type: Option<String>,
}

fn build_authorize_url(
    client_id: &str,
    redirect_uri: &str,
    challenge: &str,
    state: &str,
) -> String {
    let mut url = String::from(AUTHORIZE_URL);
    url.push('?');
    let params: [(&str, &str); 8] = [
        ("response_type", "code"),
        ("client_id", client_id),
        ("redirect_uri", redirect_uri),
        ("scope", SCOPES),
        ("code_challenge", challenge),
        ("code_challenge_method", "S256"),
        ("state", state),
        ("access_type", "offline"),
    ];
    let mut first = true;
    for (k, v) in params.iter() {
        if !first {
            url.push('&');
        }
        first = false;
        url.push_str(k);
        url.push('=');
        url.push_str(&urlencoding::encode(v));
    }
    url
}

async fn exchange_code(
    http: &reqwest::Client,
    client_id: &str,
    code: &str,
    redirect_uri: &str,
    verifier: &str,
) -> Result<TokenSet, SyncError> {
    let mut form: Vec<(&str, &str)> = vec![
        ("client_id", client_id),
        ("code", code),
        ("grant_type", "authorization_code"),
        ("redirect_uri", redirect_uri),
        ("code_verifier", verifier),
    ];
    if let Some(secret) = GOOGLE_CLIENT_SECRET {
        form.push(("client_secret", secret));
    }
    let resp = http.post(TOKEN_URL).form(&form).send().await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(SyncError::Oauth(format!(
            "token exchange failed ({status}): {body}"
        )));
    }
    let tr: GoogleTokenResponse = resp.json().await?;
    Ok(TokenSet {
        access_token: tr.access_token,
        refresh_token: tr.refresh_token,
        expires_at: tr.expires_in.map(|s| now_unix() + s),
        scope: tr.scope.unwrap_or_default(),
        token_type: tr.token_type.unwrap_or_else(|| "Bearer".into()),
    })
}

/// Multipart upload to `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`
/// with `parents:["appDataFolder"]`.  Always creates a new file; we
/// rely on Drive's "files can share a name" behaviour and rewrite the
/// canonical name on every push.  (A follow-up slice will swap to
/// upsert via `files.update` once we track the per-file id in the
/// manifest.)
async fn upload_file(
    http: &reqwest::Client,
    token: &str,
    name: &str,
    mime: &str,
    body: Vec<u8>,
) -> Result<(), SyncError> {
    let metadata = serde_json::json!({
        "name": name,
        "parents": ["appDataFolder"],
    });
    let part_meta = reqwest::multipart::Part::text(metadata.to_string())
        .mime_str("application/json; charset=UTF-8")
        .map_err(|e| SyncError::Net(e.to_string()))?;
    let part_body = reqwest::multipart::Part::bytes(body)
        .mime_str(mime)
        .map_err(|e| SyncError::Net(e.to_string()))?;
    let form = reqwest::multipart::Form::new()
        .part("metadata", part_meta)
        .part("file", part_body);

    let resp = http
        .post(format!("{UPLOAD_API}?uploadType=multipart"))
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(SyncError::Api(format!(
            "upload {name} returned {status}: {body}"
        )));
    }
    Ok(())
}

/// Walk a git object store and return `(blake3 hex, abs path)` for
/// every loose object.  Skips `pack/`, `info/`, and any non-regular
/// file.  blake3 over the on-disk bytes (which are already deflated
/// in a git object store) gives us a content-addressed key that's
/// stable across syncs.
fn collect_loose_objects(objects_dir: &Path) -> Result<Vec<(String, PathBuf)>, SyncError> {
    let mut out = Vec::new();
    for entry in WalkDir::new(objects_dir).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        // Skip pack/info trees — those need a separate sync strategy.
        if path.components().any(|c| {
            matches!(c.as_os_str().to_str(), Some("pack") | Some("info"))
        }) {
            continue;
        }
        let bytes = fs::read(path)?;
        let hash = blake3::hash(&bytes).to_hex().to_string();
        out.push((hash, path.to_path_buf()));
    }
    Ok(out)
}

fn current_branch(vault: &Path) -> Result<String, SyncError> {
    let out = git(vault, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
    if !out.status.success() {
        return Err(SyncError::Git("no branch checked out".into()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn head_sha(vault: &Path) -> Result<String, SyncError> {
    let out = git(vault, &["rev-parse", "HEAD"])?;
    if !out.status.success() {
        return Err(SyncError::Git("no HEAD".into()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn git(vault: &Path, args: &[&str]) -> Result<std::process::Output, SyncError> {
    use std::process::Command;
    #[cfg(windows)]
    use std::os::windows::process::CommandExt;
    #[cfg(windows)]
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let mut cmd = Command::new("git");
    cmd.current_dir(vault)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .env("LANG", "C");
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.output().map_err(|e| SyncError::Git(format!("git spawn failed: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn authorize_url_has_required_params() {
        let url = build_authorize_url("CID", "http://127.0.0.1:5555", "CHAL", "STATE");
        assert!(url.contains("client_id=CID"));
        assert!(url.contains("code_challenge=CHAL"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("state=STATE"));
        assert!(url.contains("response_type=code"));
    }

    #[test]
    fn collect_loose_objects_skips_pack_dir() {
        let dir = TempDir::new().unwrap();
        let objects = dir.path().join("objects");
        fs::create_dir_all(objects.join("ab")).unwrap();
        fs::write(objects.join("ab").join("cdef"), b"obj1").unwrap();
        fs::create_dir_all(objects.join("pack")).unwrap();
        fs::write(objects.join("pack").join("pack-xyz.pack"), b"skip").unwrap();
        let got = collect_loose_objects(&objects).unwrap();
        assert_eq!(got.len(), 1, "should pick up exactly one loose object");
    }
}
