use serde::Serialize;
use std::fs;
use std::path::Path;
use std::collections::HashMap;
use lazy_static::lazy_static;
use regex::Regex;

lazy_static! {
    static ref WIKILINK_RE: Regex = Regex::new(r"\[\[([^\]]+)\]\]").unwrap();
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<FileNode>>,
}

/// Read the contents of a file at the given path.
#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("Failed to read file '{}': {}", path, e))
}

/// Read the raw bytes of a file (used for binary previews — currently
/// just `.pdf`, but the same shape works for any binary asset).
///
/// We return `Vec<u8>` instead of base64-encoding here because Tauri 2's
/// v2 IPC wire format already handles `Vec<u8>` as a typed payload
/// without an extra encode/decode hop, and pdfjs accepts a `Uint8Array`
/// directly. Keeping it raw avoids the ~33% size bloat from base64.
#[tauri::command]
pub fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    fs::read(&path).map_err(|e| format!("Failed to read file '{}': {}", path, e))
}

/// Write content to a file at the given path, creating it if it doesn't exist.
#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<(), String> {
    // Ensure parent directories exist
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directories for '{}': {}", path, e))?;
    }
    fs::write(&path, &content).map_err(|e| format!("Failed to write file '{}': {}", path, e))
}

/// Recursively list a directory, returning a tree of FileNode.
#[tauri::command]
pub fn list_directory(path: String) -> Result<Vec<FileNode>, String> {
    let root = Path::new(&path);
    if !root.is_dir() {
        return Err(format!("'{}' is not a directory", path));
    }
    build_tree(root).map_err(|e| format!("Failed to list directory '{}': {}", path, e))
}

/// Create a new empty file at the given path.
#[tauri::command]
pub fn create_file(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.exists() {
        return Err(format!("File already exists: '{}'", path));
    }
    // Ensure parent directories exist
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent dirs for '{}': {}", path, e))?;
    }
    fs::write(&path, "").map_err(|e| format!("Failed to create file '{}': {}", path, e))
}

/// Create a new directory at the given path.
#[tauri::command]
pub fn create_folder(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.exists() {
        return Err(format!("Folder already exists: '{}'", path));
    }
    fs::create_dir_all(&path).map_err(|e| format!("Failed to create folder '{}': {}", path, e))
}

/// Rename (move) a file or folder.
#[tauri::command]
pub fn rename_entry(old_path: String, new_path: String) -> Result<(), String> {
    let old = Path::new(&old_path);
    if !old.exists() {
        return Err(format!("Path does not exist: '{}'", old_path));
    }
    let new_p = Path::new(&new_path);
    if new_p.exists() {
        return Err(format!("Destination already exists: '{}'", new_path));
    }
    fs::rename(&old_path, &new_path)
        .map_err(|e| format!("Failed to rename '{}' to '{}': {}", old_path, new_path, e))
}


/// Delete a file — sends it to the system recycle bin via the
/// `trash` crate so the user can recover from an accidental click.
/// On Windows uses IFileOperation, on macOS NSWorkspace, on Linux
/// the freedesktop trash spec.  If the OS has no trash (e.g.
/// headless Linux), surfaces the error so the caller can decide
/// whether to fall back to a hard delete.
#[tauri::command]
pub fn delete_file(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("File does not exist: '{}'", path));
    }
    if p.is_dir() {
        return Err(format!("Path is a directory, use delete_folder: '{}'", path));
    }
    trash::delete(p).map_err(|e| format!("Failed to recycle file '{}': {}", path, e))
}

/// Delete a folder and all its contents — sends to the recycle bin
/// (recursive containers are recycled in one operation on every
/// supported OS).  Recovery is identical to `delete_file`.
#[tauri::command]
pub fn delete_folder(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("Folder does not exist: '{}'", path));
    }
    if !p.is_dir() {
        return Err(format!("Path is not a directory: '{}'", path));
    }
    trash::delete(p).map_err(|e| format!("Failed to recycle folder '{}': {}", path, e))
}

fn build_tree(dir: &Path) -> Result<Vec<FileNode>, std::io::Error> {
    let mut entries: Vec<FileNode> = Vec::new();

    let mut dir_entries: Vec<_> = fs::read_dir(dir)?.filter_map(|e| e.ok()).collect();

    // Sort: directories first, then alphabetically
    dir_entries.sort_by(|a, b| {
        let a_is_dir = a.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let b_is_dir = b.file_type().map(|t| t.is_dir()).unwrap_or(false);
        match (a_is_dir, b_is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a
                .file_name()
                .to_string_lossy()
                .to_lowercase()
                .cmp(&b.file_name().to_string_lossy().to_lowercase()),
        }
    });

    for entry in dir_entries {
        let name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden files/dirs and common junk
        if name.starts_with('.') || name == "node_modules" || name == "target" {
            continue;
        }

        let path = entry.path();
        let is_dir = path.is_dir();

        let children = if is_dir {
            Some(build_tree(&path)?)
        } else {
            None
        };

        entries.push(FileNode {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir,
            children,
        });
    }

    Ok(entries)
}

