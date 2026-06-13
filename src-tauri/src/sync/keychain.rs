//! Token persistence.
//!
//! Storage policy (changed in slice B-2, was previously OS keychain):
//!
//!  * **Windows**  — encrypted JSON file under
//!    `%LOCALAPPDATA%\Lattice\byoc-tokens\<provider>-<vault-hash>.dpapi`.
//!    Confidentiality is provided by Win32 DPAPI's `CryptProtectData` with
//!    the user-session scope, which derives a key from the logged-in
//!    Windows account.  Result: ciphertext is only decryptable from the
//!    same user account on the same machine, no key management for us,
//!    and the file is **self-contained inside the app's data dir** so a
//!    Lattice uninstall removes the tokens (vs. Credential Manager
//!    entries which would persist).
//!
//!  * **macOS / Linux** — OS keychain via the `keyring` crate
//!    (Keychain Services / libsecret).  These platforms already give us
//!    a great secret store with the right scope, and there's no DPAPI
//!    equivalent we'd want to rebuild from scratch.
//!
//! Public API is identical across platforms:
//!
//! ```ignore
//! pub fn store(vault, provider, &TokenSet) -> Result<(), SyncError>
//! pub fn load(vault, provider) -> Result<Option<TokenSet>, SyncError>
//! pub fn delete(vault, provider) -> Result<(), SyncError>
//! pub fn storage_descriptor(vault, provider) -> StorageDescriptor
//! ```
//!
//! Key derivation: one entry per (vault, provider) pair so the same
//! desktop can connect different vaults to different GitHub accounts.
//! We hash the absolute vault path with BLAKE3 → 16-char hex prefix so
//! the on-disk filename (or keychain "username" on mac/linux) doesn't
//! leak `OneDrive - $Org`-style folder names to anyone browsing the
//! storage location.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::error::SyncError;
use super::ProviderId;

#[cfg(not(windows))]
const SERVICE: &str = "lattice-byoc";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct TokenSet {
    pub access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// Unix-seconds expiry of the access token.  `None` means
    /// "treat as long-lived" (GitHub Device-Flow tokens have no
    /// expiry unless the user enables expiration in app settings).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    /// Granted scopes (space-separated, as returned by the provider).
    #[serde(default)]
    pub scope: String,
    /// `Bearer` is the only one we use today, but keeping this around
    /// lets future adapters (e.g. Dropbox) use a different scheme
    /// without changing the on-disk shape.
    #[serde(default = "default_token_type")]
    pub token_type: String,
}

fn default_token_type() -> String {
    "Bearer".into()
}

fn hash_prefix_16(s: &str) -> String {
    let hash = blake3::hash(s.as_bytes());
    let hex = hash.to_hex();
    hex[..16].to_string()
}

fn normalized_vault_key(vault: &Path) -> Result<String, super::error::SyncError> {
    // Canonicalize so equivalent paths (relative segments, trailing
    // separators, drive-letter case on Windows) resolve to the same
    // storage key.
    //
    // Bug 18 fix: the old code silently fell back to the raw path when
    // canonicalization failed (e.g. USB drive disconnected, temporary
    // network share unmounted).  The stored token was written with the
    // canonical hash, so the raw-path fallback produced a DIFFERENT hash
    // and load() would return None even though a valid token exists —
    // making the user appear disconnected and triggering unnecessary
    // re-auth.  We now propagate the error so callers can surface a
    // meaningful message ("vault drive not reachable") instead of
    // silently re-prompting for credentials.
    let canonical = std::fs::canonicalize(vault).map_err(|e| {
        super::error::SyncError::BadInput(format!(
            "cannot canonicalize vault path '{}': {} \
             — make sure the vault drive is mounted",
            vault.display(),
            e
        ))
    })?;

    let mut s = canonical.to_string_lossy().to_string();

    // Trim trailing separators to avoid `C:\vault` vs `C:\vault\`
    // generating different hashes.
    while s.ends_with(['/', '\\']) {
        s.pop();
    }

    #[cfg(windows)]
    {
        // Treat slash style and path case as equivalent on Windows.
        s = s.replace('/', "\\").to_ascii_lowercase();
    }

    Ok(s)
}

fn legacy_vault_key(vault: &Path) -> String {
    // Historical behavior used the raw lossy path text.  Keep this for
    // read/delete fallback so existing tokens remain valid.
    vault.to_string_lossy().to_string()
}

fn vault_hash(vault: &Path) -> Result<String, super::error::SyncError> {
    // BLAKE3 is content-addressed-style: deterministic + collision-free
    // for this domain.  16 hex chars (64 bits) is plenty of entropy
    // for a per-machine namespacing key.
    Ok(hash_prefix_16(&normalized_vault_key(vault)?))
}

