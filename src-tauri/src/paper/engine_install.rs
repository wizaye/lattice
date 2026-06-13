//! Preflight: probe + install a local LaTeX engine.
//!
//! Backs `paper_engine_probe` + `paper_engine_install`.  Lets the
//! New-Paper modal (and the per-paper toolbar) detect a missing
//! engine BEFORE the user picks "PDF" as the output and hits Create,
//! so we never dead-end them with a folder + no usable artefact.
//!
//! ## Why Tectonic
//!
//! We default to **Tectonic** as the recommended engine:
//!  - Single self-contained binary (no 4 GB MiKTeX / TeX Live install).
//!  - On-demand package fetching — vanilla `\documentclass{article}`
//!    works out of the box without `tlmgr install` rituals.
//!  - Available as a single prebuilt binary from GitHub releases
//!    (Windows / macOS / Linux), plus Homebrew (`brew install
//!    tectonic`) and apt-get on recent Ubuntu.
//!
//! Users who already have MiKTeX / TeX Live get auto-detected first
//! (the existing `pick_engine()` priority order); the install path is
//! only taken when NO engine is on PATH.
//!
//! ## Why direct download instead of winget on Windows
//!
//! Tectonic is NOT in the winget catalog (verified 2026-06-09 against
//! winget 1.28 — `winget search tectonic` returns
//! `APPINSTALLER_CLI_ERROR_NO_APPLICATIONS_FOUND`).  The official
//! Tectonic install docs recommend a direct download from GitHub
//! releases.  We do exactly that: fetch the latest x86_64 MSVC zip
//! from `github.com/tectonic-typesetting/tectonic/releases/latest`,
//! extract `tectonic.exe` into `%LOCALAPPDATA%\Lattice\bin\`, and
//! prepend that dir to the process PATH so the current Lattice
//! session sees it immediately.  `lib.rs::run` also prepends it at
//! startup so subsequent launches pick it up automatically.
//!
//! ## Why we don't bundle a tectonic sidecar
//!
//! The Tectonic Windows release is ~30 MB compressed, ~80 MB on disk.
//! Bundling it into every Lattice installer would bloat downloads for
//! the >50% of users who never compile a paper.  Fetching on first
//! use is the right tradeoff: install is opt-in, the binary is on
//! PATH so any other tool (CI, `tectonic main.tex` from a terminal)
//! sees it, and updates are easy (delete + re-install).

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use wait_timeout::ChildExt;

use crate::publish::proc::spawn;

/// Result of `paper_engine_probe`.  Mirrors the existing
/// `EngineKind` enum but uses string ids so the UI can rev the engine
/// list without touching the IPC shape.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineProbe {
    /// True iff at least one of the supported engines is on PATH.
    pub any_engine: bool,
    /// Stable id of the engine the compile pipeline would actually
    /// pick (matches the priority order in `compile::pick_engine`).
    /// `None` when `any_engine` is false.
    pub preferred: Option<String>,
    /// Per-engine availability so the UI can render a checklist.
    pub engines: Vec<EngineAvailability>,
    /// Which installer we'd invoke for `paper_engine_install` on this
    /// host.  `None` means the user has to install manually (and the
    /// install command will return a friendly error).
    pub installer: Option<EngineInstaller>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineAvailability {
    /// Binary name (`tectonic`, `latexmk`, …).
    pub binary: String,
    pub available: bool,
}

/// What strategy we'd use to install Tectonic.  Drives the install
/// command + the user-facing label ("Download Tectonic (~30 MB)",
/// "Install with Homebrew", …).
#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EngineInstaller {
    /// Direct HTTPS download from the official Tectonic GitHub
    /// release into `%LOCALAPPDATA%\Lattice\bin\tectonic.exe` (or the
    /// equivalent on other OSes).  Used on Windows because Tectonic
    /// is NOT in the winget catalog.
    Direct,
    /// `brew install tectonic` (macOS / Linuxbrew).
    Homebrew,
    /// `apt-get install -y tectonic` (Debian / Ubuntu — only available
    /// in Ubuntu 24.04+; older releases need a snap).
    Apt,
    /// `cargo install tectonic` (Rust toolchain present, any OS).
    /// Last-ditch fallback when no platform package manager is on PATH.
    Cargo,
}

