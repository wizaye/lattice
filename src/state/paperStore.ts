/**
 * Slice C — paper export.  Frontend store.
 *
 * Owns the cached per-paper `PaperStatus` + transient compile
 * progress + sticky errors.  Components (`PaperToolbar`,
 * `NewPaperModal`, `PaperPreflightCard`) subscribe to this store;
 * the actual scaffold / compile / bundle work runs in Rust via
 * the `paper_*` IPC.
 *
 * Design notes (mirrors `byocStore` deliberately):
 *   - One state map keyed by absolute paper-folder path.
 *   - Mock vault rejected up-front; same `isRealVault` sentinel.
 *   - `pendingCompile` field reserved for the C1-compile phase's
 *     `paper://progress` event stream — we wire the listener in
 *     here once the event channel exists, exactly like
 *     `pendingDeviceCode` does in `byocStore`.
 *   - Errors are scoped per paper; one paper's bad compile must
 *     never blank another paper's success chip.
 *
 * Phase C1 ships **two real actions** (`refreshTemplates` +
 * `createPaper` + `refreshStatus`).  The rest are stubs that
 * surface the Rust-side "phase X" error string into the per-paper
 * `lastError` field so the UI can render it cleanly.
 */
import { create } from "zustand";

import {
  paperCompile,
  paperCreate,
  paperEmitBundle,
  paperListTemplates,
  paperOpenOverleaf,
  paperSetCompileEngine,
  paperStatus,
  type EngineKind,
  type NewPaperRequest,
  type NewPaperResult,
  type PaperStatus,
  type TemplateInfo,
} from "../lib/paper";

/** Per-paper row state — the unit of UI rendering. */
export interface PaperRowState {
  /** True once `paper.toml` exists on disk. */
  exists: boolean;
  title: string | null;
  engine: EngineKind | null;
  templateId: string | null;
  /** ISO-8601 UTC of the last successful compile.  Null until C1-compile lands. */
  lastCompiledAt: string | null;
  lastPdfPath: string | null;
  /**
   * Absolute path of the most-recent Overleaf-ready zip on disk
   * (`<paper>/build/<slug>-overleaf.zip`).  Null until the user
   * runs Export-zip or Send-to-Overleaf at least once.
   */
  lastBundlePath: string | null;
  /** Sticky error from the last failed action; null after a clean op. */
  lastError: string | null;
  /** True while a compile / preflight / bundle is in flight. */
  busy: boolean;
}

const EMPTY_ROW: PaperRowState = {
  exists: false,
  title: null,
  engine: null,
  templateId: null,
  lastCompiledAt: null,
  lastPdfPath: null,
  lastBundlePath: null,
  lastError: null,
  busy: false,
};

const MOCK_VAULT = "__mock__";
const isRealVault = (v: string | null | undefined): v is string =>
  typeof v === "string" && v.length > 0 && v !== MOCK_VAULT;

interface PaperStore {
  /** Cached built-in + BYOF templates.  Populated lazily by `refreshTemplates`. */
  templates: TemplateInfo[];
  /** Cached per-paper status, keyed by absolute paper folder path. */
  rows: Record<string, PaperRowState>;

  // ── Reads ─────────────────────────────────────────────────────────────
  rowFor(paper: string): PaperRowState;
  refreshTemplates(vault: string | null): Promise<TemplateInfo[]>;
  refreshStatus(paper: string): Promise<PaperRowState>;

  // ── Writes ────────────────────────────────────────────────────────────
  createPaper(req: NewPaperRequest): Promise<NewPaperResult>;
  setEngine(paper: string, engine: EngineKind): Promise<void>;

  // ── Stubs (errors out from Rust until phase X lands) ──────────────────
  /**
   * Kick off a paper compile.  **Phase C1 (compile half) — currently
   * surfaces the Rust-side "not yet implemented" string into
   * `lastError`.**  Wired up so the toolbar button can call it; the
   * action becomes real when `paper_compile` lands.
   */
  compile(paper: string): Promise<void>;

  /**
   * Build an Overleaf-ready zip at `<paper>/build/<slug>-overleaf.zip`
   * and stash the path in `lastBundlePath`.  Returns the zip path on
   * success, throws on failure (also surfaced into `lastError`).
   */
  emitBundle(paper: string): Promise<string>;

  /**
   * Build (or re-build) the Overleaf zip AND shell out to the OS to
   * (1) open https://www.overleaf.com/project in the default browser,
   * (2) reveal the zip in the OS file manager so the user can drag
   * it into Overleaf's upload dialog.  No-throws (errors land in
   * `lastError`).
   */
  openOverleaf(paper: string): Promise<void>;

  // ── Lifecycle ─────────────────────────────────────────────────────────
  /** Drop the cached row for a paper (e.g. when the user deletes it). */
  forgetPaper(paper: string): void;
}

const fromStatus = (s: PaperStatus): PaperRowState => ({
  exists: s.exists,
  title: s.title,
  engine: s.engine,
  templateId: s.templateId,
  lastCompiledAt: s.lastCompiledAt,
  lastPdfPath: s.lastPdfPath,
  lastBundlePath: null,
  lastError: s.lastError,
  busy: false,
});

