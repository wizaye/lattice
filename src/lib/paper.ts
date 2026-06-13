/**
 * Slice C — paper export.  Typed wrappers around the Rust `paper_*`
 * Tauri commands.
 *
 * Mirrors the conventions in `byoc.ts` deliberately so anyone who's
 * already read that file (or `vcs.ts`) can grok this one in a glance:
 *   - DTO field names match the Rust `#[serde(rename_all = "camelCase")]`
 *     repr exactly — no transformation layer.
 *   - `EngineKind` / `TemplateSource` / `PreflightSeverity` are
 *     kebab-case literal unions matching the Rust enums' kebab-case
 *     serde repr.
 *   - The mock-vault sentinel (`"__mock__"`) is rejected here, before
 *     any IPC ever reaches Rust.  The Rust side still defensively
 *     re-checks via `paper::vault_dir(...)`.
 *
 * Phase C1 ships **two real commands** end-to-end (`paperListTemplates`
 * + `paperCreate`).  Everything else returns a "phase X" error string
 * from Rust until the matching slice lands — the wrappers are
 * registered now so the UI layer can compile against the final surface.
 *
 * See `docs/paper-export-plan.md` for the full design.
 */
import { invoke } from "@tauri-apps/api/core";

/** Engine kind — matches the Rust `EngineKind` kebab-case repr. */
export type EngineKind = "typst" | "tectonic";

/** Where a template came from.  Drives the picker filter chip. */
export type TemplateSource = "built-in" | "byof";

/** Severity for a `PreflightFinding`.  Matches the Rust kebab-case repr. */
export type PreflightSeverity = "info" | "warning" | "error";

/** Returned by `paper_list_templates`. */
export interface TemplateInfo {
  id: string;
  label: string;
  description: string;
  source: TemplateSource;
  engines: EngineKind[];
  defaultEngine: EngineKind;
  preview: string | null;
}

/** Author block from the New Paper wizard. */
export interface NewPaperAuthor {
  name: string;
  email?: string | null;
  affiliation?: string | null;
  orcid?: string | null;
}

/** Input payload for `paper_create`. */
export interface NewPaperRequest {
  /**
   * Absolute vault root path.  The wizard already rejects the mock
   * vault before opening, but `paperCreate` re-checks defensively.
   */
  vault: string;
  /** Vault-relative folder for the new paper.  Empty = vault root. */
  parentRel?: string;
  title: string;
  templateId: string;
  authors?: NewPaperAuthor[];
}

/** Result returned by `paper_create`. */
export interface NewPaperResult {
  paperAbsPath: string;
  paperRelPath: string;
  /** Vault-relative path the editor should open after create. */
  openRelPath: string;
}

/**
 * Input payload for `paper_quick_pdf` — the "just give me a PDF, do not
 * scaffold a project into my vault" path.  Mirrors `NewPaperRequest` but
 * adds `seedMarkdown` so the produced PDF contains the user's own
 * content (when supplied) instead of the template's dummy example text.
 */
export interface QuickPdfRequest {
  vault: string;
  /** Vault-relative folder where the PDF should land. Empty = root. */
  parentRel?: string;
  title: string;
  templateId: string;
  authors?: NewPaperAuthor[];
  /** Body to use as the only section in the temp scaffold. */
  seedMarkdown?: string | null;
}

/** Result returned by `paper_quick_pdf` — only the PDF, no project. */
export interface QuickPdfResult {
  pdfAbsPath: string;
  pdfRelPath: string;
}

/** Returned by `paper_status` for a folder under a paper. */
export interface PaperStatus {
  exists: boolean;
  title: string | null;
  engine: EngineKind | null;
  templateId: string | null;
  lastCompiledAt: string | null;
  lastPdfPath: string | null;
  lastError: string | null;
}

/** One entry in the `paper_preflight` result. */
export interface PreflightFinding {
  severity: PreflightSeverity;
  message: string;
  file?: string | null;
  line?: number | null;
}

/**
 * True iff `v` is a non-empty string.
 * Every paper IPC checks this first.
 */
const isRealVault = (v: string | null | undefined): v is string =>
  typeof v === "string" && v.length > 0;

// ─── Real commands (phase C1) ────────────────────────────────────────────

