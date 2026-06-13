//! VCS — system `git` invoked as a subprocess.
//!
//! Every command takes a `vault_path` (the on-disk vault root) and
//! invokes `git` with `current_dir(vault)`.  Git itself handles ref
//! resolution, locks, packfiles, etc. — we only parse output.
//!
//! All Tauri commands are `async` and wrap the synchronous subprocess
//! work in `tokio::task::spawn_blocking` so they never block the
//! Tauri IPC thread pool.  Subprocess calls use `wait-timeout` to
//! kill runaway git processes instead of hanging the app.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::Duration;
use wait_timeout::ChildExt;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Default timeout for most git subprocess calls (status, stage,
/// unstage, commit, log, diff, branches).
const GIT_TIMEOUT: Duration = Duration::from_secs(30);

/// Longer timeout for operations that may be slow on first run
/// (init with `git add -A` on a large vault, push/fetch).
const GIT_TIMEOUT_LONG: Duration = Duration::from_secs(120);

// ─── DTOs ───────────────────────────────────────────────────────────────
// Field names are serialised as camelCase so the React/TS layer sees
// `headShort`, `origPath`, etc.  DO NOT rename without updating the
// frontend types.

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orig_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VcsStatus {
    pub initialized: bool,
    pub branch: Option<String>,
    pub head_short: Option<String>,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub staged: Vec<FileChange>,
    pub unstaged: Vec<FileChange>,
    pub untracked: Vec<FileChange>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub id: String,
    pub short_id: String,
    pub author: String,
    pub timestamp: i64,
    pub summary: String,
    pub body: Option<String>,
    pub parents: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphCommit {
    pub id: String,
    pub short_id: String,
    pub author: String,
    pub timestamp: i64,
    pub summary: String,
    pub body: Option<String>,
    pub parents: Vec<String>,
    pub refs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPresence {
    pub installed: bool,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ahead: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub behind: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tip_short: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tip_summary: Option<String>,
    pub tip_timestamp: i64,
}

// ─── Subprocess core ────────────────────────────────────────────────────

/// Resolve and validate `vault_path`.  Rejects empty paths, missing
/// directories, and the frontend's `"__mock__"` sentinel with a clear
/// error string.
fn vault_dir(vault_path: &str) -> Result<PathBuf, String> {
    if vault_path.is_empty() {
        return Err("vault path is empty".to_string());
    }
    let p = PathBuf::from(vault_path);
    if !p.is_dir() {
        return Err(format!("vault path is not a directory: {}", vault_path));
    }
    Ok(p)
}

/// Run `git <args>` in `vault` and return the raw Output.  Sets the
/// env vars that keep git non-interactive (no credential prompts, no
/// locale weirdness in our parsers) and, on Windows, hides the console
/// window that would otherwise flash for every subprocess.
///
/// Uses `wait-timeout` to kill the child process if it exceeds the
/// deadline — prevents the app from hanging when git's built-in
/// FSMonitor daemon deadlocks (a known macOS issue) or when a network
/// operation stalls.
fn run(vault: &Path, args: &[&str]) -> Result<Output, String> {
    run_with_timeout(vault, args, GIT_TIMEOUT)
}

/// Like `run` but with a caller-specified timeout.
fn run_with_timeout(vault: &Path, args: &[&str], timeout: Duration) -> Result<Output, String> {
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
            "git is not installed or not on PATH.".to_string()
        } else {
            format!("git spawn failed: {} (cwd={})", e, vault.display())
        }
    })?;

    match child.wait_timeout(timeout) {
        Ok(Some(status)) => {
            // Child exited within the timeout — collect stdout/stderr.
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
            // Timed out — kill the child and report.
            let _ = child.kill();
            let _ = child.wait(); // reap zombie
            Err(format!(
                "git {} timed out after {}s (cwd={})",
                args.join(" "),
                timeout.as_secs(),
                vault.display()
            ))
        }
        Err(e) => {
            let _ = child.kill();
            Err(format!("git wait failed: {} (cwd={})", e, vault.display()))
        }
    }
}

