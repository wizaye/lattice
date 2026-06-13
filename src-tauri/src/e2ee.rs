//! E2EE — End-to-end encryption module.
//!
//! # Design
//!
//! All cryptographic primitives live in the separate `lattice-crypto`
//! crate (see `packages/lattice-crypto/`).  This module is responsible only for:
//!   1. Wiring the crypto crate to the Tauri managed-state layer.
//!   2. Exposing IPC commands that read/write that state.
//!   3. Providing helpers used by the sync layer to encrypt files
//!      before they leave the device.
//!
//! # Fixes from audit
//!
//! - **Critical 1 (XOR cipher)**: replaced with XChaCha20-Poly1305
//!   via `lattice-crypto::XChaChaProvider`.
//! - **Critical 2 (salt never persisted)**: `FileSaltStore` writes
//!   the salt to `<vault>/.lattice/e2ee-salt.json` on first use and
//!   loads it on every subsequent call.
//! - **Critical 3 (no shared state)**: `E2EEState` is a Tauri managed
//!   resource. IPC commands receive it via `tauri::State<E2EEState>`
//!   and mutate through a `Mutex` so the unlock persists across calls.

use lattice_crypto::{build_vault_provider, EncryptionProvider, FileSaltStore, XChaChaProvider};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
};

// ── Managed state ─────────────────────────────────────────────────────────────

/// Tauri managed state: holds unlocked providers keyed by vault path.
///
/// Register with `app.manage(E2EEState::default())` in `lib.rs::run()`
/// BEFORE `invoke_handler!`. Commands receive it via
/// `state: tauri::State<E2EEState>`.
pub struct E2EEState {
    unlocked: Mutex<HashMap<String, XChaChaProvider>>,
}

impl Default for E2EEState {
    fn default() -> Self {
        Self {
            unlocked: Mutex::new(HashMap::new()),
        }
    }
}

impl E2EEState {
    fn is_unlocked_for(&self, vault_path: &str) -> bool {
        self.unlocked.lock().unwrap().contains_key(vault_path)
    }

    fn encrypt_for(&self, vault_path: &str, plaintext: &[u8]) -> Result<Vec<u8>, String> {
        let map = self.unlocked.lock().unwrap();
        let provider = map
            .get(vault_path)
            .ok_or_else(|| "vault is locked — call e2ee_unlock first".to_string())?;
        provider.encrypt(plaintext).map_err(|e| e.to_string())
    }

    fn decrypt_for(&self, vault_path: &str, ciphertext: &[u8]) -> Result<Vec<u8>, String> {
        let map = self.unlocked.lock().unwrap();
        let provider = map
            .get(vault_path)
            .ok_or_else(|| "vault is locked — call e2ee_unlock first".to_string())?;
        provider.decrypt(ciphertext).map_err(|e| e.to_string())
    }

    fn insert(&self, vault_path: String, provider: XChaChaProvider) {
        self.unlocked.lock().unwrap().insert(vault_path, provider);
    }

    fn remove(&self, vault_path: &str) {
        self.unlocked.lock().unwrap().remove(vault_path);
    }
}

// ── On-disk config (non-secret) ───────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct E2EEConfig {
    pub enabled: bool,
    pub vault_id: String,
}

impl E2EEConfig {
    fn config_path(vault_path: &Path) -> PathBuf {
        vault_path.join(".lattice").join("e2ee.json")
    }

    fn load(vault_path: &Path) -> Result<Option<Self>, String> {
        let p = Self::config_path(vault_path);
        if !p.exists() {
            return Ok(None);
        }
        let raw = std::fs::read_to_string(&p)
            .map_err(|e| format!("failed to read e2ee config: {e}"))?;
        serde_json::from_str(&raw)
            .map(Some)
            .map_err(|e| format!("failed to parse e2ee config: {e}"))
    }

    fn save(&self, vault_path: &Path) -> Result<(), String> {
        let p = Self::config_path(vault_path);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create .lattice dir: {e}"))?;
        }
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| format!("failed to serialise e2ee config: {e}"))?;
        std::fs::write(&p, json).map_err(|e| format!("failed to write e2ee config: {e}"))
    }
}

