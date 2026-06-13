//! VCS Auto-commit — Observer + Strategy patterns.
//!
//! # SOLID Design
//!
//! ## Single Responsibility
//! `AutoCommitScheduler` owns scheduling state only.
//! `GitCommitter` trait handles the actual git operations.
//!
//! ## Dependency Inversion
//! The scheduler depends on `GitCommitter` (abstraction), NOT on
//! `crate::git` directly. `SystemGitCommitter` is the production
//! implementation; tests can inject a stub.
//!
//! ## Observer Pattern
//! `CommitObserver` allows external components to react to commit
//! lifecycle events without being hard-wired into the scheduler.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::time::sleep;

// ── Configuration ─────────────────────────────────────────────────────────

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
    pub fn to_duration(self) -> Option<Duration> {
        match self {
            AutoCommitCadence::Off | AutoCommitCadence::ManualOnly => None,
            AutoCommitCadence::Sec30 => Some(Duration::from_secs(30)),
            AutoCommitCadence::Min1  => Some(Duration::from_secs(60)),
            AutoCommitCadence::Min5  => Some(Duration::from_secs(300)),
        }
    }
}

// ── Observer trait ─────────────────────────────────────────────────────────

pub trait CommitObserver: Send + Sync {
    fn on_commit_success(&self, vault: &PathBuf, message: &str);
    fn on_commit_failure(&self, vault: &PathBuf, error: &str);
}

// ── Abstraction for git operations (DIP) ────────────────────────────────

#[async_trait::async_trait]
pub trait GitCommitter: Send + Sync {
    async fn has_changes(&self, vault: &str) -> bool;
    async fn stage_all(&self, vault: &str) -> Result<(), String>;
    async fn commit(&self, vault: &str, message: &str) -> Result<(), String>;
    async fn generate_message(&self, vault: &str) -> String;
}

// ── Production implementation ─────────────────────────────────────────────

pub struct SystemGitCommitter;

#[async_trait::async_trait]
impl GitCommitter for SystemGitCommitter {
    async fn has_changes(&self, vault: &str) -> bool {
        if let Ok(status) = crate::git::vcs_status(vault.to_string()).await {
            !status.unstaged.is_empty() || !status.untracked.is_empty()
        } else {
            false
        }
    }

    async fn stage_all(&self, vault: &str) -> Result<(), String> {
        let status = crate::git::vcs_status(vault.to_string()).await?;
        let files: Vec<String> = status.unstaged.iter()
            .chain(status.untracked.iter())
            .map(|f| f.path.clone())
            .collect();
        if !files.is_empty() {
            crate::git::vcs_stage(vault.to_string(), files).await?;
        }
        Ok(())
    }

    async fn commit(&self, vault: &str, message: &str) -> Result<(), String> {
        crate::git::vcs_commit(vault.to_string(), message.to_string()).await?;
        Ok(())
    }

    async fn generate_message(&self, vault: &str) -> String {
        crate::vcs_commit_ai::vcs_generate_commit_message(vault.to_string(), false)
            .await
            .map(|r| r.message)
            .unwrap_or_else(|_| "Auto-commit".to_string())
    }
}

// ── Vault state ────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct VaultState {
    vault_path: PathBuf,
    cadence: AutoCommitCadence,
    last_activity: Instant,
    last_commit: Instant,
    pending_snapshot: bool,
}

// ── Scheduler ─────────────────────────────────────────────────────────────

pub struct AutoCommitScheduler {
    vaults:    Arc<Mutex<HashMap<String, VaultState>>>,
    observers: Arc<Mutex<Vec<Box<dyn CommitObserver>>>>,
    running:   Arc<Mutex<bool>>,
}

impl AutoCommitScheduler {
    pub fn new() -> Self {
        Self {
            vaults:    Arc::new(Mutex::new(HashMap::new())),
            observers: Arc::new(Mutex::new(Vec::new())),
            running:   Arc::new(Mutex::new(false)),
        }
    }

    pub fn enable(&self, vault_path: PathBuf, cadence: AutoCommitCadence) {
        let key = vault_path.to_string_lossy().to_string();
        self.vaults.lock().unwrap().insert(key, VaultState {
            vault_path,
            cadence,
            last_activity: Instant::now(),
            last_commit:   Instant::now(),
            pending_snapshot: false,
        });
    }

    pub fn disable(&self, vault_path: &PathBuf) {
        let key = vault_path.to_string_lossy().to_string();
        self.vaults.lock().unwrap().remove(&key);
    }

    pub fn record_activity(&self, vault_path: &PathBuf) {
        let key = vault_path.to_string_lossy().to_string();
        if let Some(s) = self.vaults.lock().unwrap().get_mut(&key) {
            s.last_activity = Instant::now();
            s.pending_snapshot = true;
        }
    }

    pub fn add_observer(&self, observer: Box<dyn CommitObserver>) {
        self.observers.lock().unwrap().push(observer);
    }

    pub fn start_loop<G: GitCommitter + 'static>(&self, committer: Arc<G>) {
        {
            let mut running = self.running.lock().unwrap();
            if *running { return; }
            *running = true;
        }
        let vaults    = Arc::clone(&self.vaults);
        let observers = Arc::clone(&self.observers);
        let running   = Arc::clone(&self.running);

        tokio::spawn(async move {
            loop {
                if !*running.lock().unwrap() { break; }

                let to_commit: Vec<PathBuf> = {
                    let mut guard = vaults.lock().unwrap();
                    let now = Instant::now();
                    let mut pending = Vec::new();
                    for state in guard.values_mut() {
                        let Some(dur) = state.cadence.to_duration() else { continue };
                        if state.pending_snapshot
                            && now.duration_since(state.last_activity) >= dur
                            && now.duration_since(state.last_commit)   >= dur
                        {
                            pending.push(state.vault_path.clone());
                            state.last_commit = now;
                        }
                    }
                    pending
                };

                for vault in to_commit {
                    let vault_str = vault.to_string_lossy().to_string();
                    let msg = committer.generate_message(&vault_str).await;
                    let result = {
                        let vs = vault_str.clone();
                        let m  = msg.clone();
                        let c  = Arc::clone(&committer);
                        async move {
                            c.stage_all(&vs).await?;
                            c.commit(&vs, &format!("[auto] {m}")).await
                        }
                    }.await;

                    match result {
                        Ok(()) => {
                            if let Some(s) = vaults.lock().unwrap().get_mut(&vault_str) {
                                s.pending_snapshot = false;
                            }
                            for obs in observers.lock().unwrap().iter() {
                                obs.on_commit_success(&vault, &msg);
                            }
                        }
                        Err(e) => {
                            eprintln!("Auto-commit failed for {:?}: {e}", vault);
                            for obs in observers.lock().unwrap().iter() {
                                obs.on_commit_failure(&vault, &e);
                            }
                        }
                    }
                }

                sleep(Duration::from_secs(10)).await;
            }
        });
    }

    pub fn stop_loop(&self) {
        *self.running.lock().unwrap() = false;
    }
}

impl Default for AutoCommitScheduler {
    fn default() -> Self { Self::new() }
}

// Kept for backward-compat
pub type AutoCommitManager = AutoCommitScheduler;
