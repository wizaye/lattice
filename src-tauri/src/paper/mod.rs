//! Slice C — paper export.
//!
//! Markdown-source academic papers compiled to PDF (Typst in-process,
//! Tectonic via sidecar) plus an Overleaf-ready LaTeX project bundle.
//! See `docs/paper-export-plan.md` for the full design.
//!
//! This file is the **scaffold landing** (phase C1, opening half): module
//! tree, IPC DTOs, the IPC surface (most as stubs returning a clear
//! "not yet implemented" error), and the two first-real commands:
//!
//!   * `paper_list_templates` — enumerate the built-in template ids.
//!   * `paper_create`         — write the New-Paper scaffold (§12 of
//!                              the plan) to disk + emit `paper.toml`.
//!
//! Hard rules carried from the plan:
//!   * No hosted compile — every byte stays inside the vault.
//!   * Mock-vault sentinel rejected at the TS layer; we still defensively
//!     re-validate every path with `vault_dir(...)` before touching disk.
//!   * Every IPC DTO is `#[serde(rename_all = "camelCase")]` to match the
//!     existing BYOC / VCS conventions.

pub mod bundle;
pub mod compile;
pub mod md_to_tex;
pub mod toml;
pub mod templates;

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub use toml::PaperToml;

// ─── Engine kinds ────────────────────────────────────────────────────────

/// Stable enum used in IPC + `paper.toml [engine].kind`.
///
/// `Typst` is the default — in-process via the `typst` + `typst-pdf`
/// crates (added in phase C1's compile half).  `Tectonic` is the BYOF /
/// LaTeX-flavor path and uses a Tauri sidecar binary (`tectonic-<arch>-<os>`)
/// downloaded on first use (phase C4).
#[derive(Copy, Clone, Debug, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EngineKind {
    Typst,
    Tectonic,
}

impl EngineKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            EngineKind::Typst => "typst",
            EngineKind::Tectonic => "tectonic",
        }
    }
}

// ─── Template registry DTOs ──────────────────────────────────────────────

/// Returned by `paper_list_templates`.  Built-in templates ship in the
/// binary; BYOF templates live under `<vault>/.lattice/byof-templates/`
/// and are appended by the same IPC at call time (phase C5).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateInfo {
    /// Stable id used in `paper.toml [engine].template`.  Built-ins use
    /// short kebab-case ids (`ieee-conf`); BYOF templates are namespaced
    /// (`byof:<id>`) so the picker can tell them apart at a glance.
    pub id: String,
    /// Human label for the picker card.
    pub label: String,
    /// Short marketing line under the card.
    pub description: String,
    /// `"built-in"` or `"byof"` — drives the picker filter chips.
    pub source: TemplateSource,
    /// Which engines support this template id.  IEEE Conf supports both
    /// (Typst version for default, Tectonic for the LaTeX flavor); some
    /// BYOF templates are Tectonic-only.
    pub engines: Vec<EngineKind>,
    /// Default engine when the user picks this template.
    pub default_engine: EngineKind,
    /// Optional preview thumbnail relative path inside the built-in
    /// templates dir.  `None` for BYOF — they get a placeholder card.
    pub preview: Option<String>,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TemplateSource {
    BuiltIn,
    Byof,
}

// ─── New-paper request / status DTOs ─────────────────────────────────────

/// Author block from the New Paper wizard.  Mirrors `[authors.entry]` in
/// `paper.toml`.  Email + affiliation + ORCID are optional so the wizard
/// can ship paper 1 with just a name.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPaperAuthor {
    pub name: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub affiliation: Option<String>,
    #[serde(default)]
    pub orcid: Option<String>,
}

/// Input payload for `paper_create`.  All paths are vault-relative; the
/// Rust side joins them to the validated `vault_dir`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPaperRequest {
    /// Absolute vault root path.  TS layer rejects `"__mock__"` before
    /// the IPC call; we still revalidate in `vault_dir`.
    pub vault: String,
    /// Vault-relative folder under which the new paper folder will be
    /// created.  Empty string = vault root.  `papers/` is the convention
    /// suggested by the wizard's default.
    #[serde(default)]
    pub parent_rel: String,
    /// Human-friendly paper title — becomes the slug for the folder
    /// name + the `[meta].title` field in `paper.toml`.
    pub title: String,
    /// Built-in template id (`ieee-conf`, …) or BYOF id (`byof:…`).
    pub template_id: String,
    /// Author list (rendered into `paper.toml [[authors.entry]]`).
    #[serde(default)]
    pub authors: Vec<NewPaperAuthor>,
}

