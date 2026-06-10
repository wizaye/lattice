//! v2 §1 — Calendar (unified internal model).
//!
//! ## Scope of THIS slice
//!
//! This module ships the **storage spine** and the **local provider**
//! end-to-end:
//!
//! - One Rust [`CalEvent`] type (matches the v2 spec exactly so the
//!   provider adapters can drop in later without a UI rewrite).
//! - Local events persisted as JSON at
//!   `<vault>/.lattice/calendar/local-events.json` (one document, tiny
//!   files — a real SQLite cache lands when the network providers do).
//! - Full CRUD: list / create / update / delete.
//! - `cal_list_providers` returns a manifest of *all four* tiers
//!   (Outlook A, Cal.com B, Google C, Apple C) plus Local — with
//!   `connected: false` for the network providers so the Settings →
//!   Calendar UI can already render the "Connect" buttons.
//!
//! ## Out of scope (deliberately — next slices)
//!
//! - **MSAL / Graph API** for Outlook + Teams + Copilot insights.
//!   Auth flow + `graph_client.rs` land in calendar slice B.
//! - **Cal.com v2 API key / OAuth** read-write flow — slice B.
//! - **Google Calendar incremental sync** (`syncToken` + PKCE) — slice C.
//! - **Apple EventKit sidecar (macOS) + minicaldav (Win/Linux)** — slice C.
//! - **SQLite cache** at `.lattice/calendar.db` with ETags / deltaLinks —
//!   lands when the first network provider lands (the JSON store here
//!   is fast enough for the local-only world but won't scale to a few
//!   thousand Graph events; the migration is straight-up `json → rows`).
//!
//! The shape of [`CalEvent`] and the provider-prefixed `id` convention
//! (`local:<uuid>`, `ms:<id>`, `google:<id>`, `calcom:<id>`,
//! `apple:<id>`) are spec-stable today so backend slices can land
//! without UI churn.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Datelike, Local, Utc};
use serde::{Deserialize, Serialize};

// ── Source enum ─────────────────────────────────────────────────────────

/// Origin of a calendar event.  Mirrors the v2 spec table in §1.2-§1.4.
///
/// Serialised as lowercase strings (`"outlook"`, `"google"`, …) so the
/// TS side can use a string-literal union without runtime mapping.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CalSource {
    /// Tier A — Outlook (M365) via MS Graph.
    Outlook,
    /// Tier B — Cal.com (developer / OSS).
    CalCom,
    /// Tier C — Google Calendar via OAuth + REST.
    Google,
    /// Tier C — Apple Calendar (EventKit on macOS, CalDAV elsewhere).
    Apple,
    /// User-created events that live only in this vault.  Today this
    /// is the only fully-implemented source.
    Local,
}

impl CalSource {
    fn id_prefix(self) -> &'static str {
        match self {
            CalSource::Outlook => "ms",
            CalSource::CalCom => "calcom",
            CalSource::Google => "google",
            CalSource::Apple => "apple",
            CalSource::Local => "local",
        }
    }
}

// ── Event ───────────────────────────────────────────────────────────────

/// The unified calendar event used by the UI and every provider.
///
/// All times are stored as `DateTime<Utc>` so cross-tz vault sharing
/// is unambiguous; the UI renders in local time on read.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalEvent {
    /// `<source>:<provider-id>` — globally unique within a vault.  For
    /// `local` events we generate a v4-style UUID from `rand` + time.
    pub id: String,
    pub source: CalSource,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub title: String,
    /// Optional markdown body — surfaced in the event detail pane.
    /// We never auto-render this in the grid (titles only) to keep
    /// the calendar legible at-a-glance.
    pub body_md: Option<String>,
    /// Email addresses or display names; the UI doesn't currently
    /// distinguish.  Outlook adapter will normalise to email-only.
    pub attendees: Vec<String>,
    /// `https://teams.microsoft.com/l/meetup-join/...` or
    /// `https://meet.google.com/...` — clicking opens via
    /// `tauri_plugin_opener` (system browser).
    pub meeting_url: Option<String>,
    /// Populated only for Outlook events that have Teams join info
    /// (so the AI-insights / transcript fetcher knows the meeting id
    /// without re-querying `/me/onlineMeetings`).
    pub teams_meeting_id: Option<String>,
    /// Backlink to the vault-relative note file that represents this
    /// event (created on demand by the "Open note" action).  Stored
    /// vault-relative so vault relocations don't break the link.
    pub note_path: Option<String>,
    /// Provider ETag / version stamp — used by future incremental
    /// sync to detect remote-side changes without redownloading.
    pub etag: Option<String>,
}

