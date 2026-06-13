//! Importer module — Strategy + Factory patterns.
//!
//! # SOLID Design
//!
//! ## Open / Closed Principle
//! New importers are added by implementing `ImportStrategy` and
//! registering them in `ImporterFactory::default()`.  No existing code
//! needs to change.
//!
//! ## Single Responsibility
//! Each `ImportStrategy` implementation owns exactly ONE import format.
//! Shared helpers (`TempDirGuard`, `convert_logseq_block_refs`, etc.)
//! live in `helpers.rs` so they don't pollute the strategy files.
//!
//! ## Dependency Inversion
//! The Tauri IPC layer (`importers.rs` commands) receives a
//! `&dyn ImportStrategy` from the factory rather than instantiating
//! concrete types.

pub mod helpers;
pub mod obsidian;
pub mod logseq;
pub mod notion;

use std::path::Path;
use serde::{Deserialize, Serialize};

// ── DTO ──────────────────────────────────────────────────────────────────

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportStats {
    pub files_imported: usize,
    pub attachments_imported: usize,
    pub links_converted: usize,
    pub plugins_migrated: usize,
    pub databases_converted: usize,
    pub graph_config_migrated: bool,
}

// ── Strategy trait ───────────────────────────────────────────────────────

/// A single import strategy for one external PKM format.
///
/// **OCP**: Add new formats by implementing this trait; never modify
/// existing strategies.
pub trait ImportStrategy: Send + Sync {
    /// Human-readable name used in error messages and UI.
    fn format_name(&self) -> &'static str;

    /// Perform the import from `source` into `target_vault`.
    ///
    /// `source` semantics depend on the format:
    /// - Obsidian / Logseq: a directory path
    /// - Notion: a `.zip` file path
    fn import(&self, source: &Path, target_vault: &Path) -> Result<ImportStats, String>;

    /// Validate that `source` looks like a valid source for this
    /// format before attempting the import.  Returns an error with a
    /// user-friendly message if the source is invalid.
    fn validate_source(&self, source: &Path) -> Result<(), String>;
}

// ── Factory ──────────────────────────────────────────────────────────────

/// Registry of all available import strategies.
///
/// **OCP + DIP**: callers depend on `&dyn ImportStrategy`, not on
/// concrete types.  `ImporterFactory` is the single place where
/// concrete types are named.
pub struct ImporterFactory {
    strategies: std::collections::HashMap<&'static str, Box<dyn ImportStrategy>>,
}

impl ImporterFactory {
    /// Build the registry with all built-in strategies.
    pub fn with_all_strategies() -> Self {
        let mut strategies: std::collections::HashMap<&'static str, Box<dyn ImportStrategy>> =
            std::collections::HashMap::new();
        strategies.insert("obsidian", Box::new(obsidian::ObsidianImporter));
        strategies.insert("logseq", Box::new(logseq::LogseqImporter));
        strategies.insert("notion", Box::new(notion::NotionImporter));
        Self { strategies }
    }

    /// Look up a strategy by its format key.  Returns `None` for
    /// unrecognised keys — the caller decides how to surface the error.
    pub fn get(&self, format: &str) -> Option<&dyn ImportStrategy> {
        self.strategies.get(format).map(|b| b.as_ref())
    }

    /// List all registered format keys.
    pub fn available_formats(&self) -> Vec<&'static str> {
        let mut keys: Vec<&'static str> = self.strategies.keys().copied().collect();
        keys.sort_unstable();
        keys
    }
}

impl Default for ImporterFactory {
    fn default() -> Self {
        Self::with_all_strategies()
    }
}
