/**
 * VCS — frontend store.
 *
 * Owns the cached `VcsStatus` snapshot (staged / unstaged / untracked)
 * plus refresh/commit/init/stage/unstage/discard flags.  Components
 * (ChangesPanel, StatusPill, LeftSidebar) subscribe to this store; the
 * heavy git work all happens in Rust via `git_*` / `vcs_*` IPC, which
 * shells out to the system `git` binary.
 *
 * Design notes:
 *   - The snapshot is small enough to live in memory permanently and
 *     a re-fetch is fast (<50ms with `core.fsmonitor=true`), so we
 *     don't bother with partial caching.
 *   - Refresh is debounced 250ms — coalesces a burst of saves into
 *     one IPC roundtrip; sub-second status lag is imperceptible.
 *   - Errors are sticky: `doRefresh` NEVER touches `lastError`.  Only
 *     commit/init/stage/unstage/discard clear it at the start of the
 *     op.  Reason: a transient `git status` race shouldn't wipe the
 *     "auth failed" message the user is still reading.
 *   - The store is intentionally NOT auto-wired to `vaultStore` — App
 *     calls `refresh()` explicitly on vault changes.  One wire-up site.
 */
import { create } from "zustand";
import {
  vcsBranchCreate,
  vcsBranchDelete,
  vcsBranches,
  vcsBranchSwitch,
  vcsCheckoutFile,
  vcsCommit,
  vcsCommitAll,
  vcsDiffFile,
  vcsDiscard,
  vcsInit,
  vcsLog,
  vcsLogGraph,
  vcsPreviewUntrackedCount,
  vcsStage,
  vcsStatus,
  vcsUnstage,
  totalDirtyCount,
  type BranchInfo,
  type CommitInfo,
  type GraphCommit,
  type VcsStatus,
} from "../lib/vcs";

/** Per-vault cache, scrubbed when we point at a new vault. */
interface VcsState {
  /** Latest snapshot.  Null until first successful refresh. */
  status: VcsStatus | null;
  /** Most recent log we fetched (history panel uses this). */
  history: CommitInfo[];
  /** Vault path the cached status/history was computed for. */
  cacheKey: string | null;
  /** ms epoch of the last successful refresh; drives "Just now" labels. */
  lastRefresh: number | null;
  /** True while an IPC fetch is in flight (drives the spinner). */
  refreshing: boolean;
  /** True while a commit is being written. */
  committing: boolean;
  /** True while `vcs_init` is running. */
  initializing: boolean;
  /**
   * True while any per-file staging op is in flight.  We don't track
   * which specific files are pending — the IPC roundtrip is fast
   * enough (sub-100ms) that a transient "Working…" disable on the
   * affected section is enough feedback.
   */
  staging: boolean;
  /** Most recent error string; null when the last op succeeded. */
  lastError: string | null;

  /**
   * For not-yet-initialised vaults only: count of files that would
   * be committed by `vcs_init`.  Lazily populated by
   * `refreshUntrackedPreview` so the not-tracked CTA can say
   * "Enable & commit 247 files" without walking the worktree on
   * every status refresh.  Cleared on vault switch / init success.
   */
  untrackedPreviewCount: number | null;

  // ── Slice B: branches + graph ──
  /** All branches the repo knows about (locals + remotes).  Lazy. */
  branches: BranchInfo[];
  /** Full DAG (all branches, decorated) — feeds the GitGraph view. */
  graphHistory: GraphCommit[];
  /** True while a branch op (create/switch/delete) is in flight. */
  branchOp: boolean;

  // ── Actions ──
  refresh: (vaultPath: string | null) => Promise<void>;
  refreshHistory: (vaultPath: string | null, limit?: number) => Promise<void>;
  /** Lazy: walks all refs in one subprocess.  Cheap. */
  refreshBranches: (vaultPath: string | null) => Promise<void>;
  /** Lazy: fetches the full --all --decorate DAG for the GitGraph. */
  refreshGraph: (vaultPath: string | null, limit?: number) => Promise<void>;
  /** Walk the worktree (no hashing) just to count files for the CTA. */
  refreshUntrackedPreview: (vaultPath: string | null) => Promise<void>;
  init: (vaultPath: string) => Promise<void>;

