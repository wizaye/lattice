//! Encryption provider abstraction (Open-Closed + Dependency-Inversion).
//!
//! `EncryptionProvider` is the only interface the rest of the
//! application imports.  New algorithms are added by implementing this
//! trait — no existing call-site changes.

use chacha20poly1305::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    XChaCha20Poly1305, XNonce,
};
use crate::{error::CryptoError, kdf::DerivedKey};

// Wire format:
//  [0]      version byte = 0x02  (0x01 was the old insecure XOR)
//  [1..25]  24-byte random XNonce
//  [25..]   XChaCha20-Poly1305 ciphertext + 16-byte auth tag

const VERSION: u8 = 0x02;
const NONCE_LEN: usize = 24;
const OVERHEAD: usize = 1 + NONCE_LEN + 16; // version + nonce + tag

// ── EncryptionProvider trait ─────────────────────────────────────────────────

/// Symmetric authenticated encryption.  Callers depend on this trait,
/// not on any concrete type (Dependency-Inversion Principle).
pub trait EncryptionProvider: Send + Sync {
    /// Encrypt `plaintext`.  Returns an opaque byte blob that can only
    /// be decoded by the same key.  Each call produces a different
    /// ciphertext for the same plaintext (random nonce).
    fn encrypt(&self, plaintext: &[u8]) -> Result<Vec<u8>, CryptoError>;

    /// Decrypt a blob returned by `encrypt`.  Returns `Err(Decrypt)`
    /// on any tampering or wrong key — callers MUST treat this as a
    /// hard stop and not attempt recovery by retrying with the same key.
    fn decrypt(&self, ciphertext: &[u8]) -> Result<Vec<u8>, CryptoError>;
}

// ── XChaCha20-Poly1305 implementation ────────────────────────────────────────

/// XChaCha20-Poly1305 (192-bit random nonce, 256-bit key).
///
/// Properties:
/// - Authenticated — any tampering with the ciphertext is detected.
/// - Random nonce — safe to generate randomly even for millions of
///   messages (birthday bound ≫ realistic vault sizes).
/// - Constant-time comparison — the Poly1305 tag check is done in
///   constant time by the `chacha20poly1305` crate.
pub struct XChaChaProvider {
    cipher: XChaCha20Poly1305,
}

impl XChaChaProvider {
    pub fn new(key: DerivedKey) -> Self {
        let cipher = XChaCha20Poly1305::new(key.as_bytes().into());
        Self { cipher }
    }
}

impl EncryptionProvider for XChaChaProvider {
    fn encrypt(&self, plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
        let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);

        let ciphertext_body = self
            .cipher
            .encrypt(&nonce, plaintext)
            .map_err(|e| CryptoError::Encrypt(e.to_string()))?;

        // Pack: version || nonce || ciphertext+tag
        let mut out = Vec::with_capacity(1 + NONCE_LEN + ciphertext_body.len());
        out.push(VERSION);
        out.extend_from_slice(nonce.as_slice());
        out.extend_from_slice(&ciphertext_body);
        Ok(out)
    }

    fn decrypt(&self, ciphertext: &[u8]) -> Result<Vec<u8>, CryptoError> {
        if ciphertext.len() < OVERHEAD {
            return Err(CryptoError::TruncatedCiphertext);
        }

        match ciphertext[0] {
            VERSION => {}
            v => return Err(CryptoError::UnknownVersion(v)),
        }

        let nonce = XNonce::from_slice(&ciphertext[1..1 + NONCE_LEN]);
        let body = &ciphertext[1 + NONCE_LEN..];

        self.cipher
            .decrypt(nonce, body)
            .map_err(|_| CryptoError::Decrypt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kdf::{DerivedKey, Salt, Argon2idKdf, KeyDerivation};

    fn make_provider() -> XChaChaProvider {
        let kdf = Argon2idKdf::default();
        let salt = Salt([1u8; 32]);
        let key = kdf.derive("test-passphrase", &salt, "test-vault").unwrap();
        XChaChaProvider::new(key)
    }

    #[test]
    fn round_trip() {
        let p = make_provider();
        let plaintext = b"Hello, Lattice!";
        let ct = p.encrypt(plaintext).unwrap();
        let pt = p.decrypt(&ct).unwrap();
        assert_eq!(pt, plaintext);
    }

    #[test]
    fn different_ciphertext_each_call() {
        let p = make_provider();
        let ct1 = p.encrypt(b"same input").unwrap();
        let ct2 = p.encrypt(b"same input").unwrap();
        // Random nonce ⇒ ciphertexts are different
        assert_ne!(ct1, ct2);
    }

    #[test]
    fn tampered_ciphertext_rejected() {
        let p = make_provider();
        let mut ct = p.encrypt(b"secret data").unwrap();
        ct[10] ^= 0xFF; // flip a bit
        assert!(p.decrypt(&ct).is_err());
    }

    #[test]
    fn version_0x01_rejected() {
        let p = make_provider();
        let mut ct = p.encrypt(b"data").unwrap();
        ct[0] = 0x01; // old insecure version marker
        assert!(matches!(p.decrypt(&ct), Err(CryptoError::UnknownVersion(0x01))));
    }

    #[test]
    fn truncated_ciphertext_rejected() {
        let p = make_provider();
        assert!(matches!(
            p.decrypt(&[0x02, 1, 2, 3]),
            Err(CryptoError::TruncatedCiphertext)
        ));
    }
}
