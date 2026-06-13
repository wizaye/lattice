//! Obsidian vault importer — Strategy implementation.
//!
//! Copies `.md` files and common attachment formats verbatim.
//! Wikilinks are Obsidian-native and compatible with Lattice out of
//! the box, so no link conversion is needed.

use std::path::{Path, PathBuf};
use walkdir::WalkDir;
use super::{ImportStats, ImportStrategy};
use super::helpers::assert_is_directory;

/// Obsidian vault importer.
///
/// Source: an existing Obsidian vault directory.
/// Copies markdown + attachments; wikilinks are preserved as-is.
pub struct ObsidianImporter;

impl ImportStrategy for ObsidianImporter {
    fn format_name(&self) -> &'static str {
        "Obsidian"
    }

    fn validate_source(&self, source: &Path) -> Result<(), String> {
        assert_is_directory(source, "Obsidian vault")
    }

    fn import(&self, source: &Path, target_vault: &Path) -> Result<ImportStats, String> {
        self.validate_source(source)?;
        let mut stats = ImportStats::default();

        // Copy markdown files
        for entry in WalkDir::new(source).into_iter().filter_map(|e| e.ok())
            .filter(|e| ext_is(e.path(), "md"))
        {
            copy_entry(entry.path(), source, target_vault)?;
            stats.files_imported += 1;
        }

        // Copy attachments
        for entry in WalkDir::new(source).into_iter().filter_map(|e| e.ok())
            .filter(|e| is_attachment(e.path()))
        {
            copy_entry(entry.path(), source, target_vault)?;
            stats.attachments_imported += 1;
        }

        // Plugin migration is stubbed — not feasible without a full
        // Obsidian plugin registry.  Log count as 0.
        Ok(stats)
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────

fn ext_is(p: &Path, ext: &str) -> bool {
    p.extension().and_then(|s| s.to_str()).map_or(false, |e| e.eq_ignore_ascii_case(ext))
}

fn is_attachment(p: &Path) -> bool {
    matches!(
        p.extension().and_then(|s| s.to_str()).map(|s| s.to_lowercase()).as_deref(),
        Some("png") | Some("jpg") | Some("jpeg") | Some("gif") | Some("webp")
            | Some("pdf") | Some("svg") | Some("mp4") | Some("mp3")
    )
}

fn copy_entry(src: &Path, source_root: &Path, target_vault: &Path) -> Result<(), String> {
    let rel = src.strip_prefix(source_root)
        .map_err(|e| format!("Path strip error: {e}"))?;
    let dst: PathBuf = target_vault.join(rel);
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create dir: {e}"))?;
    }
    std::fs::copy(src, &dst)
        .map_err(|e| format!("Failed to copy {:?}: {e}", src))?;
    Ok(())
}
