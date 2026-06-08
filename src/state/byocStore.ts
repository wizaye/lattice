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
 *   - The mock vault sentinel (`"__mock__"`) is rejected before any
 *     IPC; same pattern as `vcsStore`.  See its block comment for why.
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

// The mock vault uses the sentinel path "__mock__" which has no
// on-disk presence — real BYOC IPC would fail with "vault path is
// not a directory".  We still want the demo vault's Sync section to
// be a fully interactive UI walkthrough though, so we route mock
// vault calls through a simulated in-process flow (see the MOCK_*
// constants and the per-action branches below).  `isRealVault`
// gates the actual Tauri IPC path.
const MOCK_VAULT = "__mock__";
const isRealVault = (v: string | null | undefined): v is string =>
  typeof v === "string" && v.length > 0 && v !== MOCK_VAULT;
const isMockVault = (v: string | null | undefined): v is string =>
  v === MOCK_VAULT;

// ── Mock BYOC fixtures ───────────────────────────────────────────────
//
// Pure UI-only fixtures used when `vault === MOCK_VAULT`.  No network,
// no disk, no Tauri IPC.  Mirrors what the real Rust side returns for
// github + gdrive so the demo state and the real state are visually
// indistinguishable.  Updating these does NOT require a Rust rebuild.
const MOCK_PROVIDERS: ProviderInfo[] = [
  {
    id: "github",
    label: "GitHub",
    configured: true,
    supportsPull: true,
    hasBrowsableRemote: true,
    note: null,
  },
  {
    id: "gdrive",
    label: "Google Drive",
    configured: true,
    supportsPull: false,
    hasBrowsableRemote: false,
    note: "Push-only in this build — pull lands next slice.",
  },
];

const MOCK_ACCOUNTS: Record<ProviderId, AccountInfo> = {
  github: {
    displayName: "demo-user",
    accountEmail: "demo@lattice.app",
    remoteLabel: "github.com/demo-user/lattice-demo",
  },
  gdrive: {
    displayName: "Demo User",
    accountEmail: "demo@lattice.app",
    remoteLabel: "appDataFolder (sandboxed)",
  },
};

const MOCK_REMOTE_URLS: Record<ProviderId, string | null> = {
  github: "https://github.com/demo-user/lattice-demo",
  // Drive's appDataFolder is sandboxed — no public URL even in real mode.
  gdrive: null,
};

// Backend matches the Windows DPAPI shape so the menu copy in
// ChangesPanel renders identically.  `path` is null because there's
// no real encrypted blob on disk for the demo state.
const MOCK_STORAGE: Record<ProviderId, StorageDescriptor> = {
  github: {
    backend: "dpapi-file",
    path: null,
    directory: null,
    label: "lattice/byoc/github (demo)",
  },
  gdrive: {
    backend: "dpapi-file",
    path: null,
    directory: null,
    label: "lattice/byoc/gdrive (demo)",
  },
};

// Short enough to feel snappy, long enough to make the busy spinner
// visible so users see "something happened".
const MOCK_LATENCY_MS = 600;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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