impl EngineInstaller {
    pub fn label(self) -> &'static str {
        match self {
            EngineInstaller::Direct => "direct download",
            EngineInstaller::Homebrew => "Homebrew",
            EngineInstaller::Apt => "apt-get",
            EngineInstaller::Cargo => "cargo",
        }
    }
}

/// Engines we consider — same priority order as
/// [`crate::paper::compile::pick_engine`].
const KNOWN_ENGINES: &[&str] = &["tectonic", "latexmk", "pdflatex", "xelatex"];

// ─── Probe ──────────────────────────────────────────────────────────────

/// `paper_engine_probe` — fast read-only check.  Spawns a `--version`
/// probe per engine in parallel-ish (sequential, but each probe caps
/// at 5 s so the worst-case wall time is ~5 s for a no-engine box).
#[tauri::command]
pub async fn paper_engine_probe() -> Result<EngineProbe, String> {
    // Off the tokio runtime — `spawn().--version` is blocking I/O and
    // we don't want to stall the IPC executor while a corp-locked-down
    // Windows box takes 4 s to respond to the OS-level CreateProcess.
    let probe = tokio::task::spawn_blocking(probe_blocking)
        .await
        .map_err(|e| format!("paper_engine_probe join error: {e}"))?;
    Ok(probe)
}

/// Internal blocking probe — public so `paper::paper_preflight` can
/// reuse the same engine-detection logic without an extra IPC round-trip.
pub(crate) fn probe_blocking() -> EngineProbe {
    let engines: Vec<EngineAvailability> = KNOWN_ENGINES
        .iter()
        .map(|bin| EngineAvailability {
            binary: (*bin).to_string(),
            available: is_on_path(bin),
        })
        .collect();
    let preferred = engines
        .iter()
        .find(|e| e.available)
        .map(|e| e.binary.clone());
    EngineProbe {
        any_engine: preferred.is_some(),
        preferred,
        engines,
        installer: detect_installer(),
    }
}

/// Returns true iff `bin --version` exits successfully within 5 s.
///
/// Routes through `publish::proc::spawn` so the PATHEXT shim trap
/// (Windows resolving `tectonic` to `tectonic.bat` instead of
/// `tectonic.exe`) doesn't bite.
fn is_on_path(bin: &str) -> bool {
    let mut cmd = spawn(bin);
    cmd.arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => return false,
    };
    match child.wait_timeout(Duration::from_secs(5)) {
        Ok(Some(status)) => status.success(),
        Ok(None) => {
            let _ = child.kill();
            false
        }
        Err(_) => false,
    }
}

/// Decide which install strategy to use on this host.
/// Order: Direct download (Windows — winget doesn't have tectonic) >
/// native OS pm (brew on macOS, apt-get on Debian) > Cargo (works
/// anywhere with the Rust toolchain).
fn detect_installer() -> Option<EngineInstaller> {
    #[cfg(target_os = "windows")]
    {
        // Direct download is the supported path on Windows because
        // Tectonic is not published to the winget catalog.  Cargo
        // is technically possible but requires a full Rust toolchain
        // + MSVC build tools — way too much for "install tectonic".
        Some(EngineInstaller::Direct)
    }
    #[cfg(target_os = "macos")]
    {
        if is_on_path("brew") {
            return Some(EngineInstaller::Homebrew);
        }
        if is_on_path("cargo") {
            return Some(EngineInstaller::Cargo);
        }
        // Direct download also works on macOS (GitHub release ships
        // a darwin tarball) — wire that up if/when a user asks.
        None
    }
    #[cfg(all(target_os = "linux"))]
    {
        // Prefer Homebrew if the user has Linuxbrew (most common path
        // for "modern" CLI installs); fall back to apt-get on
        // Debian/Ubuntu, then Cargo.
        if is_on_path("brew") {
            return Some(EngineInstaller::Homebrew);
        }
        if is_on_path("apt-get") {
            return Some(EngineInstaller::Apt);
        }
        if is_on_path("cargo") {
            return Some(EngineInstaller::Cargo);
        }
        None
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        None
    }
}

