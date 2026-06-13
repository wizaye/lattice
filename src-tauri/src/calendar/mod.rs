//! v2 §1 — Calendar (unified internal model).
//!
//! ## Scope of THIS slice
//!
//! This module ships the **storage spine** and the **local provider**
//! end-to-end:
//!
//! - One Rust [`CalEvent`] type (matches the v2 spec exactly so the
//!   provider adapters can drop in later without a UI rewrite).
//! - Local events persisted in a small custom datastore under
//!   `<vault>/.lattice/calendar/` (snapshot + append-only op log).
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
//! - Provider-specific ETag / deltaLink sync loops for cloud adapters.
//!
//! The shape of [`CalEvent`] and the provider-prefixed `id` convention
//! (`local:<uuid>`, `ms:<id>`, `google:<id>`, `calcom:<id>`,
//! `apple:<id>`) are spec-stable today so backend slices can land
//! without UI churn.

mod providers;
pub mod graph_client;
pub mod calcom_client;
pub mod google_client;

use std::path::{Path, PathBuf};

use chrono::{DateTime, Datelike, Local, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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

fn calendar_store_path(vault: &Path) -> PathBuf {
    calendar_dir(vault).join("store-v1.json")
}

fn calendar_log_path(vault: &Path) -> PathBuf {
    calendar_dir(vault).join("events.log")
}

fn calendar_sync_state_path(vault: &Path) -> PathBuf {
    calendar_dir(vault).join("sync-state.json")
}

fn legacy_local_events_path(vault: &Path) -> PathBuf {
    calendar_dir(vault).join("local-events.json")
}

// ── Persistence ─────────────────────────────────────────────────────────

/// Legacy JSON shape used by older builds.
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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CalendarSnapshot {
    #[serde(default = "default_version")]
    version: u32,
    #[serde(default)]
    events: Vec<CalEvent>,
}

impl Default for CalendarSnapshot {
    fn default() -> Self {
        Self {
            version: 1,
            events: Vec::new(),
        }
    }
}

/// Sync state for each calendar provider.
/// Stores delta tokens / ETags for incremental sync.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderSyncState {
    /// Provider source
    pub source: CalSource,
    /// Last sync timestamp (UTC)
    pub last_sync: Option<DateTime<Utc>>,
    /// Delta token for incremental sync (Microsoft Graph deltaLink)
    pub delta_token: Option<String>,
    /// Next link for paginated results
    pub next_link: Option<String>,
    /// ETag for the entire calendar collection (if supported)
    pub collection_etag: Option<String>,
}

/// Sync state document persisted to disk
#[derive(Debug, Clone, Serialize, Deserialize)]
struct SyncStateDocument {
    #[serde(default = "default_version")]
    version: u32,
    /// Map of provider ID -> sync state
    #[serde(default)]
    providers: HashMap<String, ProviderSyncState>,
}