/// Open a new application window.
#[tauri::command]
pub async fn open_new_window(app: tauri::AppHandle) -> Result<(), String> {
    let label = format!("window_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis());
    let _ = tauri::WebviewWindowBuilder::new(
        &app,
        label,
        tauri::WebviewUrl::App(Default::default())
    )
    .title("Lattice")
    .inner_size(1400.0, 900.0)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: String,
    pub label: String,
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphData {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

/// Parse all markdown files in the vault and build a link graph.
#[tauri::command]
pub fn get_vault_graph(path: String) -> Result<GraphData, String> {
    let root = Path::new(&path);
    if !root.is_dir() {
        return Err(format!("'{}' is not a directory", path));
    }

    let mut nodes = Vec::new();
    let mut edges = Vec::new();

    let mut name_to_path = HashMap::new();

    fn walk_dir(
        dir: &Path,
        base: &Path,
        name_to_path: &mut HashMap<String, String>,
        nodes: &mut Vec<GraphNode>,
    ) -> Result<(), std::io::Error> {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    let name = p.file_name().unwrap_or_default().to_string_lossy();
                    if name.starts_with('.') || name == "node_modules" || name == "target" {
                        continue;
                    }
                    walk_dir(&p, base, name_to_path, nodes)?;
                } else if p.extension().map(|e| e == "md").unwrap_or(false) {
                    let abs_path = p.to_string_lossy().to_string();
                    let name = p.file_stem().unwrap_or_default().to_string_lossy().to_string();
                    name_to_path.insert(name.clone(), abs_path.clone());
                    
                    if let Ok(rel_path) = p.strip_prefix(base) {
                        let rel_str = rel_path.with_extension("").to_string_lossy().to_string();
                        // Standardize to forward slashes for internal referencing
                        let normalized_rel_str = rel_str.replace("\\", "/");
                        name_to_path.insert(normalized_rel_str, abs_path.clone());
                    }

                    nodes.push(GraphNode {
                        id: abs_path.clone(),
                        label: name,
                        path: abs_path,
                    });
                }
            }
        }
        Ok(())
    }

    walk_dir(root, root, &mut name_to_path, &mut nodes).map_err(|e| e.to_string())?;

    for node in &nodes {
        if let Ok(content) = fs::read_to_string(&node.path) {
            for cap in WIKILINK_RE.captures_iter(&content) {
                let target_name = cap[1].to_string();
                if let Some(target_path) = name_to_path.get(&target_name) {
                    edges.push(GraphEdge {
                        source: node.id.clone(),
                        target: target_path.clone(),
                    });
                }
            }
        }
    }

    Ok(GraphData { nodes, edges })
}

#[derive(Serialize)]
pub struct BacklinkSnippet {
    pub source_path: String,
    pub source_name: String,
    pub snippet: String,
    pub line_number: usize,
}

#[derive(Serialize)]
pub struct BacklinksResult {
    pub linked: Vec<BacklinkSnippet>,
    pub unlinked: Vec<BacklinkSnippet>,
}

#[tauri::command]
pub fn get_backlinks(vault_path: String, active_file_path: String) -> Result<BacklinksResult, String> {
    let root = Path::new(&vault_path);
    if !root.is_dir() {
        return Err(format!("'{}' is not a directory", vault_path));
    }

    let active_path = Path::new(&active_file_path);
    let active_stem = active_path.file_stem().unwrap_or_default().to_string_lossy().to_string();
    let active_stem_lower = active_stem.to_lowercase();
    
    let mut target_names = vec![active_stem.clone()];
    if let Ok(rel_path) = active_path.strip_prefix(root) {
        let rel_str = rel_path.with_extension("").to_string_lossy().to_string();
        target_names.push(rel_str.replace("\\", "/"));
    }

    let mut linked = Vec::new();
    let mut unlinked = Vec::new();

    fn walk_dir_backlinks(
        dir: &Path,
        active_path_str: &str,
        target_names: &[String],
        active_stem_lower: &str,
        linked: &mut Vec<BacklinkSnippet>,
        unlinked: &mut Vec<BacklinkSnippet>,
    ) -> Result<(), std::io::Error> {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    let name = p.file_name().unwrap_or_default().to_string_lossy();
                    if name.starts_with('.') || name == "node_modules" || name == "target" {
                        continue;
                    }
                    walk_dir_backlinks(&p, active_path_str, target_names, active_stem_lower, linked, unlinked)?;
                } else if p.extension().map(|e| e == "md").unwrap_or(false) {
                    let abs_path = p.to_string_lossy().to_string();
                    if abs_path == active_path_str {
                        continue;
                    }
                    let source_name = p.file_stem().unwrap_or_default().to_string_lossy().to_string();
                    
                    if let Ok(content) = fs::read_to_string(&p) {
                        for (i, line) in content.lines().enumerate() {
                            let line_lower = line.to_lowercase();
                            let mut has_linked = false;
                            
                            // Use WIKILINK_RE defined outside
                            for cap in WIKILINK_RE.captures_iter(line) {
                                let target_ref = cap[1].to_string();
                                if target_names.contains(&target_ref) {
                                    has_linked = true;
                                    linked.push(BacklinkSnippet {
                                        source_path: abs_path.clone(),
                                        source_name: source_name.clone(),
                                        snippet: line.trim().to_string(),
                                        line_number: i + 1,
                                    });
                                    break;
                                }
                            }
                            
                            if !has_linked && line_lower.contains(active_stem_lower) {
                                unlinked.push(BacklinkSnippet {
                                    source_path: abs_path.clone(),
                                    source_name: source_name.clone(),
                                    snippet: line.trim().to_string(),
                                    line_number: i + 1,
                                });
                            }
                        }
                    }
                }
            }
        }
        Ok(())
    }

    walk_dir_backlinks(
        root, 
        &active_file_path, 
        &target_names, 
        &active_stem_lower, 
        &mut linked, 
        &mut unlinked
    ).map_err(|e| e.to_string())?;

    Ok(BacklinksResult { linked, unlinked })
}
