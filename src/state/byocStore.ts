/**
 * BYOC sync — frontend store.
 *
 * Owns the cached per-(vault, provider) connection state, plus the
 * transient device-code payload broadcast by the Rust side during a
 * GitHub OAuth dance.  Components (ChangesPanel, DeviceCodeModal)
 * subscribe to this store; the actual OAuth / push / pull work runs
 * in Rust via the `byoc_*` IPC.
 *
 * Design notes:
 *   - One state map keyed by `${vaultPath}::${providerId}` keeps the
 *     store flat — no nested-object update gymnastics, no spread-bug
 *     traps.  String concatenation is fine here; vault paths are
 *     absolute and providers are a closed enum.
 *   - We subscribe to the `byoc://device-code` Tauri event once at
 *     store construction time and stash the most recent payload on
 *     `pendingDeviceCode`.  Modal mounts when the field is non-null;
 *     unmounts via `clearDeviceCode()` on connect resolution.
 *   - Errors are scoped per (vault, provider) — a Drive auth failure
 *     mustn't blank a GitHub success chip.
 */
import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  byocConnect,
  byocDisconnect,
  byocListProviders,
  byocManifestPath,
  byocPull,
  byocPush,
  byocRemoteUrl,
  byocStatus,
  byocStorageInfo,
  byocSyncNow,
  type AccountInfo,
  type DeviceCodePayload,
  type ProviderId,
  type ProviderInfo,
  type ProviderStatus,
  type PullResult,
  type PushResult,
  type StorageDescriptor,
} from "../lib/byoc";

/** Per-(vault, provider) row state.  Mirrors `ProviderStatus` + UI flags. */
export interface ProviderRowState {
  connected: boolean;
  accountLabel: string | null;
  remoteLabel: string | null;
  /** Unix seconds of the last successful sync; null = never synced. */
  lastSyncAt: number | null;
  /** Sticky error from the last failed op; null after a clean op. */
  lastError: string | null;
  /** True while a connect / push / pull / disconnect is in flight. */
  busy: boolean;
}

const EMPTY_ROW: ProviderRowState = {
  connected: false,
  accountLabel: null,
  remoteLabel: null,
  lastSyncAt: null,
  lastError: null,
  busy: false,
};

/**
 * Flat key for the row map.  Vault paths contain `\` on Windows and
 * `/` on Unix; neither character collides with `::`, so the simple
 * separator is safe.
 */
const rowKey = (vault: string, provider: ProviderId): string =>
  `${vault}::${provider}`;

const isRealVault = (v: string | null | undefined): v is string =>
  typeof v === "string" && v.length > 0;

interface BYOCState {
  /** Static provider catalogue, loaded once at boot. */
  providers: ProviderInfo[];
  /** True until the first `byocListProviders` call resolves. */
  providersLoading: boolean;

  /** Per-(vault, provider) status cache. */
  rows: Record<string, ProviderRowState>;

  /**
   * Latest device-code payload from the Rust side.  Non-null →
   * `DeviceCodeModal` mounts.  Reset by `clearDeviceCode()` when the
   * connect promise resolves or the user dismisses the modal.
   */
  pendingDeviceCode: DeviceCodePayload | null;