/// Run `git <args>`, require success, return stdout bytes.
fn ok_bytes(vault: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let out = run(vault, args)?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            format!("git {} exited {:?}", args.join(" "), out.status.code())
        } else {
            err
        });
    }
    Ok(out.stdout)
}

/// Like `ok_bytes` but with a custom timeout.
fn ok_bytes_with_timeout(vault: &Path, args: &[&str], timeout: Duration) -> Result<Vec<u8>, String> {
    let out = run_with_timeout(vault, args, timeout)?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            format!("git {} exited {:?}", args.join(" "), out.status.code())
        } else {
            err
        });
    }
    Ok(out.stdout)
}

/// Run `git <args>`, require success, return stdout as UTF-8 (lossy).
fn ok_str(vault: &Path, args: &[&str]) -> Result<String, String> {
    Ok(String::from_utf8_lossy(&ok_bytes(vault, args)?).to_string())
}

/// `true` iff `vault` is inside a git repo (worktree or bare).
fn is_repo(vault: &Path) -> bool {
    run(vault, &["rev-parse", "--git-dir"])
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn opt(s: &str) -> Option<String> {
    if s.is_empty() { None } else { Some(s.to_string()) }
}

// ─── Tauri commands ──────────────────────────────────────────────────────

#[tauri::command]
pub async fn git_check_installed() -> Result<GitPresence, String> {
    tokio::task::spawn_blocking(|| {
        let mut cmd = Command::new("git");
        cmd.arg("--version");
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        match cmd.output() {
            Ok(out) if out.status.success() => Ok(GitPresence {
                installed: true,
                version: Some(String::from_utf8_lossy(&out.stdout).trim().to_string()),
            }),
            _ => Ok(GitPresence { installed: false, version: None }),
        }
    })
    .await
    .map_err(|e| format!("task panicked: {e}"))?
}

#[tauri::command]
pub async fn vcs_status(vault_path: String) -> Result<VcsStatus, String> {
    tokio::task::spawn_blocking(move || vcs_status_sync(vault_path))
        .await
        .map_err(|e| format!("task panicked: {e}"))?
}

fn vcs_status_sync(vault_path: String) -> Result<VcsStatus, String> {
    let vault = vault_dir(&vault_path)?;
    if !is_repo(&vault) {
        return Ok(VcsStatus::default());
    }
    let bytes = ok_bytes(
        &vault,
        &["status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z"],
    )?;
    parse_status_v2(&bytes)
}

#[tauri::command]
pub async fn vcs_preview_untracked_count(vault_path: String) -> Result<u32, String> {
    tokio::task::spawn_blocking(move || {
        let vault = vault_dir(&vault_path)?;
        let skip: HashSet<&str> = [
            ".git", ".lattice", ".DS_Store", "Thumbs.db", "node_modules",
        ]
        .into_iter()
        .collect();

        let mut n: u32 = 0;
        for e in walkdir::WalkDir::new(&vault)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| {
                e.file_name()
                    .to_str()
                    .map(|name| !skip.contains(name))
                    .unwrap_or(false)
            })
            .filter_map(|e| e.ok())
        {
            if e.file_type().is_file() {
                n = n.saturating_add(1);
            }
        }
        Ok(n)
    })
    .await
    .map_err(|e| format!("task panicked: {e}"))?
}

#[tauri::command]
pub async fn vcs_init(vault_path: String) -> Result<VcsStatus, String> {
    let vp = vault_path.clone();
    tokio::task::spawn_blocking(move || vcs_init_sync(vp))
        .await
        .map_err(|e| format!("task panicked: {e}"))?
}

