//! GitHub adapter — OAuth Device Flow + push/pull via system git.
//!
//! Auth: Device Code Flow (NOT PKCE).  Rationale:
//!   - OAuth Apps need a client secret to exchange the auth code for
//!     a token.  We can't safely embed a secret in a desktop binary.
//!   - GitHub Apps support PKCE but Apps install per-repo, which
//!     forces an extra mid-flow "pick a repo" step that's UX-heavy
//!     for "just sync my notes".
//!   - Device Flow uses NO secret + works for OAuth Apps + nicely
//!     showcases "Lattice has no server" because we tell the user
//!     the verification URL and code directly.
//!
//! Push/pull: shell out to system `git`.  We pass the token via env
//! var `GIT_CONFIG_KEY_0=http.https://github.com/.extraheader` so
//! the token never appears on the process command line (which `ps`
//! exposes to every other user on multi-tenant systems).

use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::time::Duration;

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use wait_timeout::ChildExt;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Timeout for network-bound git subprocesses (push, fetch).
const GIT_NET_TIMEOUT: Duration = Duration::from_secs(60);

use super::clients::GITHUB_CLIENT_ID;
use super::error::SyncError;
use super::keychain::{self, TokenSet};
use super::manifest::{self, now_unix};
use super::{AccountInfo, ProviderId, ProviderStatus, PullResult, PushResult, SyncProvider};

const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const USER_URL: &str = "https://api.github.com/user";
const REPOS_URL: &str = "https://api.github.com/user/repos";
const SCOPES: &str = "repo read:user";
const USER_AGENT: &str = "lattice-byoc/0.1";

pub struct GithubProvider;

impl GithubProvider {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl SyncProvider for GithubProvider {
    fn id(&self) -> ProviderId {
        ProviderId::Github
    }

    fn display_name(&self) -> &'static str {
        "GitHub"
    }

    fn configured(&self) -> bool {
        GITHUB_CLIENT_ID.is_some()
    }

    async fn connect(&self, app: AppHandle, vault: &Path) -> Result<AccountInfo, SyncError> {
        let client_id = GITHUB_CLIENT_ID.ok_or_else(|| {
            SyncError::Oauth(
                "GitHub client id missing — set LATTICE_GITHUB_CLIENT_ID at build time".into(),
            )
        })?;
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(Duration::from_secs(30))
            .build()?;

        // Step 1: request a device + user code.
        let device = request_device_code(&http, client_id).await?;

        // Step 2: tell the frontend so it can show the verification
        // URL + user code modal.  Frontend listens for `byoc://device-code`.
        let payload = DeviceCodePayload {
            user_code: device.user_code.clone(),
            verification_uri: device.verification_uri.clone(),
            expires_in: device.expires_in,
            interval: device.interval,
        };
        let _ = app.emit("byoc://device-code", &payload);

        // Best-effort: open the verification URL in the user's browser.
        // (Frontend ALSO offers a Copy button + clickable link so this
        // is just a nicety, not a requirement.)
        if let Err(e) = tauri_plugin_opener::open_url(&device.verification_uri, None::<String>) {
            eprintln!("[byoc/github] could not auto-open browser: {e}");
        }

        // Step 3: poll until success / expiry / user denial.
        let token_set = poll_for_token(&http, client_id, &device).await?;

        // Step 4: fetch user info to label the connection in the UI.
        let user: GithubUser = http
            .get(USER_URL)
            .bearer_auth(&token_set.access_token)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .send()
            .await?
            .error_for_status()
            .map_err(|e| SyncError::Api(format!("GET /user: {e}")))?
            .json()
            .await?;

        // Step 5: ensure a target repo exists (auto-create on first connect).
        let repo_slug = ensure_vault_repo(&http, &token_set.access_token, &user, vault).await?;

        // Step 6: persist token + manifest.
        keychain::store(vault, ProviderId::Github, &token_set)?;
        let mut m = manifest::load(vault, ProviderId::Github)?.unwrap_or_default();
        m.schema = 1;
        m.is_connected = true;
        m.provider = "github".into();
        m.remote_label = Some(repo_slug.clone());
        m.account_label = Some(user.login.clone());
        manifest::save(vault, ProviderId::Github, &m)?;

        Ok(AccountInfo {
            display_name: user.login,
            account_email: user.email,
            remote_label: Some(repo_slug),
        })
    }