/// Subset of [`CalEvent`] the frontend posts to create a new event.
/// We omit `id` / `source` / `etag` — the backend always stamps those
/// for local events.
#[derive(Debug, Clone, Deserialize)]
pub struct CalEventInput {
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub title: String,
    #[serde(default)]
    pub body_md: Option<String>,
    #[serde(default)]
    pub attendees: Vec<String>,
    #[serde(default)]
    pub meeting_url: Option<String>,
    #[serde(default)]
    pub note_path: Option<String>,
}

// ── Provider manifest ───────────────────────────────────────────────────

/// What we hand back from [`cal_list_providers`].  Each entry maps 1:1
/// to a Settings → Calendar row in the UI.
///
/// `connected` is `false` for every non-Local provider in this slice;
/// the UI uses that to render a "Connect" CTA instead of "Disconnect".
#[derive(Debug, Clone, Serialize)]
pub struct CalProvider {
    pub id: CalSource,
    pub label: &'static str,
    /// Tier letter from the v2 spec (`"A"` / `"B"` / `"C"`) or
    /// `"Local"`.  Frontend groups providers by tier in the Settings
    /// UI so users see "Enterprise (Tier A)" / "Developer (Tier B)" /
    /// "Everyone (Tier C)" sections.
    pub tier: &'static str,
    pub connected: bool,
    /// Human-readable status string the row sub-title shows.  Today
    /// this is hard-coded ("Outlook + Teams via Microsoft Graph
    /// (coming soon)" etc) — when the providers land it becomes
    /// "Connected as alice@contoso.com" / token-expiry, etc.
    pub status: String,
}

// ── Path helpers ────────────────────────────────────────────────────────

fn calendar_dir(vault: &Path) -> PathBuf {
    vault.join(".lattice").join("calendar")
}

fn local_events_path(vault: &Path) -> PathBuf {
    calendar_dir(vault).join("local-events.json")
}

// ── Persistence ─────────────────────────────────────────────────────────

/// The on-disk shape for `local-events.json`.  We wrap the events
/// array in a `{ "version": 1, "events": [...] }` envelope so future
/// schema migrations are trivial (today we read `version` and migrate
/// on the way in; on first write we always stamp the latest version).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct LocalStore {
    #[serde(default = "default_version")]
    version: u32,
    #[serde(default)]
    events: Vec<CalEvent>,
}

fn default_version() -> u32 {
    1
}

impl Default for LocalStore {
    fn default() -> Self {
        Self {
            version: 1,
            events: Vec::new(),
        }
    }
}

fn load_local_store(vault: &Path) -> LocalStore {
    let path = local_events_path(vault);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return LocalStore::default();
    };
    serde_json::from_str::<LocalStore>(&raw).unwrap_or_else(|err| {
        eprintln!(
            "[calendar] failed to parse {} — starting fresh: {err}",
            path.display()
        );
        LocalStore::default()
    })
}

fn save_local_store(vault: &Path, store: &LocalStore) -> Result<(), String> {
    let dir = calendar_dir(vault);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("create {}: {e}", dir.display()))?;
    let raw = serde_json::to_string_pretty(store)
        .map_err(|e| format!("serialise calendar store: {e}"))?;
    let path = local_events_path(vault);
    std::fs::write(&path, raw).map_err(|e| format!("write {}: {e}", path.display()))
}

// ── ID generation ───────────────────────────────────────────────────────

/// Generate a `local:<random>` event id.  We don't pull `uuid` for
/// this — the `rand` crate is already a dep and a 128-bit hex string
/// is just as collision-resistant as a UUIDv4 for our purposes (a
/// single user's local events in a single vault).
fn fresh_local_id() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut buf);
    let hex: String = buf.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}:{hex}", CalSource::Local.id_prefix())
}

// ── Tauri commands ──────────────────────────────────────────────────────

/// List events in the optional `[from, to)` UTC window.  When both
/// bounds are omitted we return everything.  Today we only have
/// local-source events; future provider adapters merge their slices
/// into the returned vector via the same `[from, to)` filter.
///
/// Sorted ascending by `start` so the UI never needs to re-sort.
#[tauri::command]
pub async fn cal_list_events(
    vault_path: String,
    from: Option<DateTime<Utc>>,
    to: Option<DateTime<Utc>>,
) -> Result<Vec<CalEvent>, String> {
    let vault = PathBuf::from(&vault_path);
    if !vault.is_dir() {
        return Err(format!("vault not found: {vault_path}"));
    }
    let store = load_local_store(&vault);
    let mut events: Vec<CalEvent> = store
        .events
        .into_iter()
        .filter(|e| {
            if let Some(lo) = from {
                if e.end <= lo {
                    return false;
                }
            }
            if let Some(hi) = to {
                if e.start >= hi {
                    return false;
                }
            }
            true
        })
        .collect();
    events.sort_by(|a, b| a.start.cmp(&b.start));
    Ok(events)
}