fn vcs_init_sync(vault_path: String) -> Result<VcsStatus, String> {
    let vault = vault_dir(&vault_path)?;

    // Keep git metadata under .lattice/ so it doesn't clutter the
    // vault root file tree (the Lattice convention).
    std::fs::create_dir_all(vault.join(".lattice"))
        .map_err(|e| format!("create .lattice/: {}", e))?;

    if !is_repo(&vault) {
        ok_bytes(
            &vault,
            &["init", "--separate-git-dir=.lattice/git", "--initial-branch=main"],
        )?;
    }

    // Config tuned for large note-vaults on Windows / macOS / Linux.
    //
    // IMPORTANT: `core.fsmonitor` is explicitly DISABLED.  On macOS,
    // setting it to "true" causes `git status` to attempt launching a
    // `fsmonitor--daemon` (FSEvents-based) which deadlocks when
    // invoked from a Tauri subprocess with GIT_TERMINAL_PROMPT=0.
    // This was the root cause of the init hang on macOS.
    for (k, v) in [
        ("core.fsmonitor", "false"),
        ("core.untrackedCache", "true"),
        ("feature.manyFiles", "true"),
        ("core.autocrlf", "false"),
        ("core.safecrlf", "false"),
        ("core.longpaths", "true"),
        ("core.precomposeunicode", "true"),
        ("gc.auto", "256"),
        ("core.logAllRefUpdates", "false"),
    ] {
        ok_bytes(&vault, &["config", k, v])?;
    }

    let gi = vault.join(".gitignore");
    if !gi.exists() {
        std::fs::write(
            &gi,
            "# Lattice metadata\n.lattice/\n\n# OS junk\n.DS_Store\nThumbs.db\n",
        )
        .map_err(|e| format!("write .gitignore: {}", e))?;
    }

    // First-time setup: stage everything and create a root commit so
    // HEAD exists.  Set placeholder identity if the user hasn't.
    //
    // Uses GIT_TIMEOUT_LONG because `git add -A` on a large vault
    // can be slow (macOS Spotlight indexing, xattr, HFS+).
    let unborn = run(&vault, &["rev-parse", "--verify", "HEAD"])
        .map(|o| !o.status.success())
        .unwrap_or(true);
    if unborn {
        ok_bytes_with_timeout(&vault, &["add", "-A"], GIT_TIMEOUT_LONG)?;
        if ok_bytes(&vault, &["config", "--get", "user.name"]).is_err() {
            ok_bytes(&vault, &["config", "user.name", "Lattice User"])?;
        }
        if ok_bytes(&vault, &["config", "--get", "user.email"]).is_err() {
            ok_bytes(&vault, &["config", "user.email", "user@lattice.local"])?;
        }
        // --no-verify skips any user-installed git hooks that could
        // hang or fail during the automated init.
        ok_bytes_with_timeout(
            &vault,
            &["commit", "--allow-empty", "--no-verify", "-m", "Initial Lattice snapshot"],
            GIT_TIMEOUT_LONG,
        )?;
    }

    vcs_status_sync(vault_path)
}

#[tauri::command]
pub async fn vcs_stage(vault_path: String, paths: Vec<String>) -> Result<VcsStatus, String> {
    tokio::task::spawn_blocking(move || {
        if paths.is_empty() {
            return vcs_status_sync(vault_path);
        }
        let vault = vault_dir(&vault_path)?;
        let mut args = vec!["add", "--"];
        args.extend(paths.iter().map(String::as_str));
        ok_bytes(&vault, &args)?;
        vcs_status_sync(vault_path)
    })
    .await
    .map_err(|e| format!("task panicked: {e}"))?
}

#[tauri::command]
pub async fn vcs_unstage(vault_path: String, paths: Vec<String>) -> Result<VcsStatus, String> {
    tokio::task::spawn_blocking(move || {
        if paths.is_empty() {
            return vcs_status_sync(vault_path);
        }
        let vault = vault_dir(&vault_path)?;
        let mut args = vec!["restore", "--staged", "--"];
        args.extend(paths.iter().map(String::as_str));
        ok_bytes(&vault, &args)?;
        vcs_status_sync(vault_path)
    })
    .await
    .map_err(|e| format!("task panicked: {e}"))?
}

