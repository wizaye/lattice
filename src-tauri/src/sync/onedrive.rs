//! OneDrive sync adapter (Microsoft Graph, AppFolder scope).
//!
//! Auth: OAuth 2.0 Authorization Code + PKCE on a loopback redirect.
//! Storage scope: the per-app special folder `/drive/special/approot`
//! reached via `Files.ReadWrite.AppFolder` — Lattice never touches the
//! user's personal files outside its own sandbox.
//!
//! NOTE: iCloud not supported (no public Windows SDK).
//!
//! ADJUST to match SyncProvider trait signatures — if upstream changes
//! the trait surface, mirror the new shape here.  Today the trait
//! exposes: id, display_name, configured, supports_pull,
//! has_browsable_remote, connect, disconnect, status, push, pull.
//! The push/pull legs are built on private helpers named after the
//! REST verbs they perform: list_remote, upload, download,
//! delete_remote.

use std::path::{Path, PathBuf};
use std::time::Duration;

use async_trait::async_trait;
use reqwest::header::{AUTHORIZATION, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE};
use reqwest::{Method, StatusCode};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tokio::time::timeout;

use super::error::SyncError;
use super::keychain::{self, TokenSet};
use super::oauth::{loopback_listen, random_state, random_verifier, s256_challenge};
use super::{AccountInfo, ProviderId, ProviderStatus, PullResult, PushResult, SyncProvider};

// ── constants ──────────────────────────────────────────────────────

const AUTHORIZE_URL: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN_URL: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH_APPROOT: &str = "https://graph.microsoft.com/v1.0/drive/special/approot";
const SCOPES: &str = "Files.ReadWrite.AppFolder offline_access";

/// Graph guidance: switch to upload sessions above ~4 MiB.
const SIMPLE_UPLOAD_LIMIT: usize = 4 * 1024 * 1024;
/// Graph requires chunk sizes that are a multiple of 320 KiB.
/// We pick 32 × 320 KiB = 10 MiB, well under the 60 MiB ceiling.
const CHUNK_BASE: usize = 320 * 1024;
const CHUNK_MULTIPLE: usize = 32;
const CHUNK_SIZE: usize = CHUNK_BASE * CHUNK_MULTIPLE;

const OAUTH_TIMEOUT: Duration = Duration::from_secs(5 * 60);

// ── token + keychain plumbing ──────────────────────────────────────

/// Stored token bundle.  `access_token` is short-lived (≈1 h),
/// `refresh_token` is long-lived (≈90 d) and is what we use to
/// transparently recover from a 401.
#[derive(Clone)]
struct Tokens {
    access: String,
    refresh: String,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    #[allow(dead_code)]
    expires_in: Option<u64>,
    #[allow(dead_code)]
    token_type: Option<String>,
}

#[derive(Debug, Serialize)]
struct UploadSessionReq {
    item: UploadSessionItem,
}

#[derive(Debug, Serialize)]
struct UploadSessionItem {
    #[serde(rename = "@microsoft.graph.conflictBehavior")]
    conflict_behavior: &'static str,
}

#[derive(Debug, Deserialize)]
struct UploadSessionResp {
    #[serde(rename = "uploadUrl")]
    upload_url: String,
}

#[derive(Debug, Deserialize)]
struct DriveItemChildren {
    value: Vec<DriveItem>,
    #[serde(rename = "@odata.nextLink")]
    next_link: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
struct DriveItem {
    #[allow(dead_code)]
    id: String,
    name: String,
    #[serde(default)]
    size: u64,
    #[serde(rename = "eTag", default)]
    etag: Option<String>,
}

// ── provider ───────────────────────────────────────────────────────

pub struct OneDriveProvider {
    /// Azure AD application (client) id.  Public client — no secret.
    client_id: String,
    http: reqwest::Client,
    // Token state lives in the keychain module already in this crate;
    // see `tokens_load` / `tokens_save` below.
}

impl OneDriveProvider {
    pub fn new(client_id: String) -> Self {
        let http = reqwest::Client::builder()
            .user_agent("Lattice/OneDriveAdapter")
            .build()
            .expect("reqwest client build");
        Self { client_id, http }
    }

    // ── keychain shims ────────────────────────────────────────────
    //
    // The crate already exposes a `keychain` module with per-provider
    // token helpers.  We delegate so we never serialise raw secrets
    // through any other code path.  If the helper names differ in this
    // workspace, adjust the two call sites below.

