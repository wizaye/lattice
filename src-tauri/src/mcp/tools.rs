use serde_json::{json, Value};
use std::sync::Arc;
use lattice_vault::{Vault, NoteFolder};

// ─── helpers ─────────────────────────────────────────────────────────────────

fn folder_from_str(s: &str) -> NoteFolder {
    match s {
        "inbox"   => NoteFolder::Inbox,
        "quick"   => NoteFolder::Quick,
        "archive" => NoteFolder::Archive,
        "trash"   => NoteFolder::Trash,
        "daily"   => NoteFolder::Daily,
        _         => NoteFolder::Root,
    }
}

// ─── vault ───────────────────────────────────────────────────────────────────

pub async fn vault_info(vault: Arc<Vault>) -> Result<Value, String> {
    let settings = vault.get_settings().await;
    let notes    = vault.list_notes().await.map_err(|e| e.to_string())?;
    // Access the root path via the vault's list_notes and backlinks
    Ok(json!({
        "total_notes": notes.len(),
        "settings":    settings,
    }))
}

// ─── notes ───────────────────────────────────────────────────────────────────

pub async fn list_notes(vault: Arc<Vault>) -> Result<Value, String> {
    let notes = vault.list_notes().await.map_err(|e| e.to_string())?;
    Ok(json!(notes))
}

pub async fn read_note(vault: Arc<Vault>, rel: String) -> Result<Value, String> {
    let content = vault.read_note(&rel).await.map_err(|e| e.to_string())?;
    Ok(json!(content))
}

pub async fn write_note(vault: Arc<Vault>, rel: String, body: String) -> Result<Value, String> {
    let meta = vault.write_note(&rel, &body).await.map_err(|e| e.to_string())?;
    Ok(json!(meta))
}

