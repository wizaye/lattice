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
  paperListTemplates,
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
      const row = fromStatus(status);
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

  forgetPaper(paper) {
    set((s) => {
      if (!(paper in s.rows)) return s;
      const { [paper]: _, ...rest } = s.rows;
      return { rows: rest };
    });
  },
}));
