/**
 * VCS module — typed wrappers around the Rust `git_*` / `vcs_*`
 * Tauri commands (which all shell out to system `git`).
 *
 * Co-located with the DTOs so the import shape is obvious at the
 * call site; keeps `tauriApi.ts` from becoming a junk drawer.
 *
 * The Rust side serialises with `serde(rename_all = "camelCase")`,
 * so every field below mirrors what the IPC actually delivers — no
 * runtime transformation layer needed.
 */
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./tauriApi";

/**
 * One row in the changes list — same shape regardless of which
 * section it belongs to (staged / unstaged / untracked).
 *
 * `status` is git's porcelain v2 two-letter XY code, normalised:
 *   - Entries in `staged` have the form "X." (e.g. "M.", "A.", "D.")
 *   - Entries in `unstaged` have the form ".Y" (e.g. ".M", ".D")
 *   - Entries in `untracked` are always "??"
 *   - Conflicts (UU, AA, etc.) live in `staged` with their raw code
 *
 * Letters:  M=modified  A=added  D=deleted  R=renamed
 *           C=copied    T=type-changed  U=unmerged
 */
export interface FileChange {
  /** Vault-relative path with forward slashes (git emits these). */
  path: string;
  /** Two-letter porcelain v2 status code. See doc above for the encoding. */
  status: string;
  /** For renames/copies (R/C): the source path. */
  origPath?: string;
}

/**
 * Full per-vault status snapshot returned by `vcs_status` — single
 * IPC round-trip, single `git status --porcelain=v2 -z` subprocess.
 *
 * `initialized=false` means the vault has no git repo yet; the UI
 * shows the Enable CTA and skips the three sections.
 */
export interface VcsStatus {
  initialized: boolean;
  branch: string | null;
  headShort: string | null;
  /** Commits ahead of upstream (null when no upstream set). */
  ahead: number | null;
  /** Commits behind upstream (null when no upstream set). */
  behind: number | null;
  /** Files staged for the next commit (X column non-dot). */
  staged: FileChange[];
  /** Files modified but not staged (Y column non-dot). */
  unstaged: FileChange[];
  /** Files not yet known to git (??). */
  untracked: FileChange[];
}

/** One commit row for the History panel. */
export interface CommitInfo {
  id: string;
  shortId: string;
  /** "Name <email>" — preformatted by Rust. */
  author: string;
  /** Unix seconds. */
  timestamp: number;
  /** First line of the commit message. */
  summary: string;
  /** Everything after the first blank line, trimmed; null if absent. */
  body: string | null;
  /** Parent commit shas (usually 1; 2 for merges). */
  parents: string[];
}

/** Returned by `git_check_installed` — drives the onboarding prompt. */
export interface GitPresence {
  installed: boolean;
  version: string | null;
}

/**
 * One branch row for the Branches panel.  `isRemote=true` for
 * `refs/remotes/<remote>/<name>` refs (these are read-only; the UI
 * surfaces them so you can checkout / track them).
 */
export interface BranchInfo {
  /** Short name (`main`, `origin/main`, `feature/x`). */
  name: string;
  /** Currently-checked-out local branch. */
  isCurrent: boolean;
  /** Remote-tracking branch (under `refs/remotes/`). */
  isRemote: boolean;
  /** Configured tracking branch, short form. */
  upstream?: string;
  /** Commits ahead of upstream (null when no upstream). */
  ahead?: number;
  /** Commits behind upstream (null when no upstream). */
  behind?: number;
  /** 7-char short sha of the tip. */
  tipShort?: string;
  /** First line of the tip commit's message (for a row preview). */
  tipSummary?: string;
  /** Unix-seconds of the tip's committer date. */
  tipTimestamp: number;
}

/**
 * One commit in the graph view.  Same shape as `CommitInfo` plus the
 * `refs` field — populated via `git log --decorate`.  Each ref string
 * preserves its original prefix so the renderer can colour:
 *   - "HEAD -> main"        → bold green pill
 *   - "main", "feature/x"   → blue pill
 *   - "origin/main"         → grey pill
 *   - "tag: v0.1.0"         → orange pill
 */
export interface GraphCommit {
  id: string;
  shortId: string;
  author: string;
  timestamp: number;
  summary: string;
  body: string | null;
  parents: string[];
  refs: string[];
}

// ─── Command wrappers ─────────────────────────────────────────────────
//
// All accept the camelCase param names; Tauri translates to snake_case
// on the Rust side automatically (`vaultPath` → `vault_path`).

/** Detect whether the system has a working `git` binary on PATH. */
export async function gitCheckInstalled(): Promise<GitPresence> {
  if (!isTauri()) return { installed: false, version: null };
  return invoke<GitPresence>("git_check_installed");
}

