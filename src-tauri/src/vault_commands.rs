use tauri::State;
use std::sync::Arc;
use lattice_vault::{Vault, NoteMeta, NoteContent, NoteFolder, Task, VaultSettings};

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
