//! Typed error enum for all crypto operations.
//!
//! Using `thiserror` (SRP: errors live in one place, not scattered
//! across modules as `String`s) keeps the crate's public API clean
//! and lets callers pattern-match on failure kind.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum CryptoError {
    #[error("key derivation failed: {0}")]
    Kdf(String),

    #[error("encryption failed: {0}")]
    Encrypt(String),

    #[error("decryption failed — data is corrupted or the passphrase is wrong")]
    Decrypt,

    #[error("salt I/O error: {0}")]
    SaltIo(#[from] std::io::Error),

    #[error("salt serialisation error: {0}")]
    SaltSerde(#[from] serde_json::Error),

    #[error("invalid ciphertext envelope (version {0} unknown)")]
    UnknownVersion(u8),

    #[error("ciphertext too short to contain a valid envelope")]
    TruncatedCiphertext,
}