// ─── Install ────────────────────────────────────────────────────────────

/// Hard cap for the install subprocess.  Tectonic via winget downloads
/// ~30 MB on first run; brew can take longer if it needs to bootstrap
/// dependencies; cargo build-from-source is the worst case (~5 min on
/// a fresh Rust toolchain).  10 min covers all three with margin.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(600);

/// `paper_engine_install` — install Tectonic via the OS package
/// manager (or cargo as a last resort).  Re-probes on success and
/// returns the new `EngineProbe` so the UI can update without a
/// second round-trip.
///
/// Errors:
///   * No installer detected — returns a friendly message pointing
///     the user at the manual install URL.
///   * Install command failed — returns the tail of the subprocess
///     stderr so the user can diagnose (e.g. winget package not
///     found because the OS is too old, brew permission denied, …).
///   * Install command succeeded but the engine is still not on PATH —
///     returns a "shell restart needed" hint (some package managers
///     append to PATH only in new shells).
#[tauri::command]
pub async fn paper_engine_install() -> Result<EngineProbe, String> {
    tokio::task::spawn_blocking(install_blocking)
        .await
        .map_err(|e| format!("paper_engine_install join error: {e}"))?
}

fn install_blocking() -> Result<EngineProbe, String> {
    // Re-probe up front: if some other process installed an engine
    // since the modal opened, skip the install entirely.  Idempotent
    // is friendlier than re-running the installer on every click.
    let initial = probe_blocking();
    if initial.any_engine {
        return Ok(initial);
    }

    let installer = initial.installer.ok_or_else(|| {
        "No installer available on this host (no winget / brew / apt-get / \
         cargo and no Windows binary release). \
         Install Tectonic manually from https://tectonic-typesetting.github.io/install \
         then click Re-check engine."
            .to_string()
    })?;

    // Direct download is a different shape from the subprocess
    // installers (HTTPS GET + zip extract — no child process to wait
    // on), so split it out.  Everything else still goes through the
    // subprocess path.
    if matches!(installer, EngineInstaller::Direct) {
        install_direct_blocking()?;
    } else {
        run_subprocess_install(installer)?;
    }

    // Re-probe.  If the engine still isn't on PATH, the install
    // succeeded but the current Lattice process inherited a stale PATH
    // env — point the user at the fix (restart Lattice or open a fresh
    // shell to re-inherit).  The Direct path prepends our bin dir to
    // the process PATH inside the same call, so this only ever trips
    // for the package-manager installers.
    let after = probe_blocking();
    if !after.any_engine {
        return Err(format!(
            "{label} reported success but no LaTeX engine is on PATH yet. \
             Quit and re-launch Lattice so it can pick up the updated PATH \
             (some installers only update new shells).",
            label = installer.label()
        ));
    }
    Ok(after)
}

/// Run a package-manager install (brew / apt-get / cargo) end-to-end:
/// spawn, wait with timeout, drain stdio, surface a friendly error on
/// non-zero exit.
fn run_subprocess_install(installer: EngineInstaller) -> Result<(), String> {
    let (label, mut cmd) = build_install_cmd(installer);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("{label}: spawn failed: {e}"))?;
    match child.wait_timeout(INSTALL_TIMEOUT) {
        Ok(Some(status)) => {
            let mut stdout_buf = Vec::new();
            let mut stderr_buf = Vec::new();
            if let Some(mut s) = child.stdout.take() {
                let _ = std::io::Read::read_to_end(&mut s, &mut stdout_buf);
            }
            if let Some(mut s) = child.stderr.take() {
                let _ = std::io::Read::read_to_end(&mut s, &mut stderr_buf);
            }
            if !status.success() {
                let stderr = String::from_utf8_lossy(&stderr_buf);
                let stdout = String::from_utf8_lossy(&stdout_buf);
                return Err(format!(
                    "{label} exited with {:?}\n--- stdout ---\n{}\n--- stderr ---\n{}",
                    status.code(),
                    tail(&stdout, 2048),
                    tail(&stderr, 2048),
                ));
            }
            Ok(())
        }
        Ok(None) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(format!(
                "{label} timed out after {}s (install can be slow on first run; \
                 re-try, or install Tectonic manually from \
                 https://tectonic-typesetting.github.io/install)",
                INSTALL_TIMEOUT.as_secs()
            ))
        }
        Err(e) => {
            let _ = child.kill();
            Err(format!("{label}: wait failed: {e}"))
        }
    }
}