/// Discard worktree changes.  Tracked paths go through `git restore
/// --worktree`; untracked paths are sent to the OS recycle bin via
/// `trash` (NEVER hard-deleted — user data).
#[tauri::command]
pub async fn vcs_discard(vault_path: String, paths: Vec<String>) -> Result<VcsStatus, String> {
    tokio::task::spawn_blocking(move || {
        if paths.is_empty() {
            return vcs_status_sync(vault_path.clone());
        }
        let vault = vault_dir(&vault_path)?;

        let snap = vcs_status_sync(vault_path.clone())?;
        let untracked: HashSet<&str> =
            snap.untracked.iter().map(|c| c.path.as_str()).collect();
        let (recycle, restore): (Vec<&String>, Vec<&String>) =
            paths.iter().partition(|p| untracked.contains(p.as_str()));

        if !restore.is_empty() {
            let mut args = vec!["restore", "--worktree", "--"];
            args.extend(restore.iter().map(|s| s.as_str()));
            ok_bytes(&vault, &args)?;
        }
        for rel in &recycle {
            let abs = vault.join(rel);
            if abs.exists() {
                trash::delete(&abs).map_err(|e| format!("recycle {}: {}", rel, e))?;
            }
        }
        vcs_status_sync(vault_path)
    })
    .await
    .map_err(|e| format!("task panicked: {e}"))?
}

#[tauri::command]
pub async fn vcs_commit(vault_path: String, message: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let vault = vault_dir(&vault_path)?;
        let msg = message.trim();
        if msg.is_empty() {
            return Err("commit message is required".to_string());
        }
        ok_bytes(&vault, &["commit", "-m", msg])?;
        Ok(ok_str(&vault, &["rev-parse", "--short=7", "HEAD"])?
            .trim()
            .to_string())
    })
    .await
    .map_err(|e| format!("task panicked: {e}"))?
}

#[tauri::command]
pub async fn vcs_commit_all(vault_path: String, message: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let vault = vault_dir(&vault_path)?;
        let msg = message.trim();
        if msg.is_empty() {
            return Err("commit message is required".to_string());
        }
        ok_bytes(&vault, &["add", "-A"])?;
        ok_bytes(&vault, &["commit", "-m", msg])?;
        Ok(ok_str(&vault, &["rev-parse", "--short=7", "HEAD"])?
            .trim()
            .to_string())
    })
    .await
    .map_err(|e| format!("task panicked: {e}"))?
}

// ─── Log ────────────────────────────────────────────────────────────────
// `git log -z --pretty=format:<TEMPLATE>` separates records with a NUL
// byte (no trailing NUL).  Body is always the LAST field so its own
// newlines don't break the record layout.

const LOG_FMT: &str = "%H%n%h%n%an <%ae>%n%at%n%P%n%s%n%b";
const LOG_GRAPH_FMT: &str = "%H%n%h%n%an <%ae>%n%at%n%P%n%D%n%s%n%b";

#[tauri::command]
pub async fn vcs_log(vault_path: String, limit: u32) -> Result<Vec<CommitInfo>, String> {
    tokio::task::spawn_blocking(move || {
        let vault = vault_dir(&vault_path)?;
        if !is_repo(&vault) {
            return Ok(Vec::new());
        }
        let n = (if limit == 0 { 500 } else { limit.min(500) }).to_string();
        let fmt = format!("--pretty=format:{}", LOG_FMT);

        let out = run(&vault, &["log", "-z", "--max-count", &n, &fmt])?;
        if !out.status.success() {
            return interpret_log_error(&out.stderr, "git log");
        }
        Ok(split_records(&out.stdout)
            .filter_map(parse_commit)
            .collect())
    })
    .await
    .map_err(|e| format!("task panicked: {e}"))?
}

#[tauri::command]
pub async fn vcs_log_graph(vault_path: String, limit: u32) -> Result<Vec<GraphCommit>, String> {
    tokio::task::spawn_blocking(move || {
        let vault = vault_dir(&vault_path)?;
        if !is_repo(&vault) {
            return Ok(Vec::new());
        }
        let n = (if limit == 0 { 500 } else { limit.min(1000) }).to_string();
        let fmt = format!("--pretty=format:{}", LOG_GRAPH_FMT);

        let out = run(
            &vault,
            &["log", "-z", "--all", "--date-order", "--max-count", &n, &fmt],
        )?;
        if !out.status.success() {
            return interpret_log_error(&out.stderr, "git log --all");
        }
        Ok(split_records(&out.stdout)
            .filter_map(parse_graph_commit)
            .collect())
    })
    .await
    .map_err(|e| format!("task panicked: {e}"))?
}

