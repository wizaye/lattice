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
const SCOPES: &str = "https://www.googleapis.com/auth/drive.file openid email";
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
        
        let vault_name = vault.file_name().unwrap_or_default().to_string_lossy();
        let folder_name = format!("Lattice - {}", vault_name);
        let folder_id = ensure_vault_folder(&http, &token_set.access_token, &folder_name).await?;

        let mut m = manifest::load(vault, ProviderId::Gdrive)?.unwrap_or_default();
        m.schema = 1;
        m.is_connected = true;
        m.provider = "gdrive".into();
        m.remote_label = Some(folder_id.clone()); // Bug 17 fix: folder ID goes in remote_label
        // last_delta_cursor is reserved for Drive's startPageToken
        // pagination cursor used during incremental delta sync.  Never
        // overwrite it with the folder ID.
        m.account_label = Some(user.email.clone().unwrap_or_else(|| "google".into()));
        manifest::save(vault, ProviderId::Gdrive, &m)?;

        Ok(AccountInfo {
            display_name: user.name.unwrap_or_else(|| "Google".into()),
            account_email: user.email,
            remote_label: Some(format!("Lattice - {}", vault.file_name().unwrap_or_default().to_string_lossy())),
        })
    }

    async fn disconnect(&self, vault: &Path) -> Result<(), SyncError> {
        keychain::delete(vault, ProviderId::Gdrive)?;
        if let Some(mut m) = manifest::load(vault, ProviderId::Gdrive)? {
            m.is_connected = false;
            m.last_sync_at = None;
            manifest::save(vault, ProviderId::Gdrive, &m)?;
        }
        Ok(())
    }

    async fn status(&self, vault: &Path) -> Result<ProviderStatus, SyncError> {
        let m = manifest::load(vault, ProviderId::Gdrive)?;
        let connected = m.as_ref().map_or(false, |m| m.is_connected);
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

        // 1. Collect current workspace files
        let workspace_files = collect_workspace_files(vault)?;
        let current_paths: std::collections::HashSet<String> = workspace_files
            .iter()
            .map(|p| {
                p.strip_prefix(vault)
                    .unwrap_or(p)
                    .to_string_lossy()
                    .to_string()
            })
            .collect();

        let mut m = manifest::load(vault, ProviderId::Gdrive)?.unwrap_or_default();

        // Bug 17 fix: read folder ID from remote_label (not last_delta_cursor)
        let root_id = match m.remote_label.clone() {
            Some(id) => id,
            None => {
                let vault_name = vault.file_name().unwrap_or_default().to_string_lossy();
                let folder_name = format!("Lattice - {}", vault_name);
                let id = ensure_vault_folder(&http, &token.access_token, &folder_name).await?;
                m.remote_label = Some(id.clone());
                id
            }
        };

        let mut folder_cache = std::collections::HashMap::new();
        let mut count = 0u32;

        // Bug 16 fix: delete remote files that no longer exist locally.
        // We compare the keys in file_map (remote files we know about)
        // against the current workspace paths.  Any key present in the
        // manifest but absent from the current vault has been deleted or
        // renamed locally and must be removed from Drive.
        let remote_keys: Vec<String> = m.file_map.keys().cloned().collect();
        let mut deleted = 0u32;
        for path_str in &remote_keys {
            if !current_paths.contains(path_str) {
                if let Some(meta) = m.file_map.get(path_str) {
                    // Best-effort delete — if the remote file is already
                    // gone (e.g. manual Drive cleanup) we skip gracefully.
                    if let Err(e) = delete_remote_file(
                        &http,
                        &token.access_token,
                        &meta.id,
                    ).await {
                        eprintln!("lattice: gdrive delete {} failed: {e}", path_str);
                    } else {
                        deleted += 1;
                    }
                }
                m.file_map.remove(path_str);
            }
        }

        // 2. Upload new/changed files
        for abs_path in &workspace_files {
            let rel_path = abs_path.strip_prefix(vault).unwrap_or(abs_path);
            let path_str = rel_path.to_string_lossy().to_string();
            
            let bytes = match fs::read(abs_path) {
                Ok(b) => b,
                Err(_) => continue,
            };
            
            let hash = blake3::hash(&bytes).to_hex().to_string();
            
            let meta = m.file_map.get(&path_str);
            if let Some(existing) = meta {
                if existing.hash == hash {
                    continue; // Skip unchanged files
                }
            }
            
            let parent_dir = rel_path.parent().unwrap_or_else(|| std::path::Path::new(""));
            let parent_id = ensure_nested_folder(&http, &token.access_token, &root_id, parent_dir, &mut folder_cache).await?;
            
            let file_name = rel_path.file_name().unwrap_or_default().to_string_lossy();
            let mime = if file_name.ends_with(".md") {
                "text/markdown"
            } else if file_name.ends_with(".json") {
                "application/json"
            } else if file_name.ends_with(".txt") {
                "text/plain"
            } else {
                "application/octet-stream"
            };

            let existing_id = meta.map(|m| m.id.as_str());
            
            let new_id = upsert_file(
                &http,
                &token.access_token,
                &parent_id,
                &file_name,
                mime,
                bytes,
                existing_id,
            ).await?;
            
            m.file_map.insert(path_str, crate::sync::manifest::RemoteFileMeta {
                id: new_id,
                hash,
            });
            count += 1;
        }

        // Bug 17 fix: do NOT write root_id into last_delta_cursor here.
        // last_delta_cursor is reserved for the Drive delta-sync pagination
        // token (startPageToken).  The folder ID lives in remote_label.
        m.last_sync_at = Some(now_unix());
        manifest::save(vault, ProviderId::Gdrive, &m)?;

        Ok(PushResult {
            uploaded_objects: count,
            head: None,
            branch: current_branch(vault).ok(),
            message: format!("Uploaded {count} file(s), deleted {deleted} from Google Drive"),
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

/// Delete a remote file by its Drive file ID.
/// Returns Ok(()) when the file is already absent (404 is success for delete).
async fn delete_remote_file(
    http: &reqwest::Client,
    access_token: &str,
    file_id: &str,
) -> Result<(), SyncError> {
    let url = format!("{FILES_API}/{file_id}");
    let resp = http
        .delete(&url)
        .bearer_auth(access_token)
        .send()
        .await?;
    // 204 = deleted, 404 = already gone — both are acceptable outcomes.
    if resp.status() == 204 || resp.status() == 404 {
        return Ok(());
    }
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    Err(SyncError::Api(format!(
        "DELETE /drive/v3/files/{file_id} failed ({status}): {body}"
    )))
}

#[derive(Debug, Serialize, Deserialize)]
#[allow(dead_code)] // TODO: wire into delta-sync
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

#[derive(Deserialize)]
struct FileListResponse {
    files: Vec<DriveFile>,
}

#[derive(Deserialize)]
struct DriveFile {
    id: String,
}

async fn ensure_vault_folder(
    http: &reqwest::Client,
    token: &str,
    folder_name: &str,
) -> Result<String, SyncError> {
    // 1. Search for existing folder
    let q = format!("name='{folder_name}' and mimeType='application/vnd.google-apps.folder' and trashed=false");
    let resp = http
        .get(FILES_API)
        .bearer_auth(token)
        .query(&[("q", &q), ("spaces", &"drive".to_string())])
        .send()
        .await?;
    
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(SyncError::Api(format!("search folder returned {status}: {body}")));
    }
    
    let list: FileListResponse = resp.json().await?;
    if let Some(file) = list.files.first() {
        return Ok(file.id.clone());
    }

    // 2. Create folder if not found
    let metadata = serde_json::json!({
        "name": folder_name,
        "mimeType": "application/vnd.google-apps.folder"
    });
    
    let resp = http
        .post(FILES_API)
        .bearer_auth(token)
        .json(&metadata)
        .send()
        .await?;
        
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(SyncError::Api(format!("create folder returned {status}: {body}")));
    }
    
    let created: DriveFile = resp.json().await?;
    Ok(created.id)
}

async fn ensure_nested_folder(
    http: &reqwest::Client,
    token: &str,
    root_id: &str,
    rel_path: &Path,
    folder_cache: &mut std::collections::HashMap<PathBuf, String>,
) -> Result<String, SyncError> {
    let mut current_id = root_id.to_string();
    let mut current_path = PathBuf::new();
    
    for component in rel_path.components() {
        if let std::path::Component::Normal(name) = component {
            current_path.push(name);
            if let Some(cached_id) = folder_cache.get(&current_path) {
                current_id = cached_id.clone();
                continue;
            }
            
            let folder_name = name.to_string_lossy();
            let q = format!("name='{folder_name}' and '{current_id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false");
            
            let resp = http
                .get(FILES_API)
                .bearer_auth(token)
                .query(&[("q", &q), ("spaces", &"drive".to_string())])
                .send()
                .await?;
                
            let mut found_id = None;
            if resp.status().is_success() {
                let list: FileListResponse = resp.json().await?;
                if let Some(file) = list.files.first() {
                    found_id = Some(file.id.clone());
                }
            }
            
            if let Some(id) = found_id {
                current_id = id;
            } else {
                let metadata = serde_json::json!({
                    "name": folder_name,
                    "parents": [current_id],
                    "mimeType": "application/vnd.google-apps.folder"
                });
                
                let resp = http
                    .post(FILES_API)
                    .bearer_auth(token)
                    .json(&metadata)
                    .send()
                    .await?;
                    
                if !resp.status().is_success() {
                    let status = resp.status();
                    let err_body = resp.text().await.unwrap_or_default();
                    return Err(SyncError::Api(format!("create nested folder returned {status}: {err_body}")));
                }
                
                let created: DriveFile = resp.json().await?;
                current_id = created.id;
            }
            
            folder_cache.insert(current_path.clone(), current_id.clone());
        }
    }
    
    Ok(current_id)
}

/// Multipart upload to `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`.
/// Handles both POST (create) and PATCH (update) if `existing_id` is provided.
async fn upsert_file(
    http: &reqwest::Client,
    token: &str,
    parent_id: &str,
    name: &str,
    mime: &str,
    body: Vec<u8>,
    existing_id: Option<&str>,
) -> Result<String, SyncError> {
    let metadata = if existing_id.is_some() {
        serde_json::json!({ "name": name })
    } else {
        serde_json::json!({ "name": name, "parents": [parent_id] })
    };
    let part_meta = reqwest::multipart::Part::text(metadata.to_string())
        .mime_str("application/json; charset=UTF-8")
        .map_err(|e| SyncError::Net(e.to_string()))?;
    let part_body = reqwest::multipart::Part::bytes(body)
        .mime_str(mime)
        .map_err(|e| SyncError::Net(e.to_string()))?;
    let form = reqwest::multipart::Form::new()
        .part("metadata", part_meta)
        .part("file", part_body);

    let (url, method) = match existing_id {
        Some(id) => (format!("{UPLOAD_API}/{id}?uploadType=multipart"), reqwest::Method::PATCH),
        None => (format!("{UPLOAD_API}?uploadType=multipart"), reqwest::Method::POST),
    };

    let resp = http
        .request(method, url)
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(SyncError::Api(format!(
            "upsert {name} returned {status}: {body}"
        )));
    }
    
    let created: DriveFile = resp.json().await?;
    Ok(created.id)
}

