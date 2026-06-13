//! File-system service layer — Repository + Service patterns.
//!
//! # SOLID Design
//!
//! ## Single Responsibility
//! This module owns exactly one concern: typed, safe access to the
//! local file system.  No business logic, no IPC wiring, no Tauri
//! types — those live in `commands.rs` and call into this layer.
//!
//! ## Open / Closed
//! The `FileRepository` trait is the stable interface.  Adding new
//! storage back-ends (e.g. encrypted vault, in-memory test stub) only
//! requires implementing the trait — no changes to callers.
//!
//! ## Liskov Substitution
//! Every concrete repository (currently `LocalFileRepository`) honours
//! all pre/post-conditions declared in the trait docs.
//!
//! ## Interface Segregation
//! Three narrow traits — `ReadableRepository`, `WritableRepository`,
//! `DirectoryRepository` — are composed into the full `FileRepository`.
//! Callers that only need reads can depend on `ReadableRepository` alone.
//!
//! ## Dependency Inversion
//! High-level modules (`commands.rs`, `vault_commands.rs`) receive a
//! `&dyn FileRepository` rather than calling `std::fs` directly.

use serde::Serialize;
use std::path::{Path, PathBuf};

// ── Data transfer objects ────────────────────────────────────────────────

/// A node in the vault file tree returned by `list_directory`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<FileNode>>,
}

// ── Narrow trait: read-only access ─────────────────────────────────────

/// Read-only file access — depend on this when you only need reads.
pub trait ReadableRepository: Send + Sync {
    /// Read the UTF-8 contents of `path`.
    fn read_text(&self, path: &str) -> Result<String, String>;
    /// Read raw bytes from `path`.
    fn read_bytes(&self, path: &str) -> Result<Vec<u8>, String>;
    /// Return `true` iff `path` exists on disk.
    fn exists(&self, path: &str) -> bool;
}

// ── Narrow trait: write access ──────────────────────────────────────────

/// Write access — depend on this when you only need writes.
pub trait WritableRepository: Send + Sync {
    /// Overwrite (or create) `path` with `content`.
    fn write_text(&self, path: &str, content: &str) -> Result<(), String>;
    /// Create an empty file at `path`.  Error if it already exists.
    fn create_file(&self, path: &str) -> Result<(), String>;
    /// Create a directory (and all parents) at `path`.
    fn create_dir(&self, path: &str) -> Result<(), String>;
    /// Send `path` to the system recycle bin (never hard-deletes).
    fn delete_file(&self, path: &str) -> Result<(), String>;
    /// Send folder at `path` to the system recycle bin.
    fn delete_dir(&self, path: &str) -> Result<(), String>;
    /// Move or rename `old_path` → `new_path`.  Falls back to
    /// copy+trash on cross-device moves.
    fn rename(&self, old_path: &str, new_path: &str) -> Result<(), String>;
}

// ── Narrow trait: directory listing ────────────────────────────────────

/// Directory listing — depend on this when you need tree navigation.
pub trait DirectoryRepository: Send + Sync {
    /// Return a depth-limited file tree rooted at `path`.
    fn list_tree(&self, path: &str) -> Result<Vec<FileNode>, String>;
}

// ── Composed trait ──────────────────────────────────────────────────────

/// Full file-system access: read + write + directory listing.
///
/// Most IPC commands need all three; narrow traits are available for
/// contexts where only a subset is required (e.g. read-only export).
pub trait FileRepository: ReadableRepository + WritableRepository + DirectoryRepository {}

// ── Concrete implementation ─────────────────────────────────────────────

/// Local file-system implementation backed by `std::fs` + the `trash`
/// crate for safe deletes.
pub struct LocalFileRepository;

impl LocalFileRepository {
    pub fn new() -> Self {
        Self
    }
}

impl Default for LocalFileRepository {
    fn default() -> Self {
        Self::new()
    }
}

impl ReadableRepository for LocalFileRepository {
    fn read_text(&self, path: &str) -> Result<String, String> {
        std::fs::read_to_string(path)
            .map_err(|e| format!("Failed to read '{}': {e}", path))
    }

    fn read_bytes(&self, path: &str) -> Result<Vec<u8>, String> {
        std::fs::read(path)
            .map_err(|e| format!("Failed to read bytes '{}': {e}", path))
    }