fn legacy_vault_hash(vault: &Path) -> String {
    hash_prefix_16(&legacy_vault_key(vault))
}

#[allow(dead_code)] // used by non-Windows backend; also by storage_descriptor
fn account_key(vault: &Path, provider: ProviderId) -> Result<String, super::error::SyncError> {
    Ok(format!("{}:{}", provider.as_str(), vault_hash(vault)?))
}

// ── public API: storage descriptor (for UI "where do my tokens live?") ─

/// Human-meaningful description of where a (vault, provider) entry is
/// persisted.  Used by the `byoc_storage_info` IPC so the UI can render
/// a "Reveal" affordance and show the user that we're NOT putting
/// credentials into Credential Manager / Keychain on this platform.
#[allow(dead_code)] // wired into IPC layer in the next step
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageDescriptor {
    /// One of `"dpapi-file"` (Windows), `"keychain"` (mac/linux).
    pub backend: String,
    /// Absolute path on disk for file-backed storage, `None` for keychain.
    pub path: Option<PathBuf>,
    /// Parent folder (always present so the UI can "Reveal in Explorer").
    pub directory: Option<PathBuf>,
    /// Stable opaque label shown to the user.
    pub label: String,
}

#[allow(dead_code)] // wired into IPC layer in the next step
pub fn storage_descriptor(vault: &Path, provider: ProviderId) -> StorageDescriptor {
    #[cfg(windows)]
    {
        match win::token_path(vault, provider) {
            Ok(path) => StorageDescriptor {
                backend: "dpapi-file".into(),
                directory: path.parent().map(PathBuf::from),
                label: "Encrypted file in app data (Windows DPAPI)".into(),
                path: Some(path),
            },
            Err(_) => StorageDescriptor {
                backend: "dpapi-file".into(),
                path: None,
                directory: None,
                label: "Encrypted file in app data (Windows DPAPI)".into(),
            },
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (vault, provider);
        StorageDescriptor {
            backend: "keychain".into(),
            path: None,
            directory: None,
            label: account_key(vault, provider)
                .map(|k| format!("{SERVICE} ({k})"))
                .unwrap_or_else(|_| format!("{SERVICE} (vault path unresolvable)")),
        }
    }
}

// ── public API: store / load / delete ─────────────────────────────

pub fn store(vault: &Path, provider: ProviderId, tokens: &TokenSet) -> Result<(), SyncError> {
    let blob = serde_json::to_vec(tokens).map_err(|e| SyncError::Manifest(e.to_string()))?;
    #[cfg(windows)]
    {
        win::write(vault, provider, &blob)
    }
    #[cfg(not(windows))]
    {
        nix::write(vault, provider, &blob)
    }
}

pub fn load(vault: &Path, provider: ProviderId) -> Result<Option<TokenSet>, SyncError> {
    #[cfg(windows)]
    let bytes = win::read(vault, provider)?;
    #[cfg(not(windows))]
    let bytes = nix::read(vault, provider)?;

    match bytes {
        Some(b) => {
            let tokens: TokenSet = serde_json::from_slice(&b)
                .map_err(|err| SyncError::Manifest(err.to_string()))?;
            Ok(Some(tokens))
        }
        None => Ok(None),
    }
}

pub fn delete(vault: &Path, provider: ProviderId) -> Result<(), SyncError> {
    #[cfg(windows)]
    {
        win::delete(vault, provider)
    }
    #[cfg(not(windows))]
    {
        nix::delete(vault, provider)
    }
}

// ── Windows backend: DPAPI + file ─────────────────────────────────

#[cfg(windows)]
mod win {
    use super::*;
    use std::fs;
    use std::ptr;

    use windows_sys::Win32::Foundation::{GetLastError, LocalFree, HLOCAL};
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
    };

    fn app_local_data_dir() -> Result<PathBuf, SyncError> {
        // %LOCALAPPDATA% is set on every interactive Windows session
        // (and on services running under user accounts).  Falling back
        // to %USERPROFILE%\AppData\Local would be redundant in practice.
        let base = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .ok_or_else(|| SyncError::Io("%LOCALAPPDATA% is not set".into()))?;
        Ok(base.join("Lattice").join("byoc-tokens"))
    }

    pub(super) fn token_path(vault: &Path, provider: ProviderId) -> Result<PathBuf, SyncError> {
        let dir = app_local_data_dir()?;
        Ok(dir.join(format!(
            "{}-{}.dpapi",
            provider.as_str(),
            vault_hash(vault)?
        )))
    }

    fn token_path_legacy(vault: &Path, provider: ProviderId) -> Result<PathBuf, SyncError> {
        let dir = app_local_data_dir()?;
        Ok(dir.join(format!(
            "{}-{}.dpapi",
            provider.as_str(),
            legacy_vault_hash(vault)
        )))
    }

    pub(super) fn write(
        vault: &Path,
        provider: ProviderId,
        plaintext: &[u8],
    ) -> Result<(), SyncError> {
        let path = token_path(vault, provider)?;
        let legacy = token_path_legacy(vault, provider)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| SyncError::Io(e.to_string()))?;
        }
        let ciphertext = protect(plaintext)?;
        // Atomic-ish write: stage to .tmp then rename.
        let tmp = path.with_extension("dpapi.tmp");
        fs::write(&tmp, &ciphertext).map_err(|e| SyncError::Io(e.to_string()))?;
        fs::rename(&tmp, &path).map_err(|e| SyncError::Io(e.to_string()))?;
        // Migration cleanup: if the historical raw-path key was
        // different, remove it after successful write.
        if legacy != path && legacy.exists() {
            let _ = fs::remove_file(&legacy);
        }
        Ok(())
    }

    pub(super) fn read(
        vault: &Path,
        provider: ProviderId,
    ) -> Result<Option<Vec<u8>>, SyncError> {
        let path = token_path(vault, provider)?;
        if !path.exists() {
            let legacy = token_path_legacy(vault, provider)?;
            if !legacy.exists() {
                return Ok(None);
            }
            let ciphertext = fs::read(&legacy).map_err(|e| SyncError::Io(e.to_string()))?;
            let plaintext = unprotect(&ciphertext)?;
            return Ok(Some(plaintext));
        }
        let ciphertext = fs::read(&path).map_err(|e| SyncError::Io(e.to_string()))?;
        let plaintext = unprotect(&ciphertext)?;
        Ok(Some(plaintext))
    }

    pub(super) fn delete(vault: &Path, provider: ProviderId) -> Result<(), SyncError> {
        let path = token_path(vault, provider)?;
        let legacy = token_path_legacy(vault, provider)?;
        if path.exists() {
            fs::remove_file(&path).map_err(|e| SyncError::Io(e.to_string()))?;
        }
        if legacy.exists() {
            fs::remove_file(&legacy).map_err(|e| SyncError::Io(e.to_string()))?;
        }
        Ok(())
    }

    /// Wrap `data` with DPAPI in the current user's scope.
    fn protect(data: &[u8]) -> Result<Vec<u8>, SyncError> {
        unsafe {
            let in_blob = CRYPT_INTEGER_BLOB {
                cbData: data.len() as u32,
                pbData: data.as_ptr() as *mut u8,
            };
            let mut out_blob = CRYPT_INTEGER_BLOB {
                cbData: 0,
                pbData: ptr::null_mut(),
            };
            let ok = CryptProtectData(
                &in_blob,
                ptr::null(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                0,
                &mut out_blob,
            );
            if ok == 0 {
                let err = GetLastError();
                return Err(SyncError::Keychain(format!(
                    "CryptProtectData failed (Win32 error {err})"
                )));
            }
            let owned = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize)
                .to_vec();
            LocalFree(out_blob.pbData as HLOCAL);
            Ok(owned)
        }
    }

    /// Reverse of `protect`.
    fn unprotect(data: &[u8]) -> Result<Vec<u8>, SyncError> {
        unsafe {
            let in_blob = CRYPT_INTEGER_BLOB {
                cbData: data.len() as u32,
                pbData: data.as_ptr() as *mut u8,
            };
            let mut out_blob = CRYPT_INTEGER_BLOB {
                cbData: 0,
                pbData: ptr::null_mut(),
            };
            let ok = CryptUnprotectData(
                &in_blob,
                ptr::null_mut(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                0,
                &mut out_blob,
            );
            if ok == 0 {
                let err = GetLastError();
                return Err(SyncError::Keychain(format!(
                    "CryptUnprotectData failed (Win32 error {err}) — the \
                     token file may belong to a different Windows user or \
                     a different machine; deleting and reconnecting will \
                     fix it"
                )));
            }
            let owned = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize)
                .to_vec();
            LocalFree(out_blob.pbData as HLOCAL);
            Ok(owned)
        }
    }
}

