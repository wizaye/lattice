//! Node / npm / npx probe.
//!
//! Quartz v5 requires Node ≥ v22.0.0 and npm ≥ v10.9.2.  Before we
//! kick off any publishing setup we need to know the user has those on
//! PATH — otherwise the failure surfaces deep inside `npx quartz build`
//! 30 seconds later with a cryptic engine error.  Doing the probe at
//! wizard step 1 means the user gets a clear "install Node 22" toast
//! before any auth dance happens.
//!
//! This module is intentionally `std::process::Command`-only.  We do
//! NOT depend on `tauri-plugin-shell` yet — that comes in phase D3
//! when we need streaming stdout from `npx quartz build`.  A single
//! one-shot `--version` call is fast enough to do synchronously inside
//! a Tauri command (~50 ms on Windows) and avoids pulling the shell
//! plugin's permissions surface into the D1 capability set.

use std::process::Command;

use serde::Serialize;

/// Result of [`probe`].  Sent over IPC to the wizard's "Check
/// prerequisites" step.  All four fields are populated even on
/// failure so the UI can show the partial information ("we found Node
/// v20 but not npm — and v20 is too old for Quartz v5 anyway").
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeReport {
    /// `"v22.11.0"` or empty when not found.  Captured as-printed from
    /// `node --version`.
    pub node: String,
    /// `"10.9.2"` or empty when not found.  npm does NOT print a
    /// leading "v" so we keep the bare form.
    pub npm: String,
    /// True when `npx --version` succeeds.  npx ships with npm so this
    /// is almost always `true` when npm is `Some`, but we test it
    /// independently because some corporate installs strip it.
    pub npx: bool,
    /// True iff Node ≥ v22.0.0 AND npm ≥ v10.9.2 AND npx present.
    /// The wizard uses this single bool to enable the "Continue" button.
    pub ok: bool,
    /// Human-friendly reason when `ok=false`.  Pre-formatted for direct
    /// rendering in a toast / wizard banner — no further string work
    /// needed in the frontend.
    pub reason: Option<String>,
}

/// Minimum versions per Quartz v5 release notes.  Centralised here so a
/// future Quartz bump only needs to change two integers.
const MIN_NODE: SemVer = SemVer {
    major: 22,
    minor: 0,
    patch: 0,
};
const MIN_NPM: SemVer = SemVer {
    major: 10,
    minor: 9,
    patch: 2,
};

/// Spawn `node --version`, `npm --version`, `npx --version` and decide
/// whether the env meets Quartz v5's floor.  Never panics — every
/// failure mode flows into `reason`.
pub fn probe() -> ProbeReport {
    let node = run_version("node");
    let npm = run_version("npm");
    let npx = run_silently("npx");

    let mut reasons: Vec<String> = Vec::new();

    if node.is_empty() {
        reasons.push("Node.js was not found on PATH".to_string());
    } else if let Some(v) = SemVer::parse_lenient(&node) {
        if v < MIN_NODE {
            reasons.push(format!(
                "Node {} is too old — Quartz v5 needs ≥ v{}",
                node, MIN_NODE
            ));
        }
    } else {
        reasons.push(format!("Could not parse Node version '{}'", node));
    }

    if npm.is_empty() {
        reasons.push("npm was not found on PATH".to_string());
    } else if let Some(v) = SemVer::parse_lenient(&npm) {
        if v < MIN_NPM {
            reasons.push(format!(
                "npm {} is too old — Quartz v5 needs ≥ {}",
                npm, MIN_NPM
            ));
        }
    } else {
        reasons.push(format!("Could not parse npm version '{}'", npm));
    }

    if !npx {
        reasons.push("npx was not found on PATH".to_string());
    }

    let ok = reasons.is_empty();
    let reason = if ok { None } else { Some(reasons.join("; ")) };

    ProbeReport {
        node,
        npm,
        npx,
        ok,
        reason,
    }
}

