//! VCS module — thin subprocess wrapper over the system `git` binary.
//!
//! # Why subprocess + system git instead of an in-process git library
//!
//! Every "git library" (libgit2, gix, JGit, go-git, dulwich) is a
//! reimplementation that lags real git on feature coverage and stability.
//! The features we need most (push/fetch over HTTPS+SSH, credential
//! helpers, hooks, LFS, signed commits, merge/rebase/stash) are exactly
//! the ones library impls are weakest at.  Real git has been stable
//! since ~2010; every git GUI of consequence (VS Code, GitHub Desktop,
//! JetBrains, Sublime Merge) shells out to it for the same reason.
//!
//! Lattice is opt-in for VCS — only users who turn on cloud sync need
//! git installed, so the dependency is gated behind a real user choice.
//! Detection lives in [`git_check_installed`]; the onboarding flow
//! triggers an OS-specific install when missing.
//!
//! # On-disk layout
//!
//! ```text
//! <vault>/
//!   ├── .git                 (text pointer: "gitdir: .lattice/git")
//!   ├── .gitignore           (excludes .lattice/, .DS_Store, Thumbs.db)
//!   ├── .lattice/
//!   │   ├── git/             (the real .git directory — heavy stuff
//!   │   │                     out of vault root)
//!   │   └── config.json      (per-vault settings; future sync prefs)
//!   └── notes/...
//! ```
//!
//! Created with `git init --separate-git-dir=.lattice/git <vault>`.
//! Terminal `git status` works because of the `.git` pointer file;
//! VS Code / GitHub Desktop / GitKraken all auto-detect it the same
//! way.  Centralising under `.lattice/` keeps cloud-sync metadata
//! (added in a future slice) in one place, and means renaming the
//! product later is a single-directory rename.
//!
//! # Pipeline speed wins
//!
//! Configured at init time, once per vault:
//!   - `core.fsmonitor=true` — built-in fs watcher (git 2.36+) turns
//!     status into O(changed files) instead of O(total files).
//!   - `core.untrackedCache=true` — caches the untracked walk.
//!   - `feature.manyFiles=true` — index v4, `index.skipHash=true`,
//!     `pack.useSparse=true`.  Bigger wins on bigger repos; neutral
//!     on small ones.
//!   - `gc.auto=256` — auto-rollup loose objects.
//!
//! Per-call hygiene applied by [`run_git`]:
//!   - `GIT_TERMINAL_PROMPT=0` — never block on tty prompts.
//!   - `GIT_OPTIONAL_LOCKS=0` — never contend with terminal git.
//!   - Windows: `CREATE_NO_WINDOW` flag — no flashing console window.
//!
//! A single status invocation (`git status --porcelain=v2 -z --branch
//! --untracked-files=all`) returns the full three-section snapshot
//! (staged / unstaged / untracked) plus branch + ahead/behind in one
//! parse.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

// `CREATE_NO_WINDOW` from winapi — duplicating the constant lets us
// skip pulling the whole winapi crate in just for one flag.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ─── DTOs (serde camelCase → match TS) ──────────────────────────────────

/// One row in the changes list — independent of which section it lives in.
///
/// `status` is git's porcelain v2 two-letter XY code:
///   * X = HEAD vs index (what `commit` will record)
///   * Y = index vs worktree (what `add` will stage)
/// Untracked entries use `??`; ignored use `!!`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub status: String,
    /// Present for renames/copies (R/C) — the source path.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orig_path: Option<String>,
}

/// Full per-vault status snapshot, returned by [`vcs_status`].
///
/// Three lists so the UI can render the three real git sections
/// (staged / unstaged / untracked) with multi-select per section.
/// `initialized=false` means the vault has no git repo yet; the UI
/// should show the "Enable version control" CTA.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VcsStatus {
    pub initialized: bool,
    pub branch: Option<String>,
    pub head_short: Option<String>,
    /// Commits ahead of upstream (None when no upstream set).
    pub ahead: Option<u32>,
    /// Commits behind upstream (None when no upstream set).
    pub behind: Option<u32>,
    pub staged: Vec<FileChange>,
    pub unstaged: Vec<FileChange>,
    pub untracked: Vec<FileChange>,
}

/// One commit row for the History panel.
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

/// Returned by [`git_check_installed`] — drives the onboarding install prompt.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPresence {
    pub installed: bool,
    pub version: Option<String>,
}

