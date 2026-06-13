use std::path::{Path, PathBuf};
use crate::error::{Result, VaultError};

/// Safe path joining with symlink-safe validation
/// Prevents directory traversal attacks by ensuring resolved path stays within root
pub fn safe_join(root: &Path, rel: &str) -> Result<PathBuf> {
    // 1. Reject any ".." components
    if rel.contains("..") {
        return Err(VaultError::PathTraversal(format!(
            "Path contains '..': {}",
            rel
        )));
    }

    // 2. Build the joined path
    let joined = root.join(rel);

    // 3. For existing paths, canonicalize and verify it's within root
    if joined.exists() {
        let canonical_joined = joined
            .canonicalize()
            .map_err(|e| VaultError::Io(e))?;
        
        let canonical_root = root
            .canonicalize()
            .map_err(|e| VaultError::Io(e))?;

        if !canonical_joined.starts_with(&canonical_root) {
            return Err(VaultError::PathTraversal(format!(
                "Resolved path escapes vault root: {}",
                rel
            )));
        }

        Ok(canonical_joined)
    } else {
        // For non-existing paths (create-file case), validate parent exists and is safe
        if let Some(parent) = joined.parent() {
            if parent.exists() {
                let canonical_parent = parent
                    .canonicalize()
                    .map_err(|e| VaultError::Io(e))?;
                
                let canonical_root = root
                    .canonicalize()
                    .map_err(|e| VaultError::Io(e))?;

                if !canonical_parent.starts_with(&canonical_root) {
                    return Err(VaultError::PathTraversal(format!(
                        "Parent path escapes vault root: {}",
                        rel
                    )));
                }
            }
        }
        
        Ok(joined)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_safe_join_normal_path() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        
        let result = safe_join(root, "notes/test.md");
        assert!(result.is_ok());
    }

    #[test]
    fn test_safe_join_rejects_dotdot() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        
        let result = safe_join(root, "../etc/passwd");
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), VaultError::PathTraversal(_)));
    }

    #[test]
    fn test_safe_join_rejects_hidden_dotdot() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        
        let result = safe_join(root, "notes/../../etc/passwd");
        assert!(result.is_err());
    }
}