/// Run `<bin> --version` and return its stdout trimmed.  Empty string
/// on any failure (binary not found, non-zero exit, non-UTF-8).
fn run_version(bin: &str) -> String {
    match spawn(bin).arg("--version").output() {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).trim().to_string(),
        _ => String::new(),
    }
}

/// Like [`run_version`] but only cares about success/failure.
fn run_silently(bin: &str) -> bool {
    match spawn(bin).arg("--version").output() {
        Ok(out) => out.status.success(),
        Err(_) => false,
    }
}

/// Build a [`Command`] for `bin`, resolving Windows PATHEXT shims so
/// `npm` / `npx` (which ship as `npm.cmd` / `npx.cmd`) are found the
/// same way cmd / PowerShell find them.  `std::process::Command::new`
/// on Windows talks to `CreateProcessW` directly and does NOT walk
/// PATHEXT — bare `Command::new("npm")` fails with `NotFound` even
/// though `npm --version` works in a terminal.  This was the
/// publish-probe "npm not found" bug reported by users with a working
/// Node install.
///
/// On non-Windows targets the binary name is used verbatim — every
/// supported shell resolves PATH itself, and there's no PATHEXT story.
fn spawn(bin: &str) -> Command {
    #[cfg(windows)]
    {
        if let Some(resolved) = resolve_on_path_windows(bin) {
            let mut cmd = Command::new(resolved);
            apply_no_window(&mut cmd);
            return cmd;
        }
        let mut cmd = Command::new(bin);
        apply_no_window(&mut cmd);
        cmd
    }
    #[cfg(not(windows))]
    {
        Command::new(bin)
    }
}

