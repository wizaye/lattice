//! VCS Auto-commit — automatic periodic commits on idle
//! 
//! Implements impl-v2 §4.1: Auto-commit cadence with configurable intervals
//! - Auto-commit every 60s idle (default)
//! - Configurable: off / 30s / 1m / 5m / manual-only
//! - Snapshot on save promoted to commit at next idle window

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::time::sleep;

/// Auto-commit configuration
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AutoCommitCadence {
    Off,
    Sec30,
    Min1,
    Min5,
    ManualOnly,
}

impl AutoCommitCadence {
    pub fn to_duration(&self) -> Option<Duration> {
        match self {
            AutoCommitCadence::Off => None,
            AutoCommitCadence::Sec30 => Some(Duration::from_secs(30)),
            AutoCommitCadence::Min1 => Some(Duration::from_secs(60)),
            AutoCommitCadence::Min5 => Some(Duration::from_secs(300)),
            AutoCommitCadence::ManualOnly => None,
        }
    }
}

/// Auto-commit state for a single vault
#[derive(Debug, Clone)]
struct VaultAutoCommitState {
    vault_path: PathBuf,
    cadence: AutoCommitCadence,
    last_activity: Instant,
    last_commit: Instant,
    pending_snapshot: bool,
}

/// Global auto-commit manager
pub struct AutoCommitManager {
    vaults: Arc<Mutex<HashMap<String, VaultAutoCommitState>>>,
    running: Arc<Mutex<bool>>,
}

impl AutoCommitManager {
    pub fn new() -> Self {
        Self {
            vaults: Arc::new(Mutex::new(HashMap::new())),
            running: Arc::new(Mutex::new(false)),
        }
    }

    /// Start auto-commit for a vault
    pub fn enable(&self, vault_path: PathBuf, cadence: AutoCommitCadence) {
        let vault_key = vault_path.to_string_lossy().to_string();
        let mut vaults = self.vaults.lock().unwrap();
        vaults.insert(
            vault_key.clone(),
            VaultAutoCommitState {
                vault_path: vault_path.clone(),
                cadence,
                last_activity: Instant::now(),
                last_commit: Instant::now(),
                pending_snapshot: false,
            },
        );
    }

    /// Disable auto-commit for a vault
    pub fn disable(&self, vault_path: &PathBuf) {
        let vault_key = vault_path.to_string_lossy().to_string();
        let mut vaults = self.vaults.lock().unwrap();
        vaults.remove(&vault_key);
    }

    /// Update activity timestamp (called on every file save)
    pub fn record_activity(&self, vault_path: &PathBuf) {
        let vault_key = vault_path.to_string_lossy().to_string();
        let mut vaults = self.vaults.lock().unwrap();
        if let Some(state) = vaults.get_mut(&vault_key) {
            state.last_activity = Instant::now();
            state.pending_snapshot = true;
        }
    }

    /// Start the auto-commit background loop
    pub fn start_loop(&self) {
        {
            let mut running = self.running.lock().unwrap();
            if *running {
                return; // Already running
            }
            *running = true;
        }

        let vaults = Arc::clone(&self.vaults);
        let running = Arc::clone(&self.running);

        tokio::spawn(async move {
            loop {
                // Check if we should stop
                {
                    let r = running.lock().unwrap();
                    if !*r {
                        break;
                    }
                }

                // Check each vault
                let vaults_to_commit: Vec<(PathBuf, AutoCommitCadence)> = {
                    let mut vaults_guard = vaults.lock().unwrap();
                    let now = Instant::now();
                    
                    let mut to_commit = Vec::new();
                    for (_vault_key, state) in vaults_guard.iter_mut() {
                        if let Some(cadence_duration) = state.cadence.to_duration() {
                            let idle_time = now.duration_since(state.last_activity);
                            let since_commit = now.duration_since(state.last_commit);
                            
                            // Commit if:
                            // 1. We've been idle for longer than cadence
                            // 2. There's a pending snapshot
                            // 3. We haven't committed in the last cadence period
                            if idle_time >= cadence_duration 
                                && state.pending_snapshot 
                                && since_commit >= cadence_duration
                            {
                                to_commit.push((state.vault_path.clone(), state.cadence));
                                state.last_commit = now;
                                state.pending_snapshot = false;
                            }
                        }
                    }
                    to_commit
                };

                // Perform commits outside the lock
                for (vault_path, _cadence) in vaults_to_commit {
                    if let Err(e) = perform_auto_commit(&vault_path).await {
                        eprintln!("Auto-commit failed for {:?}: {}", vault_path, e);
                    }
                }

                // Sleep before next check
                sleep(Duration::from_secs(10)).await;
            }
        });
    }