fn interpret_log_error<T>(stderr: &[u8], label: &str) -> Result<Vec<T>, String> {
    let err = String::from_utf8_lossy(stderr).trim().to_string();
    // Empty repo (no HEAD yet) — return [] instead of erroring.
    if err.contains("does not have any commits yet")
        || err.contains("unknown revision")
        || err.contains("bad default revision")
    {
        return Ok(Vec::new());
    }
    Err(if err.is_empty() {
        format!("{} failed", label)
    } else {
        err
    })
}

fn split_records(bytes: &[u8]) -> impl Iterator<Item = &[u8]> {
    bytes.split(|b| *b == 0).filter(|r| !r.is_empty())
}

fn parse_commit(record: &[u8]) -> Option<CommitInfo> {
    let s = String::from_utf8_lossy(record);
    let s = s.trim_matches('\n');
    if s.is_empty() {
        return None;
    }
    let mut it = s.splitn(7, '\n');
    let id = it.next()?.to_string();
    let short_id = it.next()?.to_string();
    let author = it.next()?.to_string();
    let timestamp = it.next()?.parse::<i64>().unwrap_or(0);
    let parents = it
        .next()?
        .split_whitespace()
        .map(str::to_string)
        .collect::<Vec<_>>();
    let summary = it.next()?.to_string();
    let body_raw = it.next().unwrap_or("").trim();
    Some(CommitInfo {
        id,
        short_id,
        author,
        timestamp,
        summary,
        parents,
        body: if body_raw.is_empty() {
            None
        } else {
            Some(body_raw.to_string())
        },
    })
}

fn parse_graph_commit(record: &[u8]) -> Option<GraphCommit> {
    let s = String::from_utf8_lossy(record);
    let s = s.trim_matches('\n');
    if s.is_empty() {
        return None;
    }
    let mut it = s.splitn(8, '\n');
    let id = it.next()?.to_string();
    let short_id = it.next()?.to_string();
    let author = it.next()?.to_string();
    let timestamp = it.next()?.parse::<i64>().unwrap_or(0);
    let parents = it
        .next()?
        .split_whitespace()
        .map(str::to_string)
        .collect::<Vec<_>>();
    let refs_raw = it.next()?.trim();
    let summary = it.next()?.to_string();
    let body_raw = it.next().unwrap_or("").trim();
    let refs = if refs_raw.is_empty() {
        Vec::new()
    } else {
        refs_raw
            .split(", ")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    };
    Some(GraphCommit {
        id,
        short_id,
        author,
        timestamp,
        summary,
        parents,
        refs,
        body: if body_raw.is_empty() {
            None
        } else {
            Some(body_raw.to_string())
        },
    })
}

#[tauri::command]
pub async fn vcs_diff_file(
    vault_path: String,
    rel_path: String,
    staged: Option<bool>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let vault = vault_dir(&vault_path)?;
        let mut args: Vec<&str> = vec!["diff", "--no-color"];
        if staged.unwrap_or(false) {
            args.push("--cached");
        }
        args.push("--");
        args.push(&rel_path);
        ok_str(&vault, &args)
    })
    .await
    .map_err(|e| format!("task panicked: {e}"))?
}

#[tauri::command]
pub async fn vcs_checkout_file(vault_path: String, rel_path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        vcs_discard_sync(vault_path, vec![rel_path]).map(|_| ())
    })
    .await
    .map_err(|e| format!("task panicked: {e}"))?
}

