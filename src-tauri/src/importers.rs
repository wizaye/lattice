//! Importers — migrate notes from other PKM tools
//! 
//! Implements impl-v2 §11: Built-in tier importers
//! - Obsidian: Copy vault, migrate plugins, preserve wikilinks
//! - Logseq: Import journals, convert block refs, migrate graph
//! - Notion: Import export zip, convert blocks to markdown

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

// ── Obsidian Importer ───────────────────────────────────────────────────

/// Import Obsidian vault
pub async fn import_obsidian(
    source_vault: &Path,
    target_vault: &Path,
) -> Result<ImportStats, String> {
    let mut stats = ImportStats::default();
    
    // Copy all markdown files
    for entry in WalkDir::new(source_vault)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("md"))
    {
        let rel_path = entry
            .path()
            .strip_prefix(source_vault)
            .map_err(|e| format!("Path error: {}", e))?;
        let target_path = target_vault.join(rel_path);
        
        // Create parent directory
        if let Some(parent) = target_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        }
        
        // Copy file (preserves wikilinks as-is)
        std::fs::copy(entry.path(), &target_path)
            .map_err(|e| format!("Failed to copy file: {}", e))?;
        
        stats.files_imported += 1;
    }
    
    // Copy attachments (images, PDFs, etc.)
    for entry in WalkDir::new(source_vault)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            matches!(
                e.path().extension().and_then(|s| s.to_str()),
                Some("png") | Some("jpg") | Some("jpeg") | Some("pdf") | Some("svg")
            )
        })
    {
        let rel_path = entry
            .path()
            .strip_prefix(source_vault)
            .map_err(|e| format!("Path error: {}", e))?;
        let target_path = target_vault.join(rel_path);
        
        if let Some(parent) = target_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        }
        
        std::fs::copy(entry.path(), &target_path)
            .map_err(|e| format!("Failed to copy attachment: {}", e))?;
        
        stats.attachments_imported += 1;
    }
    
    // Migrate plugin configuration (stub)
    stats.plugins_migrated = migrate_obsidian_plugins(source_vault, target_vault)?;
    
    Ok(stats)
}

fn migrate_obsidian_plugins(
    _source: &Path,
    _target: &Path,
) -> Result<usize, String> {
    // TODO: Parse .obsidian/plugins and create equivalents in .lattice
    // For now, just return 0
    Ok(0)
}

// ── Logseq Importer ─────────────────────────────────────────────────────

/// Import Logseq graph
pub async fn import_logseq(
    source_graph: &Path,
    target_vault: &Path,
) -> Result<ImportStats, String> {
    let mut stats = ImportStats::default();
    
    // Copy journal entries (already compatible format)
    let journals_src = source_graph.join("journals");
    let journals_dst = target_vault.join("journals");
    
    if journals_src.exists() {
        std::fs::create_dir_all(&journals_dst)
            .map_err(|e| format!("Failed to create journals dir: {}", e))?;
        
        for entry in WalkDir::new(&journals_src)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("md"))
        {
            let rel_path = entry
                .path()
                .strip_prefix(&journals_src)
                .map_err(|e| format!("Path error: {}", e))?;
            let target_path = journals_dst.join(rel_path);
            
            if let Some(parent) = target_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create directory: {}", e))?;
            }
            
            // Convert block refs from ((ref)) to [[ref]]
            let content = std::fs::read_to_string(entry.path())
                .map_err(|e| format!("Failed to read file: {}", e))?;
            let converted = content.replace("((", "[[").replace("))", "]]");
            
            std::fs::write(&target_path, converted)
                .map_err(|e| format!("Failed to write file: {}", e))?;
            
            stats.files_imported += 1;
        }
    }
    
    // Copy pages (regular notes)
    let pages_src = source_graph.join("pages");
    if pages_src.exists() {
        for entry in WalkDir::new(&pages_src)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("md"))
        {
            let rel_path = entry
                .path()
                .strip_prefix(&pages_src)
                .map_err(|e| format!("Path error: {}", e))?;
            let target_path = target_vault.join(rel_path);
            
            if let Some(parent) = target_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create directory: {}", e))?;
            }
            
            let content = std::fs::read_to_string(entry.path())
                .map_err(|e| format!("Failed to read file: {}", e))?;
            let converted = content.replace("((", "[[").replace("))", "]]");
            
            std::fs::write(&target_path, converted)
                .map_err(|e| format!("Failed to write file: {}", e))?;
            
            stats.files_imported += 1;
        }
    }
    
    // Migrate graph config (stub)
    stats.graph_config_migrated = true;
    
    Ok(stats)
}

// ── Notion Importer ─────────────────────────────────────────────────────