    async fn disconnect(&self, vault: &Path) -> Result<(), SyncError> {
        // We DO NOT delete the manifest — preserving `uploaded_objects`
        // and `remote_label` makes "Connect again to the same repo"
        // friction-free.  Only token + last_sync_at get wiped.
        keychain::delete(vault, ProviderId::Github)?;
        if let Some(mut m) = manifest::load(vault, ProviderId::Github)? {
            m.is_connected = false;
            m.last_sync_at = None;
            manifest::save(vault, ProviderId::Github, &m)?;
        }
        Ok(())
    }

    async fn status(&self, vault: &Path) -> Result<ProviderStatus, SyncError> {
        let m = manifest::load(vault, ProviderId::Github)?;
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
        preflight_vault(vault)?;
        let token = require_token(vault)?;
        let mut m = manifest::load(vault, ProviderId::Github)?
            .ok_or_else(|| SyncError::BadInput("no sync manifest — connect first".into()))?;
        // Own the slug up front so we can freely mutate `m` below
        // without the borrow checker complaining — the slug is the
        // one piece of `m` we still need after the mutation.
        let repo_slug = m
            .remote_label
            .clone()
            .ok_or_else(|| SyncError::BadInput("no remote repo configured".into()))?;
        let remote_url = format!("https://github.com/{repo_slug}.git");

        let branch = current_branch(vault)?;
        let refspec = format!("HEAD:refs/heads/{branch}");
        let out = git_with_token(vault, &token.access_token, &["push", &remote_url, &refspec])?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(SyncError::Git(decode_push_error(&stderr, &repo_slug, &branch)));
        }

        let head = head_sha(vault).ok();
        m.local_head = head.clone();
        m.remote_head = head.clone();
        m.last_sync_at = Some(now_unix());
        manifest::save(vault, ProviderId::Github, &m)?;

        Ok(PushResult {
            uploaded_objects: 0, // git's wire protocol doesn't surface a count we can use cheaply
            head,
            branch: Some(branch),
            message: format!("Pushed to {repo_slug}"),
        })
    }

    async fn pull(&self, vault: &Path) -> Result<PullResult, SyncError> {
        preflight_vault(vault)?;
        let token = require_token(vault)?;
        let mut m = manifest::load(vault, ProviderId::Github)?
            .ok_or_else(|| SyncError::BadInput("no sync manifest — connect first".into()))?;
        // Own the slug up front — see push() for the rationale.
        let repo_slug = m
            .remote_label
            .clone()
            .ok_or_else(|| SyncError::BadInput("no remote repo configured".into()))?;
        let remote_url = format!("https://github.com/{repo_slug}.git");

        let branch = current_branch(vault)?;
        let refspec = format!("refs/heads/{branch}:refs/remotes/lattice/{branch}");
        let out = git_with_token(vault, &token.access_token, &["fetch", &remote_url, &refspec])?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            // "couldn't find remote ref" means the branch doesn't exist
            // on the remote yet — totally normal for an empty repo we
            // just created.  Treat as a no-op pull, not an error.
            if stderr.to_lowercase().contains("couldn't find remote ref")
                || stderr.to_lowercase().contains("does not appear to be a git repository")
            {
                let head = head_sha(vault).ok();
                let msg = format!(
                    "{repo_slug} has no `{branch}` branch yet — push first to create it"
                );
                return Ok(PullResult {
                    downloaded_objects: 0,
                    head,
                    branch: Some(branch),
                    conflicts: Vec::new(),
                    message: msg,
                });
            }
            return Err(SyncError::Git(decode_push_error(&stderr, &repo_slug, &branch)));
        }

        // Fast-forward only.  If the local branch has diverged we punt
        // and let the user resolve in their editor — UI for in-app
        // conflict resolution is a later slice.
        let target = format!("refs/remotes/lattice/{branch}");
        let merge = git(vault, &["merge", "--ff-only", &target])?;
        let mut conflicts = Vec::new();
        if !merge.status.success() {
            let stderr = String::from_utf8_lossy(&merge.stderr).trim().to_string();
            conflicts.push(if stderr.is_empty() {
                "remote diverged — fast-forward merge declined".into()
            } else {
                stderr
            });
        }

        let head = head_sha(vault).ok();
        m.remote_head = head.clone();
        if conflicts.is_empty() {
            m.local_head = head.clone();
            m.last_sync_at = Some(now_unix());
        }
        manifest::save(vault, ProviderId::Github, &m)?;

        Ok(PullResult {
            downloaded_objects: 0,
            head,
            branch: Some(branch),
            conflicts: conflicts.clone(),
            message: if conflicts.is_empty() {
                format!("Pulled from {repo_slug}")
            } else {
                format!("Fetched {repo_slug} (merge needs attention)")
            },
        })
    }
}