/**
 * Enumerate the templates available for the New Paper wizard.
 *
 * Pass the active vault to (eventually) include the per-vault BYOF
 * templates from `<vault>/.lattice/byof-templates/`.  For the C1
 * landing only the built-in templates are returned regardless.
 */
export async function paperListTemplates(vault: string | null): Promise<TemplateInfo[]> {
  // Mock vault is allowed to query the registry — there's no disk I/O
  // and the picker UI uses it to render the wizard preview cards.
  const arg = isRealVault(vault) ? vault : null;
  return invoke<TemplateInfo[]>("paper_list_templates", { vault: arg });
}

/**
 * Scaffold a new paper folder.  Returns the absolute + relative paths
 * plus the file the editor should open (`sections/01-introduction.md`).
 *
 * Throws if the vault is the mock sentinel.
 */
export async function paperCreate(req: NewPaperRequest): Promise<NewPaperResult> {
  if (!isRealVault(req.vault)) {
    throw new Error("Vault path is empty.");
  }
  if (!req.title.trim()) {
    throw new Error("Paper title cannot be empty.");
  }
  return invoke<NewPaperResult>("paper_create", { req });
}

/**
 * Render markdown straight to PDF without leaving a project scaffold in
 * the vault.  The Rust side scaffolds into the OS temp directory,
 * optionally replaces the dummy sections with `seedMarkdown`, compiles,
 * copies only the produced PDF into the chosen vault folder, then
 * deletes the temp scaffold.
 *
 * Use this for the "PDF (local)" output mode in the New Paper wizard
 * when the user expects "I picked PDF, I want a PDF — not a folder full
 * of template example files."
 */
export async function paperQuickPdf(req: QuickPdfRequest): Promise<QuickPdfResult> {
  if (!isRealVault(req.vault)) {
    throw new Error("Vault path is empty.");
  }
  if (!req.title.trim()) {
    throw new Error("Paper title cannot be empty.");
  }
  return invoke<QuickPdfResult>("paper_quick_pdf", { req });
}

/**
 * Read `paper.toml` for a given paper folder.  Returns `{ exists: false, ... }`
 * when the folder isn't a paper — frontend uses this to decide whether
 * to render the `PaperToolbar`.
 */
export async function paperStatus(paper: string): Promise<PaperStatus> {
  if (!paper) {
    return {
      exists: false,
      title: null,
      engine: null,
      templateId: null,
      lastCompiledAt: null,
      lastPdfPath: null,
      lastError: null,
    };
  }
  return invoke<PaperStatus>("paper_status", { paper });
}

/**
 * Update `paper.toml [engine].kind`.  Used by the engine-picker
 * dropdown in `PaperToolbar`.
 */
export async function paperSetCompileEngine(paper: string, engineKind: EngineKind): Promise<void> {
  if (!paper) throw new Error("paper path is required");
  await invoke("paper_set_compile_engine", { paper, engineKind });
}

// ─── Stub commands (phases C2-C9, registered now for type safety) ────────

/**
 * Compile the paper and return the absolute PDF path on success.
 * **Phase C1 (compile half) — currently errors out from Rust.**
 */
export async function paperCompile(paper: string): Promise<string> {
  if (!isRealVault(paper)) throw new Error("paper path is required");
  return invoke<string>("paper_compile", { paper });
}

/**
 * Run preflight without compiling.  **Phase C7 — currently errors out.**
 */
export async function paperPreflight(paper: string): Promise<PreflightFinding[]> {
  if (!isRealVault(paper)) throw new Error("paper path is required");
  return invoke<PreflightFinding[]>("paper_preflight", { paper });
}

/**
 * Emit `build/project/` + `build/project.zip` for Overleaf upload.
 * **Phase C2 — currently errors out.**
 */
export async function paperEmitBundle(paper: string): Promise<string> {
  if (!isRealVault(paper)) throw new Error("paper path is required");
  return invoke<string>("paper_emit_bundle", { paper });
}

/**
 * Open in Overleaf via the local sidecar URL or reveal-in-dir fallback.
 * **Phase C2 — currently errors out.**
 */
export async function paperOpenOverleaf(paper: string): Promise<string> {
  if (!isRealVault(paper)) throw new Error("paper path is required");
  return invoke<string>("paper_open_overleaf", { paper });
}

