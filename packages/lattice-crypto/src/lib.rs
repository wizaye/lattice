//! lattice-crypto — isolated cryptographic primitives for Lattice.
//!
//! # Architecture (SOLID)
//!
//! ```text
//! EncryptionProvider (trait)      ← Dependency-Inversion / Open-Closed
//!   └── XChaChaProvider           ← concrete, swappable
//!
//! KeyDerivation (trait)           ← Interface Segregation
//!   └── Argon2idKdf               ← concrete, swappable
//!
//! SaltStore (trait)               ← Interface Segregation
//!   └── FileSaltStore             ← concrete; stores to .lattice/
//! ```
//!
//! Callers depend on traits only — the concrete types are not exported
//! from the crate root.  This means the E2EE manager can be tested
//! with stub implementations and the algorithm can be upgraded without
//! changing call-sites.

pub mod error;
pub mod kdf;
pub mod provider;
pub mod salt;

// Re-export the single entry-point that the Tauri layer needs.
pub use provider::{EncryptionProvider, XChaChaProvider};
pub use kdf::{KeyDerivation, Argon2idKdf, DerivedKey};
pub use salt::{SaltStore, FileSaltStore};
pub use error::CryptoError;

/// Convenience: build a production-ready provider from a passphrase
/// and a vault-local salt store.  This is the ONLY function the
/// calling crate (`lattice` / `e2ee.rs`) needs at the point where it
/// constructs the provider.
pub fn build_vault_provider(
    passphrase: &str,
    vault_id: &str,
    salt_store: &dyn SaltStore,
) -> Result<XChaChaProvider, CryptoError> {
    let kdf = Argon2idKdf::default();
    let salt = salt_store.load_or_create()?;
    let derived = kdf.derive(passphrase, &salt, vault_id)?;
    Ok(XChaChaProvider::new(derived))
}