/// Synchronous discard — shared by both `vcs_discard` and `vcs_checkout_file`.
fn vcs_discard_sync(vault_path: String, paths: Vec<String>) -> Result<VcsStatus, String> {
    if paths.is_empty() {
        return vcs_status_sync(vault_path);
    }
    let vault = vault_dir(&vault_path)?;

    let snap = vcs_status_sync(vault_path.clone())?;
    let untracked: HashSet<&str> =
        snap.untracked.iter().map(|c| c.path.as_str()).collect();
    let (recycle, restore): (Vec<&String>, Vec<&String>) =
        paths.iter().partition(|p| untracked.contains(p.as_str()));

    if !restore.is_empty() {
        let mut args = vec!["restore", "--worktree", "--"];
        args.extend(restore.iter().map(|s| s.as_str()));
        ok_bytes(&vault, &args)?;
    }
    for rel in &recycle {
        let abs = vault.join(rel);
        if abs.exists() {
            trash::delete(&abs).map_err(|e| format!("recycle {}: {}", rel, e))?;
        }
    }
    vcs_status_sync(vault_path)
}

// ─── Branches ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn vcs_branches(vault_path: String) -> Result<Vec<BranchInfo>, String> {
    tokio::task::spawn_blocking(move || {
        let vault = vault_dir(&vault_path)?;
        if !is_repo(&vault) {
            return Ok(Vec::new());
        }

        // Unit-separator (US, 0x1F) is unambiguous between fields; lines
        // are newline-separated.
        const F: &str = "\x1f";
        let fmt = format!(
            "%(HEAD){F}%(refname){F}%(refname:short){F}%(upstream:short){F}%(upstream:track){F}%(objectname:short){F}%(committerdate:unix){F}%(subject)",
            F = F
        );
        let raw = ok_str(
            &vault,
            &["for-each-ref", "--format", &fmt, "refs/heads", "refs/remotes"],
        )?;

        let mut branches = Vec::new();
        for line in raw.lines() {
            if line.is_empty() {
                continue;
            }
            let f: Vec<&str> = line.split(F).collect();
            if f.len() < 8 {
                continue;
            }
            let refname = f[1];
            if refname.ends_with("/HEAD") {
                continue;
            }
            let (ahead, behind) = parse_upstream_track(f[4], f[3]);
            branches.push(BranchInfo {
                name: f[2].to_string(),
                is_current: f[0] == "*",
                is_remote: refname.starts_with("refs/remotes/"),
                upstream: opt(f[3]),
                ahead,
                behind,
                tip_short: opt(f[5]),
                tip_summary: opt(f[7]),
                tip_timestamp: f[6].parse::<i64>().unwrap_or(0),
            });
        }

        // Current → local → remote, then by tip recency.
        branches.sort_by(|a, b| {
            b.is_current
                .cmp(&a.is_current)
                .then(a.is_remote.cmp(&b.is_remote))
                .then(b.tip_timestamp.cmp(&a.tip_timestamp))
        });
        Ok(branches)
    })
    .await
    .map_err(|e| format!("task panicked: {e}"))?
}

/// Parse `%(upstream:track)` output:
///   ""              → no upstream      → (None, None)  if upstream empty
///                                       (Some(0), Some(0)) if upstream set
///   "[gone]"        → upstream deleted → (None, None)
///   "[ahead 3]"     → (Some(3), Some(0))
///   "[behind 2]"    → (Some(0), Some(2))
///   "[ahead 1, behind 4]" → (Some(1), Some(4))
fn parse_upstream_track(track: &str, upstream: &str) -> (Option<u32>, Option<u32>) {
    if upstream.is_empty() {
        return (None, None);
    }
    if track.contains("gone") {
        return (None, None);
    }
    if track.is_empty() {
        return (Some(0), Some(0));
    }
    let inner = track.trim_start_matches('[').trim_end_matches(']');
    let mut a: Option<u32> = None;
    let mut b: Option<u32> = None;
    for chunk in inner.split(',') {
        let mut toks = chunk.trim().split_whitespace();
        match (toks.next(), toks.next()) {
            (Some("ahead"), Some(n)) => a = n.parse().ok(),
            (Some("behind"), Some(n)) => b = n.parse().ok(),
            _ => {}
        }
    }
    (a.or(Some(0)), b.or(Some(0)))
}

