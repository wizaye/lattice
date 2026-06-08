//! Quartz install + build helpers.
//!
//! Implements the three subprocess calls that drive the publish
//! pipeline:
//!  1. **clone**  — `git clone --depth 1 https://github.com/jackyzha0/quartz.git <dest>`
//!  2. **install** — `npm install` inside `<dest>` (downloads ~150 MB
//!     of Quartz's transitive deps; takes 30-90s depending on cache).
//!  3. **build**   — `npx quartz build` inside `<dest>` (renders
//!     `<dest>/content/**/*.md` into `<dest>/public/`).
//!
//! Every shell-out is routed through [`super::proc::spawn`] so the
//! Windows PATHEXT shim trap (`npm` is a POSIX shell script next to
//! the real `npm.cmd` in Node's installer) cannot misfire.
//!
//! The two long-running commands (`npm install`, `npx quartz build`)
//! capture combined stdout+stderr on completion — we don't stream
//! progress to the UI yet because the IPC handler is `async fn`
//! returning a single `Result`.  Surfacing the first 4 KB of stderr
//! on failure is enough context for a user to act ("network error",
//! "ENOENT: no such file or directory", etc.) without us also having
//! to wire a Tauri event channel in this slice.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use wait_timeout::ChildExt;

use super::proc::spawn;

/// Upstream Quartz repo we clone from.  Pinned in code rather than in
/// `publish.toml` because allowing arbitrary URLs would make it
/// trivial to ship malicious build pipelines via a shared vault.
const QUARTZ_REPO_URL: &str = "https://github.com/jackyzha0/quartz.git";

/// How long we wait for `git clone` before killing the child.  Quartz
/// is ~30 MB shallow-cloned; 3 min covers a slow corporate proxy.
const CLONE_TIMEOUT: Duration = Duration::from_secs(180);

/// `npm install` for Quartz pulls a few hundred packages and can take
/// 60-120s on first run with a cold cache.  10 min cap is defensive.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(600);

/// `npx quartz create` git-clones ~30-45 community plugin repos one at
/// a time (Quartz v5 split plugins out of core).  Each clone is small
/// but the round-trip cost adds up on slow corp links.  15 min is the
/// 95th-percentile budget.
const CREATE_TIMEOUT: Duration = Duration::from_secs(900);

/// `npx quartz plugin install --from-config` builds the just-cloned
/// plugin sources with tsc/esbuild.  Most plugins ship pre-built
/// `dist/` directories so this is fast (<1 min); 10 min cap is defensive.
const PLUGIN_INSTALL_TIMEOUT: Duration = Duration::from_secs(600);

/// Quartz's full-vault build is fast (~5 s for ~500 notes); 5 min is
/// plenty for everything short of pathological vaults.
const BUILD_TIMEOUT: Duration = Duration::from_secs(300);

/// Clone Quartz into `dest`.  Removes any pre-existing `dest/` first
/// so a re-run from a half-finished install can succeed.  After clone
/// completes, deletes `dest/.git` — the Quartz repo's history isn't
/// part of the user's vault and would otherwise show up in their VCS
/// tooling as an unrelated submodule.
pub fn clone_quartz(dest: &Path) -> Result<(), String> {
    if dest.exists() {
        // Wipe the target so `git clone` doesn't fail with
        // "destination path already exists and is not an empty directory".
        std::fs::remove_dir_all(dest)
            .map_err(|e| format!("failed to clear existing {}: {}", dest.display(), e))?;
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create {}: {}", parent.display(), e))?;
    }

    let dest_str = dest.to_string_lossy().to_string();
    let mut cmd = spawn("git");
    cmd.args([
        "clone",
        "--depth",
        "1",
        "--no-tags",
        QUARTZ_REPO_URL,
        &dest_str,
    ])
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());

    run_with_timeout("git clone", cmd, CLONE_TIMEOUT)?;

    // Drop Quartz's git history — it isn't ours and confuses VCS UIs.
    let dot_git = dest.join(".git");
    if dot_git.exists() {
        // best-effort cleanup; if Windows still has a file handle open
        // (rare with --depth 1) we surface a friendly hint rather than
        // erroring the whole flow.
        if let Err(e) = std::fs::remove_dir_all(&dot_git) {
            return Err(format!(
                "cloned Quartz, but failed to remove {} (you can delete it manually): {}",
                dot_git.display(),
                e
            ));
        }
    }

    Ok(())
}

