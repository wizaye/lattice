//! `<vault>/.lattice/publish.toml` schema + round-trip helpers.
//!
//! Mirrors `paper::toml` deliberately so the two configs feel
//! identical to anyone reading either file.  Same `toml` crate, same
//! `Default`-driven sparse-load policy, same hand-rolled timestamp
//! formatter (we avoid pulling `chrono` for a single string).
//!
//! Today only [`PublishToml::load`] is wired to a real IPC command
//! ([`super::publish_status`]).  [`PublishToml::save`] +
//! [`PublishToml::new_with_defaults`] land alongside `publish_init`
//! in phase D2.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::HostId;

/// Top-level `publish.toml` document.  See
/// `docs/publishing-plan.md` §7 for field-level semantics.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PublishToml {
    pub meta: PublishMeta,
    pub host: PublishHost,
    pub quartz: PublishQuartz,
    pub content: PublishContent,
    pub exclude: PublishExclude,
    pub transform: PublishTransform,
    pub preview: PublishPreview,
    pub deploy: PublishDeploy,
    pub state: PublishState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct PublishMeta {
    /// Bumped only on breaking schema changes — D1 ships at `1`.
    pub schema: u32,
    /// ISO-8601 UTC of when the config was first written.
    pub created: String,
}

impl Default for PublishMeta {
    fn default() -> Self {
        Self {
            schema: 1,
            // Empty rather than `iso_now()` here so `Default::default()`
            // is pure (tests rely on this).  The real `created` is set
            // by `new_with_defaults` when `publish_init` lands.
            created: String::new(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PublishHost {
    /// Empty until the user finishes the host-pick step in the wizard.
    /// Optional so an unconfigured `publish.toml` still round-trips.
    pub id: Option<HostId>,
    /// Host-side site/project slug ("my-digital-garden").  Empty until set.
    pub slug: String,
    /// Host-side stable id — Cloudflare project id, Netlify site id,
    /// Vercel project id.  Empty for GitHub (uses [`Self::repo`] instead).
    pub project_id: String,
    /// GitHub-only: "owner/repo".  Reused from the BYOC sync manifest
    /// when the user picks the same repo (the wizard offers that as
    /// the default).
    pub repo: String,
    /// GitHub-only: branch we force-push the built site to.  Always
    /// `"publish"` (orphan branch, never overlaps with `main`).
    pub branch: String,
    /// Optional custom domain ("garden.example.com").  Empty = use the
    /// host's default domain.  Setting this writes a `CNAME` file into
    /// the built site for GitHub Pages.
    pub custom_domain: String,
    /// Last-known good live URL.  Refreshed on every successful deploy.
    pub live_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct PublishQuartz {
    /// Quartz major version we lock to.  Always `"5"` today.
    pub version: String,
    /// Semver range pinned into the bundled `package.json`.  Defaults
    /// to `"^5"` so patch + minor updates flow in automatically.
    pub version_range: String,
    /// Reserved for custom plugin packages — out of scope for D1.
    pub plugins: Vec<String>,
    /// Bundled template id — `"garden"` / `"docs"` / `"notebook"`.
    pub template: String,
    /// User-tunable site UI knobs.  Surfaced by the wizard's
    /// "Customise" step and applied to `quartz.config.yaml` on every
    /// `ensure_scaffold` (i.e. on every build).  Keeping this here in
    /// `publish.toml` — not directly in `quartz.config.yaml` — means a
    /// re-clone or upstream Quartz upgrade doesn't lose the user's
    /// preferences.
    pub theme: PublishTheme,
}

impl Default for PublishQuartz {
    fn default() -> Self {
        Self {
            version: "5".to_string(),
            version_range: "^5".to_string(),
            plugins: Vec::new(),
            template: "garden".to_string(),
            theme: PublishTheme::default(),
        }
    }
}

/// User-tunable Quartz site UI knobs.  Maps to a curated subset of
/// `configuration.*` and `configuration.theme.*` keys in
/// `quartz.config.yaml`.
///
/// Deliberately **not** a 1:1 mirror of Quartz's config:
///   * Colours are exposed as a small set of named presets + an
///     optional accent override.  Surfacing all 9 colour slots × 2
///     modes (light + dark) would mean 18 hex inputs in the wizard;
///     not a v1 UX.
///   * Fonts are exposed as typography presets, also for UX brevity.
///   * Plugin add/remove + per-component layout positioning are NOT
///     here — those are heavier mutations of the `plugins:` and
///     `layout:` YAML blocks; they need a different patch strategy
///     (out of scope for this slice).
///
/// Empty / `None` fields fall back to the Quartz template defaults —
/// the patcher simply skips fields the user hasn't customised so the
/// upstream YAML stays untouched.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PublishTheme {
    /// Site title shown in the top-left + browser tab + RSS feed.
    /// Empty = leave the upstream default in place.
    pub page_title: String,
    /// Suffix appended to the browser tab title only (e.g. " · My Garden").
    pub page_title_suffix: String,
    /// Named colour preset; controls `theme.colors.lightMode.secondary`
    /// + `tertiary` (and the same pair in `darkMode`).  See
    /// `palette_colors()` for the recipes.  `"default"` leaves Quartz's
    /// own palette intact.
    pub palette: String,
    /// Named typography preset; controls `theme.typography.header/body/code`.
    /// `"default"` leaves the upstream Schibsted/Source/IBM stack in place.
    pub typography: String,
    /// Quartz `enablePopovers` — link previews on hover.
    pub popovers: bool,
    /// Quartz `enableSPA` — client-side routing.
    pub spa: bool,
}

impl Default for PublishTheme {
    fn default() -> Self {
        Self {
            page_title: String::new(),
            page_title_suffix: String::new(),
            palette: "default".to_string(),
            typography: "default".to_string(),
            popovers: true,
            spa: true,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PublishContent {
    /// Folders whose contents are all opt-in (e.g. `["published/"]`).
    pub include_folders: Vec<String>,
    /// If `true`, [`Self::include_folders`] is ignored — every file
    /// must opt in via `publish: true` in its frontmatter.
    pub require_frontmatter_true: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct PublishExclude {
    /// Glob patterns evaluated relative to vault root.  Always
    /// includes `.lattice/**`, `.git/**`, and the OS-level garbage
    /// files as a baseline.
    pub patterns: Vec<String>,
}

impl Default for PublishExclude {
    fn default() -> Self {
        Self {
            patterns: vec![
                ".lattice/**".to_string(),
                ".git/**".to_string(),
                "**/.DS_Store".to_string(),
                "**/Thumbs.db".to_string(),
            ],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct PublishTransform {
    /// Wiki-link resolution policy when the target isn't in the
    /// published set: `"drop"` | `"footnote"` | `"ghost"` (default).
    pub wiki_unresolved: String,
    /// Frontmatter fields surfaced on the published page.
    pub expose_frontmatter: Vec<String>,
    /// Frontmatter fields stripped before publish (private metadata).
    pub strip_frontmatter: Vec<String>,
}

impl Default for PublishTransform {
    fn default() -> Self {
        Self {
            wiki_unresolved: "ghost".to_string(),
            expose_frontmatter: vec![
                "title".to_string(),
                "date".to_string(),
                "tags".to_string(),
                "description".to_string(),
                "cover".to_string(),
            ],
            strip_frontmatter: vec![
                "zotero_key".to_string(),
                "private_note".to_string(),
                "ai_summary".to_string(),
            ],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct PublishPreview {
    /// Auto-open the system browser when the preview server starts.
    pub auto_open: bool,
    /// Always bind host-local — `"127.0.0.1"`.  Stored to make the
    /// security posture explicit in the on-disk config.
    pub bind: String,
    /// Auto-stop the preview server after this many seconds of no
    /// requests.  Default 30 min so an idle preview doesn't linger.
    pub ttl_secs: u64,
}

impl Default for PublishPreview {
    fn default() -> Self {
        Self {
            auto_open: true,
            bind: "127.0.0.1".to_string(),
            ttl_secs: 1800,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct PublishDeploy {
    /// If `true`, every VCS commit auto-runs `publish_deploy`.  Default
    /// `false` — the wizard's "Auto-publish on commit" checkbox flips it.
    pub push_on_vcs_commit: bool,
    /// Safety knob — block the first deploy until the user has run at
    /// least one local preview.  Default `true` so a config typo never
    /// ships to production before the user has seen the result.
    pub require_preview_before_first_deploy: bool,
}

impl Default for PublishDeploy {
    fn default() -> Self {
        Self {
            push_on_vcs_commit: false,
            require_preview_before_first_deploy: true,
        }
    }
}

/// Runtime state populated by the build + deploy pipeline.  Read by
/// [`super::publish_status`]; written by `publish_build` /
/// `publish_deploy` once those land.  All fields optional so a fresh
/// `publish.toml` doesn't need a `[state]` block at all.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PublishState {
    pub last_deploy_at: Option<String>,
    pub last_deploy_id: Option<String>,
    pub last_deploy_files: Option<u32>,
    pub last_deploy_bytes: Option<u64>,
    pub last_build_at: Option<String>,
    pub last_build_ms: Option<u64>,
    /// Sticky error from the last failed build/deploy.  Cleared by the
    /// next successful run.
    pub last_error: Option<String>,
}

impl PublishToml {
    /// Read + parse a `publish.toml`.  Returns a friendly string error
    /// (not the raw `toml::de::Error`) so the IPC layer can pass it
    /// straight to the UI.
    pub fn load(path: &Path) -> Result<Self, String> {
        let text = fs::read_to_string(path)
            .map_err(|e| format!("failed to read {}: {}", path.display(), e))?;
        ::toml::from_str(&text).map_err(|e| format!("invalid publish.toml: {}", e))
    }

    /// Serialise to disk (D2 — `publish_init` will call this).
    /// Pre-creates the parent `.lattice/` directory if missing.
    #[allow(dead_code)]
    pub fn save(&self, path: &Path) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create {}: {}", parent.display(), e))?;
        }
        let text = ::toml::to_string_pretty(self)
            .map_err(|e| format!("failed to serialise publish.toml: {}", e))?;
        fs::write(path, text).map_err(|e| format!("failed to write {}: {}", path.display(), e))
    }
}

// ─── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_have_sensible_values() {
        let d = PublishToml::default();
        assert_eq!(d.meta.schema, 1);
        assert_eq!(d.quartz.version, "5");
        assert_eq!(d.quartz.template, "garden");
        assert_eq!(d.quartz.theme.palette, "default");
        assert_eq!(d.quartz.theme.typography, "default");
        assert!(d.quartz.theme.popovers);
        assert!(d.quartz.theme.spa);
        assert!(d.quartz.theme.page_title.is_empty());
        assert_eq!(d.preview.bind, "127.0.0.1");
        assert_eq!(d.preview.ttl_secs, 1800);
        assert!(d.deploy.require_preview_before_first_deploy);
        assert!(!d.deploy.push_on_vcs_commit);
        // baseline exclude list is always set
        assert!(d.exclude.patterns.iter().any(|p| p == ".lattice/**"));
        assert!(d.exclude.patterns.iter().any(|p| p == ".git/**"));
    }

    #[test]
    fn roundtrip_empty_publish_toml() {
        // Empty input parses to defaults — that's what we want from the
        // sparse-load policy.
        let cfg: PublishToml = ::toml::from_str("").expect("empty parses");
        assert_eq!(cfg.meta.schema, 1);
        assert!(cfg.host.id.is_none());
    }

    #[test]
    fn roundtrip_minimal_configured() {
        let mut cfg = PublishToml::default();
        cfg.host.id = Some(HostId::GithubPages);
        cfg.host.slug = "my-vault".to_string();
        cfg.host.repo = "alice/my-vault".to_string();
        cfg.host.branch = "publish".to_string();
        cfg.host.live_url = "https://alice.github.io/my-vault/".to_string();
        cfg.state.last_deploy_files = Some(247);
        cfg.state.last_deploy_bytes = Some(8_412_300);

        let text = ::toml::to_string_pretty(&cfg).expect("serialise");
        let back: PublishToml = ::toml::from_str(&text).expect("re-parse");
        assert_eq!(back.host.id, Some(HostId::GithubPages));
        assert_eq!(back.host.slug, "my-vault");
        assert_eq!(back.host.live_url, "https://alice.github.io/my-vault/");
        assert_eq!(back.state.last_deploy_files, Some(247));
    }

    #[test]
    fn save_then_load_via_disk_roundtrips() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join(".lattice").join("publish.toml");

        let mut cfg = PublishToml::default();
        cfg.host.id = Some(HostId::Cloudflare);
        cfg.host.slug = "garden".to_string();
        cfg.quartz.template = "notebook".to_string();
        cfg.save(&path).expect("save");

        let back = PublishToml::load(&path).expect("load");
        assert_eq!(back.host.id, Some(HostId::Cloudflare));
        assert_eq!(back.quartz.template, "notebook");
    }

    #[test]
    fn host_id_kebab_case_on_disk() {
        // Belt-and-braces: confirm the on-disk repr is kebab-case so
        // hand-edited publish.toml files are predictable.
        let mut cfg = PublishToml::default();
        cfg.host.id = Some(HostId::GithubPages);
        let text = ::toml::to_string(&cfg).expect("serialise");
        assert!(text.contains("id = \"github-pages\""));
    }
}