#[tauri::command]
pub async fn vcs_branch_create(
    vault_path: String,
    name: String,
    start_point: Option<String>,
    checkout: Option<bool>,
) -> Result<VcsStatus, String> {
    tokio::task::spawn_blocking(move || {
        let vault = vault_dir(&vault_path)?;
        let n = name.trim();
        if n.is_empty() {
            return Err("branch name is required".to_string());
        }
        let mut args: Vec<&str> = if checkout.unwrap_or(false) {
            vec!["switch", "-c", n]
        } else {
            vec!["branch", n]
        };
        if let Some(sp) = start_point.as_deref() {
            args.push(sp);
        }
        ok_bytes(&vault, &args)?;
        vcs_status_sync(vault_path)
    })
    .await
    .map_err(|e| format!("task panicked: {e}"))?
}

#[tauri::command]
pub async fn vcs_branch_switch(vault_path: String, name: String) -> Result<VcsStatus, String> {
    tokio::task::spawn_blocking(move || {
        let vault = vault_dir(&vault_path)?;
        let n = name.trim();
        if n.is_empty() {
            return Err("branch name is required".to_string());
        }
        ok_bytes(&vault, &["switch", n])?;
        vcs_status_sync(vault_path)
    })
    .await
    .map_err(|e| format!("task panicked: {e}"))?
}

#[tauri::command]
pub async fn vcs_branch_delete(
    vault_path: String,
    name: String,
    force: Option<bool>,
) -> Result<VcsStatus, String> {
    tokio::task::spawn_blocking(move || {
        let vault = vault_dir(&vault_path)?;
        let n = name.trim();
        if n.is_empty() {
            return Err("branch name is required".to_string());
        }
        let flag = if force.unwrap_or(false) { "-D" } else { "-d" };
        ok_bytes(&vault, &["branch", flag, n])?;
        vcs_status_sync(vault_path)
    })
    .await
    .map_err(|e| format!("task panicked: {e}"))?
}

// ─── Porcelain v2 parser ─────────────────────────────────────────────────
// Records are NUL-separated.  Rename/copy entries (line type '2') are
// followed by an extra NUL-separated original-path record, which we
// consume from the same iterator.

fn parse_status_v2(bytes: &[u8]) -> Result<VcsStatus, String> {
    let text = String::from_utf8_lossy(bytes);
    let mut status = VcsStatus {
        initialized: true,
        ..Default::default()
    };

    let mut iter = text.split('\0');
    while let Some(rec) = iter.next() {
        if rec.is_empty() {
            continue;
        }
        let mut parts = rec.splitn(2, ' ');
        let kind = parts.next().unwrap_or("");
        let rest = parts.next().unwrap_or("");

        match kind {
            "#" => parse_branch_header(rest, &mut status),
            "1" => {
                // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
                let mut toks = rest.splitn(8, ' ');
                let xy = toks.next().unwrap_or("..");
                for _ in 0..6 {
                    toks.next();
                }
                let path = toks.next().unwrap_or("").to_string();
                classify_xy(xy, path, None, &mut status);
            }
            "2" => {
                // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>
                // followed by NUL <orig_path>
                let mut toks = rest.splitn(9, ' ');
                let xy = toks.next().unwrap_or("..");
                for _ in 0..7 {
                    toks.next();
                }
                let path = toks.next().unwrap_or("").to_string();
                let orig = iter.next().unwrap_or("").to_string();
                classify_xy(xy, path, opt(&orig), &mut status);
            }
            "u" => {
                let toks: Vec<&str> = rest.splitn(10, ' ').collect();
                let xy = toks.first().copied().unwrap_or("UU");
                let path = toks.get(9).copied().unwrap_or("").to_string();
                status.staged.push(FileChange {
                    path,
                    status: xy.to_string(),
                    orig_path: None,
                });
            }
            "?" => {
                status.untracked.push(FileChange {
                    path: rest.to_string(),
                    status: "??".to_string(),
                    orig_path: None,
                });
            }
            _ => {}
        }
    }
    Ok(status)
}