    fn tokens_load(&self, vault: &Path) -> Result<Tokens, SyncError> {
        let bundle = keychain::load(vault, ProviderId::Onedrive)
            .map_err(|e| SyncError::Oauth(format!("keychain read failed: {e}")))?
            .ok_or_else(|| SyncError::Oauth("OneDrive not connected for this vault".into()))?;
        let refresh = bundle.refresh_token.ok_or_else(|| {
            SyncError::Oauth("stored OneDrive token has no refresh_token".into())
        })?;
        Ok(Tokens {
            access: bundle.access_token,
            refresh,
        })
    }

    fn tokens_save(&self, vault: &Path, t: &Tokens) -> Result<(), SyncError> {
        keychain::store(
            vault,
            ProviderId::Onedrive,
            &TokenSet {
                access_token: t.access.clone(),
                refresh_token: Some(t.refresh.clone()),
                expires_at: None,
                scope: SCOPES.to_string(),
                token_type: "Bearer".to_string(),
            },
        )
        .map_err(|e| SyncError::Oauth(format!("keychain write failed: {e}")))
    }

    fn tokens_clear(&self, vault: &Path) -> Result<(), SyncError> {
        keychain::delete(vault, ProviderId::Onedrive)
            .map_err(|e| SyncError::Oauth(format!("keychain clear failed: {e}")))
    }

    // ── OAuth ─────────────────────────────────────────────────────

    async fn exchange_code(
        &self,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
    ) -> Result<Tokens, SyncError> {
        let form = [
            ("client_id", self.client_id.as_str()),
            ("grant_type", "authorization_code"),
            ("code", code),
            ("code_verifier", verifier),
            ("redirect_uri", redirect_uri),
            ("scope", SCOPES),
        ];
        let resp = self
            .http
            .post(TOKEN_URL)
            .form(&form)
            .send()
            .await
            .map_err(|e| SyncError::Oauth(format!("token request failed: {e}")))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(SyncError::Oauth(format!(
                "token endpoint returned {status}: {body}"
            )));
        }
        let tr: TokenResponse = resp
            .json()
            .await
            .map_err(|e| SyncError::Oauth(format!("token parse: {e}")))?;
        let refresh = tr.refresh_token.ok_or_else(|| {
            SyncError::Oauth("token response missing refresh_token — check offline_access scope".into())
        })?;
        Ok(Tokens {
            access: tr.access_token,
            refresh,
        })
    }