/// One branch row for the Branches panel.
///
/// `isRemote=true` for `refs/remotes/<remote>/<name>` refs (these are
/// read-only — the UI surfaces them so you can checkout / track them).
/// `upstream` is the configured tracking branch (e.g. "origin/main").
/// `ahead`/`behind` are filled only when an upstream exists and is
/// reachable; missing-upstream branches return `None` for both.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    /// Short name (`main`, `origin/main`, `feature/x`).
    pub name: String,
    /// `true` for the currently checked-out local branch.
    pub is_current: bool,
    /// `true` for remote-tracking branches under `refs/remotes/`.
    pub is_remote: bool,
    /// Configured upstream (short form, e.g. "origin/main"); None when unset.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    /// Commits ahead of upstream; None when no upstream is configured.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ahead: Option<u32>,
    /// Commits behind upstream; None when no upstream is configured.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub behind: Option<u32>,
    /// 7-char short sha of the branch tip; None on broken refs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tip_short: Option<String>,
    /// First line of the tip commit's message; nice for a row preview.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tip_summary: Option<String>,
    /// Unix-seconds of the tip commit's committer date; used for sort
    /// + the "last commit was N hours ago" footnote.
    pub tip_timestamp: i64,
}

/// One commit in the graph view.  Like [`CommitInfo`] but always
/// fetched with `--all --decorate` so we can render every branch tip
/// + every tag inline on the graph.  Kept as a separate DTO so the
/// History list (which only wants HEAD's ancestors) stays unaffected.
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
    /// Refs pointing at this commit, e.g. `["HEAD", "main",
    /// "origin/main", "tag: v0.1.0"]`.  Empty when no refs land here.
    pub refs: Vec<String>,
}

// ─── Subprocess primitive ────────────────────────────────────────────────

/// Spawn `git <args>` from inside `vault` and capture its output.
///
/// Centralises every cross-call concern: env scrubbing (no tty
/// prompts, no optional locks), Windows console suppression, and a
/// uniform error-string format with stderr inline so the UI can show
/// the real reason on the error card.
fn run_git(vault: &Path, args: &[&str]) -> Result<Output, String> {
    let mut cmd = Command::new("git");
    cmd.current_dir(vault)
        .args(args)
        // Never block on credential prompts — those are routed via
        // git credential helpers (cred mgr / keychain / gh) and a
        // missing helper should fail fast, not hang the IPC.
        .env("GIT_TERMINAL_PROMPT", "0")
        // Don't fight terminal git for the index lock — read-only
        // ops set this implicitly, but being explicit covers writes
        // that don't strictly need a lock (e.g. status with fsmonitor).
        .env("GIT_OPTIONAL_LOCKS", "0")
        // Force the C locale so we can pattern-match stderr in tests
        // without locale-dependent message wording.
        .env("LC_ALL", "C")
        .env("LANG", "C");

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    cmd.output().map_err(|e| {
        // `Os { code: 2 }` on Windows / `No such file or directory`
        // on Unix both mean "git binary not found".  Translate to a
        // user-actionable message so the UI can prompt install.
        if e.kind() == std::io::ErrorKind::NotFound {
            "git is not installed or not on PATH. Enable version \
             control via Settings to install it."
                .to_string()
        } else {
            format!("failed to spawn git: {}", e)
        }
    })
}