/** One-shot status snapshot (staged + unstaged + untracked + branch). */
export async function vcsStatus(vaultPath: string): Promise<VcsStatus> {
  if (!isTauri()) return { initialized: false, branch: null, headShort: null, ahead: null, behind: null, staged: [], unstaged: [], untracked: [] };
  return invoke<VcsStatus>("vcs_status", { vaultPath });
}

/**
 * Cheap walk-only count of files that *would* be committed if the
 * user enables version control.  Used by the not-tracked CTA so the
 * button can say "Enable & commit 247 files" without walking + hashing.
 */
export async function vcsPreviewUntrackedCount(
  vaultPath: string,
): Promise<number> {
  if (!isTauri()) return 0;
  return invoke<number>("vcs_preview_untracked_count", { vaultPath });
}

/**
 * Initialise the vault for version control.  Creates `.lattice/git/`,
 * writes `.gitignore`, applies speed/safety config, takes an initial
 * commit.  Idempotent — safe to retry after a transient failure.
 */
export async function vcsInit(vaultPath: string): Promise<VcsStatus> {
  if (!isTauri()) return { initialized: false, branch: null, headShort: null, ahead: null, behind: null, staged: [], unstaged: [], untracked: [] };
  return invoke<VcsStatus>("vcs_init", { vaultPath });
}

/** Stage one or more paths for the next commit (`git add`). */
export async function vcsStage(
  vaultPath: string,
  paths: string[],
): Promise<VcsStatus> {
  if (!isTauri()) return { initialized: false, branch: null, headShort: null, ahead: null, behind: null, staged: [], unstaged: [], untracked: [] };
  return invoke<VcsStatus>("vcs_stage", { vaultPath, paths });
}

/** Unstage one or more paths (`git restore --staged`). */
export async function vcsUnstage(
  vaultPath: string,
  paths: string[],
): Promise<VcsStatus> {
  if (!isTauri()) return { initialized: false, branch: null, headShort: null, ahead: null, behind: null, staged: [], unstaged: [], untracked: [] };
  return invoke<VcsStatus>("vcs_unstage", { vaultPath, paths });
}

/**
 * Discard local edits to one or more paths.  Tracked files are
 * restored from the index; untracked files are sent to the system
 * recycle bin (NEVER hard-deleted).
 */
export async function vcsDiscard(
  vaultPath: string,
  paths: string[],
): Promise<VcsStatus> {
  if (!isTauri()) return { initialized: false, branch: null, headShort: null, ahead: null, behind: null, staged: [], unstaged: [], untracked: [] };
  return invoke<VcsStatus>("vcs_discard", { vaultPath, paths });
}

/**
 * Commit whatever is currently staged.  Caller is responsible for
 * staging via `vcsStage` first — this is a pure "snapshot the index".
 * Returns the new commit's 7-char short sha.
 */
export async function vcsCommit(
  vaultPath: string,
  message: string,
): Promise<string> {
  if (!isTauri()) return '';
  return invoke<string>("vcs_commit", { vaultPath, message });
}

/**
 * Legacy commit-everything shortcut: stages every dirty + untracked
 * path then commits.  Kept around for the "Commit all" button until
 * the per-row multi-select flow is the only UI.
 */
export async function vcsCommitAll(
  vaultPath: string,
  message: string,
): Promise<string> {
  if (!isTauri()) return '';
  return invoke<string>("vcs_commit_all", { vaultPath, message });
}

/** `limit = 0` means "no limit" (capped to 500 by Rust). */
export async function vcsLog(
  vaultPath: string,
  limit: number,
): Promise<CommitInfo[]> {
  if (!isTauri()) return [];
  return invoke<CommitInfo[]>("vcs_log", { vaultPath, limit });
}

/**
 * Unified diff for one path.  `staged=false` (default) returns the
 * worktree-vs-index diff; `staged=true` returns the index-vs-HEAD diff.
 */
export async function vcsDiffFile(
  vaultPath: string,
  relPath: string,
  staged?: boolean,
): Promise<string> {
  if (!isTauri()) return '';
  return invoke<string>("vcs_diff_file", { vaultPath, relPath, staged });
}

/**
 * Discard a single file's worktree changes (restore from index).
 * Untracked files are recycled.  Kept for the per-row Discard button.
 */
export async function vcsCheckoutFile(
  vaultPath: string,
  relPath: string,
): Promise<void> {
  if (!isTauri()) return;
  return invoke<void>("vcs_checkout_file", { vaultPath, relPath });
}

// ─── Slice B: branches + graph ────────────────────────────────────────

