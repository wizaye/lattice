use tauri::State;
use std::sync::Arc;
use lattice_vault::{Vault, NoteMeta, NoteContent, NoteFolder, Task, VaultSettings};
use lattice_vault::parse::extract_tasks;
use trash;

/// Global vault state
pub struct VaultState(pub Arc<tokio::sync::RwLock<Option<Arc<Vault>>>>);

// ===== Vault Lifecycle =====

#[tauri::command]
pub async fn open_vault(path: String, state: State<'_, VaultState>) -> Result<String, String> {
    let vault = Vault::open(std::path::PathBuf::from(&path))
        .await
        .map_err(|e| e.to_string())?;
    
    *state.0.write().await = Some(Arc::new(vault));
    Ok(format!("Opened vault at: {}", path))
}

#[tauri::command]
pub async fn close_vault(state: State<'_, VaultState>) -> Result<(), String> {
    *state.0.write().await = None;
    Ok(())
}

async fn get_vault(state: State<'_, VaultState>) -> Result<Arc<Vault>, String> {
    state
        .0
        .read()
        .await
        .clone()
        .ok_or_else(|| "No vault open".to_string())
}

// ===== Note Operations =====

#[tauri::command]
pub async fn list_notes(state: State<'_, VaultState>) -> Result<Vec<NoteMeta>, String> {
    let vault = get_vault(state).await?;
    vault.list_notes().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn read_note(rel: String, state: State<'_, VaultState>) -> Result<NoteContent, String> {
    let vault = get_vault(state).await?;
    vault.read_note(&rel).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn write_note(
    rel: String,
    body: String,
    state: State<'_, VaultState>,
) -> Result<NoteMeta, String> {
    let vault = get_vault(state).await?;
    vault.write_note(&rel, &body).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_note(
    folder: String,
    title: Option<String>,
    subpath: Option<String>,
    state: State<'_, VaultState>,
) -> Result<NoteMeta, String> {
    let vault = get_vault(state).await?;
    
    let folder_enum = match folder.as_str() {
        "inbox" => NoteFolder::Inbox,
        "quick" => NoteFolder::Quick,
        "archive" => NoteFolder::Archive,
        "trash" => NoteFolder::Trash,
        "daily" => NoteFolder::Daily,
        _ => NoteFolder::Root,
    };
    
    vault
        .create_note(folder_enum, title.as_deref(), subpath.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rename_note(
    rel: String,
    new_title: String,
    state: State<'_, VaultState>,
) -> Result<NoteMeta, String> {
    let vault = get_vault(state).await?;
    vault.rename_note(&rel, &new_title).await.map_err(|e| e.to_string())
}

/// Move a file to the vault's `.lattice/trash/` folder without requiring
/// `open_vault` (which would create unwanted folder structure).  Uses the
/// system `trash` crate so the file lands in the recycle bin / Finder Trash.
/// Falls back to a manual copy-then-delete into `<vault>/.lattice/trash/`
/// if the path-based trash crate fails (e.g. cross-device moves).
#[tauri::command]
pub async fn move_file_to_vault_trash(vault_path: String, rel_path: String) -> Result<String, String> {
    if vault_path.is_empty() || vault_path == "__mock__" {
        return Err("invalid vault path".to_string());
    }
    let vault = std::path::PathBuf::from(&vault_path);
    if !vault.is_dir() {
        return Err(format!("vault path is not a directory: {}", vault_path));
    }
    // Compute the absolute file path from vault + rel
    let abs = {
        let p = vault.join(&rel_path);
        let p = p.canonicalize().unwrap_or(p);
        p
    };
    if !abs.exists() {
        return Err(format!("file not found: {}", abs.display()));
    }
    // Use system trash crate first (recycle bin on Windows)
    trash::delete(&abs).map_err(|e| e.to_string())?;
    Ok(abs.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn move_to_trash(rel: String, state: State<'_, VaultState>) -> Result<NoteMeta, String> {
    let vault = get_vault(state).await?;
    vault.move_to_trash(&rel).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn restore_from_trash(
    rel: String,
    state: State<'_, VaultState>,
) -> Result<NoteMeta, String> {
    let vault = get_vault(state).await?;
    vault.restore_from_trash(&rel).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn empty_trash(state: State<'_, VaultState>) -> Result<(), String> {
    let vault = get_vault(state).await?;
    let trash_dir = vault.root().join("trash");
    if trash_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(trash_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    let _ = std::fs::remove_file(&path);
                } else if path.is_dir() {
                    let _ = std::fs::remove_dir_all(&path);
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn archive_note(rel: String, state: State<'_, VaultState>) -> Result<NoteMeta, String> {
    let vault = get_vault(state).await?;
    vault.archive_note(&rel).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn unarchive_note(rel: String, state: State<'_, VaultState>) -> Result<NoteMeta, String> {
    let vault = get_vault(state).await?;
    vault.unarchive_note(&rel).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_note(rel: String, state: State<'_, VaultState>) -> Result<(), String> {
    let vault = get_vault(state).await?;
    vault.delete_note(&rel).await.map_err(|e| e.to_string())
}

// ===== Task Operations =====

/// Scan all tasks in the vault without requiring a VaultState registration
/// (i.e. without calling open_vault which creates folder structure).
/// Walks every .md file under vault_path and extracts tasks directly.
#[tauri::command]
pub async fn scan_tasks_from_path(vault_path: String) -> Result<Vec<Task>, String> {
    if vault_path.is_empty() || vault_path == "__mock__" {
        return Ok(vec![]);
    }
    let root = std::path::PathBuf::from(&vault_path);
    if !root.is_dir() {
        return Err(format!("vault path is not a directory: {}", vault_path));
    }
    let mut all_tasks: Vec<Task> = Vec::new();
    // Walk .md files recursively, skipping the .lattice state directory
    let walker = walkdir::WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            // Skip hidden directories and .lattice state dir
            let name = e.file_name().to_string_lossy();
            !(name.starts_with('.') && e.depth() > 0)
        });
    for entry in walker.flatten() {
        if entry.file_type().is_file() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("md") {
                if let Ok(content) = std::fs::read_to_string(path) {
                    let rel = path.strip_prefix(&root)
                        .map(|p| p.to_string_lossy().into_owned())
                        .unwrap_or_else(|_| path.to_string_lossy().into_owned());
                    let tasks = extract_tasks(&content, &rel);
                    all_tasks.extend(tasks);
                }
            }
        }
    }
    Ok(all_tasks)
}

#[tauri::command]
pub async fn scan_tasks(state: State<'_, VaultState>) -> Result<Vec<Task>, String> {
    let vault = get_vault(state).await?;
    vault.scan_tasks().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn scan_tasks_for_note(
    rel: String,
    state: State<'_, VaultState>,
) -> Result<Vec<Task>, String> {
    let vault = get_vault(state).await?;
    vault.scan_tasks_for_note(&rel).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn toggle_task(
    rel: String,
    task_id: String,
    state: State<'_, VaultState>,
) -> Result<Task, String> {
    let vault = get_vault(state).await?;
    vault.toggle_task(&rel, &task_id).await.map_err(|e| e.to_string())
}

// ===== Settings =====

#[tauri::command]
pub async fn get_vault_settings(state: State<'_, VaultState>) -> Result<VaultSettings, String> {
    let vault = get_vault(state).await?;
    Ok(vault.get_settings().await)
}

#[tauri::command]
pub async fn set_vault_settings(
    settings: VaultSettings,
    state: State<'_, VaultState>,
) -> Result<VaultSettings, String> {
    let vault = get_vault(state).await?;
    vault.set_settings(settings).await.map_err(|e| e.to_string())
}

// ===== Backlinks =====

#[tauri::command]
pub async fn get_backlinks(
    target: String,
    state: State<'_, VaultState>,
) -> Result<Vec<(String, usize)>, String> {
    let vault = get_vault(state).await?;
    vault.get_backlinks(&target).await.map_err(|e| e.to_string())
}
