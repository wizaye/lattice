//! Slice D — publishing module.
//!
//! Orchestration layer for "make my vault into a website".  Hosts the
//! `PublishHost` trait (slice D — auth phase), the `publish.toml`
//! schema (`toml` submodule), the Node/npm/npx probe
//! (`node_probe` submodule), and the IPC commands registered in
//! `lib.rs`.
//!
//! **Phase D1 (this file) ships the wiring + four real commands:**
//!  - [`publish_probe`] — real, calls [`node_probe::probe`].
//!  - [`publish_list_hosts`] — real, returns a static array of the
//!    four hosts we plan to support (GitHub Pages / Cloudflare /
//!    Netlify / Vercel) with per-host capability flags.
//!  - [`publish_list_templates`] — real, returns the static array of
//!    bundled Quartz templates (garden / docs / notebook).
//!  - [`publish_status`] — real for the "does publish.toml exist?"
//!    check; returns `{ exists: false, ... }` for unconfigured vaults
//!    without hitting the host APIs.
//!
//! Everything else (`publish_init`, `publish_auth_*`, `publish_build`,
//! `publish_preview*`, `publish_deploy`, `publish_disconnect`,
//! `publish_open_*`) is registered but errors out with a clear
//! "phase X — not yet implemented" string so the frontend can wire
//! the UI surface and ship calls today.  Each stub names the slice it
//! lands in (see `docs/publishing-plan.md` §14 — `D2`/`D3`/...).
//!
//! The mock-vault sentinel (`"__mock__"`) is rejected up-front in the
//! frontend wrapper layer (see `src/lib/publish.ts`) and again
//! defensively here in [`vault_dir`] so a misbehaving caller can't
//! accidentally write into a fake path.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

pub mod exclude;
pub mod node_probe;
pub mod preview;
pub mod proc;
pub mod quartz;
pub mod toml;

pub use node_probe::ProbeReport;
pub use toml::PublishToml;

// ─── Shared DTOs ─────────────────────────────────────────────────────────

/// Host identifier — kebab-case so it matches the Rust enum's serde
/// repr and the TS string-literal union in `src/lib/publish.ts`.
#[derive(Copy, Clone, Eq, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HostId {
    GithubPages,
    Cloudflare,
    Netlify,
    Vercel,
}

impl HostId {
    /// Stable lowercase id used in keychain account names + IPC.
    /// Currently consumed by upcoming host adapters (D2+); kept public
    /// in D1 so the adapter modules land without a churning import.
    #[allow(dead_code)]
    pub fn as_str(self) -> &'static str {
        match self {
            HostId::GithubPages => "github-pages",
            HostId::Cloudflare => "cloudflare",
            HostId::Netlify => "netlify",
            HostId::Vercel => "vercel",
        }
    }
}

/// Static host metadata returned by [`publish_list_hosts`].  Drives the
/// host-picker chips in the publishing wizard.  Each flag maps 1:1 to a
/// piece of UI: `requires_paste` toggles the "Paste API token" step,
/// `reuses_byoc_auth` shows the "Already connected via Sync" badge, etc.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    pub id: HostId,
    pub label: &'static str,
    /// Marketing one-liner shown under the host name in the wizard card.
    pub description: &'static str,
    /// True for hosts whose auth is a token-paste (Cloudflare) rather
    /// than OAuth.  Drives the "Open dashboard → paste token" panel.
    pub requires_paste: bool,
    /// True iff the host can reuse the BYOC GitHub token (i.e. it IS
    /// GitHub).  Lets the wizard show "Already connected" without a
    /// fresh OAuth round-trip.
    pub reuses_byoc_auth: bool,
    /// True if the host's free tier supports a user-supplied apex /
    /// subdomain (Cloudflare/Netlify/Vercel).  GitHub Pages also
    /// supports CNAME, but we surface it conditionally there because
    /// the user has to configure the CNAME record themselves first.
    pub supports_custom_domain: bool,
    /// True when the host has a public site-management dashboard that's
    /// useful to "Open in browser" from the kebab menu.
    pub has_dashboard: bool,
    /// True when the published site has a public URL we can deep-link
    /// to ("Open live site").  All four hosts qualify.
    pub has_live_url: bool,
    /// Phase D1 marker — `false` until the host's adapter lands.  The
    /// wizard greys these chips out + shows "Coming soon".  Today they
    /// are all `false`; flipping a single flag here is enough to enable
    /// a host once its adapter file (e.g. `github_pages.rs`) ships.
    pub adapter_ready: bool,
}