/**
 * Visual PDF diff vs `[build].diff_against`.  **Phase C7 — currently errors out.**
 */
export async function paperDiff(paper: string): Promise<string | null> {
  if (!isRealVault(paper)) throw new Error("paper path is required");
  return invoke<string | null>("paper_diff", { paper });
}

/**
 * Import a BYOF conference bundle (zip).  Returns the new BYOF id.
 * **Phase C5 — currently errors out.**
 */
export async function paperByofImport(vault: string, zipPath: string): Promise<string> {
  if (!isRealVault(vault)) throw new Error("Vault path is empty.");
  return invoke<string>("paper_byof_import", { vault, zipPath });
}

/** **Phase C5 — currently errors out.** */
export async function paperByofReImport(
  vault: string,
  byofId: string,
  zipPath: string,
): Promise<string> {
  if (!isRealVault(vault)) throw new Error("Vault path is empty.");
  return invoke<string>("paper_byof_re_import", { vault, byofId, zipPath });
}

/** **Phase C5 — currently errors out.** */
export async function paperByofRemove(vault: string, byofId: string): Promise<void> {
  if (!isRealVault(vault)) throw new Error("Vault path is empty.");
  await invoke("paper_byof_remove", { vault, byofId });
}

// ─── Engine preflight + install (LaTeX) ─────────────────────────────────

/**
 * Which install strategy the Rust backend would use.  Matches the
 * kebab-case `EngineInstaller` enum in
 * `src-tauri/src/paper/engine_install.rs`.  `null` means the host has
 * no supported installer; the UI should fall back to showing the
 * manual install URL.
 *
 * - `direct`: HTTPS download of the Tectonic binary from GitHub
 *   releases into `%LOCALAPPDATA%\Lattice\bin\`.  Used on Windows
 *   because Tectonic is not in the winget catalog.
 * - `homebrew` / `apt` / `cargo`: shell out to the named package
 *   manager on macOS / Linux.
 */
export type EngineInstaller = "direct" | "homebrew" | "apt" | "cargo";

/** Per-engine availability row inside `EngineProbe.engines`. */
export interface EngineAvailability {
  binary: string;
  available: boolean;
}

/**
 * Returned by `paperEngineProbe` / `paperEngineInstall`.  Mirrors the
 * Rust `EngineProbe` DTO exactly.
 */
export interface EngineProbe {
  /** True iff ANY supported engine is on PATH. */
  anyEngine: boolean;
  /**
   * Binary the compile pipeline would actually pick (matches
   * `pick_engine` priority order in `paper/compile.rs`).  `null`
   * when `anyEngine` is false.
   */
  preferred: string | null;
  engines: EngineAvailability[];
  /**
   * Which installer Lattice would invoke for one-click install.
   * `null` means manual install only.
   */
  installer: EngineInstaller | null;
}

/**
 * Fast read-only probe of the local LaTeX engines.  Used by the New
 * Paper modal + PaperToolbar to show a "missing engine → Install" banner
 * BEFORE the user picks PDF as the output and hits Create.
 */
export async function paperEngineProbe(): Promise<EngineProbe> {
  return invoke<EngineProbe>("paper_engine_probe");
}

/**
 * Install Tectonic via the detected strategy: direct GitHub-release
 * download on Windows (into `%LOCALAPPDATA%\Lattice\bin\`), or the
 * OS package manager elsewhere (brew / apt-get / cargo).  Long-
 * running — UI should show a spinner.  Returns the post-install
 * `EngineProbe`; on success `anyEngine` will be `true` and the modal
 * can proceed to compile.
 *
 * Errors:
 *   * No installer available — message points at manual install URL.
 *   * Download / installer failed — message includes the stderr tail
 *     or HTTP status, so the user can diagnose (firewall, proxy,
 *     GitHub asset moved, …).
 *   * Installer succeeded but PATH still stale — message asks the
 *     user to restart Lattice.  Note: the direct-download path
 *     prepends its bin dir to the current process PATH, so this
 *     branch is only reachable for the package-manager installers.
 */
export async function paperEngineInstall(): Promise<EngineProbe> {
  return invoke<EngineProbe>("paper_engine_install");
}
