/**
 * Slice D — publishing.  Typed wrappers around the Rust `publish_*`
 * Tauri commands.
 *
 * Mirrors the conventions in `byoc.ts` and `paper.ts`:
 *   - DTO field names match the Rust `#[serde(rename_all = "camelCase")]`
 *     repr exactly — no transformation layer.
 *   - `HostId` is a kebab-case literal union matching the Rust enum.
 *   - Mock-vault sentinel (`"__mock__"`) rejected here before the IPC
 *     reaches Rust.  The Rust `publish::vault_dir(...)` re-checks
 *     defensively for buggy/non-TS callers.
 *
 * Phase D1 ships **four real commands** end-to-end:
 *   - `publishProbe` — Node / npm / npx version check
 *   - `publishListHosts` — static host registry (GitHub Pages,
 *     Cloudflare, Netlify, Vercel) with capability flags
 *   - `publishListTemplates` — static Quartz template registry
 *     (garden / docs / notebook)
 *   - `publishStatus` — local-only read of `<vault>/.lattice/publish.toml`
 *
 * Everything else returns a "phase X — not yet implemented" error
 * from Rust; wrappers are registered now so the UI layer can be built
 * against the final surface without a future churn.
 *
 * See `docs/publishing-plan.md` for the design (Quartz v5 pinned;
 * no Lattice server; per-host adapters in later D-phases).
 */
import { invoke } from "@tauri-apps/api/core";

/** Host identifier — matches the Rust `HostId` kebab-case repr. */
export type HostId = "github-pages" | "cloudflare" | "netlify" | "vercel";

/** Returned by `publish_probe`.  All fields populated even on failure. */
export interface ProbeReport {
  /** `"v22.11.0"` or empty when Node not found. */
  node: string;
  /** `"10.9.2"` or empty when npm not found. */
  npm: string;
  /** True when `npx --version` succeeds. */
  npx: boolean;
  /** True iff Node ≥ v22 AND npm ≥ v10.9.2 AND npx present. */
  ok: boolean;
  /** Pre-formatted human message — render directly in the wizard. */
  reason: string | null;
}

/** Static host metadata from `publish_list_hosts`. */
export interface HostInfo {
  id: HostId;
  label: string;
  description: string;
  /** True for hosts whose auth is a token-paste flow (Cloudflare today). */
  requiresPaste: boolean;
  /** True iff the host can reuse the BYOC GitHub token (GitHub Pages). */
  reusesByocAuth: boolean;
  /** True if the host supports a user-supplied custom domain. */
  supportsCustomDomain: boolean;
  hasDashboard: boolean;
  hasLiveUrl: boolean;
  /**
   * True once the host's adapter ships.  All four are `false` in D1 —
   * the wizard greys these chips out and shows "Coming soon".
   */
  adapterReady: boolean;
}

/** Static template metadata from `publish_list_templates`. */
export interface PublishTemplateInfo {
  id: string;
  label: string;
  description: string;
  /** Quartz major version targeted — always `"5"` today. */
  quartzVersion: string;
  /** True once the on-disk template bundle ships.  All `false` in D1. */
  bundleReady: boolean;
}

/**
 * User's UI customisations for the bundled Quartz site.  Mirrors
 * `PublishTheme` in `src-tauri/src/publish/toml.rs`.  Pushed to Rust
 * via `publishSetTheme`, persisted to `publish.toml [quartz.theme]`,
 * and surgically merged into `quartz.config.yaml` on every build by
 * `quartz::ensure_scaffold`.
 *
 * The presets ("default" / "ocean" / "forest" / "sunset" / "mono" /
 * "berry" for `palette`; "default" / "modern-serif" / "geometric-sans"
 * / "brutalist" / "elegant" for `typography`) are intentionally
 * curated — v2 may add a "custom" sentinel that unlocks full hex /
 * font-name inputs.
 */
export interface QuartzTheme {
  /** Site title shown in the masthead.  Empty = keep upstream default. */
  pageTitle: string;
  /** Appended to every page's `<title>`.  Empty allowed. */
  pageTitleSuffix: string;
  /** Palette preset id — see comment above. */
  palette: string;
  /** Typography preset id — see comment above. */
  typography: string;
  /** Hover-card link previews. */
  popovers: boolean;
  /** Single-page-app client routing (off = full page navigations). */
  spa: boolean;
}

/** Returned by `publish_status`. */
export interface PublishStatus {
  /** False until `publish_init` (phase D2) writes the config. */
  exists: boolean;
  hostId: HostId | null;
  hostSlug: string | null;
  templateId: string | null;
  liveUrl: string | null;
  lastDeployAt: string | null;
  lastBuildAt: string | null;
  lastDeployFiles: number | null;
  lastDeployBytes: number | null;
  lastError: string | null;
  /** Null until `publish_init` runs. */
  theme: QuartzTheme | null;
}

const isRealVault = (v: string | null | undefined): v is string =>
  typeof v === "string" && v.length > 0;

// ─── Real commands (phase D1) ────────────────────────────────────────────

/**
 * Probe Node / npm / npx on PATH.  Run by the wizard's first step
 * before any auth dance happens, so a missing Node fails fast with a
 * clear "install Node 22" message.
 *
 * Independent of any vault — pure environment check.
 */