  // ── Actions ──
  /** Load `byocListProviders` once at boot. */
  loadProviders: () => Promise<void>;
  /**
   * Refresh status for one provider OR all configured providers (when
   * `provider` is omitted).  Cheap — no network round-trip on the
   * Rust side, just a keychain probe + manifest read.
   */
  refresh: (vault: string | null, provider?: ProviderId) => Promise<void>;
  /** Drive the OAuth dance.  Updates row state on success. */
  connect: (vault: string, provider: ProviderId) => Promise<AccountInfo | null>;
  /** Wipe the token + manifest for this (vault, provider). */
  disconnect: (vault: string, provider: ProviderId) => Promise<void>;
  /** One-way push (used when Drive pull isn't implemented yet). */
  push: (vault: string, provider: ProviderId) => Promise<PushResult | null>;
  /** Fetch + fast-forward merge.  Drive currently errors with NotImplemented. */
  pull: (vault: string, provider: ProviderId) => Promise<PullResult | null>;
  /** Push then pull, one IPC.  Aborts on first failure. */
  syncNow: (vault: string, provider: ProviderId) => Promise<void>;
  /**
   * One-shot lookup of the on-disk token storage descriptor for the
   * "Tokens live in ..." footer.  Not cached — the UI only fetches
   * this when the kebab menu opens.
   */
  storageInfo: (
    vault: string,
    provider: ProviderId,
  ) => Promise<StorageDescriptor | null>;
  /**
   * Public browser URL for the remote backing this (vault, provider).
   * Resolves to `null` when there's no manifest yet (not connected),
   * so the UI can hide the action.
   */
  remoteUrl: (
    vault: string,
    provider: ProviderId,
  ) => Promise<string | null>;
  /**
   * Absolute path of the per-provider manifest file (under
   * `<vault>/.lattice/`).  Always returns a path even if the file
   * doesn't exist yet — caller decides whether to reveal.
   */
  manifestPath: (
    vault: string,
    provider: ProviderId,
  ) => Promise<string | null>;
  /** Dismiss the device-code modal (modal Close button calls this). */
  clearDeviceCode: () => void;
  /**
   * Lookup helper for components — never returns `undefined`, always
   * an `EMPTY_ROW` fallback so callers don't need null checks.
   */
  rowFor: (vault: string | null, provider: ProviderId) => ProviderRowState;
}

// ── Tauri event subscription ──
//
// Subscribed once at module load.  `listen` returns a promise of an
// unlisten function; we hold onto it so HMR doesn't leak listeners,
// but a leaked subscription wouldn't actually break anything — the
// payload just lands in the store, harmlessly.
let unlistenDeviceCode: UnlistenFn | null = null;

/** Returns true when running inside a Tauri desktop window. */
const isTauriRuntime = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function subscribeDeviceCode(
  onPayload: (p: DeviceCodePayload) => void,
): Promise<void> {
  if (unlistenDeviceCode) return; // already subscribed
  // Guard: `listen` throws immediately in browser/test mode because
  // the Tauri IPC bridge isn't present.  Skip gracefully rather than
  // printing a noisy warning in every browser-mode dev session.
  if (!isTauriRuntime()) return;
  try {
    unlistenDeviceCode = await listen<DeviceCodePayload>(
      "byoc://device-code",
      (event) => onPayload(event.payload),
    );
  } catch (err) {
    // We're outside a Tauri context (vitest, Storybook, etc.) — fine,
    // device code modal just won't pop in those environments.
    console.warn("[byoc] failed to subscribe to device-code events:", err);
  }
}

// HMR cleanup — only triggers in dev.  Production builds never hit this.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (unlistenDeviceCode) {
      unlistenDeviceCode();
      unlistenDeviceCode = null;
    }
  });
}

