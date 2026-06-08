/**
 * BYOC sync — typed wrappers around the Rust `byoc_*` Tauri commands.
 *
 * Co-located with the DTOs so the import shape is obvious at the call
 * site; mirrors the conventions in `vcs.ts` deliberately so anyone
 * who's already read that file can grok this one in a glance.
 *
 * The Rust side serialises with `serde(rename_all = "camelCase")` for
 * every type and `kebab-case` for `ProviderId`, so the field names
 * below match the wire format exactly — no transformation layer.
 *
 * See `docs/byoc-plan.md` for the design rules (no Lattice server,
 * tokens in OS keychain only, OAuth runs in-process, ...).
 */
import { invoke } from "@tauri-apps/api/core";

/**
 * Provider identifier — kebab-case so it matches the Rust enum's
 * `#[serde(rename_all = "kebab-case")]` repr.  The string literal
 * union doubles as the `id` field on `BYOC_PROVIDERS` in
 * `ChangesPanel.tsx`, so the type system catches typos at compile time.
 *
 * Only two providers are wired in slice B; OneDrive / Dropbox land
 * next slice and the picker UI greys those rows until then.
 */
export type ProviderId = "github" | "gdrive";

/**
 * Static metadata for the picker UI.  `configured=false` means the
 * client id wasn't baked into this build (developer build without the
 * `LATTICE_*_CLIENT_ID` env var); the row should disable Connect and
 * surface the `note` as a tooltip.
 */
export interface ProviderInfo {
  id: ProviderId;
  label: string;
  configured: boolean;
  /**
   * True when the provider's adapter has a working `pull` path.
   * Drive is push-only in slice B, so this is `false` for it; the
   * UI uses the flag to hide the "Pull only" kebab item and to know
   * that `byoc_sync_now` is implicitly push-only for that provider.
   */
  supportsPull: boolean;
  /**
   * True when there's a meaningful public URL for the remote (e.g. a
   * GitHub repo).  Drive's `appDataFolder` is sandboxed and not
   * surfaced in the user's Drive UI, so `false` for Drive — the UI
   * hides the "Open remote in browser" menu item in that case.
   */
  hasBrowsableRemote: boolean;
  note: string | null;
}

/**
 * Live connection state for one (vault, provider) pair.  This is
 * what we render in the per-row footer (account label + remote label
 * + relative last-sync time).
 *
 * `lastError` is sticky — populated by a failed push/pull, cleared
 * by the next successful op.  Frontend uses it to render an inline
 * error chip without a separate error-event channel.
 */
export interface ProviderStatus {
  connected: boolean;
  accountLabel: string | null;
  remoteLabel: string | null;
  /** Unix seconds of the last successful push/pull, or null. */
  lastSyncAt: number | null;
  lastError: string | null;
}

/** Returned by `byoc_connect` — drives the "connected as ..." chip. */
export interface AccountInfo {
  displayName: string;
  accountEmail: string | null;
  remoteLabel: string | null;
}

export interface PushResult {
  uploadedObjects: number;
  head: string | null;
  branch: string | null;
  message: string;
}

export interface PullResult {
  downloadedObjects: number;
  head: string | null;
  branch: string | null;
  /** Empty array on a clean fast-forward; populated with merge hints otherwise. */
  conflicts: string[];
  message: string;
}

export interface SyncResult {
  push: PushResult;
  pull: PullResult;
}

/**
 * Payload of the `"byoc://device-code"` Tauri event.  Fired exactly
 * once during a GitHub connect, before we start polling the token
 * endpoint.  Frontend listens via `listen("byoc://device-code", ...)`
 * (see `byocStore.ts`) and pops the verification modal.
 *
 * Field names match the Rust `DeviceCodePayload` struct (camelCase).
 */
export interface DeviceCodePayload {
  /** Short human-typeable code (e.g. "WDJB-MJHT").  Shown big + monospace. */
  userCode: string;
  /** URL the user opens in their browser to enter `userCode`. */
  verificationUri: string;
  /** Seconds until the code expires (typically 900 = 15 min). */
  expiresIn: number;
  /** Min seconds between poll attempts. */
  interval: number;
}

// ─── Command wrappers ─────────────────────────────────────────────────
//
// All accept camelCase param names; Tauri auto-translates to snake_case
// on the Rust side (`vaultPath` → `vault_path`).

/**
 * Cheap, no-IPC-side-effects: returns the provider catalogue plus
 * whether the build was compiled with the corresponding client id.
 * Frontend caches this once at app boot — the result never changes
 * for a given binary.
 */
export async function byocListProviders(): Promise<ProviderInfo[]> {
  return invoke<ProviderInfo[]>("byoc_list_providers");
}

/**
 * Probe the keychain + local manifest for the current connection
 * state.  Does NOT validate the token against the provider's API
 * (avoids spamming GitHub with `/user` calls); a real push/pull
 * will surface a 401 if the token was revoked server-side.
 */
