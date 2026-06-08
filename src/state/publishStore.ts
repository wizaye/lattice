/**
 * Slice D — publishing.  Frontend store.
 *
 * Owns the cached per-vault `PublishStatus` + the static host /
 * template registries + the latest Node-probe result.  Components
 * (`PublishWizard`, `PublishPanel`, `PublishStatusPill`,
 * `PublishPreviewBanner`) subscribe here; the actual scaffold /
 * auth / build / deploy work runs in Rust via the `publish_*` IPC.
 *
 * Design notes (mirrors `byocStore` + `paperStore` deliberately):
 *   - One state map keyed by absolute vault path.
 *   - Static registries (`hosts`, `templates`, `probe`) cached once;
 *     the wizard hydrates them on mount via `refreshRegistries()`.
 *   - Mock vault rejected at every action that takes a vault.
 *   - `pendingPreviewUrl` reserved for the D4 preview flow; same
 *     shape as `byocStore.pendingDeviceCode`.
 *
 * Phase D1 ships the same four real reads/refreshes as the wrapper
 * layer.  Everything else surfaces the Rust-side "phase X" error
 * string into the per-vault `lastError` field so the UI can render
 * it cleanly.
 */
import { create } from "zustand";

import {
  publishBuild,
  publishDeploy,
  publishListHosts,
  publishListTemplates,
  publishPreview,
  publishPreviewStop,
  publishProbe,
  publishStatus,
  type HostId,
  type HostInfo,
  type ProbeReport,
  type PublishStatus,
  type PublishTemplateInfo,
} from "../lib/publish";

/** Per-vault row state — the unit of UI rendering. */
export interface PublishRowState {
  /** True once `publish.toml` exists for this vault. */
  exists: boolean;
  hostId: HostId | null;
  hostSlug: string | null;
  templateId: string | null;
  liveUrl: string | null;
  lastDeployAt: string | null;
  lastBuildAt: string | null;
  lastDeployFiles: number | null;
  lastDeployBytes: number | null;
  /** Sticky error from the last failed action; null after a clean op. */
  lastError: string | null;
  /** True while a build / preview / deploy is in flight. */
  busy: boolean;
  /** Live preview URL while a preview server is running; null otherwise. */
  previewUrl: string | null;
}

const EMPTY_ROW: PublishRowState = {
  exists: false,
  hostId: null,
  hostSlug: null,
  templateId: null,
  liveUrl: null,
  lastDeployAt: null,
  lastBuildAt: null,
  lastDeployFiles: null,
  lastDeployBytes: null,
  lastError: null,
  busy: false,
  previewUrl: null,
};

const MOCK_VAULT = "__mock__";
const isRealVault = (v: string | null | undefined): v is string =>
  typeof v === "string" && v.length > 0 && v !== MOCK_VAULT;

interface PublishStore {
  /** Cached host registry — populated lazily on first `refreshRegistries`. */
  hosts: HostInfo[];
  /** Cached Quartz template registry — same hydration policy as `hosts`. */
  templates: PublishTemplateInfo[];
  /**
   * Latest Node-probe result.  Null until the wizard runs
   * `refreshProbe()`.  Stored once for the whole app — the probe is
   * env-wide, not per-vault.
   */
  probe: ProbeReport | null;
  /** Cached per-vault status, keyed by absolute vault path. */
  rows: Record<string, PublishRowState>;

  // ── Reads ─────────────────────────────────────────────────────────────
  rowFor(vault: string): PublishRowState;
  /** Hydrate hosts + templates.  Called once by the wizard on mount. */
  refreshRegistries(): Promise<{ hosts: HostInfo[]; templates: PublishTemplateInfo[] }>;
  /** Run the Node / npm / npx probe; cache the report. */
  refreshProbe(): Promise<ProbeReport>;
  /** Refresh the per-vault status row. */
  refreshStatus(vault: string): Promise<PublishRowState>;

  // ── Stubs (Rust errors surfaced into `lastError`) ─────────────────────
  /** **Phase D3 — currently surfaces "not yet implemented" into `lastError`.** */
  build(vault: string): Promise<void>;
  /** **Phase D4 — currently surfaces "not yet implemented" into `lastError`.** */
  preview(vault: string): Promise<void>;
  /** **Phase D4 — currently surfaces "not yet implemented" into `lastError`.** */
  previewStop(vault: string): Promise<void>;
  /** **Phase D5 — currently surfaces "not yet implemented" into `lastError`.** */
  deploy(vault: string): Promise<void>;