/// Result returned by `paper_create`.  Frontend uses `paperAbsPath` to
/// open the introduction file in a new editor tab.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPaperResult {
    pub paper_abs_path: String,
    pub paper_rel_path: String,
    /// Relative path to open in the editor after create — by default
    /// `sections/01-introduction.md`.
    pub open_rel_path: String,
}

/// Read by `paper_status`.  All fields optional so the IPC works on a
/// freshly-scaffolded paper that's never been compiled.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperStatus {
    pub exists: bool,
    pub title: Option<String>,
    pub engine: Option<EngineKind>,
    pub template_id: Option<String>,
    pub last_compiled_at: Option<String>,
    pub last_pdf_path: Option<String>,
    pub last_error: Option<String>,
}

/// One entry returned by `paper_preflight`.  Same shape as the BYOC
/// conflict list — keeps the UI rendering layer simple.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightFinding {
    pub severity: PreflightSeverity,
    pub message: String,
    #[serde(default)]
    pub file: Option<String>,
    #[serde(default)]
    pub line: Option<u32>,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PreflightSeverity {
    Info,
    Warning,
    Error,
}

// ─── Path validators ─────────────────────────────────────────────────────

/// Resolve and validate `vault_path`.  Same shape as `git::vault_dir` —
/// rejects the empty string, non-directories, and (defensively) the
/// `__mock__` sentinel even though the TS layer should never let it
/// reach us.
pub(crate) fn vault_dir(vault_path: &str) -> Result<PathBuf, String> {
    if vault_path.is_empty() {
        return Err("vault path is empty".to_string());
    }
    if vault_path == "__mock__" {
        return Err("paper IPC rejected for the mock vault".to_string());
    }
    let p = PathBuf::from(vault_path);
    if !p.is_dir() {
        return Err(format!("vault path is not a directory: {}", vault_path));
    }
    Ok(p)
}

/// Slugify a paper title for the folder name.  Lowercase ASCII, runs of
/// non-alphanumerics collapsed to a single `-`, leading/trailing `-`
/// trimmed.  Empty result falls back to `"untitled"`.
fn slugify(title: &str) -> String {
    let mut out = String::with_capacity(title.len());
    let mut prev_dash = true;
    for ch in title.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        "untitled".to_string()
    } else {
        out
    }
}

/// Block path traversal: every vault-relative input must stay inside
/// `vault_root` after canonicalisation.
fn join_inside_vault(vault_root: &Path, rel: &str) -> Result<PathBuf, String> {
    let candidate = if rel.is_empty() {
        vault_root.to_path_buf()
    } else {
        vault_root.join(rel)
    };
    // Best-effort canonicalisation — the candidate may not exist yet
    // (we're about to create it), so we walk up until we find an
    // existing ancestor and canonicalise that, then re-append the rest.
    let mut existing = candidate.as_path();
    while !existing.exists() {
        match existing.parent() {
            Some(p) => existing = p,
            None => return Err(format!("path escapes vault root: {}", candidate.display())),
        }
    }
    let canon_existing = existing
        .canonicalize()
        .map_err(|e| format!("failed to canonicalise {}: {}", existing.display(), e))?;
    let canon_vault = vault_root
        .canonicalize()
        .map_err(|e| format!("failed to canonicalise vault: {}", e))?;
    if !canon_existing.starts_with(&canon_vault) {
        return Err(format!(
            "path escapes vault root: {} (resolved to {})",
            candidate.display(),
            canon_existing.display()
        ));
    }
    Ok(candidate)
}

// ─── Tauri commands ──────────────────────────────────────────────────────

/// Enumerate the templates available for the New Paper wizard.
///
/// Today: returns only the built-in templates baked into the binary.
/// Phase C5 extends this with the BYOF templates discovered under
/// `<vault>/.lattice/byof-templates/<id>/byof.toml`.
#[tauri::command]
pub async fn paper_list_templates(_vault: Option<String>) -> Result<Vec<TemplateInfo>, String> {
    Ok(templates::built_in_templates())
}