  /** Stage one or more vault-relative paths (`git add`). */
  stageFiles: (vaultPath: string, paths: string[]) => Promise<void>;
  /** Unstage one or more paths (`git restore --staged`). */
  unstageFiles: (vaultPath: string, paths: string[]) => Promise<void>;
  /**
   * Discard local edits to one or more paths.  Tracked files are
   * restored from the index; untracked files go to the system
   * recycle bin (Rust uses the `trash` crate — never hard-delete).
   */
  discardFiles: (vaultPath: string, paths: string[]) => Promise<void>;

  /**
   * Commit whatever is currently staged.  Frontend stages first via
   * `stageFiles` so this is a pure "snapshot the index" op.  Returns
   * the new 7-char short sha, or null on failure.
   */
  commitStaged: (
    vaultPath: string,
    message: string,
  ) => Promise<string | null>;

  /**
   * Legacy commit-everything shortcut: stages every dirty/untracked
   * file then commits.  Kept for the "Commit all" path until the
   * UI fully drives the per-file flow.
   */
  commit: (vaultPath: string, message: string) => Promise<string | null>;

  diffFile: (
    vaultPath: string,
    relPath: string,
    staged?: boolean,
  ) => Promise<string>;
  /** Legacy single-file discard (per-row Discard button). */
  discardFile: (vaultPath: string, relPath: string) => Promise<void>;

  // ── Slice B: branch actions ──
  /** Create a new local branch.  `checkout=true` also switches. */
  createBranch: (
    vaultPath: string,
    name: string,
    opts?: { startPoint?: string; checkout?: boolean },
  ) => Promise<boolean>;
  /** Switch to an existing local branch. */
  switchBranch: (vaultPath: string, name: string) => Promise<boolean>;
  /** Delete a local branch (`force=true` for unmerged). */
  deleteBranch: (
    vaultPath: string,
    name: string,
    opts?: { force?: boolean },
  ) => Promise<boolean>;

  /**
   * Dismiss the currently-displayed error.  Errors are sticky by
   * design — they stay on screen across subsequent refreshes so the
   * user has time to read / copy them — so we need an explicit
   * action to clear one.  Called from the error card's close button.
   */
  clearError: () => void;
  /** Reset state — called when the user switches vaults. */
  reset: () => void;
}

// 250ms feels live-but-not-thrashy.  Any debounce window > ~150ms
// keeps our CPU off the critical path when the user is mashing Ctrl+S.
const REFRESH_DEBOUNCE_MS = 250;

// Module-level debounce timer.  Lives outside the store because we
// want to cancel/coalesce regardless of which component triggered it.
let debounceHandle: ReturnType<typeof setTimeout> | null = null;
let pendingVault: string | null = null;