export async function publishProbe(): Promise<ProbeReport> {
  return invoke<ProbeReport>("publish_probe");
}

/**
 * Static list of supported hosts + per-host capability flags.  Drives
 * the host-picker chips in the wizard.  Today every host's
 * `adapterReady` is `false` — that's expected for D1.
 */
export async function publishListHosts(): Promise<HostInfo[]> {
  return invoke<HostInfo[]>("publish_list_hosts");
}

/**
 * Static list of bundled Quartz templates.  Today every template's
 * `bundleReady` is `false` — the registry is hand-maintained until
 * the template files land in `src-tauri/src/publish/templates/`.
 */
export async function publishListTemplates(): Promise<PublishTemplateInfo[]> {
  return invoke<PublishTemplateInfo[]>("publish_list_templates");
}

/**
 * Read `<vault>/.lattice/publish.toml` and surface what the UI needs.
 * Returns `{ exists: false, ... }` (all other fields `null`) when the
 * vault hasn't been initialised — the wizard uses that to decide
 * whether to show "Set up Publishing" vs the configured publish panel.
 *
 * Local-only — does NOT call any host API.  Safe to poll on a short
 * interval (e.g. from `PublishStatusPill`) without burning quota.
 *
 * Returns an empty status (rather than throwing) for the mock vault so
 * the panel can render its disabled state without a console error.
 */
export async function publishStatus(vault: string): Promise<PublishStatus> {
  if (!isRealVault(vault)) {
    return {
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
      theme: null,
    };
  }
  return invoke<PublishStatus>("publish_status", { vault });
}

// ─── Stub commands (phases D2-D5, registered now for type safety) ───────

/** **Phase D2 — currently errors out from Rust.** */
export async function publishInit(
  vault: string,
  hostId: HostId,
  templateId: string,
): Promise<void> {
  if (!isRealVault(vault)) throw new Error("Vault path is empty.");
  await invoke("publish_init", { vault, hostId, templateId });
}

/** **Phase D2 — currently errors out.** */
export async function publishAuthStart(vault: string, hostId: HostId): Promise<string> {
  if (!isRealVault(vault)) throw new Error("Vault path is empty.");
  return invoke<string>("publish_auth_start", { vault, hostId });
}

/** **Phase D2 — currently errors out.** */
export async function publishAuthComplete(
  vault: string,
  hostId: HostId,
  codeOrToken: string,
): Promise<string[]> {
  if (!isRealVault(vault)) throw new Error("Vault path is empty.");
  return invoke<string[]>("publish_auth_complete", { vault, hostId, codeOrToken });
}

/** **Phase D2 — currently errors out.** */
export async function publishAuthPick(
  vault: string,
  hostId: HostId,
  projectIdOrNewName: string,
): Promise<void> {
  if (!isRealVault(vault)) throw new Error("Vault path is empty.");
  await invoke("publish_auth_pick", { vault, hostId, projectIdOrNewName });
}

/**
 * Persist the user's Quartz UI customisations and immediately patch
 * `<vault>/.lattice/publish/quartz/quartz.config.yaml` so the next
 * build (or preview reload) picks them up.  Cheap (file IO only —
 * no network, no npm).  Rejected on the mock vault.
 */
export async function publishSetTheme(vault: string, theme: QuartzTheme): Promise<void> {
  if (!isRealVault(vault)) throw new Error("Vault path is empty.");
  await invoke("publish_set_theme", { vault, theme });
}

/** **Phase D3 — currently errors out.**  Returns the path to the build output. */
export async function publishBuild(vault: string): Promise<string> {
  if (!isRealVault(vault)) throw new Error("Vault path is empty.");
  return invoke<string>("publish_build", { vault });
}

/** **Phase D4 — currently errors out.**  Returns the preview URL. */
export async function publishPreview(vault: string): Promise<string> {
  if (!isRealVault(vault)) throw new Error("Vault path is empty.");
  return invoke<string>("publish_preview", { vault });
}

/** **Phase D4 — currently errors out.**  Idempotent once real. */
export async function publishPreviewStop(vault: string): Promise<void> {
  if (!isRealVault(vault)) throw new Error("Vault path is empty.");
  await invoke("publish_preview_stop", { vault });
}

/** **Phase D5 — currently errors out.** */
export async function publishDeploy(vault: string): Promise<string> {
  if (!isRealVault(vault)) throw new Error("Vault path is empty.");
  return invoke<string>("publish_deploy", { vault });
}

/** **Phase D2 — currently errors out.**  Wipes host tokens from the keychain. */
export async function publishDisconnect(vault: string, hostId: HostId): Promise<void> {
  if (!isRealVault(vault)) throw new Error("Vault path is empty.");
  await invoke("publish_disconnect", { vault, hostId });
}

/** **Phase D2 — currently errors out.** */
export async function publishOpenDashboard(vault: string): Promise<void> {
  if (!isRealVault(vault)) throw new Error("Vault path is empty.");
  await invoke("publish_open_dashboard", { vault });
}

/** **Phase D5 — currently errors out.** */
export async function publishOpenLive(vault: string): Promise<void> {
  if (!isRealVault(vault)) throw new Error("Vault path is empty.");
  await invoke("publish_open_live", { vault });
}