fn collect_workspace_files(vault: &Path) -> Result<Vec<PathBuf>, SyncError> {
    let mut out = Vec::new();
    for entry in WalkDir::new(vault).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if path.components().any(|c| {
            matches!(c.as_os_str().to_str(), Some(".git") | Some(".lattice") | Some(".DS_Store"))
        }) {
            continue;
        }
        out.push(path.to_path_buf());
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

#[allow(dead_code)] // TODO: wire into delta-sync
fn head_sha(vault: &Path) -> Result<String, SyncError> {
    let out = git(vault, &["rev-parse", "HEAD"])?;
    if !out.status.success() {
        return Err(SyncError::Git("no HEAD".into()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn git(vault: &Path, args: &[&str]) -> Result<std::process::Output, SyncError> {
    use std::process::{Command, Stdio};
    use std::time::Duration;
    use wait_timeout::ChildExt;
    #[cfg(windows)]
    use std::os::windows::process::CommandExt;
    #[cfg(windows)]
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    const GIT_TIMEOUT: Duration = Duration::from_secs(30);

    let mut cmd = Command::new("git");
    cmd.current_dir(vault)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd.spawn()
        .map_err(|e| SyncError::Git(format!("git spawn failed: {e}")))?;

    match child.wait_timeout(GIT_TIMEOUT) {
        Ok(Some(status)) => {
            let stdout = child.stdout.take().map_or_else(Vec::new, |mut r| {
                let mut buf = Vec::new();
                std::io::Read::read_to_end(&mut r, &mut buf).ok();
                buf
            });
            let stderr = child.stderr.take().map_or_else(Vec::new, |mut r| {
                let mut buf = Vec::new();
                std::io::Read::read_to_end(&mut r, &mut buf).ok();
                buf
            });
            Ok(std::process::Output { status, stdout, stderr })
        }
        Ok(None) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(SyncError::Git(format!(
                "git {} timed out after {}s",
                args.join(" "),
                GIT_TIMEOUT.as_secs()
            )))
        }
        Err(e) => {
            let _ = child.kill();
            Err(SyncError::Git(format!("git wait failed: {e}")))
        }
    }
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
    fn collect_workspace_files_skips_git_and_lattice() {
        let dir = TempDir::new().unwrap();
        let vault = dir.path();
        fs::write(vault.join("hello.md"), b"obj1").unwrap();
        fs::create_dir_all(vault.join(".git")).unwrap();
        fs::write(vault.join(".git").join("config"), b"skip").unwrap();
        fs::create_dir_all(vault.join(".lattice")).unwrap();
        fs::write(vault.join(".lattice").join("config"), b"skip").unwrap();
        let got = collect_workspace_files(&vault).unwrap();
        assert_eq!(got.len(), 1, "should only pick up hello.md");
    }
}
