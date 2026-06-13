//! Vault file filter for the publish pipeline.
//!
//! Wraps `globset` so the publish build step can answer "should this
//! file be copied into `quartz/content/`?" in O(files × patterns) with
//! prefix optimisation.  Patterns are evaluated relative to the vault
//! root and follow the same shape as `.gitignore` glob syntax (without
//! the negation / re-include rules — keep it simple).
//!
//! The filter always rejects three things on top of the user list:
//! - the `.lattice/` config + cache directory (our own state, never
//!   publishable),
//! - the `.git/` directory (VCS noise),
//! - anything not ending in `.md` (Quartz only consumes markdown for
//!   the content/ tree — assets land in a follow-up phase).
//!
//! This module is intentionally tiny and pure — no I/O, no globals —
//! so it's easy to unit-test the matching rules in isolation from the
//! filesystem walker that drives it.

use std::path::Path;

use globset::{Glob, GlobSet, GlobSetBuilder};

/// Compiled exclude rules for a single vault.  Build once, query
/// many.  Constructing the matcher fails iff a pattern is malformed
/// (e.g. unclosed `[abc`); the error string is suitable for direct
/// surfacing to the UI.
#[derive(Debug)]
pub struct VaultFilter {
    excludes: GlobSet,
}

impl VaultFilter {
    /// Compile the user's exclude patterns from `publish.toml`.
    ///
    /// Patterns are evaluated against the **forward-slash** form of
    /// the path relative to the vault root — globset's matcher is
    /// path-separator agnostic but our pattern syntax (`drafts/**`)
    /// assumes `/`.  We always inject `.lattice/**`, `.git/**`,
    /// `**/.DS_Store`, and `**/Thumbs.db` as a baseline so a user can
    /// never accidentally publish their own config or VCS metadata.
    pub fn from_patterns(patterns: &[String]) -> Result<Self, String> {
        let mut b = GlobSetBuilder::new();
        // Always-on baseline — duplicates with the user list are fine.
        for baseline in [
            ".lattice/**",
            ".git/**",
            "**/.DS_Store",
            "**/Thumbs.db",
        ] {
            b.add(Glob::new(baseline).map_err(|e| format!("baseline glob {baseline}: {e}"))?);
        }
        for p in patterns {
            let g = Glob::new(p).map_err(|e| format!("exclude pattern `{p}`: {e}"))?;
            b.add(g);
        }
        let excludes = b.build().map_err(|e| format!("globset build: {e}"))?;
        Ok(VaultFilter { excludes })
    }

    /// True if `rel` (a vault-relative path) is allowed through.  Only
    /// markdown files pass — Quartz's `content/` directory is markdown-only
    /// in our D3 pipeline.  Asset copy lands in a follow-up phase.
    pub fn should_include(&self, rel: &Path) -> bool {
        // Markdown gate first — cheap.
        let ext_ok = rel
            .extension()
            .and_then(|s| s.to_str())
            .map(|e| e.eq_ignore_ascii_case("md"))
            .unwrap_or(false);
        if !ext_ok {
            return false;
        }
        // Normalise to forward-slashes so `**` against the matcher
        // behaves the same on Windows + POSIX.
        let key = rel.to_string_lossy().replace('\\', "/");
        !self.excludes.is_match(&key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn matcher(patterns: &[&str]) -> VaultFilter {
        VaultFilter::from_patterns(&patterns.iter().map(|s| s.to_string()).collect::<Vec<_>>())
            .expect("compile")
    }

    #[test]
    fn includes_top_level_markdown() {
        let m = matcher(&[]);
        assert!(m.should_include(&PathBuf::from("README.md")));
        assert!(m.should_include(&PathBuf::from("notes/garden/idea.md")));
    }

    #[test]
    fn excludes_non_markdown() {
        let m = matcher(&[]);
        assert!(!m.should_include(&PathBuf::from("image.png")));
        assert!(!m.should_include(&PathBuf::from("paper/data.csv")));
    }

    #[test]
    fn baseline_excludes_lattice_dir_even_when_user_list_empty() {
        let m = matcher(&[]);
        assert!(!m.should_include(&PathBuf::from(".lattice/publish.toml")));
        assert!(!m.should_include(&PathBuf::from(".lattice/publish/quartz/content/foo.md")));
        assert!(!m.should_include(&PathBuf::from(".git/HEAD")));
    }

    #[test]
    fn honours_user_drafts_pattern() {
        let m = matcher(&["drafts/**"]);
        assert!(!m.should_include(&PathBuf::from("drafts/wip.md")));
        assert!(!m.should_include(&PathBuf::from("drafts/sub/wip.md")));
        assert!(m.should_include(&PathBuf::from("posts/final.md")));
    }

    #[test]
    fn honours_user_private_extension_pattern() {
        let m = matcher(&["**/*.private.md"]);
        assert!(!m.should_include(&PathBuf::from("posts/secret.private.md")));
        assert!(m.should_include(&PathBuf::from("posts/public.md")));
    }

    #[test]
    fn windows_backslash_paths_normalise() {
        let m = matcher(&["drafts/**"]);
        // Simulate a path the walker on Windows might hand us.
        assert!(!m.should_include(&PathBuf::from("drafts\\wip.md")));
    }

    #[test]
    fn bad_pattern_surfaces_friendly_error() {
        let err = VaultFilter::from_patterns(&["[unclosed".to_string()]).unwrap_err();
        assert!(err.contains("[unclosed"), "expected pattern in error: {err}");
    }
}
