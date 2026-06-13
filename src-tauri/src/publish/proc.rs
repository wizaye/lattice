//! Shared subprocess helpers for the publish slice.
//!
//! Centralises the **Windows PATHEXT trap** workaround used by every
//! `Command::new(...)` call inside `publish/*`: `std::process::Command`
//! on Windows talks to `CreateProcessW` directly and does NOT walk
//! `PATHEXT` the way `cmd.exe` does, so bare `Command::new("npm")`
//! fails with `ErrorKind::NotFound` even when `npm.cmd` is on PATH.
//!
//! Two distinct shipped fixes converged into this helper:
//!
//! 1. **PATHEXT-first resolution** — Node's Windows installer drops
//!    BOTH `npm` (a 2 KB POSIX `#!/bin/sh` shebang script) AND
//!    `npm.cmd` (the real Windows shim) into `C:\Program Files\nodejs\`.
//!    A naive "bare name first" walk silently picks the POSIX text
//!    file, which `CreateProcessW` cannot execute, reproducing the
//!    exact "npm not found" symptom this code is meant to eliminate.
//!    We follow cmd.exe semantics — PATHEXT comes first when no
//!    extension was supplied; bare-name only when the caller passed
//!    e.g. `"git.exe"` explicitly.
//! 2. **CREATE_NO_WINDOW** — spawning a `.cmd` from a windowed app
//!    flashes a console flicker; the same flag the VCS git runner
//!    uses (`src-tauri/src/git.rs::run`) suppresses it.
//!
//! These helpers are crate-public so the publish module's
//! `node_probe`, `quartz`, and any future shell-out site share a
//! single resolver — preventing the bug from being reintroduced
//! per-call-site.

use std::path::PathBuf;
use std::process::{Command, Stdio};

/// Build a [`Command`] for `bin` with the Windows PATHEXT shim trap
/// + console-flicker fix applied.  On non-Windows targets it's a
/// direct passthrough to `Command::new(bin)` — POSIX shells resolve
/// PATH themselves, and there's no `.cmd` story.
///
/// The returned command has stdout/stderr inherited from the parent
/// (use `.stdout(Stdio::piped())` to capture output for parsing).
pub fn spawn(bin: &str) -> Command {
    #[cfg(windows)]
    {
        if let Some(resolved) = resolve_on_path_windows(bin) {
            let mut cmd = Command::new(resolved);
            apply_no_window(&mut cmd);
            return cmd;
        }
        // Fallback to a bare spawn so reparse-point / junction shims
        // still get a chance.  Reaches this branch on machines where
        // PATH walk found nothing but a custom shim setup might still
        // dispatch.
        let mut cmd = Command::new(bin);
        apply_no_window(&mut cmd);
        cmd
    }
    #[cfg(not(windows))]
    {
        Command::new(bin)
    }
}

/// Like [`spawn`] but pre-configures piped stdout + stderr for
/// callers that want to capture output (e.g. streaming `npm install`
/// progress to the UI).  Currently unused at the call sites that
/// already roll their own `Stdio::piped()` chain; kept available so
/// new shell-out spots don't re-roll the same boilerplate.
#[allow(dead_code)]
pub fn spawn_piped(bin: &str) -> Command {
    let mut cmd = spawn(bin);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd
}

/// Walk `PATH` × `PATHEXT` and return the first matching candidate.
///
/// **PATHEXT-before-bare-name is critical.**  See module-level docs.
/// Returns `None` when nothing resolves — caller should fall back to
/// a bare spawn so the OS still gets a chance (reparse-point shims).
#[cfg(windows)]
pub fn resolve_on_path_windows(bin: &str) -> Option<PathBuf> {
    let pathext =
        std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    let path = std::env::var_os("PATH")?;
    let has_ext = std::path::Path::new(bin).extension().is_some();
    for dir in std::env::split_paths(&path) {
        if has_ext {
            let direct = dir.join(bin);
            if direct.is_file() {
                return Some(direct);
            }
        }
        for ext in pathext.split(';') {
            let ext = ext.trim();
            if ext.is_empty() {
                continue;
            }
            let candidate = dir.join(format!("{bin}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// On non-Windows builds this is `None` — POSIX `PATH` is resolved by
/// the kernel's `execvp(3)` so the helper isn't called.  Provided for
/// callers that want to log "which binary did we actually launch?"
/// without `#[cfg]` gating.
#[cfg(not(windows))]
#[allow(dead_code)]
pub fn resolve_on_path_windows(_bin: &str) -> Option<PathBuf> {
    None
}

/// Suppress the console-window flash that `.cmd` spawns produce in a
/// Tauri WebView session.  Same flag pattern the VCS git runner uses.
#[cfg(windows)]
pub fn apply_no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

/// No-op on non-Windows builds — kept as a free function so call
/// sites don't need `#[cfg]` blocks around every spawn.
#[cfg(not(windows))]
#[allow(dead_code)]
pub fn apply_no_window(_cmd: &mut Command) {}

// ─── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression: `resolve_on_path_windows("npm")` must NOT return
    /// the extensionless POSIX shell script `C:\Program Files\nodejs\npm`;
    /// it must return the `.cmd` (or another PATHEXT extension).  This
    /// is the exact bug the resolver was written to fix.
    #[cfg(windows)]
    #[test]
    fn resolves_npm_to_pathext_not_posix_script() {
        // Only meaningful on hosts that actually have Node installed.
        // Probe `node` via a piped spawn — same code path
        // production uses.
        let node_present = match spawn("node").arg("--version").output() {
            Ok(out) => out.status.success(),
            Err(_) => false,
        };
        if !node_present {
            eprintln!("skipping: no Node on PATH on this host");
            return;
        }
        let resolved = resolve_on_path_windows("npm");
        let Some(path) = resolved else {
            panic!("npm not found on PATH despite node being present");
        };
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase());
        assert!(
            matches!(ext.as_deref(), Some("cmd") | Some("bat") | Some("exe")),
            "expected PATHEXT-suffixed shim, got {:?}",
            path
        );
    }
}
