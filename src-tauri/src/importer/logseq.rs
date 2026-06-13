//! Logseq graph importer — Strategy implementation.
//!
//! Converts Logseq `((block-ref))` syntax to `[[wikilink]]` format
//! **only outside fenced code blocks** (fence-aware conversion fixes
//! the corruption bug from the old monolith).

use std::path::Path;
use walkdir::WalkDir;
use super::{ImportStats, ImportStrategy};
use super::helpers::{assert_is_directory, convert_logseq_block_refs};

/// Logseq graph importer.
///
/// Source: a Logseq graph directory (contains `journals/`, `pages/`).
/// Converts block-refs to wikilinks; copies journal entries and pages.
pub struct LogseqImporter;

impl ImportStrategy for LogseqImporter {
    fn format_name(&self) -> &'static str {
        "Logseq"
    }

    fn validate_source(&self, source: &Path) -> Result<(), String> {
        assert_is_directory(source, "Logseq graph")
    }

    fn import(&self, source: &Path, target_vault: &Path) -> Result<ImportStats, String> {
        self.validate_source(source)?;
        let mut stats = ImportStats::default();

        // Journals
        let journals_src = source.join("journals");
        if journals_src.exists() {
            let journals_dst = target_vault.join("journals");
            std::fs::create_dir_all(&journals_dst)
                .map_err(|e| format!("Failed to create journals dir: {e}"))?;
            import_md_dir(&journals_src, &journals_src, &journals_dst, &mut stats)?;
        }

        // Pages
        let pages_src = source.join("pages");
        if pages_src.exists() {
            import_md_dir(&pages_src, &pages_src, target_vault, &mut stats)?;
        }

        stats.graph_config_migrated = true;
        Ok(stats)
    }
}

fn import_md_dir(
    src_root: &Path,
    prefix: &Path,
    dst_root: &Path,
    stats: &mut ImportStats,
) -> Result<(), String> {
    for entry in WalkDir::new(src_root).into_iter().filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("md"))
    {
        let rel = entry.path().strip_prefix(prefix)
            .map_err(|e| format!("Path error: {e}"))?;
        let dst = dst_root.join(rel);
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create dir: {e}"))?;
        }
        let content = std::fs::read_to_string(entry.path())
            .map_err(|e| format!("Failed to read {:?}: {e}", entry.path()))?;
        // Fence-aware block-ref conversion (fixes old corruption bug)
        let converted = convert_logseq_block_refs(&content);
        let links = count_converted_refs(&content, &converted);
        std::fs::write(&dst, converted)
            .map_err(|e| format!("Failed to write {:?}: {e}", dst))?;
        stats.files_imported += 1;
        stats.links_converted += links;
    }
    Ok(())
}

/// Count how many block-refs were converted (for stats only).
fn count_converted_refs(original: &str, converted: &str) -> usize {
    let orig_count = original.matches("((").count();
    let new_count = converted.matches("((").count();
    orig_count.saturating_sub(new_count)
}