  // ── Lifecycle ─────────────────────────────────────────────────────────
  /** Drop the cached row for a vault (e.g. on vault switch). */
  forgetVault(vault: string): void;
}

const fromStatus = (s: PublishStatus): PublishRowState => ({
  exists: s.exists,
  hostId: s.hostId,
  hostSlug: s.hostSlug,
  templateId: s.templateId,
  liveUrl: s.liveUrl,
  lastDeployAt: s.lastDeployAt,
  lastBuildAt: s.lastBuildAt,
  lastDeployFiles: s.lastDeployFiles,
  lastDeployBytes: s.lastDeployBytes,
  lastError: s.lastError,
  busy: false,
  previewUrl: null,
});

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Wrap a busy/error-shaped action.  Used by `build`/`preview`/`deploy`
 * to keep the row-update boilerplate in one place — every stub
 * currently flows through here, and the real implementations will too
 * once they land.
 */
const runWithBusy = async (
  setRow: (mut: (cur: PublishRowState) => PublishRowState) => void,
  fn: () => Promise<Partial<PublishRowState>>,
): Promise<void> => {
  setRow((cur) => ({ ...cur, busy: true, lastError: null }));
  try {
    const patch = await fn();
    setRow((cur) => ({ ...cur, busy: false, lastError: null, ...patch }));
  } catch (e) {
    setRow((cur) => ({ ...cur, busy: false, lastError: errMessage(e) }));
  }
};

export const usePublishStore = create<PublishStore>((set, get) => {
  const patchRow = (vault: string, mut: (cur: PublishRowState) => PublishRowState): void => {
    set((s) => {
      const cur = s.rows[vault] ?? EMPTY_ROW;
      return { rows: { ...s.rows, [vault]: mut(cur) } };
    });
  };

  return {
    hosts: [],
    templates: [],
    probe: null,
    rows: {},

    rowFor(vault) {
      return get().rows[vault] ?? EMPTY_ROW;
    },

    async refreshRegistries() {
      const [hosts, templates] = await Promise.all([publishListHosts(), publishListTemplates()]);
      set({ hosts, templates });
      return { hosts, templates };
    },

    async refreshProbe() {
      const report = await publishProbe();
      set({ probe: report });
      return report;
    },

    async refreshStatus(vault) {
      if (!isRealVault(vault)) return EMPTY_ROW;
      try {
        const status = await publishStatus(vault);
        const row = fromStatus(status);
        set((s) => ({ rows: { ...s.rows, [vault]: row } }));
        return row;
      } catch (e) {
        const row: PublishRowState = { ...EMPTY_ROW, lastError: errMessage(e) };
        set((s) => ({ rows: { ...s.rows, [vault]: row } }));
        return row;
      }
    },

    async build(vault) {
      if (!isRealVault(vault)) throw new Error("Cannot build the mock vault.");
      await runWithBusy(
        (mut) => patchRow(vault, mut),
        async () => {
          // The Rust-side stub returns the path to the build output;
          // for D1 it just throws "phase D3 — not yet implemented".
          await publishBuild(vault);
          return {};
        },
      );
    },

    async preview(vault) {
      if (!isRealVault(vault)) throw new Error("Cannot preview the mock vault.");
      await runWithBusy(
        (mut) => patchRow(vault, mut),
        async () => {
          const url = await publishPreview(vault);
          return { previewUrl: url };
        },
      );
    },

    async previewStop(vault) {
      if (!isRealVault(vault)) throw new Error("Cannot stop preview for the mock vault.");
      await runWithBusy(
        (mut) => patchRow(vault, mut),
        async () => {
          await publishPreviewStop(vault);
          return { previewUrl: null };
        },
      );
    },

    async deploy(vault) {
      if (!isRealVault(vault)) throw new Error("Cannot deploy the mock vault.");
      await runWithBusy(
        (mut) => patchRow(vault, mut),
        async () => {
          await publishDeploy(vault);
          // Refresh from disk so `lastDeployAt` / `lastDeployFiles`
          // come straight from the post-deploy publish.toml [state].
          await get().refreshStatus(vault);
          return {};
        },
      );
    },

    forgetVault(vault) {
      set((s) => {
        if (!(vault in s.rows)) return s;
        const { [vault]: _, ...rest } = s.rows;
        return { rows: rest };
      });
    },
  };
});