/// Walk `PATH` × `PATHEXT` looking for `bin` and return the first
/// match.  Returns `None` when nothing resolves — caller falls back to
/// a bare spawn so the OS still gets a chance (eg. when the user has
/// shimmed `npm` via a Reparse Point).
///
/// **PATHEXT-before-bare-name is critical when `bin` has no extension.**
/// Node.js's Windows installer drops *both* `npm` (a 2073-byte POSIX
/// shell script with a `#!/bin/sh` shebang) *and* `npm.cmd` (the real
/// Windows shim) into `C:\Program Files\nodejs\`.  A naive
/// "bare name first" walk would resolve to the POSIX script, and
/// `CreateProcessW` on a `#!`-prefixed text file fails with
/// `%1 is not a valid Win32 application`.  This exact misfire was the
/// "npm not found despite working install" bug reported in the wizard.
///
/// `cmd.exe` itself never matches a bare name when no extension is
/// supplied — it walks PATHEXT and stops there.  We follow the same
/// rule, with a single concession: if the caller passes an
/// already-suffixed name (`node.exe`), we try that bare path first so
/// we don't accidentally prefer some sibling `node.exe.cmd`.
#[cfg(windows)]
fn resolve_on_path_windows(bin: &str) -> Option<std::path::PathBuf> {
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

/// Suppress the brief console flash WebView2 users see when we spawn a
/// `.cmd` shim — matches the `CREATE_NO_WINDOW` flag the `git` runner
/// uses in `src-tauri/src/git.rs`.
#[cfg(windows)]
fn apply_no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

// ─── Tiny semver helper ──────────────────────────────────────────────────
//
// We intentionally don't pull the `semver` crate for this — parsing
// `MAJOR.MINOR.PATCH` ignoring the `v` prefix and any pre-release tail
// is one screen of code, and adding a dep for it would be the largest
// thing in the D1 commit by transitive count.

#[derive(Copy, Clone, Eq, PartialEq, Ord, PartialOrd, Debug)]
struct SemVer {
    major: u32,
    minor: u32,
    patch: u32,
}

impl std::fmt::Display for SemVer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

impl SemVer {
    /// Parse a lenient semver — accepts `"v22.11.0"`, `"22.11.0"`,
    /// `"22.11.0-rc.1"`, `"22.11.0+build.123"`.  Returns `None` for
    /// anything we can't reliably interpret as a semver triple.
    fn parse_lenient(s: &str) -> Option<Self> {
        let s = s.trim();
        let s = s.strip_prefix('v').unwrap_or(s);
        // Strip pre-release ("-rc.1") and build metadata ("+sha.123").
        let core = s.split(['-', '+']).next().unwrap_or(s);
        let mut parts = core.split('.');
        let major = parts.next()?.parse::<u32>().ok()?;
        let minor = parts.next()?.parse::<u32>().ok()?;
        let patch = parts.next()?.parse::<u32>().ok()?;
        Some(SemVer {
            major,
            minor,
            patch,
        })
    }
}

// ─── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_parses_v_prefix() {
        let v = SemVer::parse_lenient("v22.11.0").unwrap();
        assert_eq!((v.major, v.minor, v.patch), (22, 11, 0));
    }

    #[test]
    fn semver_parses_bare_triple() {
        let v = SemVer::parse_lenient("10.9.2").unwrap();
        assert_eq!((v.major, v.minor, v.patch), (10, 9, 2));
    }

    #[test]
    fn semver_strips_prerelease_and_build() {
        let v = SemVer::parse_lenient("v22.0.0-rc.1+sha.abc").unwrap();
        assert_eq!((v.major, v.minor, v.patch), (22, 0, 0));
    }

    #[test]
    fn semver_rejects_garbage() {
        assert!(SemVer::parse_lenient("").is_none());
        assert!(SemVer::parse_lenient("hello").is_none());
        assert!(SemVer::parse_lenient("22").is_none()); // need full triple
        assert!(SemVer::parse_lenient("22.11").is_none());
    }

    #[test]
    fn semver_orders_correctly() {
        let old = SemVer::parse_lenient("v20.10.0").unwrap();
        let new = SemVer::parse_lenient("v22.0.0").unwrap();
        assert!(old < new);
        assert!(old < MIN_NODE);
        assert!(new == MIN_NODE);
    }

    #[test]
    fn npm_version_floor_check_works() {
        // Boundary cases around the npm minimum (10.9.2).
        let low = SemVer::parse_lenient("10.9.1").unwrap();
        let exact = SemVer::parse_lenient("10.9.2").unwrap();
        let high = SemVer::parse_lenient("11.0.0").unwrap();
        assert!(low < MIN_NPM);
        assert_eq!(exact, MIN_NPM);
        assert!(high > MIN_NPM);
    }

    /// Smoke test: the probe runs without panicking on whatever host
    /// the test suite is on.  We don't assert `ok=true` — the CI box
    /// may or may not have node 22 — but we assert the report shape is
    /// always populated.
    #[test]
    fn probe_runs_without_panicking() {
        let r = probe();
        // node / npm strings are populated XOR a reason explains absence
        if r.node.is_empty() {
            assert!(r.reason.as_deref().unwrap_or("").contains("Node"));
        }
        if r.npm.is_empty() {
            assert!(r.reason.as_deref().unwrap_or("").contains("npm"));
        }
        // ok must be consistent with reason
        assert_eq!(r.ok, r.reason.is_none());
    }

    /// Regression: on Windows, `C:\Program Files\nodejs\` ships both
    /// `npm` (a POSIX `#!/bin/sh` script with NO extension) and
    /// `npm.cmd` (the real Windows shim).  A naive "bare name first"
    /// PATH walk would return the extensionless POSIX script, which
    /// `CreateProcessW` cannot execute.  This test guarantees we keep
    /// preferring PATHEXT candidates when no extension was supplied.
    #[cfg(windows)]
    #[test]
    fn resolves_npm_to_cmd_shim_not_posix_script() {
        // Skip when this host has no npm on PATH (CI without Node).
        if run_version("node").is_empty() {
            eprintln!("skipping: no node on PATH on this host");
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
            "expected npm to resolve to a Windows-executable extension, got {:?}",
            path
        );
    }
}