    async fn refresh(&self, current: &Tokens) -> Result<Tokens, SyncError> {
        let form = [
            ("client_id", self.client_id.as_str()),
            ("grant_type", "refresh_token"),
            ("refresh_token", current.refresh.as_str()),
            ("scope", SCOPES),
        ];
        let resp = self
            .http
            .post(TOKEN_URL)
            .form(&form)
            .send()
            .await
            .map_err(|e| SyncError::Oauth(format!("refresh request failed: {e}")))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(SyncError::Oauth(format!(
                "refresh endpoint returned {status}: {body}"
            )));
        }
        let tr: TokenResponse = resp
            .json()
            .await
            .map_err(|e| SyncError::Oauth(format!("refresh parse: {e}")))?;
        // Some IdPs rotate refresh tokens, some don't.  Keep the old
        // one if a new one wasn't issued.
        let refresh = tr
            .refresh_token
            .unwrap_or_else(|| current.refresh.clone());
        Ok(Tokens {
            access: tr.access_token,
            refresh,
        })
    }

    /// Single retry-on-401 wrapper.  Builds the request via the
    /// supplied closure, runs it, and if Graph says the token is dead
    /// refreshes it once and replays.  Returns the final response.
    async fn send_with_refresh<F>(
        &self,
        vault: &Path,
        build: F,
    ) -> Result<reqwest::Response, SyncError>
    where
        F: Fn(&reqwest::Client, &str) -> reqwest::RequestBuilder,
    {
        let mut tokens = self.tokens_load(vault)?;
        let first = build(&self.http, tokens.access.as_str())
            .send()
            .await
            .map_err(|e| SyncError::Oauth(format!("graph request failed: {e}")))?;
        if first.status() != StatusCode::UNAUTHORIZED {
            return Ok(first);
        }
        // Drop the body so the connection can be reused, then refresh.
        drop(first);
        tokens = self.refresh(&tokens).await?;
        self.tokens_save(vault, &tokens)?;
        let retry = build(&self.http, tokens.access.as_str())
            .send()
            .await
            .map_err(|e| SyncError::Oauth(format!("graph retry failed: {e}")))?;
        Ok(retry)
    }

    // ── Graph REST helpers (used by push/pull) ────────────────────

    /// `GET /drive/special/approot/children` — paginated.
    async fn list_remote(&self, vault: &Path) -> Result<Vec<DriveItem>, SyncError> {
        let mut out = Vec::new();
        let mut url = format!("{GRAPH_APPROOT}/children");
        loop {
            let next = url.clone();
            let resp = self
                .send_with_refresh(vault, |c, tok| {
                    c.request(Method::GET, &next)
                        .header(AUTHORIZATION, format!("Bearer {tok}"))
                })
                .await?;
            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err(SyncError::Oauth(format!("list_remote {status}: {body}")));
            }
            let page: DriveItemChildren = resp
                .json()
                .await
                .map_err(|e| SyncError::Oauth(format!("list_remote parse: {e}")))?;
            out.extend(page.value);
            match page.next_link {
                Some(n) => url = n,
                None => break,
            }
        }
        Ok(out)
    }

    /// Upload a single file under the AppFolder.  Picks simple PUT or
    /// resumable upload session based on size.
    async fn upload(
        &self,
        vault: &Path,
        remote_path: &str,
        bytes: Vec<u8>,
    ) -> Result<DriveItem, SyncError> {
        if bytes.len() <= SIMPLE_UPLOAD_LIMIT {
            let encoded = url_path_segment(remote_path);
            let url = format!("{GRAPH_APPROOT}:/{encoded}:/content");
            let body = bytes;
            let resp = self
                .send_with_refresh(vault, |c, tok| {
                    c.request(Method::PUT, &url)
                        .header(AUTHORIZATION, format!("Bearer {tok}"))
                        .header(CONTENT_TYPE, "application/octet-stream")
                        .body(body.clone())
                })
                .await?;
            if !resp.status().is_success() {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                return Err(SyncError::Oauth(format!("upload {status}: {text}")));
            }
            return resp
                .json()
                .await
                .map_err(|e| SyncError::Oauth(format!("upload parse: {e}")));
        }
        self.upload_resumable(vault, remote_path, bytes).await
    }

    async fn upload_resumable(
        &self,
        vault: &Path,
        remote_path: &str,
        bytes: Vec<u8>,
    ) -> Result<DriveItem, SyncError> {
        let encoded = url_path_segment(remote_path);
        let create_url = format!("{GRAPH_APPROOT}:/{encoded}:/createUploadSession");
        let session_req = UploadSessionReq {
            item: UploadSessionItem {
                conflict_behavior: "replace",
            },
        };
        let resp = self
            .send_with_refresh(vault, |c, tok| {
                c.request(Method::POST, &create_url)
                    .header(AUTHORIZATION, format!("Bearer {tok}"))
                    .json(&session_req)
            })
            .await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(SyncError::Oauth(format!(
                "createUploadSession {status}: {body}"
            )));
        }
        let session: UploadSessionResp = resp
            .json()
            .await
            .map_err(|e| SyncError::Oauth(format!("session parse: {e}")))?;

        // Chunk uploads against the pre-authenticated session URL —
        // these must NOT carry the bearer token (the URL itself is
        // the credential and Graph rejects requests that include it).
        let total = bytes.len();
        let mut start = 0usize;
        let mut last_resp: Option<reqwest::Response> = None;
        while start < total {
            let end = (start + CHUNK_SIZE).min(total);
            let chunk = bytes[start..end].to_vec();
            let range = format!("bytes {start}-{}/{total}", end - 1);
            let chunk_len = chunk.len();
            let resp = self
                .http
                .put(&session.upload_url)
                .header(CONTENT_LENGTH, chunk_len)
                .header(CONTENT_RANGE, &range)
                .body(chunk)
                .send()
                .await
                .map_err(|e| SyncError::Oauth(format!("chunk PUT failed: {e}")))?;
            if !(resp.status().is_success()
                || resp.status() == StatusCode::ACCEPTED
                || resp.status() == StatusCode::CREATED)
            {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err(SyncError::Oauth(format!("chunk {status}: {body}")));
            }
            start = end;
            last_resp = Some(resp);
        }
        // The final chunk's response carries the completed DriveItem.
        let final_resp = last_resp.ok_or_else(|| SyncError::Oauth("empty upload".into()))?;
        final_resp
            .json()
            .await
            .map_err(|e| SyncError::Oauth(format!("final parse: {e}")))
    }

    /// `GET /drive/special/approot:/{path}:/content`
    async fn download(&self, vault: &Path, remote_path: &str) -> Result<Vec<u8>, SyncError> {
        let encoded = url_path_segment(remote_path);
        let url = format!("{GRAPH_APPROOT}:/{encoded}:/content");
        let resp = self
            .send_with_refresh(vault, |c, tok| {
                c.request(Method::GET, &url)
                    .header(AUTHORIZATION, format!("Bearer {tok}"))
            })
            .await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(SyncError::Oauth(format!("download {status}: {body}")));
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| SyncError::Oauth(format!("download read: {e}")))?;
        Ok(bytes.to_vec())
    }

    /// `DELETE /drive/special/approot:/{path}:`
    #[allow(dead_code)]
    async fn delete_remote(&self, vault: &Path, remote_path: &str) -> Result<(), SyncError> {
        let encoded = url_path_segment(remote_path);
        let url = format!("{GRAPH_APPROOT}:/{encoded}:");
        let resp = self
            .send_with_refresh(vault, |c, tok| {
                c.request(Method::DELETE, &url)
                    .header(AUTHORIZATION, format!("Bearer {tok}"))
            })
            .await?;
        if !(resp.status().is_success() || resp.status() == StatusCode::NO_CONTENT) {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(SyncError::Oauth(format!("delete {status}: {body}")));
        }
        Ok(())
    }
}