/// Static template metadata for the Quartz template picker.  The
/// `id` matches the on-disk folder name under
/// `src-tauri/src/publish/templates/<id>/` (when those land in slice
/// D2; for D1 the registry is hand-maintained here).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    /// Quartz version this template targets (always "5" today; bump
    /// when Quartz v6 ships).
    pub quartz_version: &'static str,
    /// True once the template's `quartz.config.template.ts` file lands
    /// in the bundle.  All three are `false` in D1.
    pub bundle_ready: bool,
}

/// Returned by [`publish_status`].  `exists=false` means the vault
/// hasn't been initialised for publishing yet (no `publish.toml`); the
/// rest of the fields will all be `null` in that case.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishStatus {
    pub exists: bool,
    pub host_id: Option<HostId>,
    pub host_slug: Option<String>,
    pub template_id: Option<String>,
    pub live_url: Option<String>,
    pub last_deploy_at: Option<String>,
    pub last_build_at: Option<String>,
    pub last_deploy_files: Option<u32>,
    pub last_deploy_bytes: Option<u64>,
    pub last_error: Option<String>,
}

impl PublishStatus {
    fn empty() -> Self {
        Self {
            exists: false,
            host_id: None,
            host_slug: None,
            template_id: None,
            live_url: None,
            last_deploy_at: None,
            last_build_at: None,
            last_deploy_files: None,
            last_deploy_bytes: None,
            last_error: None,
        }
    }
}

// ─── Vault path helpers ──────────────────────────────────────────────────

/// Resolve a vault id (which is the absolute vault root path) into a
/// `PathBuf`, rejecting the mock sentinel and any non-directory.
///
/// The TS wrapper layer already rejects `"__mock__"`; we re-check here
/// to harden against a stray IPC call from a buggy caller (or a future
/// non-TS frontend, e.g. an MCP integration).
pub(crate) fn vault_dir(vault: &str) -> Result<PathBuf, String> {
    if vault.is_empty() {
        return Err("vault path is required".to_string());
    }
    if vault == "__mock__" {
        return Err("the mock vault does not support publishing".to_string());
    }
    let p = PathBuf::from(vault);
    if !p.is_dir() {
        return Err(format!("vault path is not a directory: {}", vault));
    }
    Ok(p)
}

/// Where `publish.toml` lives for a given vault.  Always
/// `<vault>/.lattice/publish.toml`.  Created lazily by `publish_init`
/// (phase D2); read by [`publish_status`].
pub(crate) fn publish_toml_path(vault_root: &Path) -> PathBuf {
    vault_root.join(".lattice").join("publish.toml")
}

/// Where the local Quartz checkout lives for a given vault.  Always
/// `<vault>/.lattice/publish/quartz/`.  Materialised by [`publish_init`].
pub(crate) fn quartz_dir(vault_root: &Path) -> PathBuf {
    vault_root.join(".lattice").join("publish").join("quartz")
}

/// ISO-8601 UTC timestamp without milliseconds.  Mirrors the format
/// the `paper::toml` module uses so both configs round-trip the same.
fn iso_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    // Days-since-epoch arithmetic; rough but stable enough for a
    // human-readable timestamp.  We avoid pulling `chrono` for this.
    let secs_per_day = 86_400i64;
    let days = secs / secs_per_day;
    let time_of_day = secs.rem_euclid(secs_per_day);
    let hh = time_of_day / 3600;
    let mm = (time_of_day % 3600) / 60;
    let ss = time_of_day % 60;
    let (y, mo, d) = civil_from_days(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y, mo, d, hh, mm, ss
    )
}

/// Howard Hinnant's days-from-civil inverse — days since 1970-01-01 →
/// (year, month, day).  Public domain; widely cited.
fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m as u32, d as u32)
}

// ─── IPC commands — REAL ─────────────────────────────────────────────────

/// Probe Node / npm / npx versions on `PATH`.  Used as the very first
/// step of the publishing wizard so the user gets a clear failure
/// ("Node v20 is too old, Quartz v5 needs ≥ v22") before any other
/// setup work happens.
#[tauri::command]
pub async fn publish_probe() -> Result<ProbeReport, String> {
    Ok(node_probe::probe())
}