fn parse_branch_header(rest: &str, status: &mut VcsStatus) {
    if let Some(name) = rest.strip_prefix("branch.head ") {
        let n = name.trim();
        if n != "(detached)" {
            status.branch = Some(n.to_string());
        }
    } else if let Some(oid) = rest.strip_prefix("branch.oid ") {
        let o = oid.trim();
        if o != "(initial)" {
            status.head_short = Some(o.chars().take(7).collect());
        }
    } else if let Some(ab) = rest.strip_prefix("branch.ab ") {
        let mut a: Option<u32> = None;
        let mut b: Option<u32> = None;
        for tok in ab.split_whitespace() {
            if let Some(n) = tok.strip_prefix('+') {
                a = n.parse().ok();
            } else if let Some(n) = tok.strip_prefix('-') {
                b = n.parse().ok();
            }
        }
        status.ahead = a;
        status.behind = b;
    }
}

/// XY codes from porcelain v2:
///   X = staged side, Y = unstaged side.
///   '.' or ' ' = unmodified on that side.
/// We emit one FileChange per side that has a change, so a single path
/// can appear in BOTH `staged` and `unstaged` when "staged, then edited".
fn classify_xy(xy: &str, path: String, orig: Option<String>, status: &mut VcsStatus) {
    let bytes = xy.as_bytes();
    let x = bytes.first().copied().unwrap_or(b'.');
    let y = bytes.get(1).copied().unwrap_or(b'.');
    if x != b'.' && x != b' ' && x != b'?' {
        status.staged.push(FileChange {
            path: path.clone(),
            status: format!("{}.", x as char),
            orig_path: orig.clone(),
        });
    }
    if y != b'.' && y != b' ' && y != b'?' {
        status.unstaged.push(FileChange {
            path,
            status: format!(".{}", y as char),
            orig_path: orig,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upstream_track_no_upstream() {
        assert_eq!(parse_upstream_track("", ""), (None, None));
    }

    #[test]
    fn upstream_track_gone() {
        assert_eq!(parse_upstream_track("[gone]", "origin/main"), (None, None));
    }

    #[test]
    fn upstream_track_even() {
        assert_eq!(
            parse_upstream_track("", "origin/main"),
            (Some(0), Some(0))
        );
    }

    #[test]
    fn upstream_track_ahead_only() {
        assert_eq!(
            parse_upstream_track("[ahead 3]", "origin/main"),
            (Some(3), Some(0))
        );
    }

    #[test]
    fn upstream_track_behind_only() {
        assert_eq!(
            parse_upstream_track("[behind 2]", "origin/main"),
            (Some(0), Some(2))
        );
    }

    #[test]
    fn upstream_track_both() {
        assert_eq!(
            parse_upstream_track("[ahead 1, behind 4]", "origin/main"),
            (Some(1), Some(4))
        );
    }

    #[test]
    fn classify_xy_modified_unstaged() {
        let mut s = VcsStatus::default();
        classify_xy(".M", "notes/a.md".to_string(), None, &mut s);
        assert!(s.staged.is_empty());
        assert_eq!(s.unstaged.len(), 1);
        assert_eq!(s.unstaged[0].status, ".M");
    }

    #[test]
    fn classify_xy_added_then_modified() {
        let mut s = VcsStatus::default();
        classify_xy("AM", "notes/b.md".to_string(), None, &mut s);
        assert_eq!(s.staged.len(), 1);
        assert_eq!(s.staged[0].status, "A.");
        assert_eq!(s.unstaged.len(), 1);
        assert_eq!(s.unstaged[0].status, ".M");
    }

    #[test]
    fn classify_xy_untracked_skipped() {
        // '?' codes come through line type '?' in v2 — classify_xy
        // should NOT bucket them as staged/unstaged.
        let mut s = VcsStatus::default();
        classify_xy("??", "new.md".to_string(), None, &mut s);
        assert!(s.staged.is_empty());
        assert!(s.unstaged.is_empty());
    }
}