    fn exists(&self, path: &str) -> bool {
        Path::new(path).exists()
    }
}

impl WritableRepository for LocalFileRepository {
    fn write_text(&self, path: &str, content: &str) -> Result<(), String> {
        let p = Path::new(path);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create dirs for '{}': {e}", path))?;
        }
        std::fs::write(p, content)
            .map_err(|e| format!("Failed to write '{}': {e}", path))
    }

    fn create_file(&self, path: &str) -> Result<(), String> {
        let p = Path::new(path);
        if p.exists() {
            return Err(format!("File already exists: '{}'", path));
        }
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create dirs for '{}': {e}", path))?;
        }
        std::fs::write(p, b"")
            .map_err(|e| format!("Failed to create file '{}': {e}", path))
    }

    fn create_dir(&self, path: &str) -> Result<(), String> {
        let p = Path::new(path);
        if p.exists() {
            return Err(format!("Folder already exists: '{}'", path));
        }
        std::fs::create_dir_all(p)
            .map_err(|e| format!("Failed to create folder '{}': {e}", path))
    }

    fn delete_file(&self, path: &str) -> Result<(), String> {
        let p = Path::new(path);
        if !p.exists() {
            return Err(format!("File does not exist: '{}'", path));
        }
        if p.is_dir() {
            return Err(format!("Path is a directory, use delete_dir: '{}'", path));
        }
        trash::delete(p).map_err(|e| format!("Failed to recycle '{}': {e}", path))
    }

    fn delete_dir(&self, path: &str) -> Result<(), String> {
        let p = Path::new(path);
        if !p.exists() {
            return Err(format!("Folder does not exist: '{}'", path));
        }
        if !p.is_dir() {
            return Err(format!("Not a directory: '{}'", path));
        }
        trash::delete(p).map_err(|e| format!("Failed to recycle folder '{}': {e}", path))
    }

    fn rename(&self, old_path: &str, new_path: &str) -> Result<(), String> {
        let old = Path::new(old_path);
        let new = Path::new(new_path);
        if !old.exists() {
            return Err(format!("Source does not exist: '{}'", old_path));
        }
        if new.exists() {
            return Err(format!("Destination already exists: '{}'", new_path));
        }
        if let Some(parent) = new.parent() {
            if !parent.exists() {
                let _ = std::fs::create_dir_all(parent);
            }
        }
        match std::fs::rename(old, new) {
            Ok(()) => Ok(()),
            Err(e) if is_cross_device(&e) => {
                copy_recursive(old, new)
                    .map_err(|ce| format!("Cross-device copy failed: {ce}"))?;
                trash::delete(old).map_err(|te| format!(
                    "Copied to '{}' but could not remove source '{}': {te}",
                    new_path, old_path
                ))
            }
            Err(e) => Err(format!(
                "Failed to rename '{}' → '{}': {e}",
                old_path, new_path
            )),
        }
    }
}

impl DirectoryRepository for LocalFileRepository {
    fn list_tree(&self, path: &str) -> Result<Vec<FileNode>, String> {
        let root = Path::new(path);
        if !root.is_dir() {
            return Err(format!("'{}' is not a directory", path));
        }
        build_tree_depth(root, 0)
            .map_err(|e| format!("Failed to list '{}': {e}", path))
    }
}

impl FileRepository for LocalFileRepository {}

// ── Private helpers ─────────────────────────────────────────────────────

const MAX_TREE_DEPTH: usize = 40;

fn build_tree_depth(dir: &Path, depth: usize) -> Result<Vec<FileNode>, std::io::Error> {
    if depth >= MAX_TREE_DEPTH {
        return Ok(Vec::new());
    }
    let mut entries: Vec<FileNode> = Vec::new();
    let mut dir_entries: Vec<_> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .collect();

    dir_entries.sort_by(|a, b| {
        let a_is_dir = a.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let b_is_dir = b.file_type().map(|t| t.is_dir()).unwrap_or(false);
        match (a_is_dir, b_is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.file_name()
                .to_string_lossy()
                .to_lowercase()
                .cmp(&b.file_name().to_string_lossy().to_lowercase()),
        }
    });

    for entry in dir_entries {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" || name == "target" {
            continue;
        }
        let path = entry.path();
        let ft = entry.file_type()?;
        let is_real_dir = ft.is_dir();
        let children = if is_real_dir {
            Some(build_tree_depth(&path, depth + 1)?)
        } else {
            None
        };
        entries.push(FileNode {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir: is_real_dir,
            children,
        });
    }
    Ok(entries)
}

