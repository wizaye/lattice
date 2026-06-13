//! Importer IPC commands — delegate to `importer::ImporterFactory`.
//!
//! **SRP**: This file contains ONLY command wiring.  All format-specific
//! logic lives in the `importer/` strategy implementations.

use crate::importer::{ImportStats, ImporterFactory};
use std::path::PathBuf;

#[tauri::command]
pub async fn import_obsidian_vault(
    source_path: String,
    target_path: String,
) -> Result<ImportStats, String> {
    let factory = ImporterFactory::default();
    let strategy = factory.get("obsidian")
        .ok_or("Obsidian importer not available")?;
    strategy.import(&PathBuf::from(&source_path), &PathBuf::from(&target_path))
}

#[tauri::command]
pub async fn import_logseq_graph(
    source_path: String,
    target_path: String,
) -> Result<ImportStats, String> {
    let factory = ImporterFactory::default();
    let strategy = factory.get("logseq")
        .ok_or("Logseq importer not available")?;
    strategy.import(&PathBuf::from(&source_path), &PathBuf::from(&target_path))
}

#[tauri::command]
pub async fn import_notion_export(
    zip_path: String,
    target_path: String,
) -> Result<ImportStats, String> {
    let factory = ImporterFactory::default();
    let strategy = factory.get("notion")
        .ok_or("Notion importer not available")?;
    strategy.import(&PathBuf::from(&zip_path), &PathBuf::from(&target_path))
}