export const useBYOCStore = create<BYOCState>((set, get) => {
  // Wire the device-code subscription once.  `void` since this fires
  // a promise; we don't block store creation on it.
  void subscribeDeviceCode((payload) => {
    set({ pendingDeviceCode: payload });
  });

  /**
   * Internal helper: mutate one row without disturbing others.  Spreads
   * the previous row (or `EMPTY_ROW` if absent) then applies the patch.
   */
  const patchRow = (
    vault: string,
    provider: ProviderId,
    patch: Partial<ProviderRowState>,
  ) => {
    const key = rowKey(vault, provider);
    const prev = get().rows[key] ?? EMPTY_ROW;
    set({ rows: { ...get().rows, [key]: { ...prev, ...patch } } });
  };

  return {
    providers: [],
    providersLoading: false,
    rows: {},
    pendingDeviceCode: null,

    loadProviders: async () => {
      if (get().providersLoading || get().providers.length > 0) return;
      set({ providersLoading: true });
      try {
        const providers = await byocListProviders();
        set({ providers, providersLoading: false });
      } catch (err) {
        console.warn(
          "byoc_list_providers failed:",
          err,
        );
        set({ providers: [], providersLoading: false });
      }
    },

    refresh: async (vault, provider) => {
      if (!isRealVault(vault)) return;
      const targets: ProviderId[] = provider
        ? [provider]
        : (["github", "gdrive"] as ProviderId[]);
      await Promise.all(
        targets.map(async (p) => {
          try {
            const s: ProviderStatus = await byocStatus(vault, p);
            patchRow(vault, p, {
              connected: s.connected,
              accountLabel: s.accountLabel,
              remoteLabel: s.remoteLabel,
              lastSyncAt: s.lastSyncAt,
              lastError: s.lastError,
            });
          } catch (err) {
            console.warn(`byoc_status(${p}) failed:`, err);
          }
        }),
      );
    },

    connect: async (vault, provider) => {
      if (!isRealVault(vault)) return null;
      patchRow(vault, provider, { busy: true, lastError: null });
      try {
        const acct = await byocConnect(vault, provider);
        patchRow(vault, provider, {
          busy: false,
          connected: true,
          accountLabel: acct.displayName,
          remoteLabel: acct.remoteLabel,
          lastError: null,
        });
        set({ pendingDeviceCode: null });
        return acct;
      } catch (err) {
        patchRow(vault, provider, {
          busy: false,
          lastError: String(err),
        });
        set({ pendingDeviceCode: null });
        console.error(`byoc_connect(${provider}) failed:`, err);
        return null;
      }
    },

    disconnect: async (vault, provider) => {
      if (!isRealVault(vault)) return;
      patchRow(vault, provider, { busy: true });
      try {
        await byocDisconnect(vault, provider);
        patchRow(vault, provider, {
          busy: false,
          connected: false,
          accountLabel: null,
          remoteLabel: null,
          lastSyncAt: null,
          lastError: null,
        });
      } catch (err) {
        patchRow(vault, provider, { busy: false, lastError: String(err) });
        console.error(`byoc_disconnect(${provider}) failed:`, err);
      }
    },

    push: async (vault, provider) => {
      if (!isRealVault(vault)) return null;
      patchRow(vault, provider, { busy: true, lastError: null });
      try {
        const res = await byocPush(vault, provider);
        patchRow(vault, provider, {
          busy: false,
          lastSyncAt: Math.floor(Date.now() / 1000),
          lastError: null,
        });
        return res;
      } catch (err) {
        patchRow(vault, provider, { busy: false, lastError: String(err) });
        console.error(`byoc_push(${provider}) failed:`, err);
        return null;
      }
    },

    pull: async (vault, provider) => {
      if (!isRealVault(vault)) return null;
      patchRow(vault, provider, { busy: true, lastError: null });
      try {
        const res = await byocPull(vault, provider);
        patchRow(vault, provider, {
          busy: false,
          lastSyncAt:
            res.conflicts.length === 0
              ? Math.floor(Date.now() / 1000)
              : get().rows[rowKey(vault, provider)]?.lastSyncAt ?? null,
          lastError:
            res.conflicts.length > 0 ? res.conflicts.join("; ") : null,
        });
        return res;
      } catch (err) {
        patchRow(vault, provider, { busy: false, lastError: String(err) });
        console.error(`byoc_pull(${provider}) failed:`, err);
        return null;
      }
    },

    syncNow: async (vault, provider) => {
      if (!isRealVault(vault)) return;
      patchRow(vault, provider, { busy: true, lastError: null });
      try {
        await byocSyncNow(vault, provider);
        patchRow(vault, provider, {
          busy: false,
          lastSyncAt: Math.floor(Date.now() / 1000),
          lastError: null,
        });
      } catch (err) {
        patchRow(vault, provider, { busy: false, lastError: String(err) });
        console.error(`byoc_sync_now(${provider}) failed:`, err);
      }
    },

    clearDeviceCode: () => set({ pendingDeviceCode: null }),

    storageInfo: async (vault, provider) => {
      if (!isRealVault(vault)) return null;
      try {
        return await byocStorageInfo(vault, provider);
      } catch (err) {
        console.warn(`byoc_storage_info(${provider}) failed:`, err);
        return null;
      }
    },

    remoteUrl: async (vault, provider) => {
      if (!isRealVault(vault)) return null;
      try {
        return await byocRemoteUrl(vault, provider);
      } catch (err) {
        console.warn(`byoc_remote_url(${provider}) failed:`, err);
        return null;
      }
    },

    manifestPath: async (vault, provider) => {
      if (!isRealVault(vault)) return null;
      try {
        return await byocManifestPath(vault, provider);
      } catch (err) {
        console.warn(`byoc_manifest_path(${provider}) failed:`, err);
        return null;
      }
    },

    rowFor: (vault, provider) => {
      if (!isRealVault(vault)) return EMPTY_ROW;
      return get().rows[rowKey(vault, provider)] ?? EMPTY_ROW;
    },
  };
});