/// Return the static host registry.  Cheap; called by the wizard on
/// mount.  Today every host's `adapter_ready` flag is `false` because
/// the adapters land in later D-phases.
#[tauri::command]
pub async fn publish_list_hosts() -> Result<Vec<HostInfo>, String> {
    Ok(built_in_hosts())
}

/// Return the bundled Quartz template registry.  Today all three flags
/// are `bundle_ready=false`; the wizard greys the chips out and shows
/// "Coming soon" until the template files land in `templates/`.
#[tauri::command]
pub async fn publish_list_templates() -> Result<Vec<TemplateInfo>, String> {
    Ok(built_in_templates())
}

/// Read `<vault>/.lattice/publish.toml` and surface the key fields the
/// UI needs.  Returns `{ exists: false, ... }` (with all other fields
/// `null`) when the vault hasn't been initialised — the wizard uses
/// that to decide whether to show "Set up Publishing" vs the live
/// publish panel.
///
/// Note: This does NOT call the host's status API — that's the job of
/// `publish_status_remote` (phase D3+) which the UI calls on demand
/// (e.g. when the user opens the Publish panel).  Keeping `publish_status`
/// local-only means it's safe to poll from `PublishStatusPill` on a
/// short interval without burning host quota.
#[tauri::command]
pub async fn publish_status(vault: String) -> Result<PublishStatus, String> {
    let root = vault_dir(&vault)?;
    let toml_path = publish_toml_path(&root);
    if !toml_path.exists() {
        return Ok(PublishStatus::empty());
    }
    let cfg = PublishToml::load(&toml_path)?;
    Ok(PublishStatus {
        exists: true,
        host_id: cfg.host.id,
        host_slug: opt_non_empty(&cfg.host.slug),
        template_id: opt_non_empty(&cfg.quartz.template),
        live_url: opt_non_empty(&cfg.host.live_url),
        last_deploy_at: cfg.state.last_deploy_at.clone(),
        last_build_at: cfg.state.last_build_at.clone(),
        last_deploy_files: cfg.state.last_deploy_files,
        last_deploy_bytes: cfg.state.last_deploy_bytes,
        last_error: cfg.state.last_error.clone(),
    })
}

