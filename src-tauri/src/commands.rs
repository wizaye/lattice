//! Tauri IPC command handlers — thin wrappers that delegate to the
//! service layer.
//!
//! # SOLID Design
//!
//! ## Single Responsibility
//! This file contains ONLY Tauri command declarations. All business
//! logic lives in the appropriate service (fs_service, GraphService, etc.).
//!
//! ## Dependency Inversion
//! Commands receive services via the service layer rather than calling
//! std::fs directly.

use crate::fs_service::{
    FileRepository, LocalFileRepository, GraphService, GraphData,
    FileNode,
    ReadableRepository, WritableRepository, DirectoryRepository,
};
use serde::Serialize;

// Singleton service — commands use this.
// In a larger app this would come from Tauri managed state.
fn repo() -> LocalFileRepository {
    LocalFileRepository::new()
}

#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    repo().read_text(&path)
}

#[tauri::command]
pub fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    repo().read_bytes(&path)
}

#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<(), String> {
    repo().write_text(&path, &content)
}

#[tauri::command]
pub fn list_directory(path: String) -> Result<Vec<FileNode>, String> {
    repo().list_tree(&path)
}

#[tauri::command]
pub fn create_file(path: String) -> Result<(), String> {
    repo().create_file(&path)
}

#[tauri::command]
pub fn create_folder(path: String) -> Result<(), String> {
    repo().create_dir(&path)
}

#[tauri::command]
pub fn rename_entry(old_path: String, new_path: String) -> Result<(), String> {
    repo().rename(&old_path, &new_path)
}

#[tauri::command]
pub fn delete_file(path: String) -> Result<(), String> {
    repo().delete_file(&path)
}

#[tauri::command]
pub fn delete_folder(path: String) -> Result<(), String> {
    repo().delete_dir(&path)
}

#[tauri::command]
pub fn get_vault_graph(path: String) -> Result<GraphData, String> {
    let r = repo();
    GraphService::build_graph(&r, &path)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BacklinkRef {
    pub file_id: String,
    pub file_name: String,
    pub snippet: Option<String>,
}

#[tauri::command]
pub fn get_backlinks_legacy(vault_path: String, file_name: String) -> Result<Vec<BacklinkRef>, String> {
    use crate::fs_service::ReadableRepository;
    use lazy_static::lazy_static;
    use regex::Regex;
    lazy_static! {
        static ref WIKILINK: Regex = Regex::new(r"\[\[([^\]#|]+)").unwrap();
    }
    let r = repo();
    let tree = r.list_tree(&vault_path)?;
    let target_stem = std::path::Path::new(&file_name)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    let mut results = Vec::new();
    let mut queue: Vec<crate::fs_service::FileNode> = tree;
    while let Some(node) = queue.pop() {
        if node.is_dir {
            if let Some(children) = node.children {
                queue.extend(children);
            }
            continue;
        }
        if !node.name.ends_with(".md") { continue; }
        if let Ok(content) = r.read_text(&node.path) {
            for cap in WIKILINK.captures_iter(&content) {
                let link = cap[1].trim().to_lowercase();
                if link == target_stem {
                    results.push(BacklinkRef {
                        file_id: node.path.clone(),
                        file_name: node.name.clone(),
                        snippet: None,
                    });
                    break;
                }
            }
        }
    }
    Ok(results)
}

/// Open a new application window.
#[tauri::command]
pub async fn open_new_window(app: tauri::AppHandle) -> Result<(), String> {
    let label = format!("window_{}", uuid::Uuid::new_v4().simple());
    tauri::WebviewWindowBuilder::new(
        &app,
        label,
        tauri::WebviewUrl::App(Default::default()),
    )
    .title("Lattice")
    .inner_size(1400.0, 900.0)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}