fn is_cross_device(e: &std::io::Error) -> bool {
    #[cfg(unix)]  { e.raw_os_error() == Some(libc::EXDEV) }
    #[cfg(windows)] { e.raw_os_error() == Some(17) }
    #[cfg(not(any(unix, windows)))] { let _ = e; false }
}

fn copy_recursive(src: &Path, dst: &Path) -> Result<(), std::io::Error> {
    if src.is_dir() {
        std::fs::create_dir_all(dst)?;
        for entry in std::fs::read_dir(src)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &dst.join(entry.file_name()))?;
        }
    } else {
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(src, dst)?;
    }
    Ok(())
}

// ── Graph service (SRP: separated from file service) ───────────────────

use std::collections::HashMap;
use lazy_static::lazy_static;
use regex::Regex;

lazy_static! {
    static ref WIKILINK_RE: Regex = Regex::new(r"\[\[([^\]]+)\]\]").unwrap();
}

/// A node in the vault knowledge graph.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: String,
    pub label: String,
    pub path: String,
    pub node_type: String,
    pub task_status: Option<String>,
}

/// A directed link between two graph nodes.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
}

/// The complete vault knowledge graph.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphData {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

/// Service that builds a wikilink graph from the vault.
///
/// **SRP**: This is its own service rather than being inlined into
/// `commands.rs` — graph building is a distinct responsibility from
/// file I/O.
pub struct GraphService;

impl GraphService {
    pub fn build_graph(repo: &dyn ReadableRepository, vault_path: &str) -> Result<GraphData, String> {
        let root = Path::new(vault_path);
        if !root.is_dir() {
            return Err(format!("'{}' is not a directory", vault_path));
        }

        let mut nodes = Vec::new();
        let mut edges = Vec::new();
        let mut name_to_path: HashMap<String, String> = HashMap::new();

        Self::walk_dir_for_nodes(root, root, &mut name_to_path, &mut nodes);

        // Second pass: extract wikilinks
        for node in &nodes {
            if node.node_type == "markdown" {
                if let Ok(content) = repo.read_text(&node.path) {
                    for cap in WIKILINK_RE.captures_iter(&content) {
                        let raw = &cap[1];
                        let target_name = raw.split('|').next().unwrap_or(raw)
                            .split('#').next().unwrap_or(raw)
                            .trim()
                            .to_lowercase();
                        if let Some(target_path) = name_to_path.get(&target_name) {
                            if *target_path != node.path {
                                edges.push(GraphEdge {
                                    source: node.id.clone(),
                                    target: target_path.clone(),
                                });
                            }
                        }
                    }
                }
            }
        }

        Ok(GraphData { nodes, edges })
    }

    fn walk_dir_for_nodes(
        dir: &Path,
        base: &Path,
        name_to_path: &mut HashMap<String, String>,
        nodes: &mut Vec<GraphNode>,
    ) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                let name_os = p.file_name().unwrap_or_default().to_string_lossy();
                if name_os.starts_with('.') || name_os == "node_modules" || name_os == "target" {
                    continue;
                }
                if p.is_dir() {
                    Self::walk_dir_for_nodes(&p, base, name_to_path, nodes);
                } else if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
                    let node_type = match ext.to_lowercase().as_str() {
                        "md" => "markdown",
                        "canvas" => "canvas",
                        "pdf" => "pdf",
                        _ => continue,
                    };
                    let path_str = p.to_string_lossy().to_string();
                    let label = p.file_stem()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string();
                    let key = label.to_lowercase();
                    name_to_path.insert(key, path_str.clone());
                    nodes.push(GraphNode {
                        id: path_str.clone(),
                        label: label.clone(),
                        path: path_str,
                        node_type: node_type.to_string(),
                        task_status: None,
                    });
                }
            }
        }
    }
}
