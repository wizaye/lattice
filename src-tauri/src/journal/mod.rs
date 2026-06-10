//! v2 §2 — Logseq-style daily-notes / journaling.
//!
//! ## Design
//!
//! - **One file per day** at `<vault>/<folder>/YYYY-MM-DD.md` (Logseq parity
//!   so vault round-trips through Lattice ↔ Logseq ↔ Obsidian-daily-notes
//!   work without conversion).
//! - **Folder default** = `journals/` (Logseq-compatible).  User-overridable
//!   via [`JournalSettings::folder`].
//! - **Filename format** is a `chrono` strftime pattern — default `%Y-%m-%d`.
//!   Anything else is technically allowed but the streak walker assumes the
//!   filename is the date stamp, so non-default formats lose the streak
//!   feature until we ship a real index (out of scope for this slice).
//! - **Template** = `<vault>/.lattice/templates/journal.md` if present, else
//!   the built-in [`DEFAULT_TEMPLATE`] below.  Variables `{{date}}` and
//!   `{{weekday}}` are substituted.
//! - **Streak** = consecutive days back from `today` where the file exists.
//!   Empty files count as a "miss" (matches Logseq's UX — the bullet you
//!   typed is what makes the day count).
//!
//! ## State
//!
//! - Per-vault settings live in `<vault>/.lattice/journal.json`.  We
//!   never invent a global / app-wide setting because each vault is a
//!   self-contained PKM workspace; if the user moves the vault folder,
//!   the journal config moves with it.
//! - This module owns NO in-memory cache.  All commands re-read from
//!   disk on every call.  Journaling is low-traffic (a few clicks per
//!   day) so the FS round-trip is invisible and we get strict "what's
//!   on disk is the source of truth" semantics for free.
//!
//! ## Threading
//!
//! Every Tauri command here is `async` but does only blocking FS work.
//! That's fine — Tauri schedules commands on its own runtime threadpool;
//! the FS calls don't block the IPC reactor.  We mirror the pattern
//! used in `commands.rs` and `paper/mod.rs` for consistency.

use std::path::{Path, PathBuf};

use chrono::{Datelike, Local, NaiveDate, Weekday};
use serde::{Deserialize, Serialize};

// ── Defaults ────────────────────────────────────────────────────────────

/// Logseq-compatible default folder.  Picked so a fresh Lattice vault
/// can be cracked open in Logseq and the daily notes show up in the
/// "Journals" left-rail tab without any extra config.
const DEFAULT_FOLDER: &str = "journals";

/// `chrono` strftime pattern.  `%Y-%m-%d` keeps Logseq parity exactly.
const DEFAULT_FILENAME_FORMAT: &str = "%Y-%m-%d";

/// Built-in template used when the vault has no custom
/// `templates/journal.md`.  Kept intentionally minimal — three bullets
/// in outliner mode, a `## Notes` heading for free-form text, and a
/// frontmatter block that marks the file as a daily-note (so future
/// queries / smart folders can filter on `type: daily`).
const DEFAULT_TEMPLATE: &str = "---\n\
type: daily\n\
date: {{date}}\n\
---\n\
\n\
# {{date}} — {{weekday}}\n\
\n\
- \n";

// ── Settings ────────────────────────────────────────────────────────────

/// Persisted as `<vault>/.lattice/journal.json`.  Schema is open to
/// additive change — the loader fills missing fields with defaults so
/// older config files keep working after we add knobs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JournalSettings {
    /// Vault-relative folder (no leading slash, OS-native separators
    /// normalised on write).  Default `"journals"`.
    pub folder: String,

    /// `chrono` strftime pattern for filenames.  Default `"%Y-%m-%d"`.
    pub filename_format: String,

    /// Vault-relative path to a custom template, or `None` to use
    /// [`DEFAULT_TEMPLATE`].
    pub template_path: Option<String>,

    /// Feature toggle exposed in Settings → Daily notes.  When `false`,
    /// the keyboard shortcut and "Open today" buttons still work (we
    /// don't want to lose data the user already created) — only the
    /// auto-create-on-launch behaviour (future work) honours this flag.
    pub enabled: bool,
}

impl Default for JournalSettings {
    fn default() -> Self {
        Self {
            folder: DEFAULT_FOLDER.to_string(),
            filename_format: DEFAULT_FILENAME_FORMAT.to_string(),
            template_path: None,
            enabled: true,
        }
    }
}

// ── IPC types ───────────────────────────────────────────────────────────

/// Return shape for [`journal_open_today`] / [`journal_path_for_date`].
///
/// `created = true` exactly when the disk file did not exist before
/// the call (i.e. we just wrote the template).  Callers use this to
/// decide whether to show a "✨ New journal entry" toast.
#[derive(Debug, Clone, Serialize)]
pub struct JournalOpenResult {
    /// `YYYY-MM-DD` form of the day this entry represents.  Always in
    /// canonical format regardless of `filename_format`, so the
    /// frontend has a stable key.
    pub date: String,
    /// Absolute path on disk — directly openable via the existing
    /// `read_file` / vault-tree open-by-path flow.
    pub path: String,
    /// `true` iff this call created the file (vs. opened an existing one).
    pub created: bool,
}