fn opt_non_empty(s: &str) -> Option<String> {
    if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

// ─── IPC commands — STUBS ────────────────────────────────────────────────

/// Initialise publishing for `vault`: write `publish.toml`, clone the
/// pinned Quartz repo into `<vault>/.lattice/publish/quartz/`, and run
/// `npm install` inside it.
///
/// Long-running (60-120s typical) because `npm install` pulls Quartz's
/// transitive deps.  The frontend should show a spinner while this
/// call is in flight.  Failure modes are surfaced as strings with
/// the failing step + the tail of subprocess stderr.
#[tauri::command]
pub async fn publish_init(
    vault: String,
    host_id: HostId,
    template_id: String,
) -> Result<(), String> {
    let root = vault_dir(&vault)?;
    let toml_path = publish_toml_path(&root);
    let quartz_root = quartz_dir(&root);

    // Run the heavy work in a blocking task — git clone + npm install
    // are synchronous and would otherwise hold the IPC executor.
    tokio::task::spawn_blocking(move || {
        // 1. Write `publish.toml` (or update it if the user re-runs the
        //    wizard with a different host/template choice).
        let mut cfg = if toml_path.exists() {
            PublishToml::load(&toml_path)?
        } else {
            PublishToml::default()
        };
        if cfg.meta.created.is_empty() {
            cfg.meta.created = iso_now();
        }
        cfg.host.id = Some(host_id);
        cfg.quartz.template = template_id;
        cfg.save(&toml_path)?;

        // 2. Clone Quartz (idempotent — wipes any half-installed tree).
        quartz::clone_quartz(&quartz_root)?;

        // 3. Install Quartz's deps.  This is the slow step.
        quartz::npm_install(&quartz_root)?;

        // 4. Quartz v5 split plugins out of the core package: a fresh
        //    clone has no `.quartz/plugins/` directory, but upstream
        //    `quartz/components/Head.tsx` unconditionally imports from
        //    `../../.quartz/plugins`.  We must run `quartz create` to
        //    materialise that directory before any build can succeed,
        //    then `plugin install --from-config` to populate it from
        //    the just-written `quartz.config.yaml`.
        //
        //    Both steps are slow on first run (each clones a handful
        //    of small plugin repos); they're idempotent on re-runs.
        quartz::quartz_create(&quartz_root)?;
        quartz::quartz_plugin_install(&quartz_root)?;
        Ok::<_, String>(())
    })
    .await
    .map_err(|e| format!("publish_init join error: {e}"))?
}

/// Phase D2 — start the auth flow for the chosen host.  Stub.
#[tauri::command]
pub async fn publish_auth_start(vault: String, host_id: HostId) -> Result<String, String> {
    let _ = (vault, host_id);
    Err("publish_auth_start: not yet implemented (lands in phase D2)".to_string())
}

/// Phase D2 — complete the auth flow (PKCE code arriving on loopback,
/// OR pasted token).  Returns the list of candidate projects/repos.
#[tauri::command]
pub async fn publish_auth_complete(
    vault: String,
    host_id: HostId,
    code_or_token: String,
) -> Result<Vec<String>, String> {
    let _ = (vault, host_id, code_or_token);
    Err("publish_auth_complete: not yet implemented (lands in phase D2)".to_string())
}

/// Phase D2 — persist the user's chosen project into `publish.toml [host]`.
#[tauri::command]
pub async fn publish_auth_pick(
    vault: String,
    host_id: HostId,
    project_id_or_new_name: String,
) -> Result<(), String> {
    let _ = (vault, host_id, project_id_or_new_name);
    Err("publish_auth_pick: not yet implemented (lands in phase D2)".to_string())
}

/// Run the full build pipeline: filter the vault → copy markdown into
/// `<quartz>/content/` → run `npx quartz build`.
///
/// Returns the absolute path to the produced `<quartz>/public/`
/// directory on success.  Stores `last_build_at` + `last_build_ms` in
/// `publish.toml`.
#[tauri::command]
pub async fn publish_build(vault: String) -> Result<String, String> {
    let root = vault_dir(&vault)?;
    let toml_path = publish_toml_path(&root);
    if !toml_path.exists() {
        return Err("publish.toml not found — run Set up Publishing first.".to_string());
    }
    let quartz_root = quartz_dir(&root);
    if !quartz_root.is_dir() {
        return Err(format!(
            "Quartz checkout missing at {} — run Set up Publishing again.",
            quartz_root.display()
        ));
    }

    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let mut cfg = PublishToml::load(&toml_path)?;
        let started = std::time::Instant::now();

        // 0. Self-heal: if the Quartz checkout is missing the v5
        //    `.quartz/plugins/` scaffold (e.g. it was created by an
        //    older build of Lattice that only ran clone + npm install,
        //    or `publish_init` was interrupted mid-scaffold), run
        //    `quartz create` + `plugin install --from-config` now.
        //    Idempotent no-op if the scaffold already exists.
        quartz::ensure_scaffold(&quartz_root).map_err(|e| {
            cfg.state.last_error = Some(e.clone());
            let _ = cfg.save(&toml_path);
            e
        })?;

        // 1. Compile excludes (baseline + user list).
        let filter = exclude::VaultFilter::from_patterns(&cfg.exclude.patterns)?;

        // 2. Wipe + recreate <quartz>/content/ so removed notes don't
        //    linger from a prior build.
        let content_dir = quartz_root.join("content");
        if content_dir.exists() {
            std::fs::remove_dir_all(&content_dir).map_err(|e| {
                format!("failed to clear {}: {}", content_dir.display(), e)
            })?;
        }
        std::fs::create_dir_all(&content_dir)
            .map_err(|e| format!("failed to create {}: {}", content_dir.display(), e))?;

        // 3. Walk the vault and copy filtered markdown.
        let mut copied: u32 = 0;
        let mut bytes: u64 = 0;
        for entry in WalkDir::new(&root)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let Ok(rel) = entry.path().strip_prefix(&root) else {
                continue;
            };
            if !filter.should_include(rel) {
                continue;
            }
            let dst = content_dir.join(rel);
            if let Some(parent) = dst.parent() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    format!("failed to create {}: {}", parent.display(), e)
                })?;
            }
            let n = std::fs::copy(entry.path(), &dst)
                .map_err(|e| format!("copy {}: {}", entry.path().display(), e))?;
            copied += 1;
            bytes += n;
        }

        // Quartz refuses to build with zero content; write a tiny
        // placeholder so the user gets a working preview even on an
        // empty vault.
        if copied == 0 {
            let placeholder = content_dir.join("index.md");
            std::fs::write(
                &placeholder,
                "---\ntitle: Welcome to Lattice\n---\n\nYour vault is empty — \
                 add some `.md` files and rebuild.\n",
            )
            .map_err(|e| format!("failed to write placeholder index: {e}"))?;
        }

        // 4. Build.
        let public_dir = quartz::npx_quartz_build(&quartz_root).map_err(|e| {
            // Persist the failure so the UI can surface it in the
            // status pill on the next status poll.
            cfg.state.last_error = Some(e.clone());
            let _ = cfg.save(&toml_path);
            e
        })?;

        // 5. Persist success state.
        cfg.state.last_build_at = Some(iso_now());
        cfg.state.last_build_ms = Some(started.elapsed().as_millis() as u64);
        cfg.state.last_error = None;
        cfg.state.last_deploy_files = Some(copied);
        cfg.state.last_deploy_bytes = Some(bytes);
        cfg.save(&toml_path)?;

        Ok(public_dir.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("publish_build join error: {e}"))?
}