export const usePaperStore = create<PaperStore>((set, get) => ({
  templates: [],
  rows: {},

  rowFor(paper) {
    return get().rows[paper] ?? EMPTY_ROW;
  },

  async refreshTemplates(vault) {
    try {
      const list = await paperListTemplates(vault);
      set({ templates: list });
      return list;
    } catch (e) {
      console.warn("paperListTemplates failed:", e);
      return get().templates;
    }
  },

  async refreshStatus(paper) {
    if (!paper) return EMPTY_ROW;
    try {
      const status = await paperStatus(paper);
      const next = fromStatus(status);
      // Preserve the client-only `lastBundlePath` across a status
      // refresh — the Rust `PaperStatus` doesn't know about it
      // (the zip lives in build/ which Rust treats as a cache, not
      // canonical state) and we don't want a `setEngine` call to
      // wipe the toolbar's "Reveal zip" affordance.
      const prev = get().rows[paper];
      const row: PaperRowState = {
        ...next,
        lastBundlePath: prev?.lastBundlePath ?? null,
      };
      set((s) => ({ rows: { ...s.rows, [paper]: row } }));
      return row;
    } catch (e) {
      const row: PaperRowState = {
        ...EMPTY_ROW,
        lastError: e instanceof Error ? e.message : String(e),
      };
      set((s) => ({ rows: { ...s.rows, [paper]: row } }));
      return row;
    }
  },

  async createPaper(req) {
    if (!isRealVault(req.vault)) {
      throw new Error("Cannot create a paper in the mock vault.");
    }
    const result = await paperCreate(req);
    // Pre-warm the status row so the UI doesn't show the empty card
    // for a single frame after the modal closes.
    await get().refreshStatus(result.paperAbsPath);
    return result;
  },

  async setEngine(paper, engine) {
    if (!paper) throw new Error("paper path is required");
    set((s) => {
      const cur = s.rows[paper] ?? EMPTY_ROW;
      return { rows: { ...s.rows, [paper]: { ...cur, busy: true, lastError: null } } };
    });
    try {
      await paperSetCompileEngine(paper, engine);
      await get().refreshStatus(paper);
    } catch (e) {
      set((s) => {
        const cur = s.rows[paper] ?? EMPTY_ROW;
        return {
          rows: {
            ...s.rows,
            [paper]: {
              ...cur,
              busy: false,
              lastError: e instanceof Error ? e.message : String(e),
            },
          },
        };
      });
      throw e;
    }
  },

  async compile(paper) {
    if (!isRealVault(paper)) {
      throw new Error("paper path is required");
    }
    set((s) => {
      const cur = s.rows[paper] ?? EMPTY_ROW;
      return { rows: { ...s.rows, [paper]: { ...cur, busy: true, lastError: null } } };
    });
    try {
      const pdfPath = await paperCompile(paper);
      set((s) => {
        const cur = s.rows[paper] ?? EMPTY_ROW;
        return {
          rows: {
            ...s.rows,
            [paper]: { ...cur, busy: false, lastPdfPath: pdfPath, lastError: null },
          },
        };
      });
    } catch (e) {
      set((s) => {
        const cur = s.rows[paper] ?? EMPTY_ROW;
        return {
          rows: {
            ...s.rows,
            [paper]: {
              ...cur,
              busy: false,
              lastError: e instanceof Error ? e.message : String(e),
            },
          },
        };
      });
    }
  },

  async emitBundle(paper) {
    if (!isRealVault(paper)) {
      throw new Error("paper path is required");
    }
    set((s) => {
      const cur = s.rows[paper] ?? EMPTY_ROW;
      return { rows: { ...s.rows, [paper]: { ...cur, busy: true, lastError: null } } };
    });
    try {
      const zipPath = await paperEmitBundle(paper);
      set((s) => {
        const cur = s.rows[paper] ?? EMPTY_ROW;
        return {
          rows: {
            ...s.rows,
            [paper]: { ...cur, busy: false, lastBundlePath: zipPath, lastError: null },
          },
        };
      });
      return zipPath;
    } catch (e) {
      set((s) => {
        const cur = s.rows[paper] ?? EMPTY_ROW;
        return {
          rows: {
            ...s.rows,
            [paper]: {
              ...cur,
              busy: false,
              lastError: e instanceof Error ? e.message : String(e),
            },
          },
        };
      });
      throw e;
    }
  },

  async openOverleaf(paper) {
    if (!isRealVault(paper)) {
      throw new Error("paper path is required");
    }
    set((s) => {
      const cur = s.rows[paper] ?? EMPTY_ROW;
      return { rows: { ...s.rows, [paper]: { ...cur, busy: true, lastError: null } } };
    });
    try {
      // Step 1 — re-emit the zip so the user always uploads the
      // freshest sources (cheap, ~tens of ms on a typical paper).
      const zipPath = await paperOpenOverleaf(paper);
      // Step 2 — shell out to the OS:
      //   (a) open https://www.overleaf.com/project in the browser,
      //   (b) reveal the zip in the file manager so the user can
      //       drag it into Overleaf's "Upload Project" dropzone.
      // Dynamic import keeps the opener plugin off the cold-start
      // bundle for users who never touch the paper toolbar.
      try {
        const opener = await import("@tauri-apps/plugin-opener");
        await opener.openUrl("https://www.overleaf.com/project");
        await opener.revealItemInDir(zipPath);
      } catch (openErr) {
        // Non-fatal — the zip is still on disk; surface as warning.
        console.warn("openOverleaf: shell-out failed:", openErr);
      }
      set((s) => {
        const cur = s.rows[paper] ?? EMPTY_ROW;
        return {
          rows: {
            ...s.rows,
            [paper]: { ...cur, busy: false, lastBundlePath: zipPath, lastError: null },
          },
        };
      });
    } catch (e) {
      set((s) => {
        const cur = s.rows[paper] ?? EMPTY_ROW;
        return {
          rows: {
            ...s.rows,
            [paper]: {
              ...cur,
              busy: false,
              lastError: e instanceof Error ? e.message : String(e),
            },
          },
        };
      });
    }
  },

  forgetPaper(paper) {
    set((s) => {
      if (!(paper in s.rows)) return s;
      const { [paper]: _, ...rest } = s.rows;
      return { rows: rest };
    });
  },
}));