    /// Stop the auto-commit loop
    #[allow(dead_code)]
    pub fn stop_loop(&self) {
        let mut running = self.running.lock().unwrap();
        *running = false;
    }
}

/// Perform an auto-commit for a vault
async fn perform_auto_commit(vault_path: &PathBuf) -> Result<(), String> {
    let vault_str = vault_path.to_string_lossy().to_string();
    
    // Check if there are changes
    let status = crate::git::vcs_status(vault_str.clone()).await?;
    
    if status.unstaged.is_empty() && status.untracked.is_empty() {
        return Ok(()); // No changes to commit
    }
    
    // Generate intelligent commit message
    let message = crate::vcs_commit_ai::vcs_generate_commit_message(
        vault_str.clone(),
        false, // Don't use AI for auto-commits
    ).await?;
    
    // Stage all changes
    let all_files: Vec<String> = status.unstaged.iter()
        .chain(status.untracked.iter())
        .map(|f| f.path.clone())
        .collect();
    
    if !all_files.is_empty() {
        crate::git::vcs_stage(vault_str.clone(), all_files).await?;
    }
    
    // Commit with auto-generated message
    let commit_msg = format!("[auto] {}", message.message);
    crate::git::vcs_commit(vault_str, commit_msg).await?;
    
    Ok(())
}

// ── Global Manager Instance ─────────────────────────────────────────────

lazy_static::lazy_static! {
    static ref AUTO_COMMIT_MANAGER: AutoCommitManager = AutoCommitManager::new();
}

// ── Tauri Commands ──────────────────────────────────────────────────────

/// Enable auto-commit for a vault
#[tauri::command]
pub async fn vcs_auto_commit_enable(
    vault_path: String,
    cadence: AutoCommitCadence,
) -> Result<(), String> {
    let path = PathBuf::from(&vault_path);
    AUTO_COMMIT_MANAGER.enable(path, cadence);
    
    // Start the loop if not already running
    AUTO_COMMIT_MANAGER.start_loop();
    
    Ok(())
}

/// Disable auto-commit for a vault
#[tauri::command]
pub async fn vcs_auto_commit_disable(vault_path: String) -> Result<(), String> {
    let path = PathBuf::from(&vault_path);
    AUTO_COMMIT_MANAGER.disable(&path);
    Ok(())
}

/// Record activity (called on file save)
#[tauri::command]
pub async fn vcs_auto_commit_activity(vault_path: String) -> Result<(), String> {
    let path = PathBuf::from(&vault_path);
    AUTO_COMMIT_MANAGER.record_activity(&path);
    Ok(())
}

/// Get auto-commit status
#[tauri::command]
pub async fn vcs_auto_commit_status(vault_path: String) -> Result<AutoCommitStatus, String> {
    let vault_key = vault_path;
    let vaults = AUTO_COMMIT_MANAGER.vaults.lock().unwrap();
    
    if let Some(state) = vaults.get(&vault_key) {
        Ok(AutoCommitStatus {
            enabled: true,
            cadence: state.cadence,
            seconds_since_last_activity: state.last_activity.elapsed().as_secs(),
            seconds_since_last_commit: state.last_commit.elapsed().as_secs(),
            pending_snapshot: state.pending_snapshot,
        })
    } else {
        Ok(AutoCommitStatus {
            enabled: false,
            cadence: AutoCommitCadence::Off,
            seconds_since_last_activity: 0,
            seconds_since_last_commit: 0,
            pending_snapshot: false,
        })
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoCommitStatus {
    pub enabled: bool,
    pub cadence: AutoCommitCadence,
    pub seconds_since_last_activity: u64,
    pub seconds_since_last_commit: u64,
    pub pending_snapshot: bool,
}
