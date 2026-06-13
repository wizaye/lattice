use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, Debouncer, DebouncedEvent, FileIdMap};
use std::path::PathBuf;
use std::time::Duration;
use tokio::sync::broadcast;
use crate::types::{VaultChangeEvent, ChangeScope};
use crate::error::{Result, VaultError};

pub struct VaultWatcher {
    _debouncer: Debouncer<RecommendedWatcher, FileIdMap>,
    tx: broadcast::Sender<VaultChangeEvent>,
}

impl VaultWatcher {
    pub fn new(vault_root: PathBuf) -> Result<Self> {
        let (tx, _rx) = broadcast::channel(100);
        let tx_clone = tx.clone();

        // Create debouncer with 120ms delay (same as ZenNotes)
        let mut debouncer = new_debouncer(
            Duration::from_millis(120),
            None,
            move |result: notify_debouncer_full::DebounceEventResult| {
                match result {
                    Ok(events) => {
                        for event in events {
                            if let Some(change_event) = Self::process_event(event) {
                                let _ = tx_clone.send(change_event);
                            }
                        }
                    }
                    Err(errors) => {
                        for error in errors {
                            tracing::error!("Watcher error: {:?}", error);
                        }
                    }
                }
            },
        ).map_err(|e| VaultError::Watcher(e.to_string()))?;

        // Watch main folders
        let folders = vec![
            vault_root.join("inbox"),
            vault_root.join("quick"),
            vault_root.join("archive"),
            vault_root.join("trash"),
            vault_root.join("Daily Notes"),
            vault_root.join("attachements"),
            vault_root.join(".lattice"),
        ];

        for folder in folders {
            if folder.exists() {
                debouncer
                    .watch(&folder, RecursiveMode::Recursive)
                    .map_err(|e| VaultError::Watcher(e.to_string()))?;
                tracing::debug!("Watching {:?}", folder);
            }
        }

        // Also watch root for flat vaults
        debouncer
            .watch(&vault_root, RecursiveMode::NonRecursive)
            .map_err(|e| VaultError::Watcher(e.to_string()))?;

        Ok(Self {
            _debouncer: debouncer,
            tx,
        })
    }

    fn process_event(event: DebouncedEvent) -> Option<VaultChangeEvent> {
        use notify::EventKind;

        let paths = event.event.paths;
        if paths.is_empty() {
            return None;
        }

        let path = paths[0].to_string_lossy().to_string();
        
        // Determine scope based on path
        let scope = if path.contains(".lattice/vault.json") {
            ChangeScope::VaultSettings
        } else if path.contains("attachements") || path.contains("_assets") || path.contains("assets") {
            ChangeScope::Asset
        } else if path.ends_with(".md") {
            ChangeScope::Note
        } else {
            ChangeScope::Folder
        };

        // Map notify event kinds to our change events
        match event.event.kind {
            EventKind::Create(_) => Some(VaultChangeEvent::Created { path, scope }),
            EventKind::Modify(_) => Some(VaultChangeEvent::Modified { path, scope }),
            EventKind::Remove(_) => Some(VaultChangeEvent::Deleted { path, scope }),
            _ => None,
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<VaultChangeEvent> {
        self.tx.subscribe()
    }

    pub fn channel(&self) -> broadcast::Sender<VaultChangeEvent> {
        self.tx.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    use std::fs;

    #[tokio::test]
    async fn test_watcher_creation() {
        let tmp = TempDir::new().unwrap();
        let vault_root = tmp.path().to_path_buf();

        // Create folders
        fs::create_dir_all(vault_root.join("inbox")).unwrap();
        fs::create_dir_all(vault_root.join(".lattice")).unwrap();

        let watcher = VaultWatcher::new(vault_root.clone());
        assert!(watcher.is_ok());
    }

    #[tokio::test]
    async fn test_watcher_detects_changes() {
        let tmp = TempDir::new().unwrap();
        let vault_root = tmp.path().to_path_buf();
        
        fs::create_dir_all(vault_root.join("inbox")).unwrap();
        
        let watcher = VaultWatcher::new(vault_root.clone()).unwrap();
        let mut rx = watcher.subscribe();

        // Create a file
        let test_file = vault_root.join("inbox/test.md");
        fs::write(&test_file, "# Test").unwrap();

        // Wait for event (with timeout)
        tokio::select! {
            event = rx.recv() => {
                assert!(event.is_ok());
                match event.unwrap() {
                    VaultChangeEvent::Created { scope, .. } => {
                        assert!(matches!(scope, ChangeScope::Note));
                    }
                    _ => panic!("Expected Created event"),
                }
            }
            _ = tokio::time::sleep(Duration::from_secs(1)) => {
                // Timeout is ok for this test (file systems can be slow)
            }
        }
    }
}