/// Scaffold a new paper folder under `<vault>/<parent_rel>/<slug>/`.
///
/// Writes the §12 file tree from the plan to disk and emits
/// `<paper>/.lattice/paper.toml`.  Returns the absolute + vault-relative
/// path plus the file the editor should open (intro section).
///
/// The actual Markdown/Typst body content lives in
/// `paper::templates::built_in_template_body` so each template can ship
/// its own intro / section seeds without polluting this orchestration
/// layer.
#[tauri::command]
pub async fn paper_create(req: NewPaperRequest) -> Result<NewPaperResult, String> {
    let vault = vault_dir(&req.vault)?;

    if req.title.trim().is_empty() {
        return Err("paper title is empty".to_string());
    }

    // Resolve template (must be built-in for the C1 landing).
    let template = templates::built_in_templates()
        .into_iter()
        .find(|t| t.id == req.template_id)
        .ok_or_else(|| {
            format!(
                "unknown template id: {} (BYOF templates land in phase C5)",
                req.template_id
            )
        })?;

    // Compute paper folder absolute path.
    let slug = slugify(&req.title);
    let parent_abs = join_inside_vault(&vault, &req.parent_rel)?;
    if !parent_abs.is_dir() {
        std::fs::create_dir_all(&parent_abs)
            .map_err(|e| format!("failed to create parent {}: {}", parent_abs.display(), e))?;
    }
    let mut paper_abs = parent_abs.join(&slug);
    // Disambiguate if the slug already exists.
    if paper_abs.exists() {
        for n in 2u32..=99 {
            let candidate = parent_abs.join(format!("{}-{}", slug, n));
            if !candidate.exists() {
                paper_abs = candidate;
                break;
            }
        }
        if paper_abs.exists() {
            return Err(format!(
                "could not find a free folder name under {} for slug {}",
                parent_abs.display(),
                slug
            ));
        }
    }

    // Build the on-disk scaffold.
    templates::write_scaffold(&paper_abs, &template, &req)
        .map_err(|e| format!("failed to write paper scaffold: {}", e))?;

    // Emit paper.toml.
    let cfg = PaperToml::new_for(&template, &req);
    let toml_dir = paper_abs.join(".lattice");
    std::fs::create_dir_all(&toml_dir)
        .map_err(|e| format!("failed to create .lattice dir: {}", e))?;
    cfg.save(&toml_dir.join("paper.toml"))?;

    // Compute the vault-relative paths returned to the frontend.
    let canon_vault = vault
        .canonicalize()
        .map_err(|e| format!("failed to canonicalise vault: {}", e))?;
    let canon_paper = paper_abs
        .canonicalize()
        .map_err(|e| format!("failed to canonicalise paper folder: {}", e))?;
    let paper_rel = canon_paper
        .strip_prefix(&canon_vault)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| canon_paper.to_string_lossy().to_string());

    Ok(NewPaperResult {
        paper_abs_path: paper_abs.to_string_lossy().to_string(),
        paper_rel_path: paper_rel.clone(),
        open_rel_path: format!("{}/sections/01-introduction.md", paper_rel),
    })
}

/// Read `.lattice/paper.toml` + (later) `.lattice/paper-state.json` for
/// the given paper folder.  Returns `{ exists: false }` when the folder
/// doesn't have a `paper.toml` (i.e. the active editor file isn't in a
/// paper).
#[tauri::command]
pub async fn paper_status(paper: String) -> Result<PaperStatus, String> {
    if paper.is_empty() {
        return Err("paper path is empty".to_string());
    }
    let paper_abs = PathBuf::from(&paper);
    let toml_path = paper_abs.join(".lattice").join("paper.toml");
    if !toml_path.is_file() {
        return Ok(PaperStatus { exists: false, ..Default::default() });
    }
    let cfg = PaperToml::load(&toml_path)?;
    Ok(PaperStatus {
        exists: true,
        title: Some(cfg.meta.title.clone()),
        engine: Some(cfg.engine.kind),
        template_id: Some(cfg.engine.template.clone()),
        last_compiled_at: None,
        last_pdf_path: None,
        last_error: None,
    })
}

// ── Stub commands — phases C1-compile / C2-C9 ────────────────────────────
//
// All of the heavy commands below are registered now so the TS layer can
// import them and the IPC surface is locked in, but they return a clear
// "phase X" error message until the matching slice lands.  This avoids
// the silent-failure mode where the frontend invokes a non-existent IPC
// and gets back the generic Tauri "command not found" string.

