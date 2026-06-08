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

pub mod node_probe;
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

/// Phase D2 — scaffold `.lattice/publish.toml` + `.lattice/publish/quartz/`
/// + run `npm install`.  Stub until the build pipeline lands.
#[tauri::command]
pub async fn publish_init(
    vault: String,
    host_id: HostId,
    template_id: String,
) -> Result<(), String> {
    let _ = (vault, host_id, template_id);
    Err("publish_init: not yet implemented (lands in phase D2)".to_string())
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

/// Phase D3 — run the full build pipeline (filter → copy → quartz build).
#[tauri::command]
pub async fn publish_build(vault: String) -> Result<String, String> {
    let _ = vault;
    Err("publish_build: not yet implemented (lands in phase D3)".to_string())
}

/// Phase D4 — start the local browser preview server on 127.0.0.1.
#[tauri::command]
pub async fn publish_preview(vault: String) -> Result<String, String> {
    let _ = vault;
    Err("publish_preview: not yet implemented (lands in phase D4)".to_string())
}

/// Phase D4 — stop the local preview server.  Idempotent once real.
#[tauri::command]
pub async fn publish_preview_stop(vault: String) -> Result<(), String> {
    let _ = vault;
    Err("publish_preview_stop: not yet implemented (lands in phase D4)".to_string())
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
/// `docs/publishing-plan.md` §3 "Tractability snapshot".  Today every
/// `adapter_ready` is `false` — the wizard greys them out.  Flip a
/// single bool here when an adapter lands.
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
            adapter_ready: false,
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
            adapter_ready: false,
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
            adapter_ready: false,
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
            adapter_ready: false,
        },
    ]
}

/// The three bundled Quartz templates.  Mirror of
/// `docs/publishing-plan.md` §4 — `templates/{garden, docs, notebook}/`.
/// All three are `bundle_ready=false` in D1; flip when the template
/// files land in the binary.
fn built_in_templates() -> Vec<TemplateInfo> {
    vec![
        TemplateInfo {
            id: "garden",
            label: "Digital Garden",
            description:
                "Friendly, casual default. Knowledge graph visible, backlinks \
                 expanded, soft colour palette. Best for personal note vaults.",
            quartz_version: "5",
            bundle_ready: false,
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
