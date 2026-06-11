/**
 * v2 §1 — Calendar IPC wrappers.
 *
 * Typed wrappers around the `cal_*` Tauri commands in
 * `src-tauri/src/calendar/mod.rs`.  Today this surface backs only the
 * Local provider; the same `CalEvent` shape is what the Outlook /
 * Cal.com / Google / Apple adapters will return when they land in the
 * next slice (so no UI / store changes needed when they do).
 */

import { invoke } from "@tauri-apps/api/core";

// ── Types ──

/**
 * Origin of an event.  Serialised as lowercase strings on the wire to
 * match the Rust `#[serde(rename_all = "lowercase")]` on `CalSource`.
 *
 * `"local"` is the only fully-implemented source today; the others
 * appear in `cal_list_providers` output with `connected: false`.
 */
export type CalSource = "outlook" | "calcom" | "google" | "apple" | "local";

/**
 * The unified event model used by every grid / list view.  Times are
 * ISO-8601 UTC strings (Rust `DateTime<Utc>` serialises as RFC3339);
 * the UI renders in local time on read.  IDs are `<source>:<id>` —
 * the prefix lets us route updates back to the correct provider
 * without an extra type tag.
 */
export interface CalEvent {
  id: string;
  source: CalSource;
  start: string;
  end: string;
  title: string;
  body_md: string | null;
  attendees: string[];
  meeting_url: string | null;
  teams_meeting_id: string | null;
  /** Vault-relative path to a linked note, or `null`. */
  note_path: string | null;
  /** Provider ETag — currently always `null` for local events. */
  etag: string | null;
}

/** Shape posted by the create-event dialog. */
export interface CalEventInput {
  start: string;
  end: string;
  title: string;
  body_md?: string | null;
  attendees?: string[];
  meeting_url?: string | null;
  note_path?: string | null;
}

/** One row in Settings → Calendar.  Backed by the static manifest. */
export interface CalProvider {
  id: CalSource;
  label: string;
  /** `"A"` / `"B"` / `"C"` / `"Local"` — UI groups providers by tier. */
  tier: string;
  connected: boolean;
  /** Human-readable sub-title (account, "coming soon", etc.). */
  status: string;
}

/** Sync state for a calendar provider, used for incremental sync. */
export interface ProviderSyncState {
  source: CalSource;
  /** Last sync timestamp (ISO-8601 UTC), or `null`. */
  last_sync: string | null;
  /** Delta token for Microsoft Graph deltaLink, or `null`. */
  delta_token: string | null;
  /** Next link for paginated results, or `null`. */
  next_link: string | null;
  /** ETag for the entire calendar collection, or `null`. */
  collection_etag: string | null;
}

// ── Commands ──

/**
 * List events overlapping the optional `[from, to)` UTC window.  Pass
 * `null` for either bound to make it open-ended.  Returned events are
 * sorted ascending by `start` so the grid can render in a single pass.
 */
export async function calListEvents(
  vaultPath: string,
  from: string | null,
  to: string | null,
): Promise<CalEvent[]> {
  return invoke<CalEvent[]>("cal_list_events", { vaultPath, from, to });
}

/** Create a local event.  Returns the stamped event (id + source set). */
export async function calCreateEvent(
  vaultPath: string,
  event: CalEventInput,
): Promise<CalEvent> {
  return invoke<CalEvent>("cal_create_event", { vaultPath, event });
}

/**
 * Update an existing local event in place.  Network-sourced events
 * are read-only in this slice; the backend rejects them with an
 * explicit error string.
 */
export async function calUpdateEvent(
  vaultPath: string,
  event: CalEvent,
): Promise<CalEvent> {
  return invoke<CalEvent>("cal_update_event", { vaultPath, event });
}

/** Delete a local event by id.  No-op (no error) if id is missing. */
export async function calDeleteEvent(
  vaultPath: string,
  id: string,
): Promise<void> {
  return invoke<void>("cal_delete_event", { vaultPath, id });
}

/**
 * Static provider manifest — drives the Settings → Calendar rows and
 * the "+ New event" source picker.  Today every non-Local row has
 * `connected: false`.
 */
export async function calListProviders(
  vaultPath: string,
): Promise<CalProvider[]> {
  return invoke<CalProvider[]>("cal_list_providers", { vaultPath });
}

/**
 * Today, in the machine's local time zone, as `YYYY-MM-DD`.  Exposed
 * from the backend so the calendar grid and the journal share one
 * source of truth (avoids UTC-vs-local drift after 16:00 local for
 * east-of-UTC users).
 */
export async function calTodayLocal(): Promise<string> {
  return invoke<string>("cal_today_local");
}

/**
 * Get the sync state for a calendar provider.
 * Returns `null` if the provider has never synced.
 * Used by provider adapters to enable incremental sync via delta tokens.
 */
export async function calGetSyncState(
  vaultPath: string,
  source: CalSource,
): Promise<ProviderSyncState | null> {
  return invoke<ProviderSyncState | null>("cal_get_sync_state", {
    vaultPath,
    source,
  });
}

/**
 * Update the sync state for a calendar provider after a successful sync.
 * Stores the delta token, next link, and current timestamp for
 * incremental refresh on the next sync.
 */
export async function calUpdateSyncState(
  vaultPath: string,
  source: CalSource,
  delta_token: string | null,
  next_link: string | null,
  collection_etag: string | null,
): Promise<void> {
  return invoke<void>("cal_update_sync_state", {
    vaultPath,
    source,
    delta_token,
    next_link,
    collection_etag,
  });
}

