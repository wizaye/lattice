//! Shared import helpers — RAII temp-dir, fence-aware block-ref converter,
//! Notion filename deduplication.  No strategy-specific logic here.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

// ── RAII temp-dir guard ──────────────────────────────────────────────────

/// Wraps a temporary directory and removes it on `Drop`.
///
/// Ensures cleanup even when an operation returns early via `?`.
pub struct TempDirGuard(pub PathBuf);

impl TempDirGuard {
    pub fn create() -> Result<Self, String> {
        let dir = std::env::temp_dir()
            .join(format!("lattice_import_{}", std::process::id()));
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create temp dir: {e}"))?;
        Ok(TempDirGuard(dir))
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// ── Source validation helper ─────────────────────────────────────────────

/// Assert that `path` is an existing directory.  Used by importers
/// that take a vault/graph directory as their source.
pub fn assert_is_directory(path: &Path, label: &str) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("{label} does not exist: {}", path.display()));
    }
    if !path.is_dir() {
        return Err(format!("{label} must be a directory: {}", path.display()));
    }
    Ok(())
}

/// Assert that `path` is an existing file.  Used by the Notion
/// importer which takes a `.zip` path as its source.
pub fn assert_is_file(path: &Path, label: &str) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("{label} does not exist: {}", path.display()));
    }
    if !path.is_file() {
        return Err(format!("{label} must be a file: {}", path.display()));
    }
    Ok(())
}

// ── Fence-aware Logseq block-ref conversion ──────────────────────────────

/// Replace Logseq `((block-ref))` syntax with `[[block-ref]]` wikilinks
/// **only outside fenced code blocks**.
///
/// The naive global `.replace("((", "[[")` that was in the old monolith
/// corrupted code blocks, math expressions, and footnotes.
pub fn convert_logseq_block_refs(content: &str) -> String {
    let mut result = String::with_capacity(content.len());
    let mut in_fence = false;
    let mut fence_char: Option<char> = None;

    for line in content.lines() {
        let trimmed = line.trim();
        if !in_fence {
            if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
                in_fence = true;
                fence_char = Some(trimmed.chars().next().unwrap());
                result.push_str(line);
                result.push('\n');
                continue;
            }
        } else {
            if let Some(fc) = fence_char {
                let marker: String = std::iter::repeat(fc).take(3).collect();
                if trimmed.starts_with(&marker) {
                    in_fence = false;
                    fence_char = None;
                }
            }
            result.push_str(line);
            result.push('\n');
            continue;
        }
        result.push_str(&convert_block_refs_in_line(line));
        result.push('\n');
    }
    result
}

fn convert_block_refs_in_line(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '(' && chars.peek() == Some(&'(') {
            chars.next();
            let mut inner = String::new();
            let mut closed = false;
            while let Some(ic) = chars.next() {
                if ic == ')' && chars.peek() == Some(&')') {
                    chars.next();
                    closed = true;
                    break;
                }
                inner.push(ic);
            }
            if closed {
                out.push_str("[[");
                out.push_str(&inner);
                out.push_str("]]");
            } else {
                out.push_str("((");
                out.push_str(&inner);
            }
        } else {
            out.push(c);
        }
    }
    out
}

// ── Notion filename deduplication ────────────────────────────────────────

/// Strip Notion's UUID suffix and deduplicate within an import session.
///
/// `"My Note abc123def.md"` → `"My Note.md"`.
/// If the clean name is already taken, appends `(2)`, `(3)`, … so
/// pages with the same title don't silently overwrite each other.
pub fn unique_notion_filename(raw: &str, used: &mut HashSet<String>) -> String {
    let base = clean_notion_filename(raw);
    if !used.contains(&base) {
        return base;
    }
    let (stem, ext) = base
        .rsplit_once('.')
        .map(|(s, e)| (s.to_string(), format!(".{e}")))
        .unwrap_or_else(|| (base.clone(), String::new()));
    let mut n = 2u32;
    loop {
        let candidate = format!("{stem} ({n}){ext}");
        if !used.contains(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

fn clean_notion_filename(filename: &str) -> String {
    if let Some(pos) = filename.rfind(' ') {
        let (name, suffix) = filename.split_at(pos);
        if suffix.len() > 30 && suffix.ends_with(".md") {
            return format!("{name}.md");
        }
    }
    filename.to_string()
}

// ── Zip extraction ───────────────────────────────────────────────────────

pub fn extract_zip(zip_path: &Path, output_dir: &Path) -> Result<(), String> {
    let file = std::fs::File::open(zip_path)
        .map_err(|e| format!("Failed to open zip: {e}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Failed to read zip: {e}"))?;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i)
            .map_err(|e| format!("Failed to read zip entry: {e}"))?;
        let outpath = match file.enclosed_name() {
            Some(path) => output_dir.join(path),
            None => continue,
        };
        if file.name().ends_with('/') {
            std::fs::create_dir_all(&outpath)
                .map_err(|e| format!("Failed to create dir: {e}"))?;
        } else {
            if let Some(parent) = outpath.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create dir: {e}"))?;
            }
            let mut outfile = std::fs::File::create(&outpath)
                .map_err(|e| format!("Failed to create file: {e}"))?;
            std::io::copy(&mut file, &mut outfile)
                .map_err(|e| format!("Failed to extract file: {e}"))?;
        }
    }
    Ok(())
}