// ── helpers: Device Code Flow ──────────────────────────────────────

#[derive(Debug, Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DeviceCodePayload {
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Debug, Deserialize)]
struct GithubUser {
    login: String,
    #[serde(default)]
    email: Option<String>,
}

async fn request_device_code(
    http: &reqwest::Client,
    client_id: &str,
) -> Result<DeviceCodeResponse, SyncError> {
    let resp = http
        .post(DEVICE_CODE_URL)
        .header("Accept", "application/json")
        .form(&[("client_id", client_id), ("scope", SCOPES)])
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(SyncError::Oauth(format!(
            "device code request failed ({status}): {body}"
        )));
    }
    Ok(resp.json().await?)
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    token_type: Option<String>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
    /// Set on "still waiting" / "slow_down" / "expired_token" / "access_denied".
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    error_description: Option<String>,
}

async fn poll_for_token(
    http: &reqwest::Client,
    client_id: &str,
    device: &DeviceCodeResponse,
) -> Result<TokenSet, SyncError> {
    let mut interval = Duration::from_secs(device.interval.max(1));
    let deadline = std::time::Instant::now() + Duration::from_secs(device.expires_in);

    loop {
        if std::time::Instant::now() >= deadline {
            return Err(SyncError::Oauth("user code expired".into()));
        }
        tokio::time::sleep(interval).await;

        let resp: TokenResponse = http
            .post(TOKEN_URL)
            .header("Accept", "application/json")
            .form(&[
                ("client_id", client_id),
                ("device_code", &device.device_code),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ])
            .send()
            .await?
            .json()
            .await?;

        if let Some(token) = resp.access_token {
            return Ok(TokenSet {
                access_token: token,
                refresh_token: resp.refresh_token,
                expires_at: resp.expires_in.map(|s| now_unix() + s),
                scope: resp.scope.unwrap_or_default(),
                token_type: resp.token_type.unwrap_or_else(|| "Bearer".into()),
            });
        }
        match resp.error.as_deref() {
            Some("authorization_pending") => continue,
            Some("slow_down") => {
                interval += Duration::from_secs(5);
                continue;
            }
            Some("expired_token") => {
                return Err(SyncError::Oauth("user code expired".into()));
            }
            Some("access_denied") => return Err(SyncError::Cancelled),
            Some(other) => {
                return Err(SyncError::Oauth(format!(
                    "{other}: {}",
                    resp.error_description.unwrap_or_default()
                )));
            }
            None => {
                return Err(SyncError::Oauth(
                    "token endpoint returned neither access_token nor error".into(),
                ));
            }
        }
    }
}

// ── helpers: repo bootstrap ────────────────────────────────────────

#[derive(Debug, Serialize)]
struct CreateRepoBody {
    name: String,
    private: bool,
    description: String,
    auto_init: bool,
}

async fn ensure_vault_repo(
    http: &reqwest::Client,
    token: &str,
    user: &GithubUser,
    vault: &Path,
) -> Result<String, SyncError> {
    let slug = vault_repo_name(vault);
    let owner = &user.login;
    let probe = http
        .get(format!("https://api.github.com/repos/{owner}/{slug}"))
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await?;
    if probe.status().is_success() {
        return Ok(format!("{owner}/{slug}"));
    }
    if probe.status() != reqwest::StatusCode::NOT_FOUND {
        let status = probe.status();
        let body = probe.text().await.unwrap_or_default();
        return Err(SyncError::Api(format!(
            "GET /repos/{owner}/{slug} returned {status}: {body}"
        )));
    }

    let body = CreateRepoBody {
        name: slug.clone(),
        private: true,
        description: "Lattice vault — synced from desktop.".into(),
        auto_init: false,
    };
    let create = http
        .post(REPOS_URL)
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .json(&body)
        .send()
        .await?;
    if !create.status().is_success() {
        let status = create.status();
        let body = create.text().await.unwrap_or_default();
        return Err(SyncError::Api(format!(
            "POST /user/repos returned {status}: {body}"
        )));
    }
    Ok(format!("{owner}/{slug}"))
}

