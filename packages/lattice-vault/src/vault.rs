use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio::fs;
use walkdir::WalkDir;
use crate::error::{Result, VaultError};
use crate::types::*;
use crate::cache::{MetaCache, MetaCacheEntry};
use crate::watcher::VaultWatcher;
use crate::safepath::safe_join;
use crate::parse::{extract_wikilinks, extract_tags, extract_frontmatter, extract_tasks, count_words};

pub struct Vault {
    root: PathBuf,
    settings: Arc<RwLock<VaultSettings>>,
    cache: Arc<MetaCache>,
    watcher: Arc<VaultWatcher>,
}

impl Vault {
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Open or create a vault at the given root path
    pub async fn open(root: PathBuf) -> Result<Self> {
        let root = root.canonicalize()
            .map_err(|e| VaultError::Io(e))?;

        // Ensure vault structure exists
        Self::ensure_structure(&root).await?;

        // Load or create settings
        let settings = Self::load_settings(&root).await?;

        // Load meta cache
        let cache = Arc::new(MetaCache::load(root.clone()).await?);

        // Start file watcher
        let watcher = Arc::new(VaultWatcher::new(root.clone())?);

        // Set up watcher to invalidate cache
        let cache_clone = cache.clone();
        let mut rx = watcher.subscribe();
        tokio::spawn(async move {
            while let Ok(event) = rx.recv().await {
                match event {
                    VaultChangeEvent::Modified { path, .. } | VaultChangeEvent::Created { path, .. } => {
                        cache_clone.invalidate(&path);
                    }
                    VaultChangeEvent::Deleted { path, .. } => {
                        cache_clone.invalidate(&path);
                    }
                    VaultChangeEvent::Renamed { old_path, new_path, .. } => {
                        cache_clone.invalidate(&old_path);
                        cache_clone.invalidate(&new_path);
                    }
                }
            }
        });

        Ok(Self {
            root,
            settings: Arc::new(RwLock::new(settings)),
            cache,
            watcher,
        })
    }

    async fn ensure_structure(root: &Path) -> Result<()> {
        let folders = vec!["inbox", "quick", "archive", "trash", "attachements", ".lattice"];
        
        for folder in folders {
            let path = root.join(folder);
            if !path.exists() {
                fs::create_dir_all(&path).await?;
            }
        }

        // Create Daily Notes if enabled (will check settings later)
        let daily_path = root.join("Daily Notes");
        if !daily_path.exists() {
            fs::create_dir_all(&daily_path).await?;
        }

        Ok(())
    }

    async fn load_settings(root: &Path) -> Result<VaultSettings> {
        let settings_path = root.join(".lattice/vault.json");
        
        if settings_path.exists() {
            let content = fs::read_to_string(&settings_path).await?;
            Ok(serde_json::from_str(&content)?)
        } else {
            // Create default settings
            let settings = VaultSettings::default();
            let json = serde_json::to_string_pretty(&settings)?;
            fs::write(&settings_path, json).await?;
            Ok(settings)
        }
    }

    /// List all notes in the vault
    pub async fn list_notes(&self) -> Result<Vec<NoteMeta>> {
        let mut notes = Vec::new();
        let folders = vec!["inbox", "quick", "archive", "Daily Notes"];

        for folder in folders {
            let folder_path = self.root.join(folder);
            if !folder_path.exists() {
                continue;
            }

            for entry in WalkDir::new(&folder_path)
                .into_iter()
                .filter_map(|e| e.ok())
                .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("md"))
            {
                let path = entry.path();
                let rel_path = path.strip_prefix(&self.root)
                    .map_err(|_| VaultError::InvalidStructure("Path not in vault".to_string()))?
                    .to_string_lossy()
                    .to_string();

                // Check cache first
                if self.cache.is_valid(&rel_path, path) {
                    if let Some(meta) = self.cache.get(&rel_path) {
                        notes.push(meta);
                        continue;
                    }
                }

                // Parse note and cache
                if let Ok(meta) = self.parse_note_meta(path, &rel_path).await {
                    notes.push(meta);
                }
            }
        }