/// Build the install Command for one of the subprocess-based
/// installers.  Returns a human label for error messages.  Note that
/// `EngineInstaller::Direct` is handled separately via
/// `install_direct_blocking` and never reaches this function.
fn build_install_cmd(installer: EngineInstaller) -> (&'static str, Command) {
    match installer {
        EngineInstaller::Direct => {
            // Not used — `install_blocking` dispatches Direct to
            // `install_direct_blocking` before reaching this function.
            // Keep the arm so the match stays exhaustive.
            unreachable!("Direct installer is handled by install_direct_blocking")
        }
        EngineInstaller::Homebrew => {
            let mut cmd = spawn("brew");
            cmd.args(["install", "tectonic"]);
            ("brew install tectonic", cmd)
        }
        EngineInstaller::Apt => {
            // `apt-get` typically needs sudo — we run as the user, so
            // if the policy requires root the install will fail with a
            // permission error that's surfaced in the stderr tail.
            // Documenting this is friendlier than silently dropping.
            let mut cmd = spawn("apt-get");
            cmd.args(["install", "-y", "tectonic"]);
            ("apt-get install tectonic", cmd)
        }
        EngineInstaller::Cargo => {
            let mut cmd = spawn("cargo");
            cmd.args(["install", "tectonic", "--locked"]);
            ("cargo install tectonic", cmd)
        }
    }
}

fn tail(s: &str, n: usize) -> String {
    if s.len() <= n {
        return s.to_string();
    }
    let start = s.len() - n;
    let mut idx = start;
    while idx < s.len() && !s.is_char_boundary(idx) {
        idx += 1;
    }
    s[idx..].to_string()
}

// ─── Direct download (Windows) ──────────────────────────────────────────

/// Tectonic GitHub release we pin to.  Bump this when a new release
/// has been smoke-tested with the Lattice paper pipeline.
///
/// Pinning (vs always-latest via the GitHub `releases/latest` API) is
/// deliberate:
///   * No GitHub API rate-limit risk on cold-start installs.
///   * Reproducible — every Lattice build of the same commit installs
///     the exact same tectonic binary.
///   * Fast — one HTTP GET instead of API call + asset GET.
const TECTONIC_PINNED_VERSION: &str = "0.16.9";

/// Asset filename for the pinned Windows x86_64 MSVC build.  The
/// GitHub release also ships a `-gnu` flavour; MSVC is the canonical
/// one and works on arm64 Windows under x86_64 emulation.
#[cfg(target_os = "windows")]
const TECTONIC_WINDOWS_ASSET: &str = "tectonic-0.16.9-x86_64-pc-windows-msvc.zip";

/// User-Agent header.  GitHub rejects requests with no UA on some
/// endpoints; setting a real value also makes server-side debugging
/// possible if Tectonic ever needs to investigate Lattice traffic.
const HTTP_USER_AGENT: &str = "Lattice/1.0 (+https://github.com/vijaygatla/lattice)";

/// Hard cap for the direct download.  A ~30 MB zip over a 1 Mbps
/// corp-throttled link takes ~4 min; 8 is comfortable headroom.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(8 * 60);