export const useVcsStore = create<VcsState>((set, get) => {
  /**
   * Actual fetch — only run after the debounce window elapses.
   * Critically: only clears `lastError` on the *first* successful
   * fetch when there's no existing snapshot; a transient failure
   * mid-session leaves any prior error sticky for the user to read.
   */
  const doRefresh = async (vaultPath: string | null) => {
    if (!vaultPath) {
      set({
        status: null,
        history: [],
        cacheKey: null,
        lastRefresh: null,
        refreshing: false,
        untrackedPreviewCount: null,
      });
      return;
    }
    set({ refreshing: true });
    try {
      const status = await vcsStatus(vaultPath);
      set({
        status,
        cacheKey: vaultPath,
        lastRefresh: Date.now(),
        refreshing: false,
        // If the vault is now initialised, the preview count is
        // moot — clear it so a stale "247" doesn't haunt a freshly-
        // committed empty changes list.
        ...(status.initialized ? { untrackedPreviewCount: null } : {}),
      });
    } catch (err) {
      // Only surface the error if we have nothing to show — silent
      // background errors are fine when a cached view exists.
      const s = get();
      if (s.status == null) {
        set({ refreshing: false, lastError: String(err) });
      } else {
        set({ refreshing: false });
      }
      console.error("vcs_status failed:", err);
    }
  };

  /**
   * After every write op, kick a status refresh so the UI reflects
   * reality immediately — no debounce here because the user just
   * took an explicit action and expects instant feedback.
   */
  const refreshNow = (vaultPath: string) => doRefresh(vaultPath);

  return {
    status: null,
    history: [],
    cacheKey: null,
    lastRefresh: null,
    refreshing: false,
    committing: false,
    initializing: false,
    staging: false,
    lastError: null,
    untrackedPreviewCount: null,
    branches: [],
    graphHistory: [],
    branchOp: false,

    refresh: async (vaultPath) => {
      // Debounce: if a caller fires refresh() 10 times in 200ms, we
      // run it exactly once at the trailing edge.  The most recent
      // vaultPath wins, which is correct when the user switches
      // vaults mid-save.
      pendingVault = vaultPath;
      if (debounceHandle) clearTimeout(debounceHandle);
      await new Promise<void>((resolve) => {
        debounceHandle = setTimeout(async () => {
          debounceHandle = null;
          await doRefresh(pendingVault);
          resolve();
        }, REFRESH_DEBOUNCE_MS);
      });
    },

    refreshHistory: async (vaultPath, limit = 100) => {
      if (!vaultPath) {
        set({ history: [] });
        return;
      }
      try {
        const history = await vcsLog(vaultPath, limit);
        set({ history });
      } catch (err) {
        console.error("vcs_log failed:", err);
      }
    },

    refreshBranches: async (vaultPath) => {
      if (!vaultPath) {
        set({ branches: [] });
        return;
      }
      try {
        const branches = await vcsBranches(vaultPath);
        set({ branches });
      } catch (err) {
        // Non-fatal: the Branches panel falls back to an empty list
        // with the error surfaced inline.  Don't stomp `lastError`
        // here — branch reads happen on every panel open and a flaky
        // refresh shouldn't wipe the user's commit error.
        console.error("vcs_branches failed:", err);
      }
    },

    refreshGraph: async (vaultPath, limit = 200) => {
      if (!vaultPath) {
        set({ graphHistory: [] });
        return;
      }
      try {
        const graphHistory = await vcsLogGraph(vaultPath, limit);
        set({ graphHistory });
      } catch (err) {
        console.error("vcs_log_graph failed:", err);
      }
    },

    refreshUntrackedPreview: async (vaultPath) => {
      if (!vaultPath) {
        set({ untrackedPreviewCount: null });
        return;
      }
      try {
        const n = await vcsPreviewUntrackedCount(vaultPath);
        set({ untrackedPreviewCount: n });
      } catch (err) {
        // Non-fatal — the CTA falls back to a generic label.
        console.error("vcs_preview_untracked_count failed:", err);
      }
    },

    init: async (vaultPath) => {
      set({ initializing: true, lastError: null });
      try {
        const status = await vcsInit(vaultPath);
        set({
          status,
          cacheKey: vaultPath,
          lastRefresh: Date.now(),
          initializing: false,
          untrackedPreviewCount: null,
        });
        // After init, the History panel should show the initial
        // snapshot commit immediately — kick a log refresh.
        void get().refreshHistory(vaultPath);
      } catch (err) {
        set({ initializing: false, lastError: String(err) });
        console.error("vcs_init failed:", err);
      }
    },

    stageFiles: async (vaultPath, paths) => {
      if (paths.length === 0) return;
      set({ staging: true, lastError: null });
      try {
        const status = await vcsStage(vaultPath, paths);
        set({
          status,
          cacheKey: vaultPath,
          lastRefresh: Date.now(),
          staging: false,
        });
      } catch (err) {
        set({ staging: false, lastError: String(err) });
        console.error("vcs_stage failed:", err);
      }
    },

    unstageFiles: async (vaultPath, paths) => {
      if (paths.length === 0) return;
      set({ staging: true, lastError: null });
      try {
        const status = await vcsUnstage(vaultPath, paths);
        set({
          status,
          cacheKey: vaultPath,
          lastRefresh: Date.now(),
          staging: false,
        });
      } catch (err) {
        set({ staging: false, lastError: String(err) });
        console.error("vcs_unstage failed:", err);
      }
    },

    discardFiles: async (vaultPath, paths) => {
      if (paths.length === 0) return;
      set({ staging: true, lastError: null });
      try {
        const status = await vcsDiscard(vaultPath, paths);
        set({
          status,
          cacheKey: vaultPath,
          lastRefresh: Date.now(),
          staging: false,
        });
      } catch (err) {
        set({ staging: false, lastError: String(err) });
        console.error("vcs_discard failed:", err);
      }
    },

    commitStaged: async (vaultPath, message) => {
      set({ committing: true, lastError: null });
      try {
        const shortSha = await vcsCommit(vaultPath, message);
        await refreshNow(vaultPath);
        void get().refreshHistory(vaultPath);
        set({ committing: false });
        return shortSha;
      } catch (err) {
        set({ committing: false, lastError: String(err) });
        console.error("vcs_commit failed:", err);
        return null;
      }
    },

    commit: async (vaultPath, message) => {
      set({ committing: true, lastError: null });
      try {
        const shortSha = await vcsCommitAll(vaultPath, message);
        // Refresh status (now empty) and history (new top commit).
        // Two tiny IPC calls; user latency is dominated by the
        // commit itself anyway.
        await refreshNow(vaultPath);
        void get().refreshHistory(vaultPath);
        set({ committing: false });
        return shortSha;
      } catch (err) {
        set({ committing: false, lastError: String(err) });
        console.error("vcs_commit_all failed:", err);
        return null;
      }
    },

    diffFile: async (vaultPath, relPath, staged) => {
      try {
        return await vcsDiffFile(vaultPath, relPath, staged);
      } catch (err) {
        console.error("vcs_diff_file failed:", err);
        return "";
      }
    },

    discardFile: async (vaultPath, relPath) => {
      try {
        await vcsCheckoutFile(vaultPath, relPath);
        await refreshNow(vaultPath);
      } catch (err) {
        set({ lastError: String(err) });
        console.error("vcs_checkout_file failed:", err);
      }
    },

    // ── Slice B: branch ops ──
    //
    // All three follow the same pattern:
    //   1. set branchOp=true + clear lastError
    //   2. fire the IPC; the Rust handler returns the post-op
    //      VcsStatus so we get the fresh HEAD-branch name for free
    //   3. write that status into the store
    //   4. kick refreshes for branches + graph (parallel, fire-and-
    //      forget) so the UI reflects the new world atomically
    //
    // We return a boolean instead of throwing so the calling
    // component can decide whether to dismiss its inline form / show
    // a toast — `lastError` is the source of truth for the message.

    createBranch: async (vaultPath, name, opts) => {
      set({ branchOp: true, lastError: null });
      try {
        const status = await vcsBranchCreate(
          vaultPath,
          name,
          opts?.startPoint,
          opts?.checkout ?? false,
        );
        set({
          status,
          cacheKey: vaultPath,
          lastRefresh: Date.now(),
          branchOp: false,
        });
        void get().refreshBranches(vaultPath);
        void get().refreshGraph(vaultPath);
        return true;
      } catch (err) {
        set({ branchOp: false, lastError: String(err) });
        console.error("vcs_branch_create failed:", err);
        return false;
      }
    },

    switchBranch: async (vaultPath, name) => {
      set({ branchOp: true, lastError: null });
      try {
        const status = await vcsBranchSwitch(vaultPath, name);
        set({
          status,
          cacheKey: vaultPath,
          lastRefresh: Date.now(),
          branchOp: false,
        });
        // After a switch the working tree may look very different —
        // refresh branches (for the ahead/behind numbers vs the new
        // upstream) and the graph (for HEAD movement).
        void get().refreshBranches(vaultPath);
        void get().refreshGraph(vaultPath);
        return true;
      } catch (err) {
        set({ branchOp: false, lastError: String(err) });
        console.error("vcs_branch_switch failed:", err);
        return false;
      }
    },

    deleteBranch: async (vaultPath, name, opts) => {
      set({ branchOp: true, lastError: null });
      try {
        const status = await vcsBranchDelete(vaultPath, name, opts?.force ?? false);
        set({
          status,
          cacheKey: vaultPath,
          lastRefresh: Date.now(),
          branchOp: false,
        });
        void get().refreshBranches(vaultPath);
        void get().refreshGraph(vaultPath);
        return true;
      } catch (err) {
        set({ branchOp: false, lastError: String(err) });
        console.error("vcs_branch_delete failed:", err);
        return false;
      }
    },

    clearError: () => {
      set({ lastError: null });
    },

    reset: () => {
      if (debounceHandle) {
        clearTimeout(debounceHandle);
        debounceHandle = null;
      }
      set({
        status: null,
        history: [],
        cacheKey: null,
        lastRefresh: null,
        refreshing: false,
        committing: false,
        initializing: false,
        staging: false,
        lastError: null,
        untrackedPreviewCount: null,
        branches: [],
        graphHistory: [],
        branchOp: false,
      });
    },
  };
});

/**
 * Convenience selector: count of dirty files for the StatusPill badge.
 * Sums all three sections (staged + unstaged + untracked).  Memoised
 * at component level by zustand's referential equality on the
 * primitive return value.
 */
export const selectDirtyCount = (s: VcsState): number =>
  totalDirtyCount(s.status);
