use dashmap::DashMap;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;
use tokio::fs;
use tokio::time::{sleep, Duration};
use crate::types::NoteMeta;
use crate::error::Result;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MetaCacheEntry {
    pub mtime_ms: i64,
    pub size: u64,
    pub meta: NoteMeta,
}

pub struct MetaCache {
    inner: DashMap<String, MetaCacheEntry>,
    vault_root: PathBuf,
    dirty: std::sync::atomic::AtomicBool,
}

impl MetaCache {
    pub fn new(vault_root: PathBuf) -> Self {
        Self {
            inner: DashMap::new(),
            vault_root,
            dirty: std::sync::atomic::AtomicBool::new(false),
        }
    }

    pub fn get(&self, path: &str) -> Option<NoteMeta> {
        self.inner.get(path).map(|entry| entry.meta.clone())
    }

    pub fn insert(&self, path: String, entry: MetaCacheEntry) {
        self.inner.insert(path, entry);
        self.mark_dirty();
    }

    pub fn invalidate(&self, path: &str) {
        self.inner.remove(path);
        self.mark_dirty();
    }

    pub fn clear(&self) {
        self.inner.clear();
        self.mark_dirty();
    }

    fn mark_dirty(&self) {
        self.dirty.store(true, std::sync::atomic::Ordering::Relaxed);
    }

    fn cache_path(&self) -> PathBuf {
        self.vault_root.join(".lattice/meta-cache-v1.json")
    }

    /// Persist cache to disk with debouncing
    pub async fn persist(&self) -> Result<()> {
        if !self.dirty.load(std::sync::atomic::Ordering::Relaxed) {
            return Ok(());
        }

        // Debounce: wait 1s before persisting
        sleep(Duration::from_secs(1)).await;

        let cache_path = self.cache_path();
        
        // Ensure .lattice directory exists
        if let Some(parent) = cache_path.parent() {
            fs::create_dir_all(parent).await?;
        }

        // Serialize cache to JSON
        let entries: Vec<(String, MetaCacheEntry)> = self
            .inner
            .iter()
            .map(|entry| (entry.key().clone(), entry.value().clone()))
            .collect();

        let json = serde_json::to_string_pretty(&entries)?;
        fs::write(&cache_path, json).await?;

        self.dirty.store(false, std::sync::atomic::Ordering::Relaxed);
        tracing::debug!("Persisted meta cache to {:?}", cache_path);

        Ok(())
    }

    /// Load cache from disk
    pub async fn load(vault_root: PathBuf) -> Result<Self> {
        let cache = Self::new(vault_root.clone());
        let cache_path = cache.cache_path();

        if cache_path.exists() {
            match fs::read_to_string(&cache_path).await {
                Ok(json) => {
                    let entries: Vec<(String, MetaCacheEntry)> = serde_json::from_str(&json)?;
                    for (key, value) in entries {
                        cache.inner.insert(key, value);
                    }
                    tracing::info!("Loaded {} entries from meta cache", cache.inner.len());
                }
                Err(e) => {
                    tracing::warn!("Failed to load meta cache: {}", e);
                }
            }
        }

        Ok(cache)
    }

    /// Get current file mtime in milliseconds
    pub fn get_mtime(path: &std::path::Path) -> Result<i64> {
        let metadata = std::fs::metadata(path)?;
        let mtime = metadata.modified()?;
        let duration = mtime.duration_since(UNIX_EPOCH)
            .map_err(|e| crate::error::VaultError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?;
        Ok(duration.as_millis() as i64)
    }

    /// Check if cached entry is still valid
    pub fn is_valid(&self, path: &str, file_path: &std::path::Path) -> bool {
        if let Some(entry) = self.inner.get(path) {
            if let Ok(current_mtime) = Self::get_mtime(file_path) {
                return entry.mtime_ms == current_mtime;
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn test_cache_persist_load() {
        let tmp = TempDir::new().unwrap();
        let vault_root = tmp.path().to_path_buf();

        let cache = MetaCache::new(vault_root.clone());
        cache.insert(
            "test.md".to_string(),
            MetaCacheEntry {
                mtime_ms: 123456789,
                size: 1024,
                meta: NoteMeta {
                    path: "test.md".to_string(),
                    title: "Test".to_string(),
                    mtime: 123456789,
                    size: 1024,
                    tags: vec![],
                    frontmatter: Default::default(),
                    word_count: 10,
                    folder: crate::types::NoteFolder::Inbox,
                },
            },
        );

        cache.persist().await.unwrap();

        let loaded = MetaCache::load(vault_root).await.unwrap();
        assert!(loaded.get("test.md").is_some());
        assert_eq!(loaded.get("test.md").unwrap().title, "Test");
    }
}