        Ok(notes)
    }

    async fn parse_note_meta(&self, path: &Path, rel_path: &str) -> Result<NoteMeta> {
        let content = fs::read_to_string(path).await?;
        let metadata = fs::metadata(path).await?;
        
        let title = Self::extract_title(path, &content);
        let tags = extract_tags(&content);
        let frontmatter = extract_frontmatter(&content)?;
        let word_count = count_words(&content);
        let mtime = MetaCache::get_mtime(path)?;
        let folder = Self::determine_folder(rel_path);

        let meta = NoteMeta {
            path: rel_path.to_string(),
            title,
            mtime,
            size: metadata.len(),
            tags,
            frontmatter,
            word_count,
            folder,
        };

        // Cache it
        self.cache.insert(
            rel_path.to_string(),
            MetaCacheEntry {
                mtime_ms: mtime,
                size: metadata.len(),
                meta: meta.clone(),
            },
        );

        Ok(meta)
    }

    fn extract_title(path: &Path, content: &str) -> String {
        // Try frontmatter title first
        if let Some(cap) = regex::Regex::new(r"(?m)^title:\s*(.+)$").ok().and_then(|re| re.captures(content)) {
            return cap[1].trim().to_string();
        }

        // Try first # heading
        if let Some(cap) = regex::Regex::new(r"(?m)^#\s+(.+)$").ok().and_then(|re| re.captures(content)) {
            return cap[1].trim().to_string();
        }

        // Fall back to filename
        path.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Untitled")
            .to_string()
    }

    fn determine_folder(rel_path: &str) -> NoteFolder {
        if rel_path.starts_with("inbox") {
            NoteFolder::Inbox
        } else if rel_path.starts_with("quick") {
            NoteFolder::Quick
        } else if rel_path.starts_with("archive") {
            NoteFolder::Archive
        } else if rel_path.starts_with("trash") {
            NoteFolder::Trash
        } else if rel_path.starts_with("Daily Notes") {
            NoteFolder::Daily
        } else {
            NoteFolder::Root
        }
    }

    /// Read a note's full content
    pub async fn read_note(&self, rel: &str) -> Result<NoteContent> {
        let path = safe_join(&self.root, rel)?;
        
        if !path.exists() {
            return Err(VaultError::NoteNotFound(rel.to_string()));
        }

        let content = fs::read_to_string(&path).await?;
        let meta = self.parse_note_meta(&path, rel).await?;

        Ok(NoteContent { meta, body: content })
    }

    /// Write a note's content
    pub async fn write_note(&self, rel: &str, body: &str) -> Result<NoteMeta> {
        let path = safe_join(&self.root, rel)?;
        
        // Ensure parent directory exists
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).await?;
        }

        fs::write(&path, body).await?;
        
        // Invalidate cache
        self.cache.invalidate(rel);
        
        // Re-parse and return meta
        self.parse_note_meta(&path, rel).await
    }

    /// Create a new note
    pub async fn create_note(
        &self,
        folder: NoteFolder,
        title: Option<&str>,
        subpath: Option<&str>,
    ) -> Result<NoteMeta> {
        let title = title.unwrap_or("Untitled");
        let filename = Self::sanitize_filename(title);
        
        let folder_path = match folder {
            NoteFolder::Inbox => "inbox",
            NoteFolder::Quick => "quick",
            NoteFolder::Archive => "archive",
            NoteFolder::Trash => "trash",
            NoteFolder::Daily => "Daily Notes",
            NoteFolder::Root => "",
        };

        let rel_path = if let Some(sub) = subpath {
            format!("{}/{}/{}.md", folder_path, sub, filename)
        } else {
            format!("{}/{}.md", folder_path, filename)
        };

        let initial_content = format!("# {}\n\n", title);
        self.write_note(&rel_path, &initial_content).await
    }

    fn sanitize_filename(title: &str) -> String {
        title
            .chars()
            .map(|c| match c {
                '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
                _ => c,
            })
            .collect::<String>()
            .trim()
            .to_string()
    }

    /// Rename a note
    pub async fn rename_note(&self, rel: &str, new_title: &str) -> Result<NoteMeta> {
        let old_path = safe_join(&self.root, rel)?;
        
        if !old_path.exists() {
            return Err(VaultError::NoteNotFound(rel.to_string()));
        }

        let new_filename = format!("{}.md", Self::sanitize_filename(new_title));
        let new_path = old_path.with_file_name(&new_filename);
        let new_rel = new_path.strip_prefix(&self.root)
            .map_err(|_| VaultError::InvalidStructure("Path not in vault".to_string()))?
            .to_string_lossy()
            .to_string();

        fs::rename(&old_path, &new_path).await?;
        
        self.cache.invalidate(rel);
        self.cache.invalidate(&new_rel);
        
        self.parse_note_meta(&new_path, &new_rel).await
    }

    /// Move note to trash
    pub async fn move_to_trash(&self, rel: &str) -> Result<NoteMeta> {
        let old_path = safe_join(&self.root, rel)?;
        
        if !old_path.exists() {
            return Err(VaultError::NoteNotFound(rel.to_string()));
        }

        let filename = old_path.file_name()
            .ok_or_else(|| VaultError::InvalidStructure("No filename".to_string()))?;
        
        let trash_dir = self.root.join("trash");
        if !trash_dir.exists() {
            fs::create_dir_all(&trash_dir).await?;
        }
        let trash_path = trash_dir.join(filename);
        let trash_rel = format!("trash/{}", filename.to_string_lossy());

        fs::rename(&old_path, &trash_path).await?;
        
        self.cache.invalidate(rel);
        self.cache.invalidate(&trash_rel);
        
        self.parse_note_meta(&trash_path, &trash_rel).await
    }

    /// Restore note from trash
    pub async fn restore_from_trash(&self, rel: &str) -> Result<NoteMeta> {
        if !rel.starts_with("trash/") {
            return Err(VaultError::InvalidStructure("Not in trash".to_string()));
        }

        let trash_path = safe_join(&self.root, rel)?;
        
        if !trash_path.exists() {
            return Err(VaultError::NoteNotFound(rel.to_string()));
        }

        let filename = trash_path.file_name()
            .ok_or_else(|| VaultError::InvalidStructure("No filename".to_string()))?;
        
        let inbox_path = self.root.join("inbox").join(filename);
        let inbox_rel = format!("inbox/{}", filename.to_string_lossy());

        fs::rename(&trash_path, &inbox_path).await?;
        
        self.cache.invalidate(rel);
        self.cache.invalidate(&inbox_rel);
        
        self.parse_note_meta(&inbox_path, &inbox_rel).await
    }

    /// Archive a note
    pub async fn archive_note(&self, rel: &str) -> Result<NoteMeta> {
        let old_path = safe_join(&self.root, rel)?;
        
        if !old_path.exists() {
            return Err(VaultError::NoteNotFound(rel.to_string()));
        }

        let filename = old_path.file_name()
            .ok_or_else(|| VaultError::InvalidStructure("No filename".to_string()))?;
        
        let archive_path = self.root.join("archive").join(filename);
        let archive_rel = format!("archive/{}", filename.to_string_lossy());

        fs::rename(&old_path, &archive_path).await?;
        
        self.cache.invalidate(rel);
        self.cache.invalidate(&archive_rel);
        
        self.parse_note_meta(&archive_path, &archive_rel).await
    }

    /// Unarchive a note
    pub async fn unarchive_note(&self, rel: &str) -> Result<NoteMeta> {
        if !rel.starts_with("archive/") {
            return Err(VaultError::InvalidStructure("Not in archive".to_string()));
        }

        let archive_path = safe_join(&self.root, rel)?;
        
        if !archive_path.exists() {
            return Err(VaultError::NoteNotFound(rel.to_string()));
        }

        let filename = archive_path.file_name()
            .ok_or_else(|| VaultError::InvalidStructure("No filename".to_string()))?;
        
        let inbox_path = self.root.join("inbox").join(filename);
        let inbox_rel = format!("inbox/{}", filename.to_string_lossy());

        fs::rename(&archive_path, &inbox_path).await?;
        
        self.cache.invalidate(rel);
        self.cache.invalidate(&inbox_rel);
        
        self.parse_note_meta(&inbox_path, &inbox_rel).await
    }

    /// Delete a note permanently
    pub async fn delete_note(&self, rel: &str) -> Result<()> {
        let path = safe_join(&self.root, rel)?;
        
        if !path.exists() {
            return Err(VaultError::NoteNotFound(rel.to_string()));
        }

        fs::remove_file(&path).await?;
        self.cache.invalidate(rel);
        
        Ok(())
    }

    /// Scan all tasks in the vault
    pub async fn scan_tasks(&self) -> Result<Vec<Task>> {
        let notes = self.list_notes().await?;
        let mut all_tasks = Vec::new();

        for note in notes {
            if let Ok(content) = self.read_note(&note.path).await {
                let tasks = extract_tasks(&content.body, &note.path);
                all_tasks.extend(tasks);
            }
        }

        Ok(all_tasks)
    }

    /// Scan tasks for a specific note
    pub async fn scan_tasks_for_note(&self, rel: &str) -> Result<Vec<Task>> {
        let content = self.read_note(rel).await?;
        Ok(extract_tasks(&content.body, rel))
    }

    /// Toggle a task's checked status
    pub async fn toggle_task(&self, rel: &str, task_id: &str) -> Result<Task> {
        let content = self.read_note(rel).await?;
        let tasks = extract_tasks(&content.body, rel);
        
        let task = tasks.iter().find(|t| t.id == task_id)
            .ok_or_else(|| VaultError::NoteNotFound(format!("Task {} not found", task_id)))?;

        let line_num = task.line_number;
        let mut lines: Vec<String> = content.body.lines().map(|s| s.to_string()).collect();
        
        if line_num > 0 && line_num <= lines.len() {
            let line = &lines[line_num - 1];
            let new_line = if task.checked {
                line.replace("[x]", "[ ]").replace("[X]", "[ ]")
            } else {
                line.replacen("[ ]", "[x]", 1)
            };
            lines[line_num - 1] = new_line;
        }

        let new_content = lines.join("\n");
        self.write_note(rel, &new_content).await?;

        // Return updated task
        let updated_tasks = extract_tasks(&new_content, rel);
        Ok(updated_tasks.into_iter().find(|t| t.line_number == line_num).unwrap())
    }

    /// Get vault settings
    pub async fn get_settings(&self) -> VaultSettings {
        self.settings.read().await.clone()
    }

    /// Set vault settings
    pub async fn set_settings(&self, next: VaultSettings) -> Result<VaultSettings> {
        *self.settings.write().await = next.clone();
        
        let settings_path = self.root.join(".lattice/vault.json");
        let json = serde_json::to_string_pretty(&next)?;
        fs::write(&settings_path, json).await?;
        
        Ok(next)
    }

    /// Subscribe to vault changes
    pub fn subscribe_changes(&self) -> tokio::sync::broadcast::Receiver<VaultChangeEvent> {
        self.watcher.subscribe()
    }

    /// Get backlinks for a note
    pub async fn get_backlinks(&self, target: &str) -> Result<Vec<(String, usize)>> {
        let notes = self.list_notes().await?;
        let mut backlinks = Vec::new();
        
        let target_title = target.trim_end_matches(".md");

        for note in notes {
            if let Ok(content) = self.read_note(&note.path).await {
                let links = extract_wikilinks(&content.body);
                let count = links.iter().filter(|link| link.trim() == target_title).count();
                
                if count > 0 {
                    backlinks.push((note.path, count));
                }
            }
        }

        Ok(backlinks)
    }
}