// ── SyncProvider impl ──────────────────────────────────────────────

#[async_trait]
impl SyncProvider for OneDriveProvider {
    fn id(&self) -> ProviderId {
        // ADJUST if ProviderId variant is spelled differently in this crate.
        ProviderId::Onedrive
    }

    fn display_name(&self) -> &'static str {
        "OneDrive"
    }

    fn configured(&self) -> bool {
        !self.client_id.is_empty()
    }

    fn supports_pull(&self) -> bool {
        true
    }

    fn has_browsable_remote(&self) -> bool {
        // AppFolder is not meaningfully browsable in a normal browser.
        false
    }

    async fn connect(&self, _app: AppHandle, vault: &Path) -> Result<AccountInfo, SyncError> {
        if !self.configured() {
            return Err(SyncError::Oauth("OneDrive client_id not configured".into()));
        }

        // 1) Spin up the loopback callback receiver first so we know
        //    the port before we build the authorize URL.
        let (port, rx) = loopback_listen(OAUTH_TIMEOUT).await?;
        let redirect_uri = format!("http://127.0.0.1:{port}/");

        // 2) PKCE pair + CSRF nonce.
        let verifier = random_verifier();
        let challenge = s256_challenge(&verifier);
        let state = random_state();

        // 3) Build the authorize URL and open it in the system browser.
        let authorize = format!(
            "{AUTHORIZE_URL}?client_id={cid}&response_type=code&redirect_uri={ru}\
             &response_mode=query&scope={sc}&code_challenge={cc}&code_challenge_method=S256\
             &state={st}&prompt=select_account",
            cid = urlencoding::encode(&self.client_id),
            ru = urlencoding::encode(&redirect_uri),
            sc = urlencoding::encode(SCOPES),
            cc = urlencoding::encode(&challenge),
            st = urlencoding::encode(&state),
        );
        if let Err(e) = tauri_plugin_opener::open_url(&authorize, None::<String>) {
            return Err(SyncError::Oauth(format!("failed to open browser: {e}")));
        }

        // 4) Await the callback (loopback_listen owns its own timeout
        //    but we wrap defensively).
        let cb = timeout(OAUTH_TIMEOUT, rx)
            .await
            .map_err(|_| SyncError::Oauth("OAuth timed out".into()))?
            .map_err(|_| SyncError::Oauth("loopback channel dropped".into()))??;
        if cb.state != state {
            return Err(SyncError::Oauth("state mismatch — possible CSRF".into()));
        }

        // 5) Trade the code for tokens, persist, return summary.
        let tokens = self.exchange_code(&cb.code, &verifier, &redirect_uri).await?;
        self.tokens_save(vault, &tokens)?;

        Ok(AccountInfo {
            display_name: "OneDrive (AppFolder)".to_string(),
            account_email: None,
            remote_label: Some("OneDrive AppFolder".to_string()),
        })
    }

    async fn disconnect(&self, vault: &Path) -> Result<(), SyncError> {
        // Best-effort: clearing the keychain is the source of truth.
        // We deliberately do NOT call the Graph revocation endpoint —
        // Microsoft Identity only exposes that for confidential clients.
        self.tokens_clear(vault)
    }

    async fn status(&self, vault: &Path) -> Result<ProviderStatus, SyncError> {
        // Cheap probe — just look for tokens.  Validity is proven the
        // next time push/pull hits Graph and either succeeds or 401s.
        match self.tokens_load(vault) {
            Ok(_) => Ok(ProviderStatus {
                connected: true,
                account_label: Some("OneDrive".to_string()),
                remote_label: Some("OneDrive AppFolder".to_string()),
                last_sync_at: None,
                last_error: None,
            }),
            Err(_) => Ok(ProviderStatus {
                connected: false,
                account_label: None,
                remote_label: None,
                last_sync_at: None,
                last_error: None,
            }),
        }
    }

    async fn push(&self, vault: &Path) -> Result<PushResult, SyncError> {
        // The framing here is intentionally minimal: walk the vault,
        // upload each file under its relative path, count successes.
        // The cross-provider merge/conflict story lives in `mod.rs`
        // and the git layer — this adapter is just a dumb pipe.
        let mut uploaded = 0u32;
        let files = walk_vault(vault)?;
        for (rel, bytes) in files {
            self.upload(vault, &rel, bytes).await?;
            uploaded += 1;
        }
        Ok(PushResult {
            uploaded_objects: uploaded,
            head: None,
            branch: None,
            message: format!("uploaded {uploaded} object(s) to OneDrive AppFolder"),
        })
    }

    async fn pull(&self, vault: &Path) -> Result<PullResult, SyncError> {
        let items = self.list_remote(vault).await?;
        let mut downloaded = 0u32;
        for item in items {
            let bytes = self.download(vault, &item.name).await?;
            let dest = vault.join(&item.name);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    SyncError::Oauth(format!("mkdir {}: {e}", parent.display()))
                })?;
            }
            std::fs::write(&dest, &bytes)
                .map_err(|e| SyncError::Oauth(format!("write {}: {e}", dest.display())))?;
            // size/etag are informational only; consumed by mod.rs if
            // it wants to short-circuit no-op writes in future.
            let _ = item.size;
            let _ = item.etag;
            downloaded += 1;
        }
        Ok(PullResult {
            downloaded_objects: downloaded,
            head: None,
            branch: None,
            conflicts: Vec::new(),
            message: format!("downloaded {downloaded} object(s) from OneDrive AppFolder"),
        })
    }
}

