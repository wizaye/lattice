/**
 * v2 §2 — Journaling IPC wrappers.
 *
 * Thin typed wrappers around the `journal_*` Tauri commands defined in
 * `src-tauri/src/journal/mod.rs`.  Co-located in their own file (vs
 * appended to `tauriApi.ts`) because journaling is a self-contained
 * feature surface — keeping the IPC contract in one file makes the
 * "what does the journal feature do" answer obvious from the imports.
 *
 * Naming convention: camelCase TS function ↔ snake_case Rust command.
 * The two-way invoke layer in `@tauri-apps/api/core` does not transform
 * argument keys, so we pass `vaultPath` / `vault_path` exactly as the
 * Rust handler declares them.
 */

import { invoke } from "@tauri-apps/api/core";

// ── Types (must stay bit-compatible with Rust serde derives) ──

export interface JournalSettings {
  /** Vault-relative folder for daily notes.  Default `"journals"`. */
  folder: string;
  /** `chrono` strftime pattern.  Default `"%Y-%m-%d"`. */
  filename_format: string;
  /**
   * Vault-relative path to a custom template file, or `null` to use
   * the built-in template baked into the Rust module.
   */
  template_path: string | null;
  /**
   * Feature toggle for the Settings UI.  When `false`, manual
   * commands (Ctrl+Shift+D, "Open today" button) still work — only
   * future auto-create-on-launch behaviour will skip.
   */
  enabled: boolean;
  /** Auto-create weekly rollup files like `2026-W23.md`. */
  weekly_rollup: boolean;
  /** Auto-create monthly rollup files like `2026-06.md`. */
  monthly_rollup: boolean;
}

export interface JournalOpenResult {
  /** Canonical `YYYY-MM-DD` form (independent of `filename_format`). */
  date: string;
  /** Absolute path on disk — directly openable via the vault tree. */
  path: string;
  /** `true` iff this call created the file (vs. opened an existing one). */
  created: boolean;
}

export interface JournalStreak {
  /** Days in a row ending at (or including) today.  0 if today is empty. */
  current: number;
  /** Longest run ever observed in the vault (within 1y lookback). */
  longest: number;
}

// ── Commands ──

/**
 * Open (or create) today's daily-note entry.  Today is taken from the
 * machine's local clock — the desktop app intentionally has no notion
 * of a server-side "today" (this is a desktop PKM, not a SaaS app).
 */
export async function journalOpenToday(
  vaultPath: string,
): Promise<JournalOpenResult> {
  return invoke<JournalOpenResult>("journal_open_today", { vaultPath });
}

/**
 * Open (or create) the entry for an arbitrary date.  `date` MUST be
 * the canonical `YYYY-MM-DD` form — the user's `filename_format` is a
 * pure storage detail and is not exposed at this API boundary.
 */
export async function journalOpenDate(
  vaultPath: string,
  date: string,
): Promise<JournalOpenResult> {
  return invoke<JournalOpenResult>("journal_open_date", { vaultPath, date });
}

/**
 * List all journal entries present in the vault as canonical date
 * strings, sorted ascending.  Files that don't parse against the
 * configured `filename_format` are silently dropped (the journals
 * folder is allowed to contain non-daily-note markdown too).
 */
export async function journalListDates(vaultPath: string): Promise<string[]> {
  return invoke<string[]>("journal_list_dates", { vaultPath });
}

/** Current + longest streak counters for the "🔥 N days" UX. */
export async function journalStreak(vaultPath: string): Promise<JournalStreak> {
  return invoke<JournalStreak>("journal_streak", { vaultPath });
}

/** Read the per-vault journal settings (defaults filled in). */
export async function journalGetSettings(
  vaultPath: string,
): Promise<JournalSettings> {
  return invoke<JournalSettings>("journal_get_settings", { vaultPath });
}

/**
 * Replace the per-vault settings.  The backend does NOT merge — always
 * send the full shape after editing one field (frontend already holds
 * the whole document in memory while the Settings sheet is open).
 */
export async function journalSetSettings(
  vaultPath: string,
  settings: JournalSettings,
): Promise<void> {
  return invoke<void>("journal_set_settings", { vaultPath, settings });
}