// ── macOS / Linux backend: OS keychain ────────────────────────────

#[cfg(not(windows))]
mod nix {
    use super::*;

    #[cfg(debug_assertions)]
    fn debug_token_path(vault: &Path, provider: ProviderId) -> Result<std::path::PathBuf, SyncError> {
        let base = std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .ok_or_else(|| SyncError::Io("$HOME is not set".into()))?;
        let dir = base.join(".lattice").join("byoc-tokens");
        Ok(dir.join(format!(
            "{}-{}.json",
            provider.as_str(),
            vault_hash(vault)?
        )))
    }

    #[cfg(not(debug_assertions))]
    fn entry(vault: &Path, provider: ProviderId) -> Result<keyring::Entry, SyncError> {
        keyring::Entry::new(SERVICE, &account_key(vault, provider)?)
            .map_err(|e| SyncError::Keychain(e.to_string()))
    }

    #[cfg(not(debug_assertions))]
    fn legacy_entry(vault: &Path, provider: ProviderId) -> Result<keyring::Entry, SyncError> {
        let legacy = format!("{}:{}", provider.as_str(), legacy_vault_hash(vault));
        keyring::Entry::new(SERVICE, &legacy).map_err(|e| SyncError::Keychain(e.to_string()))
    }

    pub(super) fn write(
        vault: &Path,
        provider: ProviderId,
        plaintext: &[u8],
    ) -> Result<(), SyncError> {
        #[cfg(debug_assertions)]
        {
            let path = debug_token_path(vault, provider)?;
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&path, plaintext)?;
            Ok(())
        }
        #[cfg(not(debug_assertions))]
        {
            let s = std::str::from_utf8(plaintext)
                .map_err(|e| SyncError::Manifest(e.to_string()))?;
            entry(vault, provider)?
                .set_password(s)
                .map_err(|e| SyncError::Keychain(e.to_string()))
        }
    }

    pub(super) fn read(
        vault: &Path,
        provider: ProviderId,
    ) -> Result<Option<Vec<u8>>, SyncError> {
        #[cfg(debug_assertions)]
        {
            let path = debug_token_path(vault, provider)?;
            match std::fs::read(&path) {
                Ok(bytes) => Ok(Some(bytes)),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(SyncError::Io(e.to_string())),
            }
        }
        #[cfg(not(debug_assertions))]
        {
            let e = entry(vault, provider)?;
            match e.get_password() {
                Ok(blob) => Ok(Some(blob.into_bytes())),
                Err(keyring::Error::NoEntry) => {
                    let le = legacy_entry(vault, provider)?;
                    match le.get_password() {
                        Ok(blob) => Ok(Some(blob.into_bytes())),
                        Err(keyring::Error::NoEntry) => Ok(None),
                        Err(other) => Err(SyncError::Keychain(other.to_string())),
                    }
                }
                Err(other) => Err(SyncError::Keychain(other.to_string())),
            }
        }
    }

    pub(super) fn delete(vault: &Path, provider: ProviderId) -> Result<(), SyncError> {
        #[cfg(debug_assertions)]
        {
            let path = debug_token_path(vault, provider)?;
            match std::fs::remove_file(&path) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(SyncError::Io(e.to_string())),
            }
        }
        #[cfg(not(debug_assertions))]
        {
            let e = entry(vault, provider)?;
            let le = legacy_entry(vault, provider)?;
            match e.delete_credential() {
                Ok(()) => Ok(()),
                Err(keyring::Error::NoEntry) => Ok(()),
                Err(other) => Err(SyncError::Keychain(other.to_string())),
            }
            .and_then(|_| match le.delete_credential() {
                Ok(()) => Ok(()),
                Err(keyring::Error::NoEntry) => Ok(()),
                Err(other) => Err(SyncError::Keychain(other.to_string())),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn vault_hash_is_deterministic() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().to_path_buf();
        assert_eq!(vault_hash(&p).unwrap(), vault_hash(&p).unwrap());
        assert_eq!(vault_hash(&p).unwrap().len(), 16);
    }

    #[test]
    fn vault_hash_differs_per_path() {
        let tmp = tempfile::tempdir().unwrap();
        let p1 = tmp.path().join("a");
        let p2 = tmp.path().join("b");
        std::fs::create_dir(&p1).unwrap();
        std::fs::create_dir(&p2).unwrap();
        assert_ne!(
            vault_hash(&p1).unwrap(),
            vault_hash(&p2).unwrap()
        );
    }

    #[test]
    fn account_key_includes_provider() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().to_path_buf();
        assert!(account_key(&p, ProviderId::Github).unwrap().starts_with("github:"));
        assert!(account_key(&p, ProviderId::Gdrive).unwrap().starts_with("gdrive:"));
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_roundtrip() {
        // Smoke-test DPAPI is wired up correctly.  Uses a temp file so
        // we don't pollute the real %LOCALAPPDATA%.
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("LOCALAPPDATA", tmp.path());
        let vault = tmp.path().join("test-vault");
        std::fs::create_dir(&vault).unwrap();
        let tokens = TokenSet {
            access_token: "secret-token-xyz".into(),
            refresh_token: None,
            expires_at: None,
            scope: "repo".into(),
            token_type: "Bearer".into(),
        };
        store(&vault, ProviderId::Github, &tokens).unwrap();
        let loaded = load(&vault, ProviderId::Github).unwrap().unwrap();
        assert_eq!(loaded.access_token, "secret-token-xyz");
        delete(&vault, ProviderId::Github).unwrap();
        assert!(load(&vault, ProviderId::Github).unwrap().is_none());
    }
}