/// Run `npm install` inside `dir`.  Captures combined output for the
/// error message but doesn't stream it — see module-level docs.
pub fn npm_install(dir: &Path) -> Result<(), String> {
    let mut cmd = spawn("npm");
    cmd.current_dir(dir)
        .arg("install")
        // Disable interactive prompts (npm sometimes asks about
        // funding messages or update notifiers); these can hang a
        // headless subprocess on certain corp setups.
        .args(["--no-audit", "--no-fund", "--loglevel=error"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    run_with_timeout("npm install", cmd, INSTALL_TIMEOUT)
}

/// Run `npx quartz build` inside `dir`.  Returns the path to the
/// produced `public/` directory after a successful build, or a
/// detailed error if the build failed (with Quartz's own stderr
/// excerpted — usually a markdown parse error pointing at a vault
/// file).
pub fn npx_quartz_build(dir: &Path) -> Result<PathBuf, String> {
    let mut cmd = spawn("npx");
    cmd.current_dir(dir)
        // `-y` so npx doesn't prompt to install missing packages on
        // first run (it shouldn't need to, since `npm install` ran
        // first, but the flag keeps the subprocess strictly
        // non-interactive).
        .args(["-y", "quartz", "build"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    run_with_timeout("npx quartz build", cmd, BUILD_TIMEOUT)?;

    let public_dir = dir.join("public");
    if !public_dir.is_dir() {
        return Err(format!(
            "quartz build reported success but {} does not exist",
            public_dir.display()
        ));
    }
    Ok(public_dir)
}

/// Run `npx quartz create` non-interactively to materialise the
/// `<dir>/.quartz/` scaffold (plugins + config) that Quartz v5 needs
/// before a build can resolve `../../.quartz/plugins` imports inside
/// upstream `quartz/components/Head.tsx`.  Without this step a fresh
/// clone fails the build with an esbuild "Could not resolve" error
/// at line 7 of Head.tsx.
///
/// Flags chosen so the create command never blocks on a `@clack`
/// prompt:
///   * `-t default` — template choice.  `default` is the lightest
///     starter; we re-populate `content/` from the vault on every
///     build anyway, so the chosen template only affects baseline
///     `quartz.config.yaml` defaults.
///   * `-X new` — setup strategy.  `new` means "empty content folder";
///     this is correct because `publish_build` then writes the
///     filtered vault into `content/`.
///   * `-l shortest` — wikilink resolution strategy (matches Obsidian
///     defaults; most users expect `[[Note]]` to find the file
///     wherever it lives).
///   * `-b localhost` — placeholder baseUrl for the initial config.
///     The real `baseUrl` for a deploy is patched in later by
///     `publish_deploy` when we know which host the user picked.
pub fn quartz_create(dir: &Path) -> Result<(), String> {
    let mut cmd = spawn("npx");
    cmd.current_dir(dir)
        .args([
            "-y", "quartz", "create",
            "-t", "default",
            "-X", "new",
            "-l", "shortest",
            "-b", "localhost",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    run_with_timeout("npx quartz create", cmd, CREATE_TIMEOUT)
}

/// Run `npx quartz plugin install --from-config` inside `dir`.
///
/// Resolves every plugin referenced in `quartz.config.yaml` (the file
/// written by [`quartz_create`]) — clones any that aren't already on
/// disk and builds them (tsc / esbuild).  Idempotent: re-running with
/// no config changes is a fast no-op.
pub fn quartz_plugin_install(dir: &Path) -> Result<(), String> {
    let mut cmd = spawn("npx");
    cmd.current_dir(dir)
        .args(["-y", "quartz", "plugin", "install", "--from-config"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    run_with_timeout("npx quartz plugin install", cmd, PLUGIN_INSTALL_TIMEOUT)
}

/// Idempotently make sure `<dir>` has the Quartz v5 scaffold needed
/// for a build to succeed: `.quartz/plugins/` must exist (otherwise
/// upstream `Head.tsx`'s `import { CustomOgImagesEmitterName } from
/// "../../.quartz/plugins"` fails to resolve).
///
/// Lets `publish_build` self-heal an install that was scaffolded with
/// an older build of Lattice (or interrupted mid-init) without
/// requiring the user to delete `.lattice/publish/` and re-run the
/// publishing wizard.
pub fn ensure_scaffold(dir: &Path) -> Result<(), String> {
    let plugins_dir = dir.join(".quartz").join("plugins");
    if plugins_dir.is_dir() {
        return Ok(());
    }
    quartz_create(dir)?;
    quartz_plugin_install(dir)?;
    if !plugins_dir.is_dir() {
        return Err(format!(
            "quartz create reported success but {} still does not exist — \
             try deleting {} and re-running the publishing wizard.",
            plugins_dir.display(),
            dir.display()
        ));
    }
    Ok(())
}

/// Spawn the command, wait up to `timeout`, and report failure with
/// the last 4 KB of stderr so the UI gets actionable context.
fn run_with_timeout(label: &str, mut cmd: std::process::Command, timeout: Duration) -> Result<(), String> {
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            // The PATHEXT-aware spawn already tried hard; if we still
            // don't find the binary, give the user actionable advice.
            format!(
                "could not find the binary required for `{label}`. \
                 Please confirm Node.js, npm, and git are installed and on PATH."
            )
        } else {
            format!("{label}: spawn failed: {e}")
        }
    })?;

    match child.wait_timeout(timeout) {
        Ok(Some(status)) => {
            // Drain whatever the child printed (we ignore read errors —
            // a missing pipe is harmless after the child exits).
            let stdout = drain(child.stdout.take());
            let stderr = drain(child.stderr.take());
            if status.success() {
                Ok(())
            } else {
                let mut combined = String::new();
                if !stderr.is_empty() {
                    combined.push_str(&truncate_tail(&stderr, 4096));
                }
                if combined.is_empty() && !stdout.is_empty() {
                    combined.push_str(&truncate_tail(&stdout, 4096));
                }
                if combined.is_empty() {
                    combined.push_str("(no output captured)");
                }
                Err(format!(
                    "{label} exited with {:?}\n--- stderr ---\n{}",
                    status.code(),
                    combined
                ))
            }
        }
        Ok(None) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(format!(
                "{label} timed out after {}s",
                timeout.as_secs()
            ))
        }
        Err(e) => {
            let _ = child.kill();
            Err(format!("{label}: wait failed: {e}"))
        }
    }
}

fn drain<R: std::io::Read>(reader: Option<R>) -> String {
    let Some(mut r) = reader else {
        return String::new();
    };
    let mut buf = Vec::new();
    let _ = r.read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).into_owned()
}

/// Keep the last `n` characters of `s` (npm install logs can be
/// hundreds of KB; only the tail matters for diagnosis).
fn truncate_tail(s: &str, n: usize) -> String {
    if s.len() <= n {
        return s.to_string();
    }
    let start = s.len() - n;
    // Walk forward to a char boundary so we don't slice a UTF-8 byte.
    let mut idx = start;
    while idx < s.len() && !s.is_char_boundary(idx) {
        idx += 1;
    }
    format!("…(truncated, last {} bytes shown)\n{}", n, &s[idx..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_keeps_short_strings_intact() {
        assert_eq!(truncate_tail("hello", 100), "hello");
    }

    #[test]
    fn truncate_trims_long_strings_to_tail() {
        let long = "z".repeat(5000);
        let out = truncate_tail(&long, 100);
        assert!(out.contains("(truncated"));
        // tail should be exactly 100 'z's after the marker
        // ('z' chosen so it doesn't appear in the truncation message).
        let tail_zzz: String = out.chars().filter(|c| *c == 'z').collect();
        assert_eq!(tail_zzz.len(), 100);
    }

    #[test]
    fn truncate_respects_utf8_char_boundaries() {
        // Pad with ascii then end with a multi-byte char.
        let mut s = "x".repeat(5000);
        s.push('é'); // 2 bytes
        // Should not panic.
        let _ = truncate_tail(&s, 1);
    }
}
