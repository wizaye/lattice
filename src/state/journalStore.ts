/**
 * v2 §2 — Journal store.
 *
 * Holds the per-vault journal metadata that drives the "Today" card
 * in the calendar panel and the streak badge in the sidebar.  Kept
 * intentionally thin — the journal entries themselves are markdown
 * files on disk, opened through the existing tab/editor pipeline; we
 * don't mirror their contents here.
 *
 * ## Lifecycle
 *
 * - Cleared (`reset`) whenever the user switches vaults.  App.tsx
 *   calls `reset()` from its vault-open handler.
 * - `refresh(vaultPath)` is cheap (one IPC each for streak + settings)
 *   so we just re-run it on every calendar panel mount instead of
 *   trying to invalidate surgically.
 */

import { create } from "zustand";

import {
  journalGetSettings,
  journalOpenToday,
  journalStreak,
  type JournalOpenResult,
  type JournalSettings,
  type JournalStreak,
} from "../lib/journalApi";

interface JournalState {
  /** Loaded settings (or `null` before first refresh). */
  settings: JournalSettings | null;
  /** Loaded streak (or `null` before first refresh). */
  streak: JournalStreak | null;
  /** `true` while either an IPC is in flight. */
  loading: boolean;
  /** Last IPC error (sticky until next successful refresh). */
  error: string | null;

  // ── Actions ──
  /**
   * Re-pull settings + streak from disk.  Safe to call repeatedly;
   * sets `loading` for the duration of the parallel IPC pair.
   */
  refresh: (vaultPath: string) => Promise<void>;
  /**
   * Open (or create) today's entry and refresh the streak afterwards.
   * Returns the open-result so the caller can route it to
   * `onOpenFileByPath` for tab opening.
   */
  openToday: (vaultPath: string) => Promise<JournalOpenResult>;
  /** Clear all state — call on vault switch. */
  reset: () => void;
}

export const useJournalStore = create<JournalState>((set, get) => ({
  settings: null,
  streak: null,
  loading: false,
  error: null,

  refresh: async (vaultPath: string) => {
    set({ loading: true, error: null });
    try {
      // Parallel — these don't depend on each other and the user is
      // typically waiting on whichever finishes second.
      const [settings, streak] = await Promise.all([
        journalGetSettings(vaultPath),
        journalStreak(vaultPath),
      ]);
      set({ settings, streak, loading: false });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : String(err),
        loading: false,
      });
    }
  },

  openToday: async (vaultPath: string) => {
    const result = await journalOpenToday(vaultPath);
    // Refresh the streak so the "🔥 N days" badge ticks up immediately
    // after creating today's entry.  Fire-and-forget — the open-result
    // we return is what the caller is actually waiting on.
    void get().refresh(vaultPath);
    return result;
  },

  reset: () =>
    set({ settings: null, streak: null, loading: false, error: null }),
}));