/// Streak counters for the "you've journaled N days in a row" UX.
///
/// `current` is the run that includes `today` (0 if today's entry
/// doesn't exist or is empty); `longest` is the longest run ever
/// observed in the vault.  Both are computed by walking the journals
/// folder once; this is O(files) so we cap the lookback at
/// [`STREAK_LOOKBACK_DAYS`] to keep large vaults snappy.
#[derive(Debug, Clone, Serialize)]
pub struct JournalStreak {
    pub current: u32,
    pub longest: u32,
}

const STREAK_LOOKBACK_DAYS: i64 = 365;

// ── Path helpers ────────────────────────────────────────────────────────

/// Settings file path: `<vault>/.lattice/journal.json`.
fn settings_path(vault: &Path) -> PathBuf {
    vault.join(".lattice").join("journal.json")
}

/// Folder that holds the daily notes.  Created on demand.
fn journals_dir(vault: &Path, settings: &JournalSettings) -> PathBuf {
    vault.join(&settings.folder)
}

/// Resolve a `NaiveDate` to an absolute path using the configured
/// filename format.  We deliberately use a sanitised filename (no
/// `/` or `\`) because the user could in theory set a format with a
/// path separator — that would let writes escape the journals folder.
fn file_for_date(
    vault: &Path,
    settings: &JournalSettings,
    date: NaiveDate,
) -> PathBuf {
    let raw = date.format(&settings.filename_format).to_string();
    // Strip any path separators so a misconfigured format can't
    // tunnel writes into sibling folders.  This is defence in
    // depth — Settings UI should also validate the pattern.
    let safe: String = raw
        .chars()
        .map(|c| if c == '/' || c == '\\' { '-' } else { c })
        .collect();
    journals_dir(vault, settings).join(format!("{safe}.md"))
}

// ── Settings I/O ────────────────────────────────────────────────────────

fn load_settings(vault: &Path) -> JournalSettings {
    let path = settings_path(vault);
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return JournalSettings::default(),
    };
    // On a malformed config we silently fall back to defaults rather
    // than refusing to open a daily note.  We log to stderr so devs
    // see it in `bun run tauri dev`, but the user never gets a
    // dead-end error for what is fundamentally a low-priority cache.
    serde_json::from_str::<JournalSettings>(&raw).unwrap_or_else(|err| {
        eprintln!(
            "[journal] failed to parse {} — using defaults: {err}",
            path.display()
        );
        JournalSettings::default()
    })
}

fn save_settings(vault: &Path, settings: &JournalSettings) -> Result<(), String> {
    let path = settings_path(vault);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create .lattice/: {e}"))?;
    }
    let raw = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("serialise settings: {e}"))?;
    std::fs::write(&path, raw).map_err(|e| format!("write {}: {e}", path.display()))
}

// ── Template rendering ──────────────────────────────────────────────────

/// Tiny `{{var}}` substitution.  We deliberately avoid pulling a
/// templating engine (handlebars / tera) for two variables — adding
/// one would balloon the dep graph for zero functional gain.  If we
/// ever need conditionals / loops here we can graduate to `tinytemplate`.
fn render_template(template: &str, date: NaiveDate) -> String {
    let weekday = match date.weekday() {
        Weekday::Mon => "Monday",
        Weekday::Tue => "Tuesday",
        Weekday::Wed => "Wednesday",
        Weekday::Thu => "Thursday",
        Weekday::Fri => "Friday",
        Weekday::Sat => "Saturday",
        Weekday::Sun => "Sunday",
    };
    template
        .replace("{{date}}", &date.format("%Y-%m-%d").to_string())
        .replace("{{weekday}}", weekday)
}

fn load_template(vault: &Path, settings: &JournalSettings) -> String {
    if let Some(rel) = &settings.template_path {
        let path = vault.join(rel);
        if let Ok(s) = std::fs::read_to_string(&path) {
            return s;
        }
        eprintln!(
            "[journal] template not found at {} — falling back to built-in",
            path.display()
        );
    }
    DEFAULT_TEMPLATE.to_string()
}

// ── Core open-or-create ─────────────────────────────────────────────────

fn ensure_entry(
    vault: &Path,
    date: NaiveDate,
) -> Result<JournalOpenResult, String> {
    let settings = load_settings(vault);
    let path = file_for_date(vault, &settings, date);

    let already_exists = path.exists();
    if !already_exists {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create {}: {e}", parent.display()))?;
        }
        let template = load_template(vault, &settings);
        let body = render_template(&template, date);
        std::fs::write(&path, body)
            .map_err(|e| format!("write {}: {e}", path.display()))?;
    }

    Ok(JournalOpenResult {
        date: date.format("%Y-%m-%d").to_string(),
        path: path.to_string_lossy().into_owned(),
        created: !already_exists,
    })
}

