//! Notion export importer — Strategy implementation.
//!
//! Extracts a Notion export `.zip`, converts block syntax to standard
//! Markdown, and deduplicates same-title filenames so no pages are
//! silently overwritten.

use std::collections::HashSet;
use std::path::Path;
use walkdir::WalkDir;
use super::{ImportStats, ImportStrategy};
use super::helpers::{assert_is_file, extract_zip, unique_notion_filename, TempDirGuard};

/// Notion export importer.
///
/// Source: a Notion export `.zip` file.
/// Extracts to a temp dir (cleaned up on drop), converts blocks, and
/// writes files with collision-safe names.
pub struct NotionImporter;

impl ImportStrategy for NotionImporter {
    fn format_name(&self) -> &'static str {
        "Notion"
    }

    fn validate_source(&self, source: &Path) -> Result<(), String> {
        assert_is_file(source, "Notion export zip")
    }

    fn import(&self, source: &Path, target_vault: &Path) -> Result<ImportStats, String> {
        self.validate_source(source)?;
        let mut stats = ImportStats::default();

        // TempDirGuard cleans up even if we return early with `?`
        let guard = TempDirGuard::create()?;
        extract_zip(source, guard.path())?;

        let mut used_names: HashSet<String> = HashSet::new();

        // Markdown files
        for entry in WalkDir::new(guard.path()).into_iter().filter_map(|e| e.ok())
            .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("md"))
        {
            let content = std::fs::read_to_string(entry.path())
                .map_err(|e| format!("Failed to read {:?}: {e}", entry.path()))?;
            let converted = convert_notion_blocks(&content);
            let raw_name = entry.file_name().to_string_lossy().to_string();
            let clean_name = unique_notion_filename(&raw_name, &mut used_names);
            used_names.insert(clean_name.clone());
            let dst = target_vault.join(&clean_name);
            if let Some(parent) = dst.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create dir: {e}"))?;
            }
            std::fs::write(&dst, converted)
                .map_err(|e| format!("Failed to write {:?}: {e}", dst))?;
            stats.files_imported += 1;
        }

        // Attachments
        for entry in WalkDir::new(guard.path()).into_iter().filter_map(|e| e.ok())
            .filter(|e| is_attachment(e.path()))
        {
            let fname = entry.file_name().to_string_lossy().to_string();
            let dst = target_vault.join("attachments").join(&fname);
            if let Some(parent) = dst.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create dir: {e}"))?;
            }
            std::fs::copy(entry.path(), &dst)
                .map_err(|e| format!("Failed to copy attachment: {e}"))?;
            stats.attachments_imported += 1;
        }

        // guard drops here → temp dir removed
        Ok(stats)
    }
}

fn is_attachment(p: &Path) -> bool {
    matches!(
        p.extension().and_then(|s| s.to_str()).map(|s| s.to_lowercase()).as_deref(),
        Some("png") | Some("jpg") | Some("jpeg") | Some("gif")
            | Some("pdf") | Some("csv") | Some("svg")
    )
}

fn convert_notion_blocks(content: &str) -> String {
    content
        .replace("💡 ", "> [!note] ")
        .replace("⚠️ ", "> [!warning] ")
        .replace("✅ ", "> [!success] ")
        .replace("☐ ", "- [ ] ")
        .replace("☑ ", "- [x] ")
}