impl Default for SyncStateDocument {
    fn default() -> Self {
        Self {
            version: 1,
            providers: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum CalendarOp {
    Upsert { event: CalEvent },
    Delete { id: String },
}

fn ensure_calendar_dir(vault: &Path) -> Result<(), String> {
    let dir = calendar_dir(vault);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("create {}: {e}", dir.display()))
}

fn read_snapshot(vault: &Path) -> Result<CalendarSnapshot, String> {
    let path = calendar_store_path(vault);
    if !path.is_file() {
        return Ok(CalendarSnapshot::default());
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    serde_json::from_str::<CalendarSnapshot>(&raw)
        .map_err(|e| format!("parse {}: {e}", path.display()))
}

fn write_snapshot(vault: &Path, snapshot: &CalendarSnapshot) -> Result<(), String> {
    let path = calendar_store_path(vault);
    let tmp = path.with_extension("tmp");
    let raw = serde_json::to_string_pretty(snapshot)
        .map_err(|e| format!("serialise calendar snapshot: {e}"))?;
    std::fs::write(&tmp, raw)
        .map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path)
        .map_err(|e| format!("replace {}: {e}", path.display()))
}

fn read_ops(vault: &Path) -> Result<Vec<CalendarOp>, String> {
    let path = calendar_log_path(vault);
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    let mut ops = Vec::new();
    for (idx, line) in raw.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let op = serde_json::from_str::<CalendarOp>(trimmed)
            .map_err(|e| format!("parse {} line {}: {e}", path.display(), idx + 1))?;
        ops.push(op);
    }
    Ok(ops)
}

fn append_op(vault: &Path, op: &CalendarOp) -> Result<(), String> {
    use std::io::Write;
    let path = calendar_log_path(vault);
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open {} for append: {e}", path.display()))?;
    let line = serde_json::to_string(op)
        .map_err(|e| format!("serialise calendar op: {e}"))?;
    file.write_all(line.as_bytes())
        .map_err(|e| format!("append {}: {e}", path.display()))?;
    file.write_all(b"\n")
        .map_err(|e| format!("append newline to {}: {e}", path.display()))?;
    Ok(())
}

fn apply_op(events: &mut Vec<CalEvent>, op: CalendarOp) {
    match op {
        CalendarOp::Upsert { event } => {
            if let Some(slot) = events.iter_mut().find(|e| e.id == event.id) {
                *slot = event;
            } else {
                events.push(event);
            }
        }
        CalendarOp::Delete { id } => {
            events.retain(|e| e.id != id);
        }
    }
}

fn compact_if_needed(vault: &Path, events: &[CalEvent]) -> Result<(), String> {
    const LOG_COMPACT_THRESHOLD_BYTES: u64 = 256 * 1024;
    let log = calendar_log_path(vault);
    let size = std::fs::metadata(&log).map(|m| m.len()).unwrap_or(0);
    if size < LOG_COMPACT_THRESHOLD_BYTES {
        return Ok(());
    }
    write_snapshot(
        vault,
        &CalendarSnapshot {
            version: 1,
            events: events.to_vec(),
        },
    )?;
    std::fs::write(&log, "")
        .map_err(|e| format!("truncate {}: {e}", log.display()))
}

fn load_events(vault: &Path) -> Result<Vec<CalEvent>, String> {
    ensure_calendar_dir(vault)?;
    let snapshot_path = calendar_store_path(vault);
    let mut snapshot = read_snapshot(vault)?;

    if !snapshot_path.is_file() {
        let legacy_path = legacy_local_events_path(vault);
        if legacy_path.is_file() {
            let raw = std::fs::read_to_string(&legacy_path)
                .map_err(|e| format!("read {}: {e}", legacy_path.display()))?;
            let legacy = serde_json::from_str::<LocalStore>(&raw)
                .map_err(|e| format!("parse {}: {e}", legacy_path.display()))?;
            snapshot.events = legacy.events;
            write_snapshot(vault, &snapshot)?;
        }
    }

    let ops = read_ops(vault)?;
    for op in ops {
        apply_op(&mut snapshot.events, op);
    }
    snapshot
        .events
        .sort_by(|a, b| a.start.cmp(&b.start));
    Ok(snapshot.events)
}

fn save_events(vault: &Path, events: &[CalEvent]) -> Result<(), String> {
    ensure_calendar_dir(vault)?;
    write_snapshot(
        vault,
        &CalendarSnapshot {
            version: 1,
            events: events.to_vec(),
        },
    )
}

fn create_event(vault: &Path, event: CalEvent) -> Result<(), String> {
    let mut events = load_events(vault)?;
    apply_op(&mut events, CalendarOp::Upsert { event: event.clone() });
    append_op(vault, &CalendarOp::Upsert { event })?;
    compact_if_needed(vault, &events)
}

fn update_event(vault: &Path, event: CalEvent) -> Result<(), String> {
    let mut events = load_events(vault)?;
    if !events.iter().any(|e| e.id == event.id && e.source == CalSource::Local) {
        return Err(format!("event {} not found", event.id));
    }
    apply_op(&mut events, CalendarOp::Upsert { event: event.clone() });
    append_op(vault, &CalendarOp::Upsert { event })?;
    compact_if_needed(vault, &events)
}

fn delete_event(vault: &Path, id: &str) -> Result<(), String> {
    let mut events = load_events(vault)?;
    apply_op(&mut events, CalendarOp::Delete { id: id.to_string() });
    append_op(vault, &CalendarOp::Delete { id: id.to_string() })?;
    compact_if_needed(vault, &events)
}

fn migrate_legacy_json_if_needed(vault: &Path) -> Result<(), String> {
    ensure_calendar_dir(vault)?;
    let snapshot_path = calendar_store_path(vault);
    if snapshot_path.is_file() {
        return Ok(());
    }
    let legacy_path = legacy_local_events_path(vault);
    if legacy_path.is_file() {
        let raw = std::fs::read_to_string(&legacy_path)
            .map_err(|e| format!("read {}: {e}", legacy_path.display()))?;
        let store = serde_json::from_str::<LocalStore>(&raw)
            .map_err(|e| format!("parse {}: {e}", legacy_path.display()))?;
        return save_events(vault, &store.events);
    }
    save_events(vault, &[])
}

// ── Sync state management ───────────────────────────────────────────────

/// Read sync state from disk
fn read_sync_state(vault: &Path) -> Result<SyncStateDocument, String> {
    let path = calendar_sync_state_path(vault);
    if !path.is_file() {
        return Ok(SyncStateDocument::default());
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    serde_json::from_str::<SyncStateDocument>(&raw)
        .map_err(|e| format!("parse {}: {e}", path.display()))
}

/// Write sync state to disk
fn write_sync_state(vault: &Path, state: &SyncStateDocument) -> Result<(), String> {
    ensure_calendar_dir(vault)?;
    let path = calendar_sync_state_path(vault);
    let tmp = path.with_extension("tmp");
    let raw = serde_json::to_string_pretty(state)
        .map_err(|e| format!("serialise sync state: {e}"))?;
    std::fs::write(&tmp, raw)
        .map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path)
        .map_err(|e| format!("replace {}: {e}", path.display()))
}

/// Update sync state for a provider
fn update_sync_state(
    vault: &Path,
    source: CalSource,
    delta_token: Option<String>,
    next_link: Option<String>,
    collection_etag: Option<String>,
) -> Result<(), String> {
    let mut state = read_sync_state(vault)?;
    let provider_key = source.id_prefix().to_string();
    
    state.providers.insert(
        provider_key,
        ProviderSyncState {
            source,
            last_sync: Some(Utc::now()),
            delta_token,
            next_link,
            collection_etag,
        },
    );
    
    write_sync_state(vault, &state)
}

/// Get sync state for a provider
fn get_sync_state(vault: &Path, source: CalSource) -> Result<Option<ProviderSyncState>, String> {
    let state = read_sync_state(vault)?;
    let provider_key = source.id_prefix().to_string();
    Ok(state.providers.get(&provider_key).cloned())
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
    migrate_legacy_json_if_needed(&vault)?;
    let events: Vec<CalEvent> = load_events(&vault)?
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
    migrate_legacy_json_if_needed(&vault)?;
    create_event(&vault, stamped.clone())?;
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
    migrate_legacy_json_if_needed(&vault)?;
    update_event(&vault, event.clone())?;
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
    migrate_legacy_json_if_needed(&vault)?;
    delete_event(&vault, &id)?;
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
            status: "Events live in .lattice/calendar/store-v1.json + events.log".into(),
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

/// Get the sync state for a calendar provider.
/// Returns the delta token, next link, and last sync time if available.
/// This is used by provider adapters to enable incremental sync.
#[tauri::command]
pub async fn cal_get_sync_state(
    vault_path: String,
    source: CalSource,
) -> Result<Option<ProviderSyncState>, String> {
    let vault = PathBuf::from(&vault_path);
    if !vault.is_dir() {
        return Err(format!("vault not found: {vault_path}"));
    }
    get_sync_state(&vault, source)
}

/// Update the sync state for a calendar provider.
/// Called by provider adapters after a successful sync to store the
/// delta token / next link for incremental refresh.
#[tauri::command]
pub async fn cal_update_sync_state(
    vault_path: String,
    source: CalSource,
    delta_token: Option<String>,
    next_link: Option<String>,
    collection_etag: Option<String>,
) -> Result<(), String> {
    let vault = PathBuf::from(&vault_path);
    if !vault.is_dir() {
        return Err(format!("vault not found: {vault_path}"));
    }
    update_sync_state(&vault, source, delta_token, next_link, collection_etag)
}