/// Start a local HTTP preview server bound to `127.0.0.1:<random>`,
/// serving the most recently built `<quartz>/public/` directory.
/// Returns the URL the UI should open in the system browser.
#[tauri::command]
pub async fn publish_preview(vault: String) -> Result<String, String> {
    let root = vault_dir(&vault)?;
    let public_dir = quartz_dir(&root).join("public");
    if !public_dir.is_dir() {
        return Err(
            "No built site found — run Build first to render your vault.".to_string(),
        );
    }
    let root_clone = root.clone();
    let public_clone = public_dir.clone();
    tokio::task::spawn_blocking(move || preview::start(&root_clone, &public_clone))
        .await
        .map_err(|e| format!("publish_preview join error: {e}"))?
}

/// Stop the local preview server for this vault.  Idempotent.
#[tauri::command]
pub async fn publish_preview_stop(vault: String) -> Result<(), String> {
    let root = vault_dir(&vault)?;
    tokio::task::spawn_blocking(move || preview::stop(&root))
        .await
        .map_err(|e| format!("publish_preview_stop join error: {e}"))?
}

/// Phase D5 — push the built site to the configured host.
#[tauri::command]
pub async fn publish_deploy(vault: String) -> Result<String, String> {
    let _ = vault;
    Err("publish_deploy: not yet implemented (lands in phase D5)".to_string())
}

/// Phase D2 — wipe host tokens from the keychain + reset `publish.toml [host]`.
#[tauri::command]
pub async fn publish_disconnect(vault: String, host_id: HostId) -> Result<(), String> {
    let _ = (vault, host_id);
    Err("publish_disconnect: not yet implemented (lands in phase D2)".to_string())
}

/// Phase D2 — open the host's site-management URL in the system browser.
#[tauri::command]
pub async fn publish_open_dashboard(vault: String) -> Result<(), String> {
    let _ = vault;
    Err("publish_open_dashboard: not yet implemented (lands in phase D2)".to_string())
}

/// Phase D5 — open `publish.toml [host].live_url` in the system browser.
#[tauri::command]
pub async fn publish_open_live(vault: String) -> Result<(), String> {
    let _ = vault;
    Err("publish_open_live: not yet implemented (lands in phase D5)".to_string())
}

// ─── Static registries ───────────────────────────────────────────────────