/// `%LOCALAPPDATA%\Lattice\bin\` (Windows) / `~/.local/share/Lattice/
/// bin/` (Linux) / `~/Library/Application Support/Lattice/bin/`
/// (macOS).  Used both by `install_direct_blocking` to drop the
/// downloaded binary AND by `lib.rs::run` at startup to prepend the
/// dir to PATH so previously-installed binaries are discoverable.
pub fn lattice_bin_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let local = std::env::var_os("LOCALAPPDATA")?;
        Some(PathBuf::from(local).join("Lattice").join("bin"))
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")?;
        Some(
            PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("Lattice")
                .join("bin"),
        )
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
            return Some(PathBuf::from(xdg).join("Lattice").join("bin"));
        }
        let home = std::env::var_os("HOME")?;
        Some(
            PathBuf::from(home)
                .join(".local")
                .join("share")
                .join("Lattice")
                .join("bin"),
        )
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        None
    }
}

/// Returns true iff the Lattice bin directory exists and contains at
/// least one file.  Used by `lib.rs::run` to gate the PATH mutation
/// so users who never installed Tectonic via Lattice don't have
/// `%LOCALAPPDATA%\Lattice\bin\` prepended to PATH on every launch
/// (Bug 37 fix).
pub fn lattice_bin_dir_has_content() -> bool {
    lattice_bin_dir()
        .filter(|d| d.is_dir())
        .map(|d| std::fs::read_dir(d).ok().and_then(|mut r| r.next()).is_some())
        .unwrap_or(false)
}

/// Prepend `lattice_bin_dir()` to the current process's PATH if not
/// already present.  Safe to call multiple times — the dedup check
/// keeps PATH from growing on repeated calls.
///
/// Called from:
///   * `lib.rs::run` at startup, so a previously-installed binary is
///     immediately on PATH for the entire Lattice session.
///   * `install_direct_blocking` after writing the binary, so the
///     post-install probe sees it without needing a restart.
pub fn prepend_bin_dir_to_path() {
    let Some(dir) = lattice_bin_dir() else { return };
    // Create the dir even if empty — keeps the PATH entry valid for
    // future installs and avoids a missing-dir warning from PATH
    // consumers that pre-validate entries.
    let _ = std::fs::create_dir_all(&dir);

    let sep = if cfg!(target_os = "windows") { ';' } else { ':' };
    let dir_str = dir.to_string_lossy().to_string();
    let current = std::env::var("PATH").unwrap_or_default();

    // Dedup: only prepend if the dir isn't already in PATH.  Case
    // insensitive on Windows because PATH lookups are case-insensitive
    // there anyway.
    let already_present = current.split(sep).any(|p| {
        #[cfg(target_os = "windows")]
        {
            p.eq_ignore_ascii_case(&dir_str)
        }
        #[cfg(not(target_os = "windows"))]
        {
            p == dir_str
        }
    });
    if already_present {
        return;
    }
    let new_path = if current.is_empty() {
        dir_str
    } else {
        format!("{dir_str}{sep}{current}")
    };
    std::env::set_var("PATH", new_path);
}