async function subscribeDeviceCode(
  onPayload: (p: DeviceCodePayload) => void,
): Promise<void> {
  if (unlistenDeviceCode) return; // already subscribed
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
        // Non-fatal.  Two scenarios land here:
        //   1. Pure-browser dev mode (no Tauri bridge) — `invoke` is
        //      undefined.  Seed `MOCK_PROVIDERS` so the demo vault's
        //      Sync section still renders correctly with per-provider
        //      capability flags.  Real vaults aren't usable here
        //      anyway (no Rust IPC for git ops either).
        //   2. Tauri context but the IPC errored.  Same fallback —
        //      the panel still renders with the hard-coded labels
        //      and the user can retry.
        console.warn(
          "byoc_list_providers failed — falling back to mock provider metadata:",
          err,
        );
        set({ providers: MOCK_PROVIDERS, providersLoading: false });
      }
    },

    refresh: async (vault, provider) => {
      // Mock vault: state already lives in the rows map (mutated by
      // mock connect / sync calls).  Nothing to fetch from a remote
      // source.
      if (isMockVault(vault)) return;
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
            // Status probes are cheap — a transient failure shouldn't
            // populate `lastError` (we'd stomp a real auth error from
            // the previous push/pull the user is still reading).  Log
            // and move on.
            console.warn(`byoc_status(${p}) failed:`, err);
          }
        }),
      );
    },

    connect: async (vault, provider) => {
      if (isMockVault(vault)) {
        // Simulated OAuth dance — no device-code modal so the demo
        // stays one-click.  Busy spinner visible for MOCK_LATENCY_MS
        // so the UX matches the real flow's "connecting…" beat.
        patchRow(vault, provider, { busy: true, lastError: null });
        await sleep(MOCK_LATENCY_MS);
        const acct = MOCK_ACCOUNTS[provider];
        patchRow(vault, provider, {
          busy: false,
          connected: true,
          accountLabel: acct.displayName,
          remoteLabel: acct.remoteLabel,
          lastError: null,
        });
        return acct;
      }
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
        // Connect resolved → device-code modal is no longer useful.
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
      if (isMockVault(vault)) {
        patchRow(vault, provider, { busy: true });
        await sleep(200);
        patchRow(vault, provider, {
          busy: false,
          connected: false,
          accountLabel: null,
          remoteLabel: null,
          lastSyncAt: null,
          lastError: null,
        });
        return;
      }
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
      if (isMockVault(vault)) {
        const row = get().rows[rowKey(vault, provider)];
        if (!row?.connected) {
          // Mirror the real Rust side's "no sync manifest — connect first".
          patchRow(vault, provider, {
            lastError: "Connect first to enable push.",
          });
          return null;
        }
        patchRow(vault, provider, { busy: true, lastError: null });
        await sleep(MOCK_LATENCY_MS);
        patchRow(vault, provider, {
          busy: false,
          lastSyncAt: Math.floor(Date.now() / 1000),
          lastError: null,
        });
        // Numbers are illustrative — the demo vault has ~7 markdown
        // files plus the sample canvas; round up to mimic a real
        // git push of small objects.
        return {
          uploadedObjects: 12,
          head: "abc1234",
          branch: "main",
          message: "Pushed 12 objects (demo)",
        };
      }
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
      if (isMockVault(vault)) {
        if (provider === "gdrive") {
          // Match the real Drive adapter — push-only in slice B.
          patchRow(vault, provider, {
            lastError:
              "Pull not supported by this provider yet — push-only sync",
          });
          return null;
        }
        const row = get().rows[rowKey(vault, provider)];
        if (!row?.connected) {
          patchRow(vault, provider, {
            lastError: "Connect first to enable pull.",
          });
          return null;
        }
        patchRow(vault, provider, { busy: true, lastError: null });
        await sleep(MOCK_LATENCY_MS);
        patchRow(vault, provider, {
          busy: false,
          lastSyncAt: Math.floor(Date.now() / 1000),
          lastError: null,
        });
        return {
          downloadedObjects: 0,
          head: "abc1234",
          branch: "main",
          conflicts: [],
          message: "Already up to date (demo)",
        };
      }
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
      if (isMockVault(vault)) {
        const row = get().rows[rowKey(vault, provider)];
        if (!row?.connected) {
          patchRow(vault, provider, {
            lastError: "Connect first to enable sync.",
          });
          return;
        }
        patchRow(vault, provider, { busy: true, lastError: null });
        await sleep(MOCK_LATENCY_MS);
        patchRow(vault, provider, {
          busy: false,
          lastSyncAt: Math.floor(Date.now() / 1000),
          lastError: null,
        });
        return;
      }
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
      if (isMockVault(vault)) return MOCK_STORAGE[provider];
      if (!isRealVault(vault)) return null;
      try {
        return await byocStorageInfo(vault, provider);
      } catch (err) {
        console.warn(`byoc_storage_info(${provider}) failed:`, err);
        return null;
      }
    },

    remoteUrl: async (vault, provider) => {
      if (isMockVault(vault)) {
        const row = get().rows[rowKey(vault, provider)];
        if (!row?.connected) return null;
        return MOCK_REMOTE_URLS[provider];
      }
      if (!isRealVault(vault)) return null;
      try {
        return await byocRemoteUrl(vault, provider);
      } catch (err) {
        console.warn(`byoc_remote_url(${provider}) failed:`, err);
        return null;
      }
    },

    manifestPath: async (vault, provider) => {
      // No on-disk manifest for the demo vault — UI hides the
      // "Reveal local manifest" item when this returns null.
      if (isMockVault(vault)) return null;
      if (!isRealVault(vault)) return null;
      try {
        return await byocManifestPath(vault, provider);
      } catch (err) {
        console.warn(`byoc_manifest_path(${provider}) failed:`, err);
        return null;
      }
    },

    rowFor: (vault, provider) => {
      // Mock vault uses the same rows map keyed by `__mock__::<provider>`.
      if (isMockVault(vault)) {
        return get().rows[rowKey(vault, provider)] ?? EMPTY_ROW;
      }
      if (!isRealVault(vault)) return EMPTY_ROW;
      return get().rows[rowKey(vault, provider)] ?? EMPTY_ROW;
    },
  };
});