// ── small free helpers ─────────────────────────────────────────────

/// Encode a remote path so it's safe inside a Graph URL.  We percent-
/// encode each segment but keep the `/` separators intact so callers
/// can pass nested paths like `notes/2026/jun.md`.
fn url_path_segment(path: &str) -> String {
    path.split('/')
        .map(|s| urlencoding::encode(s).into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

/// Walk the vault and return `(relative_path, bytes)` for every file.
/// Skips dotfiles/dotdirs (e.g. `.git`) to avoid round-tripping VCS
/// metadata through the cloud.
fn walk_vault(vault: &Path) -> Result<Vec<(String, Vec<u8>)>, SyncError> {
    let mut out = Vec::new();
    let mut stack: Vec<PathBuf> = vec![vault.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir)
            .map_err(|e| SyncError::Oauth(format!("readdir {}: {e}", dir.display())))?;
        for entry in entries {
            let entry = entry
                .map_err(|e| SyncError::Oauth(format!("dirent {}: {e}", dir.display())))?;
            let name = entry.file_name();
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
            let path = entry.path();
            let ft = entry
                .file_type()
                .map_err(|e| SyncError::Oauth(format!("file_type {}: {e}", path.display())))?;
            if ft.is_dir() {
                stack.push(path);
            } else if ft.is_file() {
                let rel = path
                    .strip_prefix(vault)
                    .map_err(|e| SyncError::Oauth(format!("strip_prefix: {e}")))?
                    .to_string_lossy()
                    .replace('\\', "/");
                let bytes = std::fs::read(&path)
                    .map_err(|e| SyncError::Oauth(format!("read {}: {e}", path.display())))?;
                out.push((rel, bytes));
            }
        }
    }
    Ok(out)
}