export async function byocStatus(
  vaultPath: string,
  provider: ProviderId,
): Promise<ProviderStatus> {
  return invoke<ProviderStatus>("byoc_status", { vaultPath, provider });
}

/**
 * Kick off the OAuth dance.  GitHub uses Device Code Flow and emits
 * `byoc://device-code` before this promise resolves (so the modal can
 * mount).  Google uses PKCE + loopback redirect; the user's browser
 * opens directly to consent.
 *
 * Resolves with the connected account info on success; rejects with
 * a human-readable error string on cancellation, timeout (5 min for
 * Drive consent, ~15 min for GitHub device code), or API failure.
 */
export async function byocConnect(
  vaultPath: string,
  provider: ProviderId,
): Promise<AccountInfo> {
  return invoke<AccountInfo>("byoc_connect", { vaultPath, provider });
}

/**
 * Wipe the token from the OS keychain + the local manifest for this
 * (vault, provider) pair.  Idempotent — safe to call on an already-
 * disconnected provider.  Does NOT revoke the OAuth grant on the
 * provider's side (user can do that themselves in github.com/settings
 * or myaccount.google.com if they want a hard kill).
 */
export async function byocDisconnect(
  vaultPath: string,
  provider: ProviderId,
): Promise<void> {
  return invoke<void>("byoc_disconnect", { vaultPath, provider });
}

/**
 * Push local git history (GitHub) or BLAKE3-addressed loose objects
 * (Drive) to the configured remote.  Requires a prior successful
 * `byocConnect` — fails fast with a "no sync manifest — connect first"
 * error otherwise so the UI can offer the Connect button instead.
 */
export async function byocPush(
  vaultPath: string,
  provider: ProviderId,
): Promise<PushResult> {
  return invoke<PushResult>("byoc_push", { vaultPath, provider });
}

/**
 * Fetch remote refs/objects.  GitHub does a fast-forward-only merge
 * (conflicts surface in `PullResult.conflicts`); Drive currently
 * returns `NotImplemented` (pull is shipping in the next slice).
 */
export async function byocPull(
  vaultPath: string,
  provider: ProviderId,
): Promise<PullResult> {
  return invoke<PullResult>("byoc_pull", { vaultPath, provider });
}

/**
 * Convenience: push then pull, one IPC round-trip from the frontend's
 * POV.  Aborts on the first failure (no half-sync states).  Drive
 * currently errors on the pull step since it's not implemented yet —
 * use `byocPush` directly if you want one-way upload for now.
 */
export async function byocSyncNow(
  vaultPath: string,
  provider: ProviderId,
): Promise<SyncResult> {
  return invoke<SyncResult>("byoc_sync_now", { vaultPath, provider });
}

// ─── Storage transparency + reveal helpers ────────────────────────────
//
// Strictly read-only metadata commands.  The UI uses these to render
// the "Tokens live in ..." footer + the kebab-menu actions (Open
// remote, Reveal local manifest).  None of these touch the network.

/**
 * Where on disk this (vault, provider)'s tokens are stored.
 *
 * - On Windows, `backend = "dpapi-file"` and `path` is the encrypted
 *   `.dpapi` blob inside `%LOCALAPPDATA%\Lattice\byoc-tokens\`.
 * - On macOS / Linux, `backend = "keychain"`, `path` is null (the
 *   OS doesn't expose a file path), and `label` is the account key
 *   we used in `keyring::Entry::new`.
 *
 * `directory` is the parent folder (handy for "Reveal in Explorer"
 * on Windows — `path` itself isn't user-meaningful since it's
 * encrypted bytes).
 */
export interface StorageDescriptor {
  backend: "dpapi-file" | "keychain";
  path: string | null;
  directory: string | null;
  label: string;
}

export async function byocStorageInfo(
  vaultPath: string,
  provider: ProviderId,
): Promise<StorageDescriptor> {
  return invoke<StorageDescriptor>("byoc_storage_info", { vaultPath, provider });
}

/**
 * Resolve the public browser URL for the remote backing this
 * (vault, provider).  Returns `null` when there's no manifest yet
 * (i.e. the user hasn't connected) — UI should hide the action.
 */
export async function byocRemoteUrl(
  vaultPath: string,
  provider: ProviderId,
): Promise<string | null> {
  return invoke<string | null>("byoc_remote_url", { vaultPath, provider });
}

/**
 * Absolute on-disk path of the per-provider sync manifest (the small
 * JSON file under `<vault>/.lattice/`).  Always returns a path even
 * if the file doesn't exist yet — callers should `exists()`-check
 * before revealing.
 */
export async function byocManifestPath(
  vaultPath: string,
  provider: ProviderId,
): Promise<string> {
  return invoke<string>("byoc_manifest_path", { vaultPath, provider });
}