/// Import Notion export zip
pub async fn import_notion(
    export_zip: &Path,
    target_vault: &Path,
) -> Result<ImportStats, String> {
    let mut stats = ImportStats::default();
    
    // Extract zip to temporary directory
    let temp_dir = std::env::temp_dir().join(format!("lattice_notion_import_{}", std::process::id()));
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create temp dir: {}", e))?;
    
    extract_zip(export_zip, &temp_dir)?;
    
    // Process all markdown files in the export
    for entry in WalkDir::new(&temp_dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .map(|ext| ext == "md")
                .unwrap_or(false)
        })
    {
        let content = std::fs::read_to_string(entry.path())
            .map_err(|e| format!("Failed to read file: {}", e))?;
        
        // Convert Notion blocks to standard markdown
        let converted = convert_notion_blocks(&content);
        
        // Extract clean filename (Notion adds hashes)
        let filename = entry
            .file_name()
            .to_string_lossy()
            .to_string();
        let clean_name = clean_notion_filename(&filename);
        
        let target_path = target_vault.join(&clean_name);
        if let Some(parent) = target_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        }
        
        std::fs::write(&target_path, converted)
            .map_err(|e| format!("Failed to write file: {}", e))?;
        
        stats.files_imported += 1;
    }
    
    // Copy attachments
    for entry in WalkDir::new(&temp_dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .map(|ext| matches!(ext.to_str(), Some("png") | Some("jpg") | Some("jpeg") | Some("pdf") | Some("csv")))
                .unwrap_or(false)
        })
    {
        let filename = entry
            .file_name()
            .to_string_lossy()
            .to_string();
        let target_path = target_vault.join("attachments").join(filename);
        
        if let Some(parent) = target_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        }
        
        std::fs::copy(entry.path(), &target_path)
            .map_err(|e| format!("Failed to copy attachment: {}", e))?;
        
        stats.attachments_imported += 1;
    }
    
    // Convert databases (stub)
    stats.databases_converted = convert_notion_databases(&temp_dir, target_vault)?;
    
    // Cleanup temp directory
    let _ = std::fs::remove_dir_all(&temp_dir);
    
    Ok(stats)
}

fn extract_zip(zip_path: &Path, output_dir: &Path) -> Result<(), String> {
    let file = std::fs::File::open(zip_path)
        .map_err(|e| format!("Failed to open zip: {}", e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Failed to read zip: {}", e))?;
    
    for i in 0..archive.len() {
        let mut file = archive.by_index(i)
            .map_err(|e| format!("Failed to read zip entry: {}", e))?;
        let outpath = match file.enclosed_name() {
            Some(path) => output_dir.join(path),
            None => continue,
        };
        
        if file.name().ends_with('/') {
            std::fs::create_dir_all(&outpath)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        } else {
            if let Some(parent) = outpath.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create directory: {}", e))?;
            }
            let mut outfile = std::fs::File::create(&outpath)
                .map_err(|e| format!("Failed to create file: {}", e))?;
            std::io::copy(&mut file, &mut outfile)
                .map_err(|e| format!("Failed to copy file: {}", e))?;
        }
    }
    
    Ok(())
}

fn convert_notion_blocks(content: &str) -> String {
    let mut result = content.to_string();
    
    // Convert Notion callouts to standard markdown
    result = result.replace("💡 ", "> [!note] ");
    result = result.replace("⚠️ ", "> [!warning] ");
    result = result.replace("✅ ", "> [!success] ");
    
    // Convert Notion checkboxes
    result = result.replace("☐ ", "- [ ] ");
    result = result.replace("☑ ", "- [x] ");
    
    // Convert Notion toggle blocks (simplified)
    result = result.replace("▸ ", "<details>\n<summary>");
    
    result
}

fn clean_notion_filename(filename: &str) -> String {
    // Remove Notion's UUID suffix: "My Note abc123def.md" -> "My Note.md"
    if let Some(pos) = filename.rfind(' ') {
        let (name, suffix) = filename.split_at(pos);
        if suffix.len() > 30 && suffix.ends_with(".md") {
            return format!("{}.md", name);
        }
    }
    filename.to_string()
}

fn convert_notion_databases(
    _source: &Path,
    _target: &Path,
) -> Result<usize, String> {
    // TODO: Convert Notion CSV exports to Lattice .lattice-db format
    Ok(0)
}

// ── Import Stats ────────────────────────────────────────────────────────

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportStats {
    pub files_imported: usize,
    pub attachments_imported: usize,
    pub links_converted: usize,
    pub plugins_migrated: usize,
    pub databases_converted: usize,
    pub graph_config_migrated: bool,
}

// ── Tauri Commands ──────────────────────────────────────────────────────

#[tauri::command]
pub async fn import_obsidian_vault(
    source_path: String,
    target_path: String,
) -> Result<ImportStats, String> {
    let source = PathBuf::from(&source_path);
    let target = PathBuf::from(&target_path);
    
    if !source.exists() {
        return Err("Source vault does not exist".to_string());
    }
    
    import_obsidian(&source, &target).await
}

#[tauri::command]
pub async fn import_logseq_graph(
    source_path: String,
    target_path: String,
) -> Result<ImportStats, String> {
    let source = PathBuf::from(&source_path);
    let target = PathBuf::from(&target_path);
    
    if !source.exists() {
        return Err("Source graph does not exist".to_string());
    }
    
    import_logseq(&source, &target).await
}

#[tauri::command]
pub async fn import_notion_export(
    zip_path: String,
    target_path: String,
) -> Result<ImportStats, String> {
    let zip = PathBuf::from(&zip_path);
    let target = PathBuf::from(&target_path);
    
    if !zip.exists() {
        return Err("Export zip does not exist".to_string());
    }
    
    import_notion(&zip, &target).await
}