fn lattice_dir(vault_path: &Path) -> PathBuf {
    vault_path.join(".lattice")
}

// ── Public helpers (used by sync layer) ─────────────────────────────────────

/// Encrypt `plaintext` if the vault is unlocked; otherwise pass through.
pub fn maybe_encrypt(
    state: &E2EEState,
    vault_path: &str,
    plaintext: &[u8],
) -> Result<Vec<u8>, String> {
    if state.is_unlocked_for(vault_path) {
        state.encrypt_for(vault_path, plaintext)
    } else {
        Ok(plaintext.to_vec())
    }
}

/// Decrypt `ciphertext` if the vault is unlocked; otherwise pass through.
pub fn maybe_decrypt(
    state: &E2EEState,
    vault_path: &str,
    ciphertext: &[u8],
) -> Result<Vec<u8>, String> {
    if state.is_unlocked_for(vault_path) {
        state.decrypt_for(vault_path, ciphertext)
    } else {
        Ok(ciphertext.to_vec())
    }
}

// ── Tauri IPC commands ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn e2ee_initialize(
    vault_path: String,
    passphrase: String,
    state: tauri::State<'_, E2EEState>,
) -> Result<(), String> {
    let path = PathBuf::from(&vault_path);
    let mut config = E2EEConfig::load(&path)?.unwrap_or_else(|| E2EEConfig {
        enabled: false,
        vault_id: uuid::Uuid::new_v4().to_string(),
    });
    config.enabled = true;
    config.save(&path)?;

    let salt_store = FileSaltStore::new(&lattice_dir(&path));
    let provider = build_vault_provider(&passphrase, &config.vault_id, &salt_store)
        .map_err(|e| e.to_string())?;
    state.insert(vault_path, provider);
    Ok(())
}

#[tauri::command]
pub async fn e2ee_unlock(
    vault_path: String,
    passphrase: String,
    state: tauri::State<'_, E2EEState>,
) -> Result<(), String> {
    let path = PathBuf::from(&vault_path);
    let config = E2EEConfig::load(&path)?
        .ok_or_else(|| "E2EE has not been initialised for this vault".to_string())?;
    if !config.enabled {
        return Err("E2EE is not enabled for this vault".to_string());
    }
    let salt_store = FileSaltStore::new(&lattice_dir(&path));
    let provider = build_vault_provider(&passphrase, &config.vault_id, &salt_store)
        .map_err(|e| e.to_string())?;
    state.insert(vault_path, provider);
    Ok(())
}

#[tauri::command]
pub async fn e2ee_lock(
    vault_path: String,
    state: tauri::State<'_, E2EEState>,
) -> Result<(), String> {
    state.remove(&vault_path);
    Ok(())
}

#[tauri::command]
pub async fn e2ee_is_unlocked(
    vault_path: String,
    state: tauri::State<'_, E2EEState>,
) -> Result<bool, String> {
    Ok(state.is_unlocked_for(&vault_path))
}

#[tauri::command]
pub async fn e2ee_status(
    vault_path: String,
    state: tauri::State<'_, E2EEState>,
) -> Result<E2EEStatus, String> {
    let path = PathBuf::from(&vault_path);
    let config = E2EEConfig::load(&path)?;
    Ok(E2EEStatus {
        enabled: config.as_ref().map(|c| c.enabled).unwrap_or(false),
        unlocked: state.is_unlocked_for(&vault_path),
        vault_id: config.map(|c| c.vault_id).unwrap_or_default(),
    })
}

#[tauri::command]
pub async fn e2ee_is_enabled(vault_path: String) -> Result<bool, String> {
    let path = PathBuf::from(&vault_path);
    Ok(E2EEConfig::load(&path)?.map(|c| c.enabled).unwrap_or(false))
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct E2EEStatus {
    pub enabled: bool,
    pub unlocked: bool,
    pub vault_id: String,
}
