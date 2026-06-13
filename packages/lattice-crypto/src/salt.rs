//! Salt persistence (Interface-Segregation / Single-Responsibility).
//!
//! A salt must be generated once and stored alongside the vault.
//! `SaltStore` is a small single-purpose trait so tests can use an
//! in-memory stub without touching the filesystem.

use crate::{error::CryptoError, kdf::Salt};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

// On-disk envelope — one JSON file next to the vault config.
#[derive(Serialize, Deserialize)]
struct SaltEnvelope {
    /// Base64-encoded 32-byte salt.
    salt_b64: String,
}

// ── SaltStore trait ──────────────────────────────────────────────────────────

/// Load an existing salt or generate and persist a new one.
///
/// Keeping this as a trait lets us:
/// - Use a deterministic stub in unit tests.
/// - Swap the storage medium (file, OS keychain) without changing KDF
///   or encryption code.
pub trait SaltStore: Send + Sync {
    fn load_or_create(&self) -> Result<Salt, CryptoError>;
}

// ── FileSaltStore ─────────────────────────────────────────────────────────────

/// Persist the salt as JSON at `<vault>/.lattice/e2ee-salt.json`.
///
/// The salt is NOT a secret — it is safe to store alongside the
/// encrypted data.  Its purpose is to prevent two vaults with the
/// same passphrase from deriving the same key.
pub struct FileSaltStore {
    path: PathBuf,
}

impl FileSaltStore {
    /// `lattice_dir` should be `<vault>/.lattice/`.
    pub fn new(lattice_dir: &Path) -> Self {
        Self {
            path: lattice_dir.join("e2ee-salt.json"),
        }
    }
}

impl SaltStore for FileSaltStore {
    fn load_or_create(&self) -> Result<Salt, CryptoError> {
        if self.path.exists() {
            // Load existing salt.
            let raw = std::fs::read_to_string(&self.path)?;
            let env: SaltEnvelope = serde_json::from_str(&raw)?;
            let bytes = base64_decode(&env.salt_b64)?;
            if bytes.len() != 32 {
                return Err(CryptoError::SaltIo(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "salt file is corrupted (expected 32 bytes)",
                )));
            }
            let mut arr = [0u8; 32];
            arr.copy_from_slice(&bytes);
            return Ok(Salt(arr));
        }

        // Create a fresh random salt.
        let salt = Salt::random();
        let env = SaltEnvelope {
            salt_b64: base64_encode(salt.as_bytes()),
        };
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // Atomic write: .tmp → rename so a power-loss mid-write never
        // produces a truncated salt file.
        let tmp = self.path.with_extension("tmp");
        std::fs::write(&tmp, serde_json::to_string(&env)?)?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(salt)
    }
}

// ── Minimal base64 helpers ────────────────────────────────────────────────────
// We use base64 from `serde_json` string encoding as a poor-man's
// approach — it's just standard base64 alphabet.  In practice we
// inline two tiny helpers so we don't need to pull the full `base64`
// crate just for the salt file.  (The `base64` crate IS already a
// transitive dep via `argon2`, but it's not in `[dependencies]` here.)

fn base64_encode(bytes: &[u8]) -> String {
    // Simple stdlib-only base64 via lookup table.
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = if chunk.len() > 1 { chunk[1] as usize } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as usize } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(n >> 18) & 0x3F] as char);
        out.push(TABLE[(n >> 12) & 0x3F] as char);
        if chunk.len() > 1 { out.push(TABLE[(n >> 6) & 0x3F] as char); } else { out.push('='); }
        if chunk.len() > 2 { out.push(TABLE[n & 0x3F] as char); } else { out.push('='); }
    }
    out
}

fn base64_decode(s: &str) -> Result<Vec<u8>, CryptoError> {
    const REV: [i8; 256] = {
        let mut t = [-1i8; 256];
        let chars = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut i = 0usize;
        while i < chars.len() { t[chars[i] as usize] = i as i8; i += 1; }
        t
    };
    let s = s.trim_end_matches('=');
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let bytes = s.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        let a = REV[bytes[i] as usize];
        let b = REV[bytes[i + 1] as usize];
        if a < 0 || b < 0 { break; }
        out.push(((a as u8) << 2) | ((b as u8) >> 4));
        if i + 2 < bytes.len() {
            let c = REV[bytes[i + 2] as usize];
            if c >= 0 { out.push(((b as u8) << 4) | ((c as u8) >> 2)); }
            if i + 3 < bytes.len() {
                let d = REV[bytes[i + 3] as usize];
                if d >= 0 { out.push(((c as u8) << 6) | (d as u8)); }
            }
        }
        i += 4;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn load_or_create_is_idempotent() {
        let dir = tempdir().unwrap();
        let store = FileSaltStore::new(dir.path());
        let s1 = store.load_or_create().unwrap();
        let s2 = store.load_or_create().unwrap();
        assert_eq!(s1.0, s2.0, "same salt must be returned on second call");
    }

    #[test]
    fn base64_round_trip() {
        let data = b"hello crypto world 12345678";
        assert_eq!(base64_decode(&base64_encode(data)).unwrap(), data);
    }
}