/// Direct download install.  Used on Windows (where Tectonic is not
/// in any package manager catalog) and as a future fallback on other
/// OSes when no native pm is on PATH.  Currently only the Windows
/// asset is wired up; macOS / Linux still fall through to subprocess
/// installers above.
#[cfg(target_os = "windows")]
fn install_direct_blocking() -> Result<(), String> {
    let bin_dir = lattice_bin_dir()
        .ok_or_else(|| "%LOCALAPPDATA% is not set — cannot install Tectonic".to_string())?;
    std::fs::create_dir_all(&bin_dir)
        .map_err(|e| format!("create {}: {e}", bin_dir.display()))?;

    let url = format!(
        "https://github.com/tectonic-typesetting/tectonic/releases/download/\
         tectonic%40{ver}/{asset}",
        ver = TECTONIC_PINNED_VERSION,
        asset = TECTONIC_WINDOWS_ASSET,
    );

    // Use the blocking client so we don't have to drag a tokio runtime
    // into the spawn_blocking worker thread.  The download is sync I/O
    // anyway — there's no concurrency to gain from async here.
    let client = reqwest::blocking::Client::builder()
        .user_agent(HTTP_USER_AGENT)
        .timeout(DOWNLOAD_TIMEOUT)
        .build()
        .map_err(|e| format!("build HTTP client: {e}"))?;

    let resp = client
        .get(&url)
        .send()
        .map_err(|e| format!("GET {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "GET {url} returned HTTP {} — Tectonic may have moved the asset; \
             install manually from https://tectonic-typesetting.github.io/install \
             and click Re-check engine.",
            resp.status()
        ));
    }
    let bytes = resp
        .bytes()
        .map_err(|e| format!("download body from {url}: {e}"))?;

    // Extract `tectonic.exe` from the zip.  The MSVC asset is a flat
    // zip with the binary at the root — no nested folders.  If a
    // future release nests it, scan for any entry whose filename
    // matches `tectonic.exe` (case-insensitive on Windows).
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|e| format!("open Tectonic zip: {e}"))?;

    let mut tectonic_bytes: Option<Vec<u8>> = None;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("read zip entry {i}: {e}"))?;
        let name = entry.name().to_string();
        let stem = name.rsplit(['/', '\\']).next().unwrap_or(&name);
        if stem.eq_ignore_ascii_case("tectonic.exe") {
            let mut buf = Vec::with_capacity(entry.size() as usize);
            entry
                .read_to_end(&mut buf)
                .map_err(|e| format!("extract {name}: {e}"))?;
            tectonic_bytes = Some(buf);
            break;
        }
    }
    let tectonic_bytes = tectonic_bytes.ok_or_else(|| {
        format!(
            "Tectonic zip from {url} did not contain tectonic.exe \
             (asset format changed?) — install manually from \
             https://tectonic-typesetting.github.io/install"
        )
    })?;

    // Write atomically: write to .tmp then rename, so a crash mid-
    // write doesn't leave a truncated binary on disk that future
    // probes would happily try to run.
    let final_path = bin_dir.join("tectonic.exe");
    let tmp_path = bin_dir.join("tectonic.exe.tmp");
    {
        let mut f = std::fs::File::create(&tmp_path)
            .map_err(|e| format!("create {}: {e}", tmp_path.display()))?;
        f.write_all(&tectonic_bytes)
            .map_err(|e| format!("write {}: {e}", tmp_path.display()))?;
        f.sync_all()
            .map_err(|e| format!("sync {}: {e}", tmp_path.display()))?;
    }
    // On Windows `rename` fails if the destination exists.  Best-effort
    // remove the old binary first (will fail if the OS has it open via
    // a running tectonic process — surface that error to the user).
    if final_path.exists() {
        std::fs::remove_file(&final_path).map_err(|e| {
            format!(
                "remove existing {} (is tectonic.exe currently running?): {e}",
                final_path.display()
            )
        })?;
    }
    std::fs::rename(&tmp_path, &final_path)
        .map_err(|e| format!("rename {} → {}: {e}", tmp_path.display(), final_path.display()))?;

    // Make sure the post-install probe (and the rest of the Lattice
    // session) can find it.  Idempotent — safe even if startup
    // already prepended this dir.
    prepend_bin_dir_to_path();

    Ok(())
}

/// Non-Windows direct-download stub.  Kept so the dispatch in
/// `install_blocking` compiles on every OS.  When a non-Windows user
/// somehow ends up with `EngineInstaller::Direct` (currently
/// unreachable — `detect_installer` only returns Direct on Windows),
/// return a friendly error instead of silently no-oping.
#[cfg(not(target_os = "windows"))]
fn install_direct_blocking() -> Result<(), String> {
    Err(
        "Direct download install is currently only wired up for Windows. \
         Install Tectonic via your package manager (brew install tectonic / \
         apt-get install tectonic / cargo install tectonic) or download from \
         https://tectonic-typesetting.github.io/install."
            .to_string(),
    )
}