/// Create a new local event.  We validate `start < end` to keep the
/// grid renderer's assumptions intact (zero-length spans break some
/// week-view layouts).  Returns the stamped event so the UI gets the
/// generated `id` back in one round-trip.
#[tauri::command]
pub async fn cal_create_event(
    vault_path: String,
    event: CalEventInput,
) -> Result<CalEvent, String> {
    let vault = PathBuf::from(&vault_path);
    if !vault.is_dir() {
        return Err(format!("vault not found: {vault_path}"));
    }
    if event.start >= event.end {
        return Err("event start must be before end".into());
    }
    let mut store = load_local_store(&vault);
    let stamped = CalEvent {
        id: fresh_local_id(),
        source: CalSource::Local,
        start: event.start,
        end: event.end,
        title: event.title,
        body_md: event.body_md,
        attendees: event.attendees,
        meeting_url: event.meeting_url,
        teams_meeting_id: None,
        note_path: event.note_path,
        etag: None,
    };
    store.events.push(stamped.clone());
    save_local_store(&vault, &store)?;
    Ok(stamped)
}

/// Replace an existing local event in place.  Returns `Err` if the
/// id is not found or is not a local event (provider events are
/// read-only in this slice — the network adapters will own writes
/// to their own backends).
#[tauri::command]
pub async fn cal_update_event(
    vault_path: String,
    event: CalEvent,
) -> Result<CalEvent, String> {
    let vault = PathBuf::from(&vault_path);
    if !vault.is_dir() {
        return Err(format!("vault not found: {vault_path}"));
    }
    if event.source != CalSource::Local {
        return Err("only local events are editable in this slice".into());
    }
    if event.start >= event.end {
        return Err("event start must be before end".into());
    }
    let mut store = load_local_store(&vault);
    let Some(slot) = store.events.iter_mut().find(|e| e.id == event.id) else {
        return Err(format!("event {} not found", event.id));
    };
    *slot = event.clone();
    save_local_store(&vault, &store)?;
    Ok(event)
}

/// Delete a local event by id.  Idempotent — deleting a missing id
/// is a no-op (no error) so the UI doesn't need to special-case
/// "already gone" races from double-clicks.
#[tauri::command]
pub async fn cal_delete_event(
    vault_path: String,
    id: String,
) -> Result<(), String> {
    let vault = PathBuf::from(&vault_path);
    if !vault.is_dir() {
        return Err(format!("vault not found: {vault_path}"));
    }
    if !id.starts_with("local:") {
        return Err("only local events are deletable in this slice".into());
    }
    let mut store = load_local_store(&vault);
    let before = store.events.len();
    store.events.retain(|e| e.id != id);
    if store.events.len() != before {
        save_local_store(&vault, &store)?;
    }
    Ok(())
}

/// Static provider manifest.  Today every network provider reports
/// `connected: false` with a "coming soon" status string — when each
/// provider's auth flow lands, it replaces its row's status with the
/// real connection info (account, token expiry, etc.).
///
/// We always include Local first so the UI's default-selected
/// provider when creating an event is the one that actually works.
#[tauri::command]
pub async fn cal_list_providers(
    _vault_path: String,
) -> Result<Vec<CalProvider>, String> {
    Ok(vec![
        CalProvider {
            id: CalSource::Local,
            label: "Local (this vault)",
            tier: "Local",
            connected: true,
            status: "Events live in .lattice/calendar/local-events.json".into(),
        },
        CalProvider {
            id: CalSource::Outlook,
            label: "Outlook + Teams",
            tier: "A",
            connected: false,
            status: "Microsoft Graph (MSAL) integration ships in the next slice"
                .into(),
        },
        CalProvider {
            id: CalSource::CalCom,
            label: "Cal.com",
            tier: "B",
            connected: false,
            status: "API-key auth ships in the next slice".into(),
        },
        CalProvider {
            id: CalSource::Google,
            label: "Google Calendar",
            tier: "C",
            connected: false,
            status: "OAuth + PKCE integration ships in the next slice".into(),
        },
        CalProvider {
            id: CalSource::Apple,
            label: "Apple Calendar",
            tier: "C",
            connected: false,
            status:
                "EventKit (macOS) / CalDAV (Win+Linux) integration ships in the next slice"
                    .into(),
        },
    ])
}

/// Today (in local time) as canonical `YYYY-MM-DD`.  The frontend has
/// `new Date().toISOString().slice(0,10)` but that returns *UTC*
/// today, which silently drifts to "tomorrow" for users east of UTC
/// after 16:00 local.  Expose the backend's local-date computation so
/// the calendar grid and journal share one source of truth.
#[tauri::command]
pub async fn cal_today_local() -> Result<String, String> {
    let today = Local::now().date_naive();
    Ok(format!(
        "{:04}-{:02}-{:02}",
        today.year(),
        today.month(),
        today.day()
    ))
}