/// Derive a repo name from the vault folder name.  Falls back to
/// "lattice-vault" if the path tail can't be slugified into anything
/// usable.  Length-limit + lowercase + ascii-only.
fn vault_repo_name(vault: &Path) -> String {
    let base = vault
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("lattice-vault");
    let mut slug = String::with_capacity(base.len());
    let mut last_dash = false;
    for ch in base.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash && !slug.is_empty() {
            slug.push('-');
            last_dash = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        slug = "lattice-vault".into();
    }
    if slug.len() > 80 {
        slug.truncate(80);
        while slug.ends_with('-') {
            slug.pop();
        }
    }
    if !slug.starts_with("lattice-") {
        slug = format!("lattice-{slug}");
    }
    slug
}

// ── helpers: git subprocess ────────────────────────────────────────

fn require_token(vault: &Path) -> Result<TokenSet, SyncError> {
    keychain::load(vault, ProviderId::Github)?
        .ok_or_else(|| SyncError::BadInput("github not connected for this vault".into()))
}

/// Sanity-check the vault before we shell out to git.  Bubbles up
/// clearer messages than git's raw "fatal: not a git repository" /
/// "src refspec ... matches no" output.
fn preflight_vault(vault: &Path) -> Result<(), SyncError> {
    if !vault.exists() {
        return Err(SyncError::BadInput(format!(
            "vault folder does not exist: {}",
            vault.display()
        )));
    }
    // Lattice uses `--separate-git-dir=.lattice/git` which creates a
    // `.git` *file* (gitdir pointer), not a `.git` directory.  Accept
    // either shape so the preflight works with both standard and
    // Lattice-managed repos.
    let dot_git = vault.join(".git");
    if !dot_git.exists() {
        return Err(SyncError::BadInput(
            "this vault has no git repository — enable Version Control \
             above before connecting a sync provider"
                .into(),
        ));
    }
    // Empty repos (initialised but no commits yet) fail later inside
    // `current_branch` / `head_sha` with a much less helpful message;
    // catch them here.
    let head = git(vault, &["rev-parse", "--verify", "HEAD"]);
    if let Ok(out) = head {
        if !out.status.success() {
            return Err(SyncError::BadInput(
                "this vault has no commits yet — commit at least one \
                 file before syncing"
                    .into(),
            ));
        }
    }
    Ok(())
}

/// Translate git's terse push stderr into a one-line message that
/// tells the user *what to do next*.  Falls back to the raw stderr
/// when nothing matches — we never want to hide useful diagnostics.
fn decode_push_error(stderr: &str, repo_slug: &str, branch: &str) -> String {
    let s = stderr.to_lowercase();
    if s.contains("403") || s.contains("permission") || s.contains("forbidden") {
        return format!(
            "GitHub refused the push to {repo_slug} (403). The OAuth \
             grant may be missing the `repo` scope — click Disconnect, \
             then Connect again and accept all scopes."
        );
    }
    if s.contains("401") || s.contains("bad credentials") || s.contains("authentication") {
        return format!(
            "GitHub rejected the token for {repo_slug} (401). Click \
             Disconnect and reconnect to mint a fresh device-flow token."
        );
    }
    if s.contains("non-fast-forward") || s.contains("fetch first") || s.contains("updates were rejected") {
        return format!(
            "{repo_slug}/{branch} has commits we don't — click Pull (or \
             Sync) first, then push again."
        );
    }
    if s.contains("src refspec") && s.contains("matches no") {
        return "this vault has no commits to push — commit at least one \
                file in the Changes panel first"
            .into();
    }
    if s.contains("could not resolve host") || s.contains("timed out") || s.contains("network is unreachable") {
        return "GitHub is unreachable — check your network connection \
                and try again"
            .into();
    }
    if stderr.is_empty() {
        format!("git push to {repo_slug} failed (no stderr)")
    } else {
        // Strip the noisy "To https://github.com/..." line if present
        // so the surfaced message is the *cause*, not the URL.
        stderr
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty() && !l.starts_with("To "))
            .unwrap_or(stderr)
            .to_string()
    }
}

