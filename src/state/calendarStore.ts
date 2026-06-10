/**
 * v2 §1 — Calendar store.
 *
 * Holds the events list, the provider manifest, and the user's
 * current viewport (selected day + view mode).  All times in this
 * store are kept in their wire-form ISO-8601 UTC strings; the panel
 * component converts to local `Date` objects at render time.
 *
 * ## View / window contract
 *
 * - The component owns "where am I looking" (`selectedDate` +
 *   `viewMode`) but `refreshEvents` is parametrised on a `[from, to]`
 *   window so the store doesn't need to know about month/week math.
 * - That keeps the store dumb (it's a cache, not a calendar engine)
 *   and lets the panel decide how aggressively to pre-fetch around
 *   the visible window.
 */

import { create } from "zustand";

import {
  calCreateEvent,
  calDeleteEvent,
  calListEvents,
  calListProviders,
  calUpdateEvent,
  type CalEvent,
  type CalEventInput,
  type CalProvider,
} from "../lib/calendarApi";

/** Granularity of the calendar grid. */
export type CalViewMode = "day" | "week" | "month";

interface CalendarState {
  /** Events currently in the cache (cover the last fetched window). */
  events: CalEvent[];
  /** Provider manifest (rendered in Settings → Calendar + "New event"). */
  providers: CalProvider[];
  /**
   * Anchor date for the current view as `YYYY-MM-DD`.  The panel
   * derives "is this event in the visible window" from this + the
   * view mode.
   */
  selectedDate: string;
  /** Current grid granularity. */
  viewMode: CalViewMode;
  /** `true` while a list/create/update/delete IPC is in flight. */
  loading: boolean;
  /** Last IPC error (sticky until the next successful call). */
  error: string | null;

  // ── Actions ──
  setSelectedDate: (iso: string) => void;
  setViewMode: (mode: CalViewMode) => void;
  /** Replace `events` with the result of a `[from, to)` query. */
  refreshEvents: (
    vaultPath: string,
    fromIso: string | null,
    toIso: string | null,
  ) => Promise<void>;
  /** Refresh the provider manifest (cheap — runs once on panel mount). */
  refreshProviders: (vaultPath: string) => Promise<void>;
  /**
   * Create a local event and merge it into the in-memory cache so the
   * UI updates without waiting for a full refresh.
   */
  createEvent: (vaultPath: string, input: CalEventInput) => Promise<CalEvent>;
  /** Update a local event in place; mirrors the change into `events`. */
  updateEvent: (vaultPath: string, event: CalEvent) => Promise<CalEvent>;
  /** Delete a local event by id; removes from `events` on success. */
  deleteEvent: (vaultPath: string, id: string) => Promise<void>;
  /** Clear state — call on vault switch. */
  reset: () => void;
}

/** Today in the user's local zone, as `YYYY-MM-DD`. */
function todayLocalIso(): string {
  const now = new Date();
  // Build a local-zone date string by hand (NOT toISOString — that's UTC).
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export const useCalendarStore = create<CalendarState>((set) => ({
  events: [],
  providers: [],
  selectedDate: todayLocalIso(),
  viewMode: "week",
  loading: false,
  error: null,

  setSelectedDate: (iso) => set({ selectedDate: iso }),
  setViewMode: (mode) => set({ viewMode: mode }),

  refreshEvents: async (vaultPath, fromIso, toIso) => {
    set({ loading: true, error: null });
    try {
      const events = await calListEvents(vaultPath, fromIso, toIso);
      set({ events, loading: false });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : String(err),
        loading: false,
      });
    }
  },

  refreshProviders: async (vaultPath) => {
    try {
      const providers = await calListProviders(vaultPath);
      set({ providers });
    } catch (err) {
      // Provider failures are non-fatal — Local always works and the
      // UI degrades gracefully without the manifest (just no
      // "Connect" rows in Settings).
      console.error("[calendar] refreshProviders failed:", err);
    }
  },

  createEvent: async (vaultPath, input) => {
    const created = await calCreateEvent(vaultPath, input);
    set((s) => ({
      events: [...s.events, created].sort((a, b) =>
        a.start.localeCompare(b.start),
      ),
    }));
    return created;
  },

  updateEvent: async (vaultPath, event) => {
    const updated = await calUpdateEvent(vaultPath, event);
    set((s) => ({
      events: s.events
        .map((e) => (e.id === updated.id ? updated : e))
        .sort((a, b) => a.start.localeCompare(b.start)),
    }));
    return updated;
  },

  deleteEvent: async (vaultPath, id) => {
    await calDeleteEvent(vaultPath, id);
    set((s) => ({ events: s.events.filter((e) => e.id !== id) }));
  },

  reset: () =>
    set({
      events: [],
      providers: [],
      selectedDate: todayLocalIso(),
      viewMode: "week",
      loading: false,
      error: null,
    }),
}));

// Re-export to keep "things calendar-y" importable from one place.
export type { CalEvent, CalEventInput, CalProvider } from "../lib/calendarApi";