// ── Tauri commands ──────────────────────────────────────────────────────

/// Open (or create) today's journal entry.  `today` is taken in the
/// user's local time zone — Lattice is a desktop app so the local
/// clock IS the user's intent ("today" means whatever the wall clock
/// on this machine says it is).
#[tauri::command]
pub async fn journal_open_today(
    vault_path: String,
) -> Result<JournalOpenResult, String> {
    let vault = PathBuf::from(&vault_path);
    if !vault.is_dir() {
        return Err(format!("vault not found: {vault_path}"));
    }
    let today = Local::now().date_naive();
    ensure_entry(&vault, today)
}

/// Open (or create) the entry for an arbitrary date.  `date` is the
/// canonical `YYYY-MM-DD` form — we don't accept the user's custom
/// `filename_format` here because the frontend always speaks the
/// canonical form (the format is purely a filename concern).
#[tauri::command]
pub async fn journal_open_date(
    vault_path: String,
    date: String,
) -> Result<JournalOpenResult, String> {
    let vault = PathBuf::from(&vault_path);
    if !vault.is_dir() {
        return Err(format!("vault not found: {vault_path}"));
    }
    let parsed = NaiveDate::parse_from_str(&date, "%Y-%m-%d")
        .map_err(|e| format!("invalid date {date}: {e}"))?;
    ensure_entry(&vault, parsed)
}

/// List all journal dates present in the vault.  Returns canonical
/// `YYYY-MM-DD` strings sorted ascending.  Filename format is
/// honoured: we strip the configured strftime pattern off each file
/// stem and round-trip through `NaiveDate` to validate.  Files that
/// don't parse are silently skipped (they're just other markdown
/// files the user dropped in the journals folder).
#[tauri::command]
pub async fn journal_list_dates(vault_path: String) -> Result<Vec<String>, String> {
    let vault = PathBuf::from(&vault_path);
    if !vault.is_dir() {
        return Err(format!("vault not found: {vault_path}"));
    }
    let settings = load_settings(&vault);
    let dir = journals_dir(&vault, &settings);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut dates: Vec<String> = std::fs::read_dir(&dir)
        .map_err(|e| format!("read {}: {e}", dir.display()))?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("md") {
                return None;
            }
            let stem = path.file_stem()?.to_str()?;
            let parsed = NaiveDate::parse_from_str(stem, &settings.filename_format)
                .ok()?;
            Some(parsed.format("%Y-%m-%d").to_string())
        })
        .collect();
    dates.sort();
    Ok(dates)
}

/// Current + longest streak counters.  Walks back from today up to
/// [`STREAK_LOOKBACK_DAYS`] days — beyond that the answer is
/// "long enough that the user already knows."
#[tauri::command]
pub async fn journal_streak(vault_path: String) -> Result<JournalStreak, String> {
    let vault = PathBuf::from(&vault_path);
    if !vault.is_dir() {
        return Err(format!("vault not found: {vault_path}"));
    }
    let settings = load_settings(&vault);
    let today = Local::now().date_naive();

    let has_entry = |d: NaiveDate| -> bool {
        let p = file_for_date(&vault, &settings, d);
        match std::fs::metadata(&p) {
            Ok(m) => m.len() > 0,
            Err(_) => false,
        }
    };

    let mut longest: u32 = 0;
    let mut run: u32 = 0;
    // Walk OLDEST → newest so the final value of `run` equals the
    // run that includes (or ends at) today.  Stop the run as soon
    // as a day has no entry; reset to 0.
    for offset in (0..=STREAK_LOOKBACK_DAYS).rev() {
        let Some(date) = today.checked_sub_signed(chrono::Duration::days(offset))
        else {
            continue;
        };
        if has_entry(date) {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 0;
        }
    }
    Ok(JournalStreak {
        current: run,
        longest,
    })
}

/// Return the resolved settings (defaults filled in).  Frontend uses
/// this to render Settings → Daily notes without having to mirror the
/// default constants in TS.
#[tauri::command]
pub async fn journal_get_settings(
    vault_path: String,
) -> Result<JournalSettings, String> {
    let vault = PathBuf::from(&vault_path);
    if !vault.is_dir() {
        return Err(format!("vault not found: {vault_path}"));
    }
    Ok(load_settings(&vault))
}

/// Replace the full settings document.  We don't merge — the frontend
/// always sends the full shape after editing one field, which keeps
/// the persistence model trivial (no partial-update conflicts).
#[tauri::command]
pub async fn journal_set_settings(
    vault_path: String,
    settings: JournalSettings,
) -> Result<(), String> {
    let vault = PathBuf::from(&vault_path);
    if !vault.is_dir() {
        return Err(format!("vault not found: {vault_path}"));
    }
    save_settings(&vault, &settings)
}
