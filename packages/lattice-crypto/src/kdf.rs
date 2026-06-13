//! Key-derivation abstraction (Interface Segregation Principle).
//!
//! `KeyDerivation` is a small trait so future algorithms (e.g. scrypt,
//! bcrypt-for-legacy migration) can be added without touching callers.

use crate::error::CryptoError;
use argon2::{Algorithm, Argon2, Params, Version};
use rand::RngCore;
use rand::rngs::OsRng;
use zeroize::{Zeroize, ZeroizeOnDrop};

// ── DerivedKey ───────────────────────────────────────────────────────────────

/// 32-byte key material derived from a passphrase.
///
/// Implements `ZeroizeOnDrop` so the key bytes are wiped when this
/// value is dropped — minimises the window during which the key
/// exists in freed heap memory.
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct DerivedKey(pub(crate) [u8; 32]);

impl DerivedKey {
    /// Raw key bytes — only needed by the encryption provider.
    pub(crate) fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

// ── Salt ─────────────────────────────────────────────────────────────────────

/// 32-byte random salt — stored alongside the encrypted vault.
#[derive(Debug, Clone)]
pub struct Salt(pub [u8; 32]);

impl Salt {
    /// Generate a new cryptographically random salt.
    pub fn random() -> Self {
        let mut bytes = [0u8; 32];
        OsRng.fill_bytes(&mut bytes);
        Salt(bytes)
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

// ── KeyDerivation trait ───────────────────────────────────────────────────────

/// Derive a fixed-length key from a passphrase + salt.
///
/// `vault_id` is an additional context string so vaults with the
/// same passphrase produce different keys.
pub trait KeyDerivation: Send + Sync {
    fn derive(
        &self,
        passphrase: &str,
        salt: &Salt,
        vault_id: &str,
    ) -> Result<DerivedKey, CryptoError>;
}

// ── Argon2id implementation ──────────────────────────────────────────────────

/// Argon2id with OWASP-recommended interactive parameters (2026).
///
/// - Memory  : 64 MiB (65 536 KiB)
/// - Iterations: 3
/// - Parallelism: 4
///
/// These balance security against a real attacker with responsiveness
/// on commodity hardware (~200ms on a laptop, imperceptible for a
/// one-time unlock).
pub struct Argon2idKdf {
    m_cost_kib: u32,
    t_cost: u32,
    p_cost: u32,
}

impl Default for Argon2idKdf {
    fn default() -> Self {
        Self {
            m_cost_kib: 65_536,
            t_cost: 3,
            p_cost: 4,
        }
    }
}

impl KeyDerivation for Argon2idKdf {
    fn derive(
        &self,
        passphrase: &str,
        salt: &Salt,
        vault_id: &str,
    ) -> Result<DerivedKey, CryptoError> {
        let params = Params::new(
            self.m_cost_kib,
            self.t_cost,
            self.p_cost,
            Some(32), // output length
        )
        .map_err(|e| CryptoError::Kdf(e.to_string()))?;

        let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

        // Combine passphrase + vault_id so two vaults with the same
        // passphrase derive different keys without adding a second
        // round-trip.
        let input = format!("{}\x00{}", passphrase, vault_id);

        let mut key_bytes = [0u8; 32];
        argon2
            .hash_password_into(input.as_bytes(), salt.as_bytes(), &mut key_bytes)
            .map_err(|e| CryptoError::Kdf(e.to_string()))?;

        Ok(DerivedKey(key_bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_passphrase_salt_vault_id_gives_same_key() {
        let kdf = Argon2idKdf::default();
        let salt = Salt([42u8; 32]);
        let k1 = kdf.derive("hunter2", &salt, "vault-A").unwrap();
        let k2 = kdf.derive("hunter2", &salt, "vault-A").unwrap();
        assert_eq!(k1.0, k2.0);
    }

    #[test]
    fn different_vault_ids_give_different_keys() {
        let kdf = Argon2idKdf::default();
        let salt = Salt([0u8; 32]);
        let k1 = kdf.derive("pass", &salt, "vault-A").unwrap();
        let k2 = kdf.derive("pass", &salt, "vault-B").unwrap();
        assert_ne!(k1.0, k2.0);
    }
}