/// Run git and require exit code 0.  Returns stdout (utf-8 lossy) on
/// success; stderr-prefixed error string on failure.  Used everywhere
/// except `git status`/`rev-parse` checks, which interpret non-zero
/// exit codes specifically.
fn git_ok(vault: &Path, args: &[&str]) -> Result<String, String> {
    let out = run_git(vault, args)?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("git {} failed (exit {:?})", args.join(" "), out.status.code())
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

// ─── Repo discovery / init ──────────────────────────────────────────────

/// Locate the git directory for `vault`.  Returns `None` when the
/// vault has no repo (CTA target) and an error only on truly broken
/// trees (e.g. git is installed but `rev-parse` segfaults).
fn discover_git_dir(vault: &Path) -> Result<Option<PathBuf>, String> {
    let out = run_git(vault, &["rev-parse", "--git-dir"])?;
    if !out.status.success() {
        // Most common case: "fatal: not a git repository" — quiet None.
        return Ok(None);
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if path.is_empty() {
        return Ok(None);
    }
    let p = PathBuf::from(&path);
    // `rev-parse --git-dir` can print a relative path — resolve it
    // against the vault so callers always get an absolute location.
    Ok(Some(if p.is_absolute() { p } else { vault.join(p) }))
}

// ─── Tauri commands ──────────────────────────────────────────────────────

/// Detect whether the system has a working `git` binary.  Used by the
/// onboarding wizard before offering "Enable sync" — and as a cheap
/// pre-flight before every other VCS command.
#[tauri::command]
pub fn git_check_installed() -> Result<GitPresence, String> {
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
}

/// One-shot status snapshot.  Uses porcelain v2 + NUL separators so
/// the parse is unambiguous (paths can contain newlines).  Single
/// subprocess per call; with `core.fsmonitor=true` (set at init) this
/// stays sub-50ms even on multi-thousand-file vaults.
#[tauri::command]
pub fn vcs_status(vault_path: String) -> Result<VcsStatus, String> {
    let vault = PathBuf::from(&vault_path);
    if !vault.is_dir() {
        return Err(format!("vault path is not a directory: {}", vault_path));
    }

    // Not initialised → return the empty shape so the UI can show
    // the Enable CTA without showing fake change counts.
    let git_dir = match discover_git_dir(&vault)? {
        Some(d) => d,
        None => return Ok(VcsStatus::default()),
    };
    let _ = git_dir; // discovered to confirm repo presence

    let out = run_git(
        &vault,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=all",
            "-z",
        ],
    )?;
    if !out.status.success() {
        return Err(format!(
            "git status failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }

    parse_status_v2(&out.stdout)
}

/// Cheap walk-only file count for the pre-init CTA ("Enable & commit
/// N files").  Independent of git so it works before init.  Skips
/// `.lattice/`, `.git*`, and a handful of well-known junk.
#[tauri::command]
pub fn vcs_preview_untracked_count(vault_path: String) -> Result<u32, String> {
    let vault = PathBuf::from(&vault_path);
    if !vault.is_dir() {
        return Err(format!("vault path is not a directory: {}", vault_path));
    }
    let mut count: u32 = 0;
    let skip: HashSet<&str> = [".git", ".lattice", ".DS_Store", "Thumbs.db", "node_modules"]
        .into_iter()
        .collect();
    for entry in walkdir::WalkDir::new(&vault)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            e.file_name()
                .to_str()
                .map(|n| !skip.contains(n))
                .unwrap_or(false)
        })
        .filter_map(|e| e.ok())
    {
        if entry.file_type().is_file() {
            count = count.saturating_add(1);
        }
    }
    Ok(count)
}

/// Initialise a vault for version control.
///
/// Creates the git dir at `<vault>/.lattice/git/` via `--separate-git-dir`,
/// writes a sensible `.gitignore`, applies all the speed/safety config,
/// and takes the initial commit.  Idempotent: re-runs are no-ops if a
/// repo + HEAD already exist; partial states are repaired.
#[tauri::command]
pub fn vcs_init(vault_path: String) -> Result<VcsStatus, String> {
    let vault = PathBuf::from(&vault_path);
    if !vault.is_dir() {
        return Err(format!("vault path is not a directory: {}", vault_path));
    }

    // 1) Ensure `.lattice/` exists so `--separate-git-dir` has a parent.
    let lattice_dir = vault.join(".lattice");
    std::fs::create_dir_all(&lattice_dir)
        .map_err(|e| format!("failed to create .lattice/: {}", e))?;

    // 2) Init (or no-op).  We pass `--initial-branch=main` so we never
    //    inherit the user's `init.defaultBranch` config — keeps cloud
    //    sync targets predictable.
    let already_repo = discover_git_dir(&vault)?.is_some();
    if !already_repo {
        git_ok(
            &vault,
            &[
                "init",
                "--separate-git-dir=.lattice/git",
                "--initial-branch=main",
            ],
        )?;
    }

    // 3) Apply the speed + safety config.  `git config` is a no-op
    //    when the value is already set — idempotent.
    let cfg: &[(&str, &str)] = &[
        // Speed
        ("core.fsmonitor", "true"),
        ("core.untrackedCache", "true"),
        ("feature.manyFiles", "true"),
        // Safety / cross-platform sanity
        ("core.autocrlf", "false"),
        ("core.safecrlf", "false"),
        ("core.longpaths", "true"),
        ("core.precomposeunicode", "true"),
        // Auto-GC loose objects so the repo doesn't bloat
        ("gc.auto", "256"),
        // Disable reflog write to avoid sync-driver lock contention
        // on OneDrive/Dropbox-hosted vaults.  Single-user notes app:
        // reflog has no value, breaks on cloud reparse points.
        ("core.logAllRefUpdates", "false"),
    ];
    for (k, v) in cfg {
        git_ok(&vault, &["config", k, v])?;
    }

    // 4) `.gitignore` — exclude our metadata dir + OS junk.  Write
    //    only if absent so we never clobber user edits.
    let gi_path = vault.join(".gitignore");
    if !gi_path.exists() {
        std::fs::write(
            &gi_path,
            "# Lattice metadata (do not track)\n.lattice/\n\n# OS junk\n.DS_Store\nThumbs.db\n",
        )
        .map_err(|e| format!("failed to write .gitignore: {}", e))?;
    }

    // 5) Initial commit — only if HEAD is unborn (idempotent).
    let head_unborn = run_git(&vault, &["rev-parse", "--verify", "HEAD"])
        .map(|o| !o.status.success())
        .unwrap_or(true);
    if head_unborn {
        // Stage everything (respecting .gitignore).
        git_ok(&vault, &["add", "-A"])?;

        // Identity fallback so the first commit never errors on a
        // fresh machine.  Real identity is set during onboarding;
        // this is the sentinel value the UI can rewrite later.
        let has_name = git_ok(&vault, &["config", "--get", "user.name"]).is_ok();
        let has_email = git_ok(&vault, &["config", "--get", "user.email"]).is_ok();
        if !has_name {
            git_ok(&vault, &["config", "user.name", "Lattice User"])?;
        }
        if !has_email {
            git_ok(&vault, &["config", "user.email", "user@lattice.local"])?;
        }

        // `--allow-empty` so an empty vault still gets an anchor commit.
        git_ok(
            &vault,
            &["commit", "--allow-empty", "-m", "Initial Lattice snapshot"],
        )?;
    }

    vcs_status(vault_path)
}

/// Stage one or more paths (real `git add -- <paths…>`).  Handles
/// modifications, additions, AND worktree deletions in one call.
#[tauri::command]
pub fn vcs_stage(vault_path: String, paths: Vec<String>) -> Result<VcsStatus, String> {
    if paths.is_empty() {
        return vcs_status(vault_path);
    }
    let vault = PathBuf::from(&vault_path);
    let mut args: Vec<&str> = vec!["add", "--"];
    args.extend(paths.iter().map(String::as_str));
    git_ok(&vault, &args)?;
    vcs_status(vault_path)
}

/// Unstage one or more paths.  Uses `git restore --staged --` (git
/// 2.23+, ~2019) which is more obvious than the legacy
/// `git reset HEAD --`.  Files staged for deletion get restored to
/// "deleted in worktree" — the actual blob in HEAD is untouched.
#[tauri::command]
pub fn vcs_unstage(vault_path: String, paths: Vec<String>) -> Result<VcsStatus, String> {
    if paths.is_empty() {
        return vcs_status(vault_path);
    }
    let vault = PathBuf::from(&vault_path);
    let mut args: Vec<&str> = vec!["restore", "--staged", "--"];
    args.extend(paths.iter().map(String::as_str));
    git_ok(&vault, &args)?;
    vcs_status(vault_path)
}

/// Discard worktree changes to tracked files (restore from index).
/// For untracked files, send them to the system recycle bin via the
/// `trash` crate — never `fs::remove_file`, which is unrecoverable.
///
/// The caller passes a mix of tracked + untracked paths; we sort
/// them via a single `git status` then dispatch each kind to the
/// right primitive in one batch.
#[tauri::command]
pub fn vcs_discard(vault_path: String, paths: Vec<String>) -> Result<VcsStatus, String> {
    if paths.is_empty() {
        return vcs_status(vault_path);
    }
    let vault = PathBuf::from(&vault_path);

    // Bucket the requested paths.  We need to know which are tracked
    // (use `git restore`) vs untracked (recycle bin), because git's
    // `restore` doesn't accept untracked paths.
    let snap = vcs_status(vault_path.clone())?;
    let untracked: HashSet<&str> =
        snap.untracked.iter().map(|c| c.path.as_str()).collect();

    let (to_recycle, to_restore): (Vec<&String>, Vec<&String>) =
        paths.iter().partition(|p| untracked.contains(p.as_str()));

    // Restore tracked paths from the index in one subprocess.
    if !to_restore.is_empty() {
        let mut args: Vec<&str> = vec!["restore", "--worktree", "--"];
        args.extend(to_restore.iter().map(|s| s.as_str()));
        git_ok(&vault, &args)?;
    }

    // Recycle untracked paths one at a time — `trash::delete_all`
    // accepts a slice but loses per-path error context, which we
    // need when one of N files is locked by another process.
    for rel in &to_recycle {
        let abs = vault.join(rel);
        if abs.exists() {
            trash::delete(&abs)
                .map_err(|e| format!("failed to recycle {}: {}", rel, e))?;
        }
    }

    vcs_status(vault_path)
}

/// Commit whatever is currently staged.  The frontend stages first
/// (via [`vcs_stage`]) so this is a pure "snapshot the index" — no
/// implicit worktree-wide add.  Returns the new commit's short sha.
#[tauri::command]
pub fn vcs_commit(vault_path: String, message: String) -> Result<String, String> {
    let vault = PathBuf::from(&vault_path);
    let msg = message.trim();
    if msg.is_empty() {
        return Err("commit message is required".to_string());
    }

    git_ok(&vault, &["commit", "-m", msg])?;
    let sha = git_ok(&vault, &["rev-parse", "--short=7", "HEAD"])?;
    Ok(sha.trim().to_string())
}

/// Convenience: stage everything currently dirty, then commit.  Used
/// by the legacy "Commit" button until the multi-select UI is wired.
/// Once the UI calls `vcs_stage` explicitly this can be deleted.
#[tauri::command]
pub fn vcs_commit_all(vault_path: String, message: String) -> Result<String, String> {
    let vault = PathBuf::from(&vault_path);
    let msg = message.trim();
    if msg.is_empty() {
        return Err("commit message is required".to_string());
    }
    // `-a` stages tracked modifications/deletions; we then have to
    // add untracked files ourselves (git -a doesn't touch them).
    git_ok(&vault, &["add", "-A"])?;
    git_ok(&vault, &["commit", "-m", msg])?;
    let sha = git_ok(&vault, &["rev-parse", "--short=7", "HEAD"])?;
    Ok(sha.trim().to_string())
}

/// Log — paginated by `limit` (0 = unbounded, capped to 500 to keep
/// the History panel snappy).  Custom format string keeps parsing
/// deterministic (no locale, no shell quoting surprises).
#[tauri::command]
pub fn vcs_log(vault_path: String, limit: u32) -> Result<Vec<CommitInfo>, String> {
    let vault = PathBuf::from(&vault_path);
    let cap = if limit == 0 { 500 } else { limit.min(500) };
    let n = cap.to_string();

    // Field separator = ASCII unit separator (0x1f); record separator
    // = ASCII record separator (0x1e).  Neither appears in normal
    // commit metadata, so the parse is safe without quoting.
    const F: &str = "\x1f";
    const R: &str = "\x1e";
    let fmt = format!(
        "%H{f}%h{f}%an <%ae>{f}%at{f}%P{f}%s{f}%b{r}",
        f = F,
        r = R
    );

    let out = git_ok(
        &vault,
        &[
            "log",
            "--max-count",
            &n,
            "--format",
            &fmt,
        ],
    );
    let raw = match out {
        Ok(s) => s,
        Err(e) => {
            // Unborn HEAD on a brand-new repo — empty history, not an error.
            if e.contains("does not have any commits yet")
                || e.contains("unknown revision")
                || e.contains("bad default revision")
            {
                return Ok(Vec::new());
            }
            return Err(e);
        }
    };

    let mut commits = Vec::new();
    for record in raw.split(R) {
        let r = record.trim_matches('\n');
        if r.is_empty() {
            continue;
        }
        let fields: Vec<&str> = r.split(F).collect();
        if fields.len() < 7 {
            continue;
        }
        let id = fields[0].to_string();
        let short_id = fields[1].to_string();
        let author = fields[2].to_string();
        let timestamp = fields[3].parse::<i64>().unwrap_or(0);
        let parents: Vec<String> = fields[4]
            .split_whitespace()
            .map(str::to_string)
            .collect();
        let summary = fields[5].to_string();
        let body_raw = fields[6].trim();
        let body = if body_raw.is_empty() {
            None
        } else {
            Some(body_raw.to_string())
        };
        commits.push(CommitInfo {
            id,
            short_id,
            author,
            timestamp,
            summary,
            body,
            parents,
        });
    }
    Ok(commits)
}

/// Unified diff for one path.  Defaults to the unstaged diff
/// (worktree vs index); pass `staged=true` for the staged diff
/// (index vs HEAD).  Used by the per-row diff flyout.
#[tauri::command]
pub fn vcs_diff_file(
    vault_path: String,
    rel_path: String,
    staged: Option<bool>,
) -> Result<String, String> {
    let vault = PathBuf::from(&vault_path);
    let mut args: Vec<&str> = vec!["diff", "--no-color"];
    if staged.unwrap_or(false) {
        args.push("--cached");
    }
    args.push("--");
    args.push(&rel_path);
    git_ok(&vault, &args)
}

/// Restore one file from HEAD (legacy single-file shortcut used by
/// the existing per-row "Discard" button).  Equivalent to:
///   `git checkout HEAD -- <path>`
/// Untracked files are recycled (sent to trash), not hard-deleted.
#[tauri::command]
pub fn vcs_checkout_file(vault_path: String, rel_path: String) -> Result<(), String> {
    vcs_discard(vault_path, vec![rel_path]).map(|_| ())
}

// ─── Porcelain v2 parser ─────────────────────────────────────────────────
//
// Format reference: https://git-scm.com/docs/git-status#_porcelain_format_version_2
//
// We split on NUL and walk records.  Each record's first token tells
// us the type:
//   "#" → header line (branch info)
//   "1" → ordinary changed entry (modify/add/delete)
//   "2" → renamed/copied entry  (consumes TWO NUL-separated paths)
//   "u" → unmerged entry        (conflicts)
//   "?" → untracked
//   "!" → ignored
//
// We don't request ignored, so `!` never appears.  We treat `u` as
// "staged" so the user can see conflicts and resolve via the index.

fn parse_status_v2(bytes: &[u8]) -> Result<VcsStatus, String> {
    let text = String::from_utf8_lossy(bytes);
    let mut status = VcsStatus::default();
    status.initialized = true;

    let mut iter = text.split('\0').peekable();
    while let Some(rec) = iter.next() {
        if rec.is_empty() {
            continue;
        }
        let mut parts = rec.splitn(2, ' ');
        let tag = parts.next().unwrap_or("");
        match tag {
            "#" => {
                // Header — parse # branch.head / # branch.ab +A -B
                let rest = parts.next().unwrap_or("");
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
                    // "+3 -2"
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
            "1" => {
                // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
                if let Some(rest) = parts.next() {
                    let mut toks = rest.splitn(8, ' ');
                    let xy = toks.next().unwrap_or("..");
                    let _sub = toks.next();
                    let _mh = toks.next();
                    let _mi = toks.next();
                    let _mw = toks.next();
                    let _hh = toks.next();
                    let _hi = toks.next();
                    let path = toks.next().unwrap_or("").to_string();
                    classify_xy(xy, path, None, &mut status);
                }
            }
            "2" => {
                // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>
                // followed by a separate NUL-terminated "<origPath>" token.
                if let Some(rest) = parts.next() {
                    let mut toks = rest.splitn(9, ' ');
                    let xy = toks.next().unwrap_or("..");
                    for _ in 0..7 {
                        toks.next();
                    }
                    let path = toks.next().unwrap_or("").to_string();
                    let orig = iter.next().unwrap_or("").to_string();
                    classify_xy(
                        xy,
                        path,
                        if orig.is_empty() { None } else { Some(orig) },
                        &mut status,
                    );
                }
            }
            "u" => {
                // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
                if let Some(rest) = parts.next() {
                    let toks: Vec<&str> = rest.splitn(10, ' ').collect();
                    let xy = toks.first().copied().unwrap_or("UU");
                    let path = toks.get(9).copied().unwrap_or("").to_string();
                    status.staged.push(FileChange {
                        path,
                        status: xy.to_string(),
                        orig_path: None,
                    });
                }
            }
            "?" => {
                let path = parts.next().unwrap_or("").to_string();
                status.untracked.push(FileChange {
                    path,
                    status: "??".to_string(),
                    orig_path: None,
                });
            }
            _ => {} // ignore "!" + anything new git adds in the future
        }
    }

    Ok(status)
}

/// Split an XY status into its staged / unstaged buckets per git's
/// porcelain v2 semantics.  A path can legally appear in BOTH
/// sections at once (e.g. "MM" = staged modification + new unstaged
/// modification on top); we push to each side independently.
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

// ─── Slice B: branches + graph ──────────────────────────────────────────
//
// The Branches panel needs one list call (`vcs_branches`) plus three
// write ops (create / switch / delete).  Rename + force-delete + push
// to upstream all land in later slices; the surface here is the
// minimum needed for "create a branch, work on it, switch back".
//
// The Graph view needs one fetch (`vcs_log_graph`) that, unlike the
// History list, includes EVERY branch tip (`--all`) and decorates
// each commit with its refs (`HEAD -> main`, `origin/main`, `tag:
// v0.1.0`).  Lane assignment is done client-side from the DAG — see
// `src/lib/gitGraph.ts`.

/// List every branch the repo knows about — locals first, then
/// remote-tracking refs.  Single `git for-each-ref` subprocess; one
/// row per ref.  Fields are separated by ASCII unit separator (0x1f)
/// and records by newline.
///
/// We deliberately surface remote-tracking branches because they're
/// what the user will want to `git switch -c local-name <remote>` —
/// the Branches panel shows them in a "Remote" subsection.
#[tauri::command]
pub fn vcs_branches(vault_path: String) -> Result<Vec<BranchInfo>, String> {
    let vault = PathBuf::from(&vault_path);

    // %(HEAD) is "*" for the checked-out branch, " " otherwise.
    // %(upstream:track) is e.g. "[ahead 2]" / "[behind 1]" /
    // "[ahead 2, behind 1]" / "[gone]" / "" — we parse all four.
    // We omit unreachable refs (e.g. broken symbolic refs) by
    // requiring a valid objectname.
    const F: &str = "\x1f";
    let fmt = format!(
        "%(HEAD){f}%(refname){f}%(refname:short){f}%(upstream:short){f}%(upstream:track){f}%(objectname:short){f}%(committerdate:unix){f}%(subject)",
        f = F
    );

    let raw = git_ok(
        &vault,
        &[
            "for-each-ref",
            "--format",
            &fmt,
            "refs/heads",
            "refs/remotes",
        ],
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
        let head_marker = f[0];
        let refname = f[1];
        let short = f[2];
        let upstream = f[3];
        let track = f[4];
        let tip_short = f[5];
        let ts = f[6].parse::<i64>().unwrap_or(0);
        let subject = f[7];

        // Skip the symbolic HEAD ref itself (refs/remotes/<r>/HEAD)
        // — it's a pointer to whichever branch the remote calls
        // default, not a branch we can checkout independently.
        if refname.ends_with("/HEAD") {
            continue;
        }

        let is_remote = refname.starts_with("refs/remotes/");
        let is_current = head_marker == "*";

        // Parse upstream:track — examples:
        //   ""                    → no upstream OR even with upstream
        //   "[gone]"              → upstream deleted on remote
        //   "[ahead 2]"           → 2 ahead, 0 behind
        //   "[behind 3]"          → 0 ahead, 3 behind
        //   "[ahead 1, behind 4]" → both
        let (ahead, behind) = parse_upstream_track(track, upstream);

        branches.push(BranchInfo {
            name: short.to_string(),
            is_current,
            is_remote,
            upstream: if upstream.is_empty() {
                None
            } else {
                Some(upstream.to_string())
            },
            ahead,
            behind,
            tip_short: if tip_short.is_empty() {
                None
            } else {
                Some(tip_short.to_string())
            },
            tip_summary: if subject.is_empty() {
                None
            } else {
                Some(subject.to_string())
            },
            tip_timestamp: ts,
        });
    }

    // Sort: current branch first, then locals (by recency), then
    // remotes (by recency).  Keeps the panel ordered like the user
    // thinks about branches.
    branches.sort_by(|a, b| {
        b.is_current
            .cmp(&a.is_current)
            .then(a.is_remote.cmp(&b.is_remote))
            .then(b.tip_timestamp.cmp(&a.tip_timestamp))
    });

    Ok(branches)
}

/// Parse git's `upstream:track` field into `(ahead, behind)`.
fn parse_upstream_track(track: &str, upstream: &str) -> (Option<u32>, Option<u32>) {
    if upstream.is_empty() {
        return (None, None);
    }
    // "[gone]" → upstream exists in config but the remote ref is
    // missing.  We surface this in the UI as a different state, but
    // the count fields stay None.
    if track.contains("gone") {
        return (None, None);
    }
    // Strip the surrounding brackets if present.
    let inner = track.trim_start_matches('[').trim_end_matches(']');
    let mut a: Option<u32> = None;
    let mut b: Option<u32> = None;
    // "ahead 2, behind 3" / "ahead 2" / "behind 3"
    for chunk in inner.split(',') {
        let mut toks = chunk.trim().split_whitespace();
        match (toks.next(), toks.next()) {
            (Some("ahead"), Some(n)) => a = n.parse().ok(),
            (Some("behind"), Some(n)) => b = n.parse().ok(),
            _ => {}
        }
    }
    // Even-with-upstream: empty track but upstream set.  Both are 0.
    if a.is_none() && b.is_none() && track.is_empty() {
        return (Some(0), Some(0));
    }
    (a.or(Some(0)), b.or(Some(0)))
}

/// Create a new local branch.  Optionally checks it out (`checkout=true`
/// → `git switch -c`); otherwise creates without changing HEAD (`git
/// branch`).  `start_point` defaults to HEAD when None.
#[tauri::command]
pub fn vcs_branch_create(
    vault_path: String,
    name: String,
    start_point: Option<String>,
    checkout: Option<bool>,
) -> Result<VcsStatus, String> {
    let vault = PathBuf::from(&vault_path);
    let n = name.trim();
    if n.is_empty() {
        return Err("branch name is required".to_string());
    }

    if checkout.unwrap_or(false) {
        // `git switch -c <name> [<start>]` — atomic create+checkout.
        let mut args: Vec<&str> = vec!["switch", "-c", n];
        if let Some(sp) = &start_point {
            args.push(sp);
        }
        git_ok(&vault, &args)?;
    } else {
        let mut args: Vec<&str> = vec!["branch", n];
        if let Some(sp) = &start_point {
            args.push(sp);
        }
        git_ok(&vault, &args)?;
    }

    vcs_status(vault_path)
}

/// Switch to an existing branch.  Fails fast with a readable error if
/// the worktree has unstaged changes that would conflict — the UI
/// catches this and prompts the user to stash / commit first.
#[tauri::command]
pub fn vcs_branch_switch(
    vault_path: String,
    name: String,
) -> Result<VcsStatus, String> {
    let vault = PathBuf::from(&vault_path);
    let n = name.trim();
    if n.is_empty() {
        return Err("branch name is required".to_string());
    }
    git_ok(&vault, &["switch", n])?;
    vcs_status(vault_path)
}

/// Delete a local branch.  `force=true` → `git branch -D` (deletes
/// even if unmerged); otherwise `-d` (refuses unmerged branches).
/// The frontend hides the toggle behind a confirmation dialog.
#[tauri::command]
pub fn vcs_branch_delete(
    vault_path: String,
    name: String,
    force: Option<bool>,
) -> Result<VcsStatus, String> {
    let vault = PathBuf::from(&vault_path);
    let n = name.trim();
    if n.is_empty() {
        return Err("branch name is required".to_string());
    }
    let flag = if force.unwrap_or(false) { "-D" } else { "-d" };
    git_ok(&vault, &["branch", flag, n])?;
    vcs_status(vault_path)
}

/// Full graph log — like [`vcs_log`] but with `--all --decorate` so
/// every branch tip + tag is included and each commit knows its refs.
/// Same field separators as `vcs_log`; we add %D (decoration without
/// parens) as a new field at the end so the parser stays simple.
#[tauri::command]
pub fn vcs_log_graph(vault_path: String, limit: u32) -> Result<Vec<GraphCommit>, String> {
    let vault = PathBuf::from(&vault_path);
    let cap = if limit == 0 { 500 } else { limit.min(1000) };
    let n = cap.to_string();

    const F: &str = "\x1f";
    const R: &str = "\x1e";
    let fmt = format!(
        "%H{f}%h{f}%an <%ae>{f}%at{f}%P{f}%s{f}%b{f}%D{r}",
        f = F,
        r = R
    );

    let raw = match git_ok(
        &vault,
        &[
            "log",
            "--all",
            "--date-order",
            "--max-count",
            &n,
            "--format",
            &fmt,
        ],
    ) {
        Ok(s) => s,
        Err(e) => {
            // Unborn HEAD on a brand-new repo — empty graph, not an error.
            if e.contains("does not have any commits yet")
                || e.contains("unknown revision")
                || e.contains("bad default revision")
            {
                return Ok(Vec::new());
            }
            return Err(e);
        }
    };

    let mut commits = Vec::new();
    for record in raw.split(R) {
        let r = record.trim_matches('\n');
        if r.is_empty() {
            continue;
        }
        let fields: Vec<&str> = r.split(F).collect();
        if fields.len() < 8 {
            continue;
        }
        let id = fields[0].to_string();
        let short_id = fields[1].to_string();
        let author = fields[2].to_string();
        let timestamp = fields[3].parse::<i64>().unwrap_or(0);
        let parents: Vec<String> = fields[4]
            .split_whitespace()
            .map(str::to_string)
            .collect();
        let summary = fields[5].to_string();
        let body_raw = fields[6].trim();
        let body = if body_raw.is_empty() {
            None
        } else {
            Some(body_raw.to_string())
        };
        // %D format: "HEAD -> main, origin/main, tag: v0.1.0" (or "").
        // We split on ", " and trim — preserves the "HEAD -> " prefix
        // and "tag: " prefix so the renderer can colour them differently.
        let refs_raw = fields[7].trim();
        let refs: Vec<String> = if refs_raw.is_empty() {
            Vec::new()
        } else {
            refs_raw
                .split(", ")
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        };

        commits.push(GraphCommit {
            id,
            short_id,
            author,
            timestamp,
            summary,
            body,
            parents,
            refs,
        });
    }
    Ok(commits)
}

// ─── Tests ──────────────────────────────────────────────────────────────
//
// Pure-function tests for the bits that DON'T need a real git binary +
// repo — the parsers.  The IPC commands themselves are covered by the
// frontend integration story (stress-test vault) instead of cargo
// test, because they're inherently subprocess-driven.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upstream_track_no_upstream() {
        // No upstream configured → both None.
        assert_eq!(parse_upstream_track("", ""), (None, None));
    }

    #[test]
    fn upstream_track_gone() {
        // Remote deleted the tracked branch → both None.
        assert_eq!(
            parse_upstream_track("[gone]", "origin/main"),
            (None, None)
        );
    }

    #[test]
    fn upstream_track_even() {
        // Even with upstream → both 0.  Track is empty when even.
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
            parse_upstream_track("[behind 5]", "origin/main"),
            (Some(0), Some(5))
        );
    }

    #[test]
    fn upstream_track_both() {
        assert_eq!(
            parse_upstream_track("[ahead 2, behind 7]", "origin/main"),
            (Some(2), Some(7))
        );
    }

    #[test]
    fn classify_xy_modified_unstaged() {
        let mut s = VcsStatus::default();
        classify_xy(".M", "foo.md".to_string(), None, &mut s);
        assert_eq!(s.staged.len(), 0);
        assert_eq!(s.unstaged.len(), 1);
        assert_eq!(s.unstaged[0].path, "foo.md");
        assert_eq!(s.unstaged[0].status, ".M");
    }

    #[test]
    fn classify_xy_added_then_modified() {
        // X=A (added in index), Y=M (modified in worktree) → appears
        // in BOTH staged and unstaged.
        let mut s = VcsStatus::default();
        classify_xy("AM", "bar.md".to_string(), None, &mut s);
        assert_eq!(s.staged.len(), 1);
        assert_eq!(s.staged[0].status, "A.");
        assert_eq!(s.unstaged.len(), 1);
        assert_eq!(s.unstaged[0].status, ".M");
    }

    #[test]
    fn classify_xy_untracked_skipped() {
        // Untracked is handled by the "?" record type, not classify_xy.
        // The function should ignore ?-marked Y/X.
        let mut s = VcsStatus::default();
        classify_xy("??", "new.md".to_string(), None, &mut s);
        assert_eq!(s.staged.len(), 0);
        assert_eq!(s.unstaged.len(), 0);
    }
}