fn current_branch(vault: &Path) -> Result<String, SyncError> {
    let out = git(vault, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
    if !out.status.success() {
        return Err(SyncError::Git(
            "vault has no checked-out branch (detached HEAD?) — \
             checkout a branch in the Branches panel and try again"
                .into(),
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn head_sha(vault: &Path) -> Result<String, SyncError> {
    let out = git(vault, &["rev-parse", "HEAD"])?;
    if !out.status.success() {
        return Err(SyncError::Git(
            "vault has no HEAD — commit at least one file before syncing"
                .into(),
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn git(vault: &Path, args: &[&str]) -> Result<Output, SyncError> {
    git_timed(vault, args, GIT_NET_TIMEOUT)
}

fn git_timed(vault: &Path, args: &[&str], timeout: Duration) -> Result<Output, SyncError> {
    let mut cmd = Command::new("git");
    cmd.current_dir(vault)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            SyncError::Git("git is not installed or not on PATH".into())
        } else {
            SyncError::Git(format!("git spawn failed: {e}"))
        }
    })?;

    match child.wait_timeout(timeout) {
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
            Ok(Output { status, stdout, stderr })
        }
        Ok(None) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(SyncError::Git(format!(
                "git {} timed out after {}s",
                args.join(" "),
                timeout.as_secs()
            )))
        }
        Err(e) => {
            let _ = child.kill();
            Err(SyncError::Git(format!("git wait failed: {e}")))
        }
    }
}

/// Run git with an in-memory `http.<host>.extraheader` carrying the
/// bearer token.  Uses `GIT_CONFIG_COUNT` + `GIT_CONFIG_KEY_*` env
/// vars so the token doesn't appear on argv (visible to other users
/// via `ps`) or in `.git/config`.
fn git_with_token(vault: &Path, token: &str, args: &[&str]) -> Result<Output, SyncError> {
    let mut cmd = Command::new("git");
    cmd.current_dir(vault)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .env("GIT_CONFIG_COUNT", "1")
        .env("GIT_CONFIG_KEY_0", "http.https://github.com/.extraheader")
        .env("GIT_CONFIG_VALUE_0", {
            // Git's smart HTTP transport uses Basic auth, NOT Bearer.
            // Bearer works for the REST API but is rejected by the
            // HTTP transport endpoint.  The username is the literal
            // string "x-access-token" (GitHub's convention); the
            // password is the OAuth token.
            let credentials = BASE64.encode(format!("x-access-token:{token}"));
            format!("Authorization: Basic {credentials}")
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            SyncError::Git("git is not installed or not on PATH".into())
        } else {
            SyncError::Git(format!("git spawn failed: {e}"))
        }
    })?;

    match child.wait_timeout(GIT_NET_TIMEOUT) {
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
            Ok(Output { status, stdout, stderr })
        }
        Ok(None) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(SyncError::Git(format!(
                "git {} timed out after {}s",
                args.join(" "),
                GIT_NET_TIMEOUT.as_secs()
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
    use std::path::PathBuf;

    #[test]
    fn slug_basic() {
        assert_eq!(vault_repo_name(&PathBuf::from("/my notes")), "lattice-my-notes");
    }

    #[test]
    fn slug_strips_trailing_dashes() {
        assert_eq!(vault_repo_name(&PathBuf::from("/Foo!!")), "lattice-foo");
    }

    #[test]
    fn slug_fallback() {
        assert_eq!(vault_repo_name(&PathBuf::from("/!@#")), "lattice-vault");
    }

    #[test]
    fn slug_already_prefixed_stays_single_prefix() {
        let slug = vault_repo_name(&PathBuf::from("/lattice-demo"));
        // Should NOT become "lattice-lattice-demo"
        assert_eq!(slug, "lattice-demo");
    }
}