/// The four hosts we plan to support.  Mirror of
/// `docs/publishing-plan.md` §3 "Tractability snapshot".
///
/// `adapter_ready` controls whether the wizard lets the user pick the
/// host.  All four are now `true` because the **local preview path**
/// works for every host — we write the chosen host into
/// `publish.toml` and use it on the eventual `publish_deploy` call,
/// but the build + preview steps are host-agnostic.  The actual
/// deploy adapters land in later D-phases.
fn built_in_hosts() -> Vec<HostInfo> {
    vec![
        HostInfo {
            id: HostId::GithubPages,
            label: "GitHub Pages",
            description:
                "Free static hosting on the same repo your vault already syncs to. \
                 Reuses your BYOC token — no extra account.",
            requires_paste: false,
            reuses_byoc_auth: true,
            supports_custom_domain: true,
            has_dashboard: true,
            has_live_url: true,
            adapter_ready: true,
        },
        HostInfo {
            id: HostId::Cloudflare,
            label: "Cloudflare Pages",
            description:
                "500 builds/month + unlimited bandwidth on the free tier. \
                 We open the dashboard with the right token template pre-filled.",
            requires_paste: true,
            reuses_byoc_auth: false,
            supports_custom_domain: true,
            has_dashboard: true,
            has_live_url: true,
            adapter_ready: true,
        },
        HostInfo {
            id: HostId::Netlify,
            label: "Netlify",
            description:
                "300 build minutes + 100 GB bandwidth free. Standard OAuth — \
                 sign in once and we'll create the site automatically.",
            requires_paste: false,
            reuses_byoc_auth: false,
            supports_custom_domain: true,
            has_dashboard: true,
            has_live_url: true,
            adapter_ready: true,
        },
        HostInfo {
            id: HostId::Vercel,
            label: "Vercel",
            description:
                "6 000 minutes + 100 GB bandwidth on the Hobby tier. OAuth via \
                 Vercel Integration — pick a project or create one in-flow.",
            requires_paste: false,
            reuses_byoc_auth: false,
            supports_custom_domain: true,
            has_dashboard: true,
            has_live_url: true,
            adapter_ready: true,
        },
    ]
}

/// The three bundled Quartz templates.  Mirror of
/// `docs/publishing-plan.md` §4 — `templates/{garden, docs, notebook}/`.
///
/// `bundle_ready` controls whether the wizard offers the template.
/// `garden` is `true` because Quartz's own default config produces a
/// usable garden site out of the box — we don't yet overlay our own
/// per-template config files; that lands in a follow-up phase.  The
/// other two templates remain `false` until their config overlays land.
fn built_in_templates() -> Vec<TemplateInfo> {
    vec![
        TemplateInfo {
            id: "garden",
            label: "Digital Garden",
            description:
                "Friendly, casual default. Knowledge graph visible, backlinks \
                 expanded, soft colour palette. Best for personal note vaults.",
            quartz_version: "5",
            bundle_ready: true,
        },
        TemplateInfo {
            id: "docs",
            label: "Documentation",
            description:
                "docs.rs-style sidebar, search-first navigation, no graph view. \
                 Best for project documentation that wants a serious tone.",
            quartz_version: "5",
            bundle_ready: false,
        },
        TemplateInfo {
            id: "notebook",
            label: "Research Notebook",
            description:
                "Academic layout — KaTeX math, footnotes promoted, citation \
                 styling, no transitive backlinks. Best for paper drafts \
                 (pairs with Slice C paper export).",
            quartz_version: "5",
            bundle_ready: false,
        },
    ]
}

// ─── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vault_dir_rejects_mock_sentinel() {
        assert!(vault_dir("__mock__").is_err());
    }

    #[test]
    fn vault_dir_rejects_empty() {
        assert!(vault_dir("").is_err());
    }

    #[test]
    fn host_id_serializes_as_kebab_case() {
        // The wire repr is contracted with src/lib/publish.ts; this
        // test fails the build if anyone accidentally drops the
        // `#[serde(rename_all = "kebab-case")]` attr.
        let s = serde_json::to_string(&HostId::GithubPages).unwrap();
        assert_eq!(s, "\"github-pages\"");
        let s = serde_json::to_string(&HostId::Cloudflare).unwrap();
        assert_eq!(s, "\"cloudflare\"");
    }

    #[test]
    fn built_in_registries_have_expected_counts() {
        assert_eq!(built_in_hosts().len(), 4);
        assert_eq!(built_in_templates().len(), 3);
    }

    #[test]
    fn empty_status_is_all_null_but_exists_false() {
        let s = PublishStatus::empty();
        assert!(!s.exists);
        assert!(s.host_id.is_none());
        assert!(s.live_url.is_none());
        assert!(s.last_deploy_at.is_none());
    }
}