#[tauri::command]
pub async fn paper_compile(paper: String) -> Result<String, String> {
    if paper.is_empty() {
        return Err("paper path is empty".to_string());
    }
    let paper_abs = PathBuf::from(&paper);
    if !paper_abs.is_dir() {
        return Err(format!("paper folder not found: {}", paper_abs.display()));
    }
    // Defensive: a paper is identified by the presence of
    // .lattice/paper.toml.  Reject anything else so we don't compile
    // arbitrary folders the UI may pass by mistake.
    if !paper_abs.join(".lattice").join("paper.toml").is_file() {
        return Err(format!(
            "no .lattice/paper.toml under {} \u{2014} not a paper folder",
            paper_abs.display()
        ));
    }
    // The compile pipeline is CPU-bound (LaTeX shell-out) so we run
    // it on the blocking pool to keep the Tauri event loop responsive.
    let pdf = tokio::task::spawn_blocking(move || compile::compile(&paper_abs))
        .await
        .map_err(|e| format!("paper_compile join error: {e}"))??;
    Ok(pdf.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn paper_preflight(paper: String) -> Result<Vec<PreflightFinding>, String> {
    let _ = paper;
    Err("paper_preflight is not yet implemented (lands in phase C7)".to_string())
}

#[tauri::command]
pub async fn paper_emit_bundle(paper: String) -> Result<String, String> {
    if paper.is_empty() {
        return Err("paper path is empty".to_string());
    }
    let paper_abs = PathBuf::from(&paper);
    if !paper_abs.is_dir() {
        return Err(format!("paper folder not found: {}", paper_abs.display()));
    }
    if !paper_abs.join(".lattice").join("paper.toml").is_file() {
        return Err(format!(
            "no .lattice/paper.toml under {} \u{2014} not a paper folder",
            paper_abs.display()
        ));
    }
    // Zip writer + walkdir are blocking I/O — keep them off the IPC
    // executor so the toolbar's busy spinner can render the in-flight
    // state.
    let zip = tokio::task::spawn_blocking(move || bundle::emit_bundle(&paper_abs))
        .await
        .map_err(|e| format!("paper_emit_bundle join error: {e}"))??;
    Ok(zip.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn paper_open_overleaf(paper: String) -> Result<String, String> {
    // Same precondition checks as paper_emit_bundle — we re-bundle
    // every time so the user always uploads the latest sources.
    if paper.is_empty() {
        return Err("paper path is empty".to_string());
    }
    let paper_abs = PathBuf::from(&paper);
    if !paper_abs.is_dir() {
        return Err(format!("paper folder not found: {}", paper_abs.display()));
    }
    if !paper_abs.join(".lattice").join("paper.toml").is_file() {
        return Err(format!(
            "no .lattice/paper.toml under {} \u{2014} not a paper folder",
            paper_abs.display()
        ));
    }
    // Generate (or regenerate) the zip on disk.  The frontend then
    // shells out to plugin-opener to:
    //   (1) open the containing folder in OS Explorer (so the user can
    //       drag-drop the zip into Overleaf), AND
    //   (2) open https://www.overleaf.com/project in the default
    //       browser (the New Project page).
    // We return the zip path so the TS layer can do both with one IPC.
    let zip = tokio::task::spawn_blocking(move || bundle::emit_bundle(&paper_abs))
        .await
        .map_err(|e| format!("paper_open_overleaf join error: {e}"))??;
    Ok(zip.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn paper_diff(paper: String) -> Result<Option<String>, String> {
    let _ = paper;
    Err("paper_diff is not yet implemented (lands in phase C7)".to_string())
}

#[tauri::command]
pub async fn paper_byof_import(vault: String, zip_path: String) -> Result<String, String> {
    let _ = (vault, zip_path);
    Err("paper_byof_import is not yet implemented (lands in phase C5)".to_string())
}

#[tauri::command]
pub async fn paper_byof_re_import(
    vault: String,
    byof_id: String,
    zip_path: String,
) -> Result<String, String> {
    let _ = (vault, byof_id, zip_path);
    Err("paper_byof_re_import is not yet implemented (lands in phase C5)".to_string())
}

#[tauri::command]
pub async fn paper_byof_remove(vault: String, byof_id: String) -> Result<(), String> {
    let _ = (vault, byof_id);
    Err("paper_byof_remove is not yet implemented (lands in phase C5)".to_string())
}

#[tauri::command]
pub async fn paper_set_compile_engine(paper: String, engine_kind: EngineKind) -> Result<(), String> {
    if paper.is_empty() {
        return Err("paper path is empty".to_string());
    }
    let toml_path = PathBuf::from(&paper).join(".lattice").join("paper.toml");
    if !toml_path.is_file() {
        return Err(format!("no paper.toml at {}", toml_path.display()));
    }
    let mut cfg = PaperToml::load(&toml_path)?;
    cfg.engine.kind = engine_kind;
    cfg.save(&toml_path)
}

// ─── Unit tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_basics() {
        assert_eq!(slugify("On the Local-First PKM"), "on-the-local-first-pkm");
        assert_eq!(slugify("  trailing  "), "trailing");
        assert_eq!(slugify("!!!"), "untitled");
        assert_eq!(slugify("ALL CAPS!"), "all-caps");
        assert_eq!(slugify("a/b\\c"), "a-b-c");
    }

    #[test]
    fn vault_dir_rejects_mock_sentinel() {
        let err = vault_dir("__mock__").unwrap_err();
        assert!(err.contains("mock vault"));
    }

    #[test]
    fn vault_dir_rejects_empty() {
        assert!(vault_dir("").is_err());
    }
}