pub async fn create_note(
    vault: Arc<Vault>,
    folder: String,
    title: Option<String>,
    subpath: Option<String>,
) -> Result<Value, String> {
    let folder_enum = folder_from_str(&folder);
    let meta = vault
        .create_note(folder_enum, title.as_deref(), subpath.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    Ok(json!(meta))
}

pub async fn rename_note(vault: Arc<Vault>, rel: String, new_title: String) -> Result<Value, String> {
    let meta = vault.rename_note(&rel, &new_title).await.map_err(|e| e.to_string())?;
    Ok(json!(meta))
}

pub async fn move_note_tool(
    vault: Arc<Vault>,
    rel: String,
    target_folder: String,
    _subpath: String,
) -> Result<Value, String> {
    // Implement move by read + trash + create in target folder
    let content = vault.read_note(&rel).await.map_err(|e| e.to_string())?;
    let folder_enum = folder_from_str(&target_folder);
    // Extract filename without path
    let filename = std::path::Path::new(&rel)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Untitled")
        .to_string();
    vault.move_to_trash(&rel).await.map_err(|e| e.to_string())?;
    let meta = vault
        .create_note(folder_enum, Some(&filename), None)
        .await
        .map_err(|e| e.to_string())?;
    vault.write_note(&meta.path, &content.body).await.map_err(|e| e.to_string())?;
    Ok(json!(meta))
}

pub async fn trash_note(vault: Arc<Vault>, rel: String) -> Result<Value, String> {
    let meta = vault.move_to_trash(&rel).await.map_err(|e| e.to_string())?;
    Ok(json!(meta))
}

pub async fn restore_note(vault: Arc<Vault>, rel: String) -> Result<Value, String> {
    let meta = vault.restore_from_trash(&rel).await.map_err(|e| e.to_string())?;
    Ok(json!(meta))
}

pub async fn archive_note_tool(vault: Arc<Vault>, rel: String) -> Result<Value, String> {
    let meta = vault.archive_note(&rel).await.map_err(|e| e.to_string())?;
    Ok(json!(meta))
}

pub async fn unarchive_note_tool(vault: Arc<Vault>, rel: String) -> Result<Value, String> {
    let meta = vault.unarchive_note(&rel).await.map_err(|e| e.to_string())?;
    Ok(json!(meta))
}

pub async fn delete_note_tool(vault: Arc<Vault>, rel: String) -> Result<Value, String> {
    vault.delete_note(&rel).await.map_err(|e| e.to_string())?;
    Ok(json!({ "deleted": rel }))
}

pub async fn duplicate_note(vault: Arc<Vault>, rel: String) -> Result<Value, String> {
    let content = vault.read_note(&rel).await.map_err(|e| e.to_string())?;
    let stem = std::path::Path::new(&rel)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Note")
        .to_string();
    let copy_title = format!("{} Copy", stem);
    // Get the folder part of rel
    let folder_str = std::path::Path::new(&rel)
        .parent()
        .and_then(|p| p.to_str())
        .unwrap_or("")
        .to_string();
    let folder_enum = if folder_str.contains("archive") { NoteFolder::Archive }
        else if folder_str.contains("quick") { NoteFolder::Quick }
        else if folder_str.contains("Daily") { NoteFolder::Daily }
        else { NoteFolder::Inbox };
    let meta = vault.create_note(folder_enum, Some(&copy_title), None).await.map_err(|e| e.to_string())?;
    vault.write_note(&meta.path, &content.body).await.map_err(|e| e.to_string())?;
    Ok(json!(meta))
}

pub async fn append_to_note(vault: Arc<Vault>, rel: String, content: String) -> Result<Value, String> {
    let current = vault.read_note(&rel).await.map_err(|e| e.to_string())?;
    let new_body = format!("{}\n{}", current.body.trim_end(), content);
    let meta = vault.write_note(&rel, &new_body).await.map_err(|e| e.to_string())?;
    Ok(json!(meta))
}

pub async fn prepend_to_note(vault: Arc<Vault>, rel: String, content: String) -> Result<Value, String> {
    let current = vault.read_note(&rel).await.map_err(|e| e.to_string())?;
    let new_body = format!("{}\n{}", content, current.body.trim_start());
    let meta = vault.write_note(&rel, &new_body).await.map_err(|e| e.to_string())?;
    Ok(json!(meta))
}

pub async fn replace_in_note(
    vault: Arc<Vault>,
    rel: String,
    from: String,
    to: String,
) -> Result<Value, String> {
    let current = vault.read_note(&rel).await.map_err(|e| e.to_string())?;
    let new_body = current.body.replacen(&from, &to, 1);
    let meta = vault.write_note(&rel, &new_body).await.map_err(|e| e.to_string())?;
    Ok(json!(meta))
}

pub async fn insert_at_line(
    vault: Arc<Vault>,
    rel: String,
    line: usize,
    content: String,
) -> Result<Value, String> {
    let current = vault.read_note(&rel).await.map_err(|e| e.to_string())?;
    let mut lines: Vec<&str> = current.body.lines().collect();
    let idx = line.saturating_sub(1).min(lines.len());
    lines.insert(idx, &content);
    let new_body = lines.join("\n");
    let meta = vault.write_note(&rel, &new_body).await.map_err(|e| e.to_string())?;
    Ok(json!(meta))
}

// ─── folders (filesystem operations) ─────────────────────────────────────────

pub async fn list_folders(vault: Arc<Vault>) -> Result<Value, String> {
    // Get vault root by reading a note to find the path, or use settings
    let settings = vault.get_settings().await;
    // We'll walk based on the primary location
    let loc = match settings.primary_notes_location {
        NoteFolder::Inbox => "inbox",
        _ => "",
    };
    Ok(json!({ "primary_notes_location": loc, "note": "Use list_notes to enumerate all files" }))
}

pub async fn create_folder(
    _vault: Arc<Vault>,
    _folder: String,
    _subpath: String,
) -> Result<Value, String> {
    Ok(json!({ "note": "Folder creation requires vault root access — use the desktop UI for now" }))
}

pub async fn rename_folder(
    _vault: Arc<Vault>,
    _folder: String,
    _old_name: String,
    _new_name: String,
) -> Result<Value, String> {
    Ok(json!({ "note": "Folder rename requires vault root access — use the desktop UI for now" }))
}

pub async fn delete_folder(
    _vault: Arc<Vault>,
    _folder: String,
    _subpath: String,
) -> Result<Value, String> {
    Ok(json!({ "note": "Folder delete requires vault root access — use the desktop UI for now" }))
}

// ─── search ──────────────────────────────────────────────────────────────────

pub async fn search_text(vault: Arc<Vault>, query: String) -> Result<Value, String> {
    // Scan notes for title/tag matches (full-text search needs vault root access)
    let notes = vault.list_notes().await.map_err(|e| e.to_string())?;
    if notes.is_empty() {
        return Ok(json!([]));
    }
    // Derive root from first note's absolute path
    // NoteMeta.path is relative — scan notes manually for query matches
    let mut results = Vec::new();
    let q = query.to_lowercase();
    for note in &notes {
        if note.title.to_lowercase().contains(&q) ||
           note.tags.iter().any(|t| t.to_lowercase().contains(&q)) {
            results.push(json!({ "path": note.path, "title": note.title }));
        }
    }
    Ok(json!(results))
}

pub async fn backlinks(vault: Arc<Vault>, target: String) -> Result<Value, String> {
    let links = vault.get_backlinks(&target).await.map_err(|e| e.to_string())?;
    Ok(json!(links))
}

pub async fn read_primary_notes_location(vault: Arc<Vault>) -> Result<Value, String> {
    let settings = vault.get_settings().await;
    Ok(json!({ "primary_notes_location": settings.primary_notes_location }))
}

// ─── tasks ───────────────────────────────────────────────────────────────────

pub async fn list_tasks(vault: Arc<Vault>, rel: String) -> Result<Value, String> {
    let tasks = vault.scan_tasks_for_note(&rel).await.map_err(|e| e.to_string())?;
    Ok(json!(tasks))
}

pub async fn scan_all_tasks(vault: Arc<Vault>) -> Result<Value, String> {
    let tasks = vault.scan_tasks().await.map_err(|e| e.to_string())?;
    Ok(json!(tasks))
}

pub async fn toggle_task(vault: Arc<Vault>, rel: String, task_id: String) -> Result<Value, String> {
    let task = vault.toggle_task(&rel, &task_id).await.map_err(|e| e.to_string())?;
    Ok(json!(task))
}

pub async fn empty_trash(vault: Arc<Vault>) -> Result<Value, String> {
    // Move all trash notes to permanent delete
    let notes = vault.list_notes().await.map_err(|e| e.to_string())?;
    let trash_notes: Vec<_> = notes.iter()
        .filter(|n| n.path.starts_with("trash/") || n.path.starts_with("trash\\"))
        .collect();
    let count = trash_notes.len();
    for note in trash_notes {
        let _ = vault.delete_note(&note.path).await;
    }
    Ok(json!({ "emptied": true, "deleted_count": count }))
}

// ─── tool registry ───────────────────────────────────────────────────────────

pub fn get_tool_definitions() -> Vec<Value> {
    vec![
        json!({ "name": "vault_info",                "description": "Return vault metadata: total note count and current settings." }),
        json!({ "name": "list_notes",                "description": "List all notes in the vault with metadata (path, size, mtime, tags, title)." }),
        json!({ "name": "read_note",                 "description": "Read the full content of a note by its relative path.", "parameters": { "rel": "string — relative path from vault root" } }),
        json!({ "name": "write_note",                "description": "Write (overwrite) a note's content.", "parameters": { "rel": "string", "body": "string" } }),
        json!({ "name": "create_note",               "description": "Create a new note in a lifecycle folder.", "parameters": { "folder": "inbox|quick|archive|trash|daily|root", "title?": "string", "subpath?": "string" } }),
        json!({ "name": "rename_note",               "description": "Rename a note (updates the filename).", "parameters": { "rel": "string", "new_title": "string" } }),
        json!({ "name": "move_note",                 "description": "Move a note to a different lifecycle folder.", "parameters": { "rel": "string", "target_folder": "string", "subpath": "string" } }),
        json!({ "name": "trash_note",                "description": "Move a note to the trash folder.", "parameters": { "rel": "string" } }),
        json!({ "name": "restore_note",              "description": "Restore a note from trash.", "parameters": { "rel": "string" } }),
        json!({ "name": "archive_note",              "description": "Archive a note.", "parameters": { "rel": "string" } }),
        json!({ "name": "unarchive_note",            "description": "Unarchive a note back to inbox.", "parameters": { "rel": "string" } }),
        json!({ "name": "delete_note",               "description": "Permanently delete a note (cannot be undone).", "parameters": { "rel": "string" } }),
        json!({ "name": "duplicate_note",            "description": "Duplicate a note (creates a copy with ' Copy' suffix).", "parameters": { "rel": "string" } }),
        json!({ "name": "append_to_note",            "description": "Append text to the end of a note.", "parameters": { "rel": "string", "content": "string" } }),
        json!({ "name": "prepend_to_note",           "description": "Prepend text to the beginning of a note.", "parameters": { "rel": "string", "content": "string" } }),
        json!({ "name": "replace_in_note",           "description": "Replace the first occurrence of a string in a note.", "parameters": { "rel": "string", "from": "string", "to": "string" } }),
        json!({ "name": "insert_at_line",            "description": "Insert a line of text at a specific line number (1-based).", "parameters": { "rel": "string", "line": "number", "content": "string" } }),
        json!({ "name": "list_folders",              "description": "List lifecycle folders in the vault." }),
        json!({ "name": "create_folder",             "description": "Create a sub-folder (requires desktop app).", "parameters": { "folder": "string", "subpath": "string" } }),
        json!({ "name": "rename_folder",             "description": "Rename a folder (requires desktop app).", "parameters": { "folder": "string", "old_name": "string", "new_name": "string" } }),
        json!({ "name": "delete_folder",             "description": "Delete a folder (requires desktop app).", "parameters": { "folder": "string", "subpath": "string" } }),
        json!({ "name": "search_text",               "description": "Search notes by title or tag match.", "parameters": { "query": "string" } }),
        json!({ "name": "backlinks",                 "description": "Find all notes that link to the given target title.", "parameters": { "target": "string" } }),
        json!({ "name": "read_primary_notes_location", "description": "Return the configured primary notes location." }),
        json!({ "name": "list_tasks",                "description": "List all tasks in a specific note.", "parameters": { "rel": "string" } }),
        json!({ "name": "scan_all_tasks",            "description": "Scan all notes and return every task with its status, text, source file, and line number." }),
        json!({ "name": "toggle_task",               "description": "Toggle a task's completion state.", "parameters": { "rel": "string", "task_id": "string" } }),
        json!({ "name": "empty_trash",               "description": "Permanently delete all notes in the trash folder." }),
    ]
}

// ─── helpers ─────────────────────────────────────────────────────────────────

fn folder_from_str(s: &str) -> NoteFolder {
    match s {
        "inbox"   => NoteFolder::Inbox,
        "quick"   => NoteFolder::Quick,
        "archive" => NoteFolder::Archive,
        "trash"   => NoteFolder::Trash,
        "daily"   => NoteFolder::Daily,
        _         => NoteFolder::Root,
    }
}

// ─── vault ───────────────────────────────────────────────────────────────────

pub async fn vault_info(vault: Arc<Vault>) -> Result<Value, String> {
    let settings = vault.get_settings().await;
    let notes    = vault.list_notes().await.map_err(|e| e.to_string())?;
    Ok(json!({
        "total_notes": notes.len(),
        "vault_path":  vault.root().to_string_lossy(),
        "settings":    settings,
    }))
}

// ─── notes ───────────────────────────────────────────────────────────────────

pub async fn list_notes(vault: Arc<Vault>) -> Result<Value, String> {
    let notes = vault.list_notes().await.map_err(|e| e.to_string())?;
    Ok(json!(notes))
}

pub async fn read_note(vault: Arc<Vault>, rel: String) -> Result<Value, String> {
    let content = vault.read_note(&rel).await.map_err(|e| e.to_string())?;
    Ok(json!(content))
}

pub async fn write_note(vault: Arc<Vault>, rel: String, body: String) -> Result<Value, String> {
    let meta = vault.write_note(&rel, &body).await.map_err(|e| e.to_string())?;
    Ok(json!(meta))
}

pub async fn create_note(
    vault: Arc<Vault>,
    folder: String,
    title: Option<String>,
    subpath: Option<String>,
) -> Result<Value, String> {
    let folder_enum = folder_from_str(&folder);
    let meta = vault
        .create_note(folder_enum, title.as_deref(), subpath.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    Ok(json!(meta))
}

pub async fn rename_note(vault: Arc<Vault>, rel: String, new_title: String) -> Result<Value, String> {
    let meta = vault.rename_note(&rel, &new_title).await.map_err(|e| e.to_string())?;
    Ok(json!(meta))
}

pub async fn move_note(
    vault: Arc<Vault>,
    rel: String,
    target_folder: String,
    subpath: String,
) -> Result<Value, String> {
    let folder_enum = folder_from_str(&target_folder);
    let meta = vault.move_note(&rel, folder_enum, &subpath).await.map_err(|e| e.to_string())?;
    Ok(json!(meta))
}

pub async fn trash_note(vault: Arc<Vault>, rel: String) -> Result<Value, String> {
    let meta = vault.move_to_trash(&rel).await.map_err(|e| e.to_string())?;
    Ok(json!(meta))
}

pub async fn restore_note(vault: Arc<Vault>, rel: String) -> Result<Value, String> {
    let meta = vault.restore_from_trash(&rel).await.map_err(|e| e.to_string())?;
    Ok(json!(meta))
}

pub async fn archive_note(vault: Arc<Vault>, rel: String) -> Result<Value, String> {
    let meta = vault.archive_note(&rel).await.map_err(|e| e.to_string())?;
    Ok(json!(meta))
}

pub async fn unarchive_note(vault: Arc<Vault>, rel: String) -> Result<Value, String> {
    let meta = vault.unarchive_note(&rel).await.map_err(|e| e.to_string())?;
    Ok(json!(meta))
}

pub async fn delete_note(vault: Arc<Vault>, rel: String) -> Result<Value, String> {
    vault.delete_note(&rel).await.map_err(|e| e.to_string())?;
    Ok(json!({ "deleted": rel }))
}

pub async fn duplicate_note(vault: Arc<Vault>, rel: String) -> Result<Value, String> {
    let meta = vault.duplicate_note(&rel).await.map_err(|e| e.to_string())?;
    Ok(json!(meta))
}

pub async fn append_to_note(vault: Arc<Vault>, rel: String, content: String) -> Result<Value, String> {
    let current = vault.read_note(&rel).await.map_err(|e| e.to_string())?;
    let new_body = format!("{}\n{}", current.body.trim_end(), content);
    let meta = vault.write_note(&rel, &new_body).await.map_err(|e| e.to_string())?;
    Ok(json!(meta))
}

pub async fn prepend_to_note(vault: Arc<Vault>, rel: String, content: String) -> Result<Value, String> {
    let current = vault.read_note(&rel).await.map_err(|e| e.to_string())?;
    let new_body = format!("{}\n{}", content, current.body.trim_start());
    let meta = vault.write_note(&rel, &new_body).await.map_err(|e| e.to_string())?;
    Ok(json!(meta))
}

pub async fn replace_in_note(
    vault: Arc<Vault>,
    rel: String,
    from: String,
    to: String,
) -> Result<Value, String> {
    let current = vault.read_note(&rel).await.map_err(|e| e.to_string())?;
    let new_body = current.body.replacen(&from, &to, 1);
    let meta = vault.write_note(&rel, &new_body).await.map_err(|e| e.to_string())?;
    Ok(json!(meta))
}

pub async fn insert_at_line(
    vault: Arc<Vault>,
    rel: String,
    line: usize,
    content: String,
) -> Result<Value, String> {
    let current = vault.read_note(&rel).await.map_err(|e| e.to_string())?;
    let mut lines: Vec<&str> = current.body.lines().collect();
    let idx = line.saturating_sub(1).min(lines.len());
    lines.insert(idx, &content);
    // We need an owned String to return
    let new_body = lines.join("\n");
    let meta = vault.write_note(&rel, &new_body).await.map_err(|e| e.to_string())?;
    Ok(json!(meta))
}

// ─── folders ─────────────────────────────────────────────────────────────────

pub async fn list_folders(vault: Arc<Vault>) -> Result<Value, String> {
    let folders = vault.list_folders().await.map_err(|e| e.to_string())?;
    Ok(json!(folders))
}

pub async fn create_folder(
    vault: Arc<Vault>,
    folder: String,
    subpath: String,
) -> Result<Value, String> {
    let folder_enum = folder_from_str(&folder);
    vault.create_folder(folder_enum, &subpath).await.map_err(|e| e.to_string())?;
    Ok(json!({ "created": subpath }))
}

pub async fn rename_folder(
    vault: Arc<Vault>,
    folder: String,
    old_name: String,
    new_name: String,
) -> Result<Value, String> {
    let folder_enum = folder_from_str(&folder);
    let new_path = vault.rename_folder(folder_enum, &old_name, &new_name).await.map_err(|e| e.to_string())?;
    Ok(json!({ "new_path": new_path }))
}

pub async fn delete_folder(
    vault: Arc<Vault>,
    folder: String,
    subpath: String,
) -> Result<Value, String> {
    let folder_enum = folder_from_str(&folder);
    vault.delete_folder(folder_enum, &subpath).await.map_err(|e| e.to_string())?;
    Ok(json!({ "deleted": subpath }))
}

// ─── search ──────────────────────────────────────────────────────────────────

pub async fn search_text(vault: Arc<Vault>, query: String) -> Result<Value, String> {
    use lattice_vault::SearchConfig;
    let cfg = SearchConfig::default();
    let results = lattice_vault::search(vault.root(), &query, &cfg)
        .await
        .map_err(|e| e.to_string())?;
    Ok(json!(results))
}

pub async fn backlinks(vault: Arc<Vault>, target: String) -> Result<Value, String> {
    let links = vault.get_backlinks(&target).await.map_err(|e| e.to_string())?;
    Ok(json!(links))
}

pub async fn read_primary_notes_location(vault: Arc<Vault>) -> Result<Value, String> {
    let settings = vault.get_settings().await;
    Ok(json!({ "primary_notes_location": settings.primary_notes_location }))
}

// ─── tasks ───────────────────────────────────────────────────────────────────

pub async fn list_tasks(vault: Arc<Vault>, rel: String) -> Result<Value, String> {
    let tasks = vault.scan_tasks_for_note(&rel).await.map_err(|e| e.to_string())?;
    Ok(json!(tasks))
}

pub async fn scan_all_tasks(vault: Arc<Vault>) -> Result<Value, String> {
    let tasks = vault.scan_tasks().await.map_err(|e| e.to_string())?;
    Ok(json!(tasks))
}

pub async fn toggle_task(vault: Arc<Vault>, rel: String, task_id: String) -> Result<Value, String> {
    let task = vault.toggle_task(&rel, &task_id).await.map_err(|e| e.to_string())?;
    Ok(json!(task))
}

pub async fn empty_trash(vault: Arc<Vault>) -> Result<Value, String> {
    vault.empty_trash().await.map_err(|e| e.to_string())?;
    Ok(json!({ "emptied": true }))
}

// ─── tool registry ───────────────────────────────────────────────────────────

pub fn get_tool_definitions() -> Vec<Value> {
    vec![
        json!({ "name": "vault_info",                "description": "Return vault metadata: total note count, vault path, and current settings." }),
        json!({ "name": "list_notes",                "description": "List all notes in the vault with metadata (path, size, mtime, tags, title)." }),
        json!({ "name": "read_note",                 "description": "Read the full content of a note by its relative path.", "parameters": { "rel": "string — relative path from vault root" } }),
        json!({ "name": "write_note",                "description": "Write (overwrite) a note's content.", "parameters": { "rel": "string", "body": "string" } }),
        json!({ "name": "create_note",               "description": "Create a new note in a lifecycle folder.", "parameters": { "folder": "inbox|quick|archive|trash|daily|root", "title?": "string", "subpath?": "string" } }),
        json!({ "name": "rename_note",               "description": "Rename a note (updates the filename; preserves wikilinks).", "parameters": { "rel": "string", "new_title": "string" } }),
        json!({ "name": "move_note",                 "description": "Move a note to a different folder.", "parameters": { "rel": "string", "target_folder": "string", "subpath": "string" } }),
        json!({ "name": "trash_note",                "description": "Move a note to the trash folder.", "parameters": { "rel": "string" } }),
        json!({ "name": "restore_note",              "description": "Restore a note from trash.", "parameters": { "rel": "string" } }),
        json!({ "name": "archive_note",              "description": "Archive a note.", "parameters": { "rel": "string" } }),
        json!({ "name": "unarchive_note",            "description": "Unarchive a note back to inbox.", "parameters": { "rel": "string" } }),
        json!({ "name": "delete_note",               "description": "Permanently delete a note (cannot be undone).", "parameters": { "rel": "string" } }),
        json!({ "name": "duplicate_note",            "description": "Duplicate a note (creates a copy with ' Copy' suffix).", "parameters": { "rel": "string" } }),
        json!({ "name": "append_to_note",            "description": "Append text to the end of a note.", "parameters": { "rel": "string", "content": "string" } }),
        json!({ "name": "prepend_to_note",           "description": "Prepend text to the beginning of a note.", "parameters": { "rel": "string", "content": "string" } }),
        json!({ "name": "replace_in_note",           "description": "Replace the first occurrence of a string in a note.", "parameters": { "rel": "string", "from": "string", "to": "string" } }),
        json!({ "name": "insert_at_line",            "description": "Insert a line of text at a specific line number (1-based).", "parameters": { "rel": "string", "line": "number", "content": "string" } }),
        json!({ "name": "list_folders",              "description": "List all folders in the vault." }),
        json!({ "name": "create_folder",             "description": "Create a sub-folder.", "parameters": { "folder": "string", "subpath": "string" } }),
        json!({ "name": "rename_folder",             "description": "Rename a folder.", "parameters": { "folder": "string", "old_name": "string", "new_name": "string" } }),
        json!({ "name": "delete_folder",             "description": "Delete a folder and all its contents.", "parameters": { "folder": "string", "subpath": "string" } }),
        json!({ "name": "search_text",               "description": "Full-text search across all notes.", "parameters": { "query": "string" } }),
        json!({ "name": "backlinks",                 "description": "Find all notes that link to the given target title.", "parameters": { "target": "string" } }),
        json!({ "name": "read_primary_notes_location", "description": "Return the configured primary notes location (inbox / root)." }),
        json!({ "name": "list_tasks",                "description": "List all tasks in a specific note.", "parameters": { "rel": "string" } }),
        json!({ "name": "scan_all_tasks",            "description": "Scan all notes and return every task with its status, text, source file, and line number." }),
        json!({ "name": "toggle_task",               "description": "Toggle a task's completion state.", "parameters": { "rel": "string", "task_id": "string" } }),
        json!({ "name": "empty_trash",               "description": "Permanently delete all notes in the trash folder." }),
    ]
}