/**
 * List every branch the repo knows about (locals + remote-tracking).
 * Already sorted: current first, then locals by recency, then remotes
 * by recency.  One subprocess (`git for-each-ref`), cheap to refresh.
 */
export async function vcsBranches(vaultPath: string): Promise<BranchInfo[]> {
  if (!isTauri()) return [];
  return invoke<BranchInfo[]>("vcs_branches", { vaultPath });
}

/**
 * Create a new local branch.  `checkout=true` does atomic create+switch
 * (`git switch -c`); otherwise the branch is created without changing
 * HEAD.  `startPoint` defaults to HEAD.  Returns the post-op status so
 * the panel can update branch + working changes in one render.
 */
export async function vcsBranchCreate(
  vaultPath: string,
  name: string,
  startPoint?: string,
  checkout?: boolean,
): Promise<VcsStatus> {
  if (!isTauri()) return { initialized: false, branch: null, headShort: null, ahead: null, behind: null, staged: [], unstaged: [], untracked: [] };
  return invoke<VcsStatus>("vcs_branch_create", {
    vaultPath,
    name,
    startPoint,
    checkout,
  });
}

/**
 * Switch to an existing local branch.  Fails fast with the raw git
 * error string when the worktree has changes that would conflict —
 * the UI catches this and offers stash / commit before retrying.
 */
export async function vcsBranchSwitch(
  vaultPath: string,
  name: string,
): Promise<VcsStatus> {
  if (!isTauri()) return { initialized: false, branch: null, headShort: null, ahead: null, behind: null, staged: [], unstaged: [], untracked: [] };
  return invoke<VcsStatus>("vcs_branch_switch", { vaultPath, name });
}

/**
 * Delete a local branch.  `force=true` deletes even unmerged branches
 * (`git branch -D`); otherwise unmerged branches are rejected so the
 * user can decide.
 */
export async function vcsBranchDelete(
  vaultPath: string,
  name: string,
  force?: boolean,
): Promise<VcsStatus> {
  if (!isTauri()) return { initialized: false, branch: null, headShort: null, ahead: null, behind: null, staged: [], unstaged: [], untracked: [] };
  return invoke<VcsStatus>("vcs_branch_delete", { vaultPath, name, force });
}

/**
 * Full DAG log for the graph view.  Includes every branch tip
 * (`--all`) and decorates each commit with its refs (`HEAD -> main`,
 * `origin/main`, `tag: v0.1.0`).  Lane assignment happens client-side
 * (see `src/lib/gitGraph.ts`).
 *
 * `limit=0` means "default" (500); the Rust side hard-caps at 1000.
 */
export async function vcsLogGraph(
  vaultPath: string,
  limit: number,
): Promise<GraphCommit[]> {
  if (!isTauri()) return [];
  return invoke<GraphCommit[]>("vcs_log_graph", { vaultPath, limit });
}

// ─── Helpers ──────────────────────────────────────────────────────────

/** Total count of dirty files across all sections (for the dirty badge). */
export function totalDirtyCount(status: VcsStatus | null): number {
  if (!status) return 0;
  return (
    status.staged.length + status.unstaged.length + status.untracked.length
  );
}

/**
 * Human-readable short label for a porcelain v2 XY code (one section
 * at a time — caller already knows which side the entry lives on).
 *
 * Examples:  "M." → "Modified"   ".D" → "Deleted"   "??" → "Untracked"
 *            "R." → "Renamed"    "UU" → "Both modified"
 */
export function statusLabel(code: string): string {
  if (code === "??") return "Untracked";
  // Conflict codes (porcelain v2 emits raw 2-letter codes for u entries).
  switch (code) {
    case "DD":
      return "Both deleted";
    case "AU":
      return "Added by us";
    case "UD":
      return "Deleted by them";
    case "UA":
      return "Added by them";
    case "DU":
      return "Deleted by us";
    case "AA":
      return "Both added";
    case "UU":
      return "Both modified";
  }
  // Normalised single-letter (other side is "." or " ").
  const letter = code.replace(/[\.\s]/g, "")[0] ?? "?";
  switch (letter) {
    case "M":
      return "Modified";
    case "A":
      return "Added";
    case "D":
      return "Deleted";
    case "R":
      return "Renamed";
    case "C":
      return "Copied";
    case "T":
      return "Type changed";
    case "U":
      return "Unmerged";
    default:
      return code;
  }
}

/** Single-letter glyph for the per-row icon. */
export function statusGlyph(code: string): string {
  if (code === "??") return "U";
  if (code.length === 2 && code !== code.replace(/[\.\s]/g, "")) {
    return code.replace(/[\.\s]/g, "")[0] ?? "?";
  }
  return code[0] ?? "?";
}

