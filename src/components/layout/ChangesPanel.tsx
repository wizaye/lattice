import { useEffect, useMemo, useRef, useState } from "react";
import { useVaultStore } from "../../state/vaultStore";
import { useVcsStore } from "../../state/vcsStore";
import { useBYOCStore, type ProviderRowState } from "../../state/byocStore";
import {
  statusGlyph,
  statusLabel,
  type BranchInfo,
  type FileChange,
} from "../../lib/vcs";
import type { ProviderId } from "../../lib/byoc";
import {
  IcCheck,
  IcClose,
  IcCloud,
  IcCopy,
  IcDiff,
  IcDiscard,
  IcGitBranch,
  IcGitCommit,
  IcHistory,
  IcRefresh,
  IcSparkle,
} from "../common/Icons";
import { GitGraph } from "./GitGraph";
import "./ChangesPanel.css";

/**
 * Changes panel — left-sidebar view that owns BOTH the local VCS
 * surface (working changes, history, branches) AND the BYOC sync
 * pipeline (GitHub / GDrive / OneDrive / Dropbox / iCloud / WebDAV).
 *
 * # Layout (real-git-shaped)
 *
 * Working changes is split into three collapsible sub-sections that
 * mirror git's actual data model:
 *
 *   ┌─ Staged    ── X files ──┐  what `git commit` will record
 *   ├─ Unstaged  ── Y files ──┤  worktree edits not yet `git add`-ed
 *   └─ Untracked ── Z files ──┘  files git doesn't know about
 *
 * Per-row checkboxes support multi-select (click, ctrl-click,
 * shift-click range).  Each section gets its own "select all"
 * checkbox and "+" / "−" affordance:
 *
 *   - Untracked / Unstaged "+" → stage selected (`git add`)
 *   - Staged           "−" → unstage selected (`git restore --staged`)
 *   - Any section      "⌫" → discard selected (restore from index /
 *                            recycle bin for untracked)
 *
 * The Commit button stays disabled until at least one row is staged —
 * matches every other git GUI and prevents accidental "commit all".
 *
 * All heavy work runs in Rust; this component is a thin renderer over
 * `useVcsStore`.  Status refresh is debounced inside the store so a
 * flurry of saves doesn't thrash the IPC.
 */
export function ChangesPanel() {
  const vaultPath = useVaultStore((s) => s.vaultPath);

  const status = useVcsStore((s) => s.status);
  const history = useVcsStore((s) => s.history);
  const graphHistory = useVcsStore((s) => s.graphHistory);
  const branches = useVcsStore((s) => s.branches);
  const branchOp = useVcsStore((s) => s.branchOp);
  const refreshing = useVcsStore((s) => s.refreshing);
  const committing = useVcsStore((s) => s.committing);
  const initializing = useVcsStore((s) => s.initializing);
  const staging = useVcsStore((s) => s.staging);
  const lastError = useVcsStore((s) => s.lastError);
  const historyError = useVcsStore((s) => s.historyError);
  const graphError = useVcsStore((s) => s.graphError);
  const untrackedPreviewCount = useVcsStore((s) => s.untrackedPreviewCount);

  const refresh = useVcsStore((s) => s.refresh);
  const refreshHistory = useVcsStore((s) => s.refreshHistory);
  const refreshGraph = useVcsStore((s) => s.refreshGraph);
  const refreshBranches = useVcsStore((s) => s.refreshBranches);
  const refreshUntrackedPreview = useVcsStore(
    (s) => s.refreshUntrackedPreview,
  );
  const initRepo = useVcsStore((s) => s.init);
  const stageFiles = useVcsStore((s) => s.stageFiles);
  const unstageFiles = useVcsStore((s) => s.unstageFiles);
  const discardFiles = useVcsStore((s) => s.discardFiles);
  const commitStaged = useVcsStore((s) => s.commitStaged);
  const commitAll = useVcsStore((s) => s.commit);
  const createBranch = useVcsStore((s) => s.createBranch);
  const switchBranch = useVcsStore((s) => s.switchBranch);
  const deleteBranch = useVcsStore((s) => s.deleteBranch);
  const clearError = useVcsStore((s) => s.clearError);

  const [message, setMessage] = useState("");
  // Selection state — one Set per section.  Strings (paths) so that
  // re-renders from a status refresh preserve the user's selection
  // for rows that still exist; gone rows simply drop out naturally.
  const [stagedSel, setStagedSel] = useState<Set<string>>(new Set());
  const [unstagedSel, setUnstagedSel] = useState<Set<string>>(new Set());
  const [untrackedSel, setUntrackedSel] = useState<Set<string>>(new Set());
  // Anchor for shift-click range selection — one per section.  Cleared
  // whenever the underlying list changes shape (path additions/removals).
  const stagedAnchor = useRef<string | null>(null);
  const unstagedAnchor = useRef<string | null>(null);
  const untrackedAnchor = useRef<string | null>(null);

  // True for ~1.5s after the user clicks "Copy" on the error card so
  // we can flip the label to "Copied!" as a confirmation pulse.  Lives
  // in component state because it's purely visual.
  const [errorCopied, setErrorCopied] = useState(false);
  // Track whether the user has manually expanded History so we only
  // fetch the log the first time it's opened — keeps the initial
  // ChangesPanel paint cheap.
  const historyFetchedFor = useRef<string | null>(null);
  // Same lazy-once pattern for the Branches panel; the IPC is cheap
  // but we still want to defer it until the user actually opens the
  // section.
  const branchesFetchedFor = useRef<string | null>(null);

  // Fetch the log the first time History is rendered for this vault,
  // or whenever the cache key drifts (user switched vaults).
  //
  // We deliberately fetch BOTH the flat `vcs_log` (cheap; powers the
  // CommitInfo metadata cache) and the decorated `vcs_log_graph`
  // (slightly more expensive; powers the GitGraph DAG view) in
  // parallel.  They're tiny IPC calls and racing them lets the
  // GitGraph show up without a perceived second hop.
  const onHistoryToggle = (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    if (!e.currentTarget.open) return;
    if (!vaultPath) return;
    if (historyFetchedFor.current === vaultPath) return;
    historyFetchedFor.current = vaultPath;
    void refreshHistory(vaultPath, 100);
    void refreshGraph(vaultPath, 200);
  };

  const onBranchesToggle = (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    if (!e.currentTarget.open) return;
    if (!vaultPath) return;
    if (branchesFetchedFor.current === vaultPath) return;
    branchesFetchedFor.current = vaultPath;
    void refreshBranches(vaultPath);
  };

  // Force a fresh history+graph fetch.  Wired to the Retry / Refresh
  // buttons in the History empty-state cards (see below).  Clears
  // the per-vault gate so the auto-fetch useEffect would also
  // re-fire on the next render \u2014 belt + braces.
  const onHistoryRetry = () => {
    if (!vaultPath) return;
    historyFetchedFor.current = null;
    void refreshHistory(vaultPath, 100);
    void refreshGraph(vaultPath, 200);
  };

  // Extract sections via memo so the body of the component stays
  // declarative; cheap (just array refs from the snapshot).
  const staged = useMemo<FileChange[]>(() => status?.staged ?? [], [status]);
  const unstaged = useMemo<FileChange[]>(
    () => status?.unstaged ?? [],
    [status],
  );
  const untracked = useMemo<FileChange[]>(
    () => status?.untracked ?? [],
    [status],
  );
  const totalCount = staged.length + unstaged.length + untracked.length;
  const initialised = status?.initialized ?? false;

  // ── BYOC sync wiring ─────────────────────────────────────────────
  //
  // The store keeps row state per (vault, provider).  We auto-load the
  // provider catalogue once at boot and refresh status whenever the
  // vault changes OR the user enables VCS (since sync gates on having
  // a git repo to push).
  const byocProviders = useBYOCStore((s) => s.providers);
  const byocLoadProviders = useBYOCStore((s) => s.loadProviders);
  const byocRefresh = useBYOCStore((s) => s.refresh);
  const byocConnectAction = useBYOCStore((s) => s.connect);
  const byocDisconnectAction = useBYOCStore((s) => s.disconnect);
  const byocSyncNowAction = useBYOCStore((s) => s.syncNow);
  const byocPushAction = useBYOCStore((s) => s.push);
  const byocPullAction = useBYOCStore((s) => s.pull);
  const byocStorageInfoAction = useBYOCStore((s) => s.storageInfo);
  const byocRemoteUrlAction = useBYOCStore((s) => s.remoteUrl);
  const byocManifestPathAction = useBYOCStore((s) => s.manifestPath);
  const byocRowFor = useBYOCStore((s) => s.rowFor);
  // Subscribe to the rows map itself so the panel re-renders when
  // any provider's state changes (connect / sync / disconnect).
  // Without this, `byocRowFor` is a stable function reference and
  // zustand never notifies us of row mutations — the UI would freeze
  // on the pre-click state forever.  We don't read this directly;
  // it's a re-render trigger.
  useBYOCStore((s) => s.rows);
  const pendingDeviceCode = useBYOCStore((s) => s.pendingDeviceCode);
  const clearDeviceCode = useBYOCStore((s) => s.clearDeviceCode);

  useEffect(() => {
    void byocLoadProviders();
  }, [byocLoadProviders]);

  useEffect(() => {
    if (!initialised) return;
    if (!vaultPath) return;
    void byocRefresh(vaultPath);
  }, [vaultPath, initialised, byocRefresh]);

  // Auto-fetch history + graph as soon as the panel knows the vault is
  // initialised — independent of whether the user has expanded the
  // History `<details>`.  Two reasons this can't wait for `onToggle`:
  //   1. The History section is now open-by-default (so users SEE
  //      their commits after an app restart instead of staring at a
  //      collapsed summary and assuming the app forgot their work).
  //      `onToggle` only fires on user interaction, not on initial
  //      render of an already-open <details>.
  //   2. The Zustand store is in-memory only.  After a restart it
  //      starts empty, so even if the section is open we'd show the
  //      "No commits yet" empty-state until the user clicked refresh.
  //
  // App-level vault-change effect (see `src/App.tsx`) ALSO primes
  // the store on vault open so this panel feels instant when the
  // user navigates to it for the first time.  Both paths are
  // idempotent: the `historyFetchedFor` ref + the store's own
  // `cacheKey` guard against duplicate IPCs.
  //
  // The `historyFetchedFor` ref still gates the call so we don't
  // re-hit the IPC on every render — exactly the same once-per-vault
  // semantics the toggle handler enforces.
  useEffect(() => {
    if (!vaultPath) {
      // Vault closed / mock vault — clear the per-vault gates so
      // re-opening the SAME vault path later re-fetches (otherwise
      // the ref would still point at that path and the next mount
      // would think it had already fetched).
      historyFetchedFor.current = null;
      branchesFetchedFor.current = null;
      return;
    }
    if (!initialised) return;
    if (historyFetchedFor.current === vaultPath) return;
    historyFetchedFor.current = vaultPath;
    void refreshHistory(vaultPath, 100);
    void refreshGraph(vaultPath, 200);
  }, [vaultPath, initialised, refreshHistory, refreshGraph]);

  // Same auto-fetch pattern for Branches.  The Branches section is
  // open-by-default (see the JSX below) so users land on a populated
  // list after vault open / app restart instead of an empty card
  // they have to expand + refresh to populate.  `vcs_branches` is a
  // single `git for-each-ref` call — cheap enough to fire eagerly
  // alongside the history warm-up.
  useEffect(() => {
    if (!vaultPath) return;
    if (!initialised) return;
    if (branchesFetchedFor.current === vaultPath) return;
    branchesFetchedFor.current = vaultPath;
    void refreshBranches(vaultPath);
  }, [vaultPath, initialised, refreshBranches]);

  // When we discover the vault isn't tracked, fetch the preview count
  // ONCE per vault so the Enable CTA can show "Enable & commit N files"
  // without us walking the worktree on every status refresh.
  useEffect(() => {
    if (!vaultPath) return;
    if (initialised) return;
    if (untrackedPreviewCount !== null) return;
    void refreshUntrackedPreview(vaultPath);
  }, [vaultPath, initialised, untrackedPreviewCount, refreshUntrackedPreview]);

  // Prune selection sets whenever the underlying lists change so we
  // don't carry around stale paths (which would silently inflate
  // selectedCount and break "select all" math).
  useEffect(() => {
    const live = new Set(staged.map((c) => c.path));
    setStagedSel((s) => filterSet(s, live));
  }, [staged]);
  useEffect(() => {
    const live = new Set(unstaged.map((c) => c.path));
    setUnstagedSel((s) => filterSet(s, live));
  }, [unstaged]);
  useEffect(() => {
    const live = new Set(untracked.map((c) => c.path));
    setUntrackedSel((s) => filterSet(s, live));
  }, [untracked]);

  // ── Handlers ────────────────────────────────────────────────────────

  const onInit = async () => {
    if (!vaultPath) return;
    await initRepo(vaultPath);
  };

  const onCommit = async () => {
    if (!vaultPath) return;
    if (!initialised) return;
    if (staged.length === 0) return;
    if (!message.trim()) return;
    const shortSha = await commitStaged(vaultPath, message.trim());
    if (shortSha) setMessage("");
  };

  /**
   * "Commit all" fast-path — stage everything then commit in one
   * batch.  Used when nothing is staged but the user still wants to
   * snapshot what's there.  Mirrors `git commit -a` + add untracked.
   */
  const onCommitAll = async () => {
    if (!vaultPath) return;
    if (!initialised) return;
    if (totalCount === 0) return;
    if (!message.trim()) return;
    const shortSha = await commitAll(vaultPath, message.trim());
    if (shortSha) setMessage("");
  };

  /** Stage everything currently selected in unstaged + untracked. */
  const onStageSelected = async () => {
    if (!vaultPath) return;
    const paths = [...unstagedSel, ...untrackedSel];
    if (paths.length === 0) return;
    await stageFiles(vaultPath, paths);
    setUnstagedSel(new Set());
    setUntrackedSel(new Set());
  };

  /** Unstage everything currently selected in staged. */
  const onUnstageSelected = async () => {
    if (!vaultPath || stagedSel.size === 0) return;
    await unstageFiles(vaultPath, Array.from(stagedSel));
    setStagedSel(new Set());
  };

  /** Discard everything currently selected across all three sections. */
  const onDiscardSelected = async () => {
    if (!vaultPath) return;
    const paths = [...stagedSel, ...unstagedSel, ...untrackedSel];
    if (paths.length === 0) return;
    const trackedCount = stagedSel.size + unstagedSel.size;
    const untrackedCount = untrackedSel.size;
    const confirmed = window.confirm(
      `Discard ${paths.length} file${paths.length === 1 ? "" : "s"}?\n\n` +
        (trackedCount > 0
          ? `${trackedCount} tracked file${trackedCount === 1 ? "" : "s"} will be restored from the last commit.\n`
          : "") +
        (untrackedCount > 0
          ? `${untrackedCount} untracked file${untrackedCount === 1 ? "" : "s"} will be sent to the recycle bin.\n`
          : "") +
        `\nThis cannot be undone via Undo.`,
    );
    if (!confirmed) return;
    await discardFiles(vaultPath, paths);
    setStagedSel(new Set());
    setUnstagedSel(new Set());
    setUntrackedSel(new Set());
  };

  /**
   * Per-row stage handler (no multi-select).  Skipping the selection
   * dance keeps the common "stage this one file" gesture one click.
   */
  const onStageOne = async (path: string) => {
    if (!vaultPath) return;
    await stageFiles(vaultPath, [path]);
  };
  const onUnstageOne = async (path: string) => {
    if (!vaultPath) return;
    await unstageFiles(vaultPath, [path]);
  };
  const onDiscardOne = async (path: string, isUntracked: boolean) => {
    if (!vaultPath) return;
    const confirmed = window.confirm(
      isUntracked
        ? `Send '${path}' to the recycle bin? You can restore it from there.`
        : `Discard local changes to '${path}'? This cannot be undone via Undo.`,
    );
    if (!confirmed) return;
    await discardFiles(vaultPath, [path]);
  };

  // ── Error-card handlers ────────────────────────────────────────────
  // The error card replaces the old plain "<p class='cp-error'>" block.
  // It's deliberately sticky (background refreshes no longer wipe
  // lastError) so users have time to read failures before they vanish,
  // and it surfaces Copy + Retry next to Dismiss so a single click can
  // either escalate or unblock.

  /** Copy the raw error string to the clipboard with a brief pulse. */
  const onCopyError = async () => {
    if (!lastError) return;
    try {
      await navigator.clipboard.writeText(lastError);
      setErrorCopied(true);
      window.setTimeout(() => setErrorCopied(false), 1500);
    } catch {
      // Clipboard API can fail in non-secure contexts; fall back to a
      // hidden textarea + execCommand so the user always has a path.
      const ta = document.createElement("textarea");
      ta.value = lastError;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        setErrorCopied(true);
        window.setTimeout(() => setErrorCopied(false), 1500);
      } finally {
        document.body.removeChild(ta);
      }
    }
  };

  /**
   * Retry whichever IPC most recently failed.  We don't track the
   * exact action, but the only failures that surface here come from
   * commit / init / stage / discard / refresh — and commit is the
   * only one with an obvious "do it again" intent.  Retry calls
   * commitStaged with the current message draft so a transient
   * filesystem hiccup doesn't force the user to re-type anything.
   *
   * If nothing is staged (because the user hit retry from an init or
   * status failure), fall back to refresh — surfaces the actually-
   * correct state to the user without a destructive action.
   */
  const onRetry = async () => {
    if (!vaultPath) return;
    clearError();
    if (initialised && staged.length > 0 && message.trim()) {
      await commitStaged(vaultPath, message.trim());
    } else {
      await refresh(vaultPath);
    }
  };

  const onRefreshClick = () => {
    if (!vaultPath) return;
    void refresh(vaultPath);
    // History / Branches are invalidated by commits, but a manual
    // refresh is also our universal "get unstuck" path \u2014 ALWAYS
    // re-pull both, regardless of whether the per-vault gate had
    // fired before.  Previously we gated this on `*FetchedFor`,
    // which meant a transient first-fetch failure could only be
    // recovered by switching vaults (the gate was set BEFORE the\n    // IPC resolved and stayed burnt on failure).  Cheap calls, no\n    // reason to skip.
    void refreshHistory(vaultPath, 100);
    void refreshGraph(vaultPath, 200);
    void refreshBranches(vaultPath);
  };

  const anyPending = committing || staging || initializing;

  return (
    <div className="cp">
      {/* ===== Working changes ===== */}
      <details className="cp-section" open>
        <summary>
          <span className="cp-summary-row">
            <span className="cp-summary-title">
              <IcDiff /> Working changes
            </span>
            <span className={`cp-badge${totalCount === 0 ? " muted" : ""}`}>
              {totalCount}
            </span>
          </span>
        </summary>

        <div className="cp-section-body">
          {!vaultPath ? (
            <div className="cp-empty">
              <IcGitCommit />
              <span>Open a vault folder to enable version control.</span>
            </div>
          ) : !initialised ? (
            // ── NOT-TRACKED state ────────────────────────────────────
            // Explicit opt-in.  We don't pre-list the worktree as
            // "untracked" rows because:
            //   - It's an implicit action the user didn't authorise.
            //   - A 200-file wall buries the actual CTA.
            //   - On init we'd immediately auto-commit anyway, which
            //     would then make the rows disappear — confusing.
            // So we show a clear status card + one big button.  The
            // file-count comes from a cheap walk-only IPC call gated
            // behind a useEffect so it only fires when this branch
            // actually renders.
            <div className="cp-untracked">
              <div className="cp-untracked-card">
                <div className="cp-untracked-icon" aria-hidden>
                  <IcGitCommit />
                </div>
                <div className="cp-untracked-body">
                  <div className="cp-untracked-title">
                    Version control is off
                  </div>
                  <div className="cp-untracked-desc">
                    {untrackedPreviewCount === null
                      ? "This vault isn't tracked yet."
                      : untrackedPreviewCount === 0
                        ? "This vault isn't tracked yet — it's currently empty."
                        : `This vault isn't tracked yet — ${untrackedPreviewCount} file${untrackedPreviewCount === 1 ? "" : "s"} ready to snapshot.`}
                  </div>
                </div>
              </div>
              <button
                className="cp-btn block primary"
                onClick={onInit}
                disabled={initializing}
                title="Create a .git repository inside the vault and take the first snapshot"
              >
                <IcGitCommit />
                {initializing
                  ? "Enabling…"
                  : untrackedPreviewCount && untrackedPreviewCount > 0
                    ? `Enable version control & commit ${untrackedPreviewCount} file${untrackedPreviewCount === 1 ? "" : "s"}`
                    : "Enable version control"}
              </button>
              <p className="cp-hint">
                Lattice uses standard git under the hood. Your vault
                stays portable — open a terminal afterwards and{" "}
                <code>git log</code> works as you'd expect. Sync
                providers (GitHub, Drive, Dropbox…) become available
                once tracking is on.
              </p>
            </div>
          ) : totalCount === 0 ? (
            <div className="cp-empty">
              <IcCheck />
              <span>No changes since last commit.</span>
            </div>
          ) : (
            <div className="cp-sections">
              <ChangeSection
                title="Staged"
                kind="staged"
                changes={staged}
                selection={stagedSel}
                setSelection={setStagedSel}
                anchorRef={stagedAnchor}
                primaryActionLabel="Unstage"
                onPrimary={onUnstageOne}
                onDiscardOne={(p) => onDiscardOne(p, false)}
                onSelectionPrimary={onUnstageSelected}
                onSelectionDiscard={onDiscardSelected}
                disabled={anyPending}
              />
              <ChangeSection
                title="Unstaged"
                kind="unstaged"
                changes={unstaged}
                selection={unstagedSel}
                setSelection={setUnstagedSel}
                anchorRef={unstagedAnchor}
                primaryActionLabel="Stage"
                onPrimary={onStageOne}
                onDiscardOne={(p) => onDiscardOne(p, false)}
                onSelectionPrimary={onStageSelected}
                onSelectionDiscard={onDiscardSelected}
                disabled={anyPending}
              />
              <ChangeSection
                title="Untracked"
                kind="untracked"
                changes={untracked}
                selection={untrackedSel}
                setSelection={setUntrackedSel}
                anchorRef={untrackedAnchor}
                primaryActionLabel="Stage"
                onPrimary={onStageOne}
                onDiscardOne={(p) => onDiscardOne(p, true)}
                onSelectionPrimary={onStageSelected}
                onSelectionDiscard={onDiscardSelected}
                disabled={anyPending}
              />
            </div>
          )}

          {initialised && totalCount > 0 && (
            <div className="cp-commit-form">
              <textarea
                className="cp-commit-msg"
                placeholder={
                  staged.length > 0
                    ? `Commit message (${staged.length} staged file${staged.length === 1 ? "" : "s"})`
                    : "Commit message"
                }
                rows={2}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                disabled={committing}
              />
              <div className="cp-commit-actions">
                <button
                  className="cp-btn ghost"
                  title="Generate a commit message from the diff (coming soon)"
                  disabled
                >
                  <IcSparkle /> Suggest
                </button>
                <button
                  className="cp-btn ghost"
                  title={
                    totalCount === 0
                      ? "Nothing to commit"
                      : !message.trim()
                        ? "Write a commit message first"
                        : "Stage everything and commit in one step"
                  }
                  onClick={onCommitAll}
                  disabled={
                    anyPending || totalCount === 0 || !message.trim()
                  }
                >
                  Commit all
                </button>
                <button
                  className="cp-btn primary"
                  title={
                    staged.length === 0
                      ? "Stage at least one file first"
                      : !message.trim()
                        ? "Write a commit message first"
                        : "Commit staged changes"
                  }
                  onClick={onCommit}
                  disabled={
                    anyPending || staged.length === 0 || !message.trim()
                  }
                >
                  <IcGitCommit />
                  {committing ? "Committing…" : "Commit staged"}
                </button>
              </div>
            </div>
          )}

          {lastError && (
            <div className="cp-error-card" role="alert" aria-live="polite">
              <div className="cp-error-card-head">
                <span className="cp-error-card-title">Git error</span>
                <button
                  type="button"
                  className="cp-error-card-close"
                  onClick={clearError}
                  aria-label="Dismiss error"
                  title="Dismiss"
                >
                  <IcClose />
                </button>
              </div>
              <pre className="cp-error-card-body">{lastError}</pre>
              <div className="cp-error-card-actions">
                <button
                  type="button"
                  className="cp-btn ghost"
                  onClick={onCopyError}
                  title="Copy the full error to the clipboard"
                >
                  <IcCopy /> {errorCopied ? "Copied!" : "Copy details"}
                </button>
                <button
                  type="button"
                  className="cp-btn ghost"
                  onClick={onRetry}
                  disabled={committing || refreshing}
                  title="Try the operation again"
                >
                  <IcRefresh /> Retry
                </button>
              </div>
            </div>
          )}
        </div>
      </details>

      {/* ===== History (commit graph) ===== */}
      {/*
        Open by default.  Closed-by-default produced a real-world bug
        where users restarted the app, saw a collapsed History summary,
        and assumed their prior commits had been lost — because the
        Zustand store is in-memory and `onToggle` was the only thing
        that ever fired a fetch.  See the `useEffect` above (gated by
        `historyFetchedFor`) which now drives the auto-load.
      */}
      <details className="cp-section" open onToggle={onHistoryToggle}>
        <summary>
          <span className="cp-summary-row">
            <span className="cp-summary-title">
              <IcHistory /> History
            </span>
            <span
              className={`cp-badge${graphHistory.length === 0 ? " muted" : ""}`}
            >
              {graphHistory.length > 0
                ? graphHistory.length
                : history.length > 0
                  ? history.length
                  : "—"}
            </span>
          </span>
        </summary>

        <div className="cp-section-body">
          {!vaultPath ? (
            <div className="cp-empty">
              <IcGitCommit />
              <span>Open a vault folder to see commit history.</span>
            </div>
          ) : !initialised ? (
            // Not-tracked: the CTA lives in Working Changes (open by
            // default).  History just needs to explain why it's empty
            // and point users back up.
            <div className="cp-empty">
              <IcGitCommit />
              <span>
                Enable version control above to start recording history.
              </span>
            </div>
          ) : (historyError || graphError) &&
              graphHistory.length === 0 &&
              history.length === 0 ? (
            // Both log IPCs blew up (or the only one we tried did).
            // Show the raw git error so the user can actually report
            // the problem instead of staring at an "empty" panel.
            // Retry clears the per-vault gates and re-fires both.
            <div className="cp-empty cp-history-error">
              <IcGitCommit />
              <span className="cp-error-title">
                Couldn&apos;t load commit history.
              </span>
              <code className="cp-error-msg">
                {historyError ?? graphError}
              </code>
              <button
                type="button"
                className="cp-btn cp-btn-ghost cp-history-retry"
                onClick={onHistoryRetry}
              >
                Retry
              </button>
            </div>
          ) : graphHistory.length === 0 &&
              history.length === 0 &&
              status?.headShort ? (
            // HEAD points at a real commit but both reads came back
            // empty (and they didn't error — if they had we'd be in
            // the branch above).  That's the warm-up still in flight,
            // or the auto-fetch gate hasn't fired yet because the
            // panel mounted before `status.initialized` flipped.
            // Either way: kick a retry rather than lying with the
            // "No commits yet" empty state.
            <div className="cp-empty">
              <IcGitCommit />
              <span>Loading history…</span>
              <button
                type="button"
                className="cp-btn cp-btn-ghost cp-history-retry"
                onClick={onHistoryRetry}
              >
                Refresh
              </button>
            </div>
          ) : graphHistory.length === 0 && history.length === 0 ? (
            <div className="cp-empty">
              <IcGitCommit />
              <span>No commits yet — make your first commit above.</span>
            </div>
          ) : graphHistory.length > 0 ? (
            // Real DAG view — branches + tags + merge curves.
            <GitGraph commits={graphHistory} />
          ) : (
            // Fallback flat list while the graph is still loading
            // (or in the rare case `vcs_log_graph` failed but the
            // plain `vcs_log` succeeded).
            <ul className="cp-history-list">
              {history.map((c) => (
                <li key={c.id} className="cp-commit-row" title={c.id}>
                  <span className="cp-commit-sha">{c.shortId}</span>
                  <span className="cp-commit-summary">{c.summary}</span>
                  <span className="cp-commit-meta">
                    {formatRelativeTime(c.timestamp)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>

      {/* ===== Branches ===== */}
      {/* Open by default for the same reason as History: the
          Zustand store is in-memory only and the auto-fetch
          `useEffect` above primes the list on vault open / app
          restart, so collapsing it would just hide already-fetched
          data.  `onToggle` still kicks a refresh the first time the
          user re-expands an explicitly-collapsed section. */}
      <details className="cp-section" open onToggle={onBranchesToggle}>
        <summary>
          <span className="cp-summary-row">
            <span className="cp-summary-title">
              <IcGitBranch /> Branches
            </span>
            <span className="cp-badge muted">
              {status?.branch ?? "—"}
            </span>
          </span>
        </summary>
        <div className="cp-section-body">
          {!vaultPath ? (
            <div className="cp-empty">
              <IcGitBranch />
              <span>Open a vault folder to manage branches.</span>
            </div>
          ) : !initialised ? (
            <div className="cp-empty">
              <IcGitBranch />
              <span>
                Enable version control above to start branching.
              </span>
            </div>
          ) : (
            <BranchesPanel
              vaultPath={vaultPath ?? ""}
              branches={branches}
              currentBranch={status?.branch ?? null}
              dirty={totalCount > 0}
              busy={branchOp || anyPending}
              onCreate={(name, opts) =>
                createBranch(vaultPath!, name, opts)
              }
              onSwitch={(name) => switchBranch(vaultPath!, name)}
              onDelete={(name, opts) => deleteBranch(vaultPath!, name, opts)}
            />
          )}
        </div>
      </details>

      {/* ===== Sync (BYOC) ===== */}
      <details className="cp-section">
        <summary>
          <span className="cp-summary-row">
            <span className="cp-summary-title">
              <IcCloud /> Sync (BYOC)
            </span>
            <span
              className={`cp-badge ${
                initialised ? "muted" : "danger"
              }`}
            >
              {initialised
                ? syncBadge(vaultPath, byocRowFor)
                : "VCS required"}
            </span>
          </span>
        </summary>

        <div className="cp-section-body">
          {!initialised ? (
            <>
              <div className="cp-empty">
                <IcCloud />
                <span>
                  Enable version control above to set up sync providers.
                </span>
              </div>
              <p className="cp-hint">
                Sync pushes the vault's git history to your chosen
                provider — GitHub or Google Drive in this build,
                OneDrive and Dropbox in the next slice. Tokens stay in
                your OS keychain; we never proxy your data.
              </p>
            </>
          ) : (
            <>
              <p className="cp-hint">
                Bring your own cloud. Tokens live in your OS
                keychain; no Lattice server sits between this app
                and your provider.
              </p>

              <ul className="cp-provider-list">
                {BYOC_PROVIDERS.map((p) => {
                  // Real adapters (github, gdrive) read from the live
                  // BYOC store; placeholder rows (onedrive, dropbox,
                  // icloud, webdav) stay cosmetic until their adapter
                  // lands in the next slice.
                  const isReal =
                    p.id === "github" || p.id === "gdrive";
                  const providerMeta = byocProviders.find(
                    (m) => m.id === p.id,
                  );
                  const configured = providerMeta?.configured ?? false;
                  // Default to `true` for legacy / fallback so that
                  // GitHub-style providers keep their full menu when
                  // metadata is briefly missing.  Drive overrides both
                  // to `false` server-side.
                  const supportsPull = providerMeta?.supportsPull ?? true;
                  const hasBrowsableRemote =
                    providerMeta?.hasBrowsableRemote ?? true;
                  const row: ProviderRowState = isReal
                    ? byocRowFor(vaultPath, p.id as ProviderId)
                    : EMPTY_PROVIDER_ROW;
                  const pid = p.id as ProviderId;
                  return (
                    <BYOCProviderRow
                      key={p.id}
                      label={p.label}
                      color={p.color}
                      isReal={isReal}
                      configured={configured}
                      supportsPull={supportsPull}
                      hasBrowsableRemote={hasBrowsableRemote}
                      providerNote={providerMeta?.note ?? null}
                      row={row}
                      vaultPath={vaultPath}
                      onConnect={() => {
                        if (!vaultPath) return;
                        void byocConnectAction(vaultPath, pid);
                      }}
                      onDisconnect={() => {
                        if (!vaultPath) return;
                        void byocDisconnectAction(vaultPath, pid);
                      }}
                      onSyncNow={() => {
                        if (!vaultPath) return;
                        void byocSyncNowAction(vaultPath, pid);
                      }}
                      onPush={() => {
                        if (!vaultPath) return;
                        void byocPushAction(vaultPath, pid);
                      }}
                      onPull={() => {
                        if (!vaultPath) return;
                        void byocPullAction(vaultPath, pid);
                      }}
                      getStorageInfo={() =>
                        vaultPath
                          ? byocStorageInfoAction(vaultPath, pid)
                          : Promise.resolve(null)
                      }
                      getRemoteUrl={() =>
                        vaultPath
                          ? byocRemoteUrlAction(vaultPath, pid)
                          : Promise.resolve(null)
                      }
                      getManifestPath={() =>
                        vaultPath
                          ? byocManifestPathAction(vaultPath, pid)
                          : Promise.resolve(null)
                      }
                    />
                  );
                })}
              </ul>
            </>
          )}
        </div>
      </details>

      {/* Device-code modal — mounts only while a GitHub Device-Code
          dance is mid-flight.  Outside the Sync section so the modal
          isn't clipped by the section's overflow rules. */}
      {pendingDeviceCode && (
        <DeviceCodeModal
          payload={pendingDeviceCode}
          onClose={clearDeviceCode}
        />
      )}

      {/* Refresh hint pinned at the bottom — lets the user know the
          panel auto-refreshes but also exposes the manual trigger. */}
      {!!vaultPath && (
        <p className="cp-footnote">
          {refreshing
            ? "Refreshing…"
            : !initialised
              ? "Not tracked."
              : status?.headShort
                ? `HEAD ${status.headShort}`
                : "Local only — no commits yet."}
          {" · "}
          <button
            type="button"
            className="cp-linkbtn"
            onClick={onRefreshClick}
            disabled={refreshing || !vaultPath}
          >
            Refresh
          </button>
        </p>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Sub-components
// ────────────────────────────────────────────────────────────────────────

/**
 * Branches sub-panel — drives the Slice B branch UI.
 *
 * Splits the branch list into two groups:
 *
 *   ┌─ Local ──────────────────────────────────────┐
 *   │ ●  main                  abc1234  2h ago      │
 *   │    feature/notes  ↑3 ↓1  def5678  yesterday   │
 *   └──────────────────────────────────────────────┘
 *   ┌─ Remote ─────────────────────────────────────┐
 *   │    origin/main           abc1234  2h ago      │
 *   └──────────────────────────────────────────────┘
 *
 *   [+] New branch  (inline form, expand-on-click)
 *
 * Switching is gated when the worktree is dirty — we surface a
 * `window.confirm` so the user has a chance to bail (slice B doesn't
 * carry forward dirty edits across switches, that's a future stash
 * feature).  Deletes are likewise confirmed; the dialog includes a
 * force toggle wired straight into the `--force` flag the IPC takes.
 *
 * All the state lives in the parent store — this component is a
 * controlled view that fires callbacks for each mutation and re-reads
 * `branches` on the next render.  Keeps the panel reactive without
 * a local cache that could drift from the source of truth.
 */
function BranchesPanel({
  vaultPath,
  branches,
  currentBranch,
  dirty,
  busy,
  onCreate,
  onSwitch,
  onDelete,
}: {
  vaultPath: string;
  branches: BranchInfo[];
  currentBranch: string | null;
  /** True if there are uncommitted changes — switch confirmation lives here. */
  dirty: boolean;
  /** True while any branch IPC is in flight. */
  busy: boolean;
  onCreate: (
    name: string,
    opts?: { startPoint?: string; checkout?: boolean },
  ) => Promise<boolean>;
  onSwitch: (name: string) => Promise<boolean>;
  onDelete: (name: string, opts?: { force?: boolean }) => Promise<boolean>;
}) {
  // Inline "new branch" form state.  Collapsed by default so the
  // panel stays compact; the "+" button toggles it open.
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [checkoutAfter, setCheckoutAfter] = useState(true);

  // Split by `isRemote` once per render — small list, cheap.
  const { locals, remotes } = useMemo(() => {
    const l: BranchInfo[] = [];
    const r: BranchInfo[] = [];
    for (const b of branches) (b.isRemote ? r : l).push(b);
    return { locals: l, remotes: r };
  }, [branches]);

  const onCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    const ok = await onCreate(name, { checkout: checkoutAfter });
    if (ok) {
      setNewName("");
      setShowNew(false);
    }
  };

  const onSwitchClick = async (b: BranchInfo) => {
    if (b.isCurrent) return;
    if (dirty) {
      // Native confirm is intentional — it's modal, blocks the
      // event loop, and we don't want to ship a full modal stack
      // for the rare "switch with dirty worktree" path.  If this
      // ever becomes annoying we can swap it for an in-panel
      // banner with Continue / Cancel buttons.
      const ok = window.confirm(
        `You have uncommitted changes.  Switching to "${b.name}" may move them across branches or fail.  Continue?`,
      );
      if (!ok) return;
    }
    await onSwitch(b.name);
  };

  const onDeleteClick = async (b: BranchInfo) => {
    // Two-step confirm: confirm at all, then ask about --force if
    // the simple delete fails (handled server-side via the error
    // surfaced through `lastError`).  Up-front we just ask for the
    // common "delete merged branch" path.
    const ok = window.confirm(
      `Delete branch "${b.name}"?  This cannot be undone (the commits remain reachable via reflog for ~90 days, but no UI to recover them yet).`,
    );
    if (!ok) return;
    const deleted = await onDelete(b.name, { force: false });
    if (!deleted) {
      // Probably unmerged — offer force.  Re-uses the same primitive
      // so we don't have to ship a separate "force delete" toggle in
      // the row.
      const force = window.confirm(
        `Branch "${b.name}" wasn't fully merged.  Force delete anyway?`,
      );
      if (force) await onDelete(b.name, { force: true });
    }
  };

  return (
    <div className="cp-branches">
      <ul className="cp-branch-list">
        {locals.length === 0 && (
          <li className="cp-branch-empty">
            No local branches yet — create one below.
          </li>
        )}
        {locals.map((b) => (
          <li
            key={b.name}
            className={`cp-branch-row${b.isCurrent ? " current" : ""}`}
            title={
              b.upstream
                ? `Tracking ${b.upstream}` +
                  (b.ahead != null ? ` · ↑${b.ahead}` : "") +
                  (b.behind != null ? ` · ↓${b.behind}` : "")
                : b.name
            }
          >
            <span className="cp-branch-glyph" aria-hidden>
              {b.isCurrent ? "●" : "○"}
            </span>
            <span className="cp-branch-name">{b.name}</span>
            {b.upstream && (b.ahead || b.behind) ? (
              <span className="cp-branch-track">
                {b.ahead ? <span className="ahead">↑{b.ahead}</span> : null}
                {b.behind ? <span className="behind">↓{b.behind}</span> : null}
              </span>
            ) : null}
            <span className="cp-branch-tip">{b.tipShort ?? ""}</span>
            <span className="cp-branch-time">
              {formatRelativeTime(b.tipTimestamp)}
            </span>
            <span className="cp-branch-actions">
              {!b.isCurrent && (
                <button
                  type="button"
                  className="cp-btn cp-btn-tiny"
                  disabled={busy || !vaultPath}
                  onClick={() => onSwitchClick(b)}
                  title="Switch to this branch"
                >
                  Switch
                </button>
              )}
              {!b.isCurrent && (
                <button
                  type="button"
                  className="cp-btn cp-btn-tiny cp-btn-ghost"
                  disabled={busy || !vaultPath}
                  onClick={() => onDeleteClick(b)}
                  title="Delete this branch"
                >
                  Delete
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>

      {remotes.length > 0 && (
        <>
          <h4 className="cp-branch-section-h">Remote</h4>
          <ul className="cp-branch-list">
            {remotes.map((b) => (
              <li
                key={b.name}
                className="cp-branch-row remote"
                title={b.name}
              >
                <span className="cp-branch-glyph" aria-hidden>
                  ◦
                </span>
                <span className="cp-branch-name">{b.name}</span>
                <span className="cp-branch-tip">{b.tipShort ?? ""}</span>
                <span className="cp-branch-time">
                  {formatRelativeTime(b.tipTimestamp)}
                </span>
                <span className="cp-branch-actions" />
              </li>
            ))}
          </ul>
        </>
      )}

      {showNew ? (
        <form className="cp-branch-new" onSubmit={onCreateSubmit}>
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="branch-name"
            autoFocus
            disabled={busy}
          />
          <label className="cp-branch-checkout">
            <input
              type="checkbox"
              checked={checkoutAfter}
              onChange={(e) => setCheckoutAfter(e.target.checked)}
              disabled={busy}
            />
            <span>Switch after create</span>
          </label>
          <div className="cp-branch-new-actions">
            <button
              type="submit"
              className="cp-btn cp-btn-primary cp-btn-tiny"
              disabled={busy || !newName.trim()}
            >
              Create
            </button>
            <button
              type="button"
              className="cp-btn cp-btn-tiny cp-btn-ghost"
              onClick={() => {
                setShowNew(false);
                setNewName("");
              }}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          className="cp-btn cp-btn-block cp-btn-ghost"
          onClick={() => setShowNew(true)}
          disabled={busy}
        >
          + New branch from {currentBranch ?? "HEAD"}
        </button>
      )}
    </div>
  );
}

/**
 * One collapsible section (Staged / Unstaged / Untracked).
 *
 * Owns its own header (with a select-all checkbox + selected count +
 * batch action buttons) and renders one [`ChangeRow`] per entry.
 *
 * Selection state is lifted to the parent so the Commit form can read
 * `staged.length > 0` without reaching into a child.  We pass back a
 * `setSelection` so range-select math (shift-click) can mutate the
 * Set ergonomically without prop drilling a reducer.
 */
function ChangeSection({
  title,
  kind,
  changes,
  selection,
  setSelection,
  anchorRef,
  primaryActionLabel,
  onPrimary,
  onDiscardOne,
  onSelectionPrimary,
  onSelectionDiscard,
  disabled,
}: {
  title: string;
  kind: "staged" | "unstaged" | "untracked";
  changes: FileChange[];
  selection: Set<string>;
  setSelection: React.Dispatch<React.SetStateAction<Set<string>>>;
  anchorRef: React.MutableRefObject<string | null>;
  /** Label for the per-row primary button ("Stage" or "Unstage"). */
  primaryActionLabel: string;
  /** Per-row primary action: stage or unstage a single path. */
  onPrimary: (path: string) => void | Promise<void>;
  /** Per-row discard. */
  onDiscardOne: (path: string) => void | Promise<void>;
  /** Header batch button — runs primary on all selected paths. */
  onSelectionPrimary: () => void | Promise<void>;
  /** Header batch button — runs discard on all selected paths. */
  onSelectionDiscard: () => void | Promise<void>;
  /** Disable every action while an IPC is in flight. */
  disabled: boolean;
}) {
  // Empty sections collapse to nothing — keeps the panel tidy when
  // (e.g.) the user has staged everything and Unstaged is now empty.
  if (changes.length === 0) return null;

  const allSelected = selection.size === changes.length && changes.length > 0;
  const someSelected = selection.size > 0 && !allSelected;
  const selectionEmpty = selection.size === 0;

  /** Master checkbox: select all / clear all in this section. */
  const onToggleAll = () => {
    if (selection.size === changes.length) {
      setSelection(new Set());
      anchorRef.current = null;
    } else {
      setSelection(new Set(changes.map((c) => c.path)));
      anchorRef.current = changes[changes.length - 1]?.path ?? null;
    }
  };

  /**
   * Row click — supports plain click (toggle), ctrl/cmd-click (toggle
   * without clearing others), and shift-click (range from anchor).
   *
   * The anchor is the most-recently-clicked row, NOT the selection's
   * earliest entry — matches the muscle memory of macOS Finder, VS
   * Code, GitHub Desktop, every modern explorer.
   */
  const onRowClick = (path: string, e: React.MouseEvent) => {
    const idx = changes.findIndex((c) => c.path === path);
    if (idx < 0) return;

    if (e.shiftKey && anchorRef.current) {
      const anchorIdx = changes.findIndex(
        (c) => c.path === anchorRef.current,
      );
      if (anchorIdx >= 0) {
        const [lo, hi] =
          anchorIdx < idx ? [anchorIdx, idx] : [idx, anchorIdx];
        const range = changes.slice(lo, hi + 1).map((c) => c.path);
        // Replace selection with the range — matches Finder/Explorer
        // behaviour; "extend selection with shift" gets complicated
        // and users rarely use it.
        setSelection(new Set(range));
        return;
      }
    }

    const isToggleModifier = e.ctrlKey || e.metaKey;
    setSelection((prev) => {
      const next = new Set(prev);
      if (isToggleModifier) {
        if (next.has(path)) next.delete(path);
        else next.add(path);
      } else {
        // Plain click: if this row IS the only selected one, clear
        // it; otherwise replace selection with just this row.
        if (next.size === 1 && next.has(path)) {
          next.delete(path);
        } else {
          next.clear();
          next.add(path);
        }
      }
      return next;
    });
    anchorRef.current = path;
  };

  return (
    <div className={`cp-subsection cp-subsection-${kind}`}>
      <div className="cp-subsection-head">
        <label className="cp-subsection-toggle" title={`Select all ${title.toLowerCase()}`}>
          <input
            type="checkbox"
            checked={allSelected}
            ref={(el) => {
              // Indeterminate state isn't reachable via the JSX
              // attribute — set it imperatively each render.
              if (el) el.indeterminate = someSelected;
            }}
            onChange={onToggleAll}
            disabled={disabled}
          />
          <span className="cp-subsection-title">{title}</span>
          <span className="cp-subsection-count">
            {selection.size > 0
              ? `${selection.size}/${changes.length}`
              : changes.length}
          </span>
        </label>
        <div className="cp-subsection-actions">
          <button
            type="button"
            className="cp-btn tiny"
            onClick={onSelectionPrimary}
            disabled={disabled || selectionEmpty}
            title={
              selectionEmpty
                ? `Select rows to ${primaryActionLabel.toLowerCase()}`
                : `${primaryActionLabel} ${selection.size} selected`
            }
          >
            {primaryActionLabel}
          </button>
          <button
            type="button"
            className="cp-btn tiny ghost"
            onClick={onSelectionDiscard}
            disabled={disabled || selectionEmpty}
            title={
              selectionEmpty
                ? "Select rows to discard"
                : `Discard ${selection.size} selected`
            }
          >
            Discard
          </button>
        </div>
      </div>

      <ul className="cp-change-list">
        {changes.map((c) => (
          <ChangeRow
            key={c.path}
            change={c}
            checked={selection.has(c.path)}
            onRowClick={onRowClick}
            primaryActionLabel={primaryActionLabel}
            onPrimary={onPrimary}
            onDiscard={onDiscardOne}
            disabled={disabled}
          />
        ))}
      </ul>
    </div>
  );
}

/**
 * One row in a section.  Clicking the row toggles selection; clicking
 * the per-row buttons fires the action against just this path
 * (selection-independent, matches VS Code / GitHub Desktop).
 *
 * `e.stopPropagation()` on the button clicks is essential — otherwise
 * the row's click handler swallows the action and only toggles
 * selection.
 */
function ChangeRow({
  change,
  checked,
  onRowClick,
  primaryActionLabel,
  onPrimary,
  onDiscard,
  disabled,
}: {
  change: FileChange;
  checked: boolean;
  onRowClick: (path: string, e: React.MouseEvent) => void;
  primaryActionLabel: string;
  onPrimary: (path: string) => void | Promise<void>;
  onDiscard: (path: string) => void | Promise<void>;
  disabled: boolean;
}) {
  return (
    <li
      className={`cp-change-row${checked ? " selected" : ""}`}
      data-status={change.status}
      onClick={(e) => onRowClick(change.path, e)}
      title={statusLabel(change.status)}
    >
      <input
        type="checkbox"
        className="cp-change-check"
        checked={checked}
        // Stop the row click from firing alongside the checkbox onChange.
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          e.stopPropagation();
          onRowClick(change.path, {
            ctrlKey: true,
            metaKey: false,
            shiftKey: false,
          } as React.MouseEvent);
        }}
        disabled={disabled}
        aria-label={`Select ${change.path}`}
      />
      <span className="cp-change-glyph" aria-hidden>
        {statusGlyph(change.status)}
      </span>
      <span className="cp-change-path">{change.path}</span>
      <button
        type="button"
        className="cp-change-action"
        title={`${primaryActionLabel} ${change.path}`}
        onClick={(e) => {
          e.stopPropagation();
          void onPrimary(change.path);
        }}
        disabled={disabled}
      >
        {primaryActionLabel === "Stage" ? "+" : "−"}
      </button>
      <button
        type="button"
        className="cp-change-discard"
        title="Discard changes to this file"
        onClick={(e) => {
          e.stopPropagation();
          void onDiscard(change.path);
        }}
        disabled={disabled}
      >
        <IcDiscard />
      </button>
    </li>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

/** Keep only the entries in `keep`; pure (returns same ref when no-op). */
function filterSet(s: Set<string>, keep: Set<string>): Set<string> {
  let changed = false;
  const next = new Set<string>();
  for (const v of s) {
    if (keep.has(v)) next.add(v);
    else changed = true;
  }
  return changed ? next : s;
}

/**
 * Human-friendly relative time. Tiny inline impl — Intl.RelativeTimeFormat
 * is overkill for the small set of buckets the History panel needs.
 */
function formatRelativeTime(unixSeconds: number): string {
  if (!unixSeconds) return "";
  const now = Date.now() / 1000;
  const delta = Math.max(0, now - unixSeconds);
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  if (delta < 30 * 86400) return `${Math.floor(delta / 86400)}d ago`;
  const date = new Date(unixSeconds * 1000);
  return date.toLocaleDateString();
}

/**
 * BYOC providers shipped (or "soon") in the panel.  Slice B wires up
 * `github` + `gdrive`; the other rows stay cosmetic until their Rust
 * adapter lands.  Keep the `id` values in sync with `ProviderId` in
 * `lib/byoc.ts` (kebab-case to match the Rust enum on the wire).
 *
 * Order is shown left-to-right by user-base / parity priority. The
 * dot color is purely cosmetic so the row reads at a glance.
 */
const BYOC_PROVIDERS: Array<{
  id: string;
  label: string;
  color: "github" | "google" | "microsoft" | "dropbox" | "apple" | "webdav";
}> = [
  { id: "github", label: "GitHub", color: "github" },
  { id: "gdrive", label: "Google Drive", color: "google" },
  { id: "onedrive", label: "OneDrive", color: "microsoft" },
  { id: "dropbox", label: "Dropbox", color: "dropbox" },
  { id: "icloud", label: "iCloud Drive", color: "apple" },
  { id: "webdav", label: "WebDAV", color: "webdav" },
];

// Re-export for the toolbar so the "More" menu can offer "Discard all"
// once we wire the real command. Keeps the icon import surface in one
// file — easier to grep when we finally ship VCS.
export const ChangesPanelIcons = {
  Discard: IcDiscard,
  Refresh: IcRefresh,
};

// ────────────────────────────────────────────────────────────────────────
// BYOC helpers
// ────────────────────────────────────────────────────────────────────────

/**
 * Placeholder row for the not-yet-wired providers (OneDrive, Dropbox,
 * iCloud, WebDAV).  Lets `ProviderRow` render uniformly without
 * branching on real-vs-stub everywhere — the values are never read
 * for those rows because we render the "Soon" button instead.
 */
const EMPTY_PROVIDER_ROW: ProviderRowState = {
  connected: false,
  accountLabel: null,
  remoteLabel: null,
  lastSyncAt: null,
  lastError: null,
  busy: false,
};

/**
 * Tiny status pill copy for the Sync section header.  We don't try to
 * surface every detail here — just an at-a-glance answer to "is sync
 * doing anything?".  Errors take precedence over connection state so
 * the user notices a failed push without expanding the section.
 *
 * Mock vault uses the same logic — `byocStore` mutates the same
 * `rows` map keyed by `__mock__::<provider>` so the badge animates
 * during simulated connects/syncs just like the real flow.
 */
function syncBadge(
  vault: string | null,
  rowFor: (v: string | null, p: ProviderId) => ProviderRowState,
): string {
  if (!vault) return "Off";
  const gh = rowFor(vault, "github");
  const gd = rowFor(vault, "gdrive");
  if (gh.lastError || gd.lastError) return "Error";
  if (gh.busy || gd.busy) return "Syncing…";
  const connected = (gh.connected ? 1 : 0) + (gd.connected ? 1 : 0);
  if (connected === 0) return "Off";
  if (connected === 1) return "1 connected";
  return `${connected} connected`;
}

/**
 * One row in the BYOC provider list.  Encapsulates the kebab-menu
 * open/close + storage-info fetch so the outer `ChangesPanel` doesn't
 * grow another set of hooks per provider.
 *
 * Action surface:
 *   - Primary button → Connect / Sync (push + pull)
 *   - Kebab (⋮)      → Push only, Pull only*, Open remote*, Reveal
 *                       token file, Reveal local manifest, Disconnect
 *
 *   * "Pull only" is hidden when `supportsPull` is false (e.g. Drive,
 *     which is push-only in slice B).  "Open remote in browser" is
 *     hidden when `hasBrowsableRemote` is false (e.g. Drive's
 *     sandboxed `appDataFolder`).
 *
 * Storage descriptor is fetched lazily — only when the menu opens —
 * so the panel mount stays cheap.  Cached after the first fetch since
 * the path is stable for the (vault, provider) pair.
 */
function BYOCProviderRow({
  label,
  color,
  isReal,
  configured,
  supportsPull,
  hasBrowsableRemote,
  providerNote,
  row,
  vaultPath,
  onConnect,
  onDisconnect,
  onSyncNow,
  onPush,
  onPull,
  getStorageInfo,
  getRemoteUrl,
  getManifestPath,
}: {
  label: string;
  color: string;
  isReal: boolean;
  configured: boolean;
  /** When false, hides "Pull only" in the kebab menu. */
  supportsPull: boolean;
  /**
   * When false, hides "Open remote in browser" — there's no
   * meaningful URL to navigate to (e.g. Drive `appDataFolder`).
   */
  hasBrowsableRemote: boolean;
  providerNote: string | null | undefined;
  row: ProviderRowState;
  vaultPath: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
  onSyncNow: () => void;
  onPush: () => void;
  onPull: () => void;
  getStorageInfo: () => Promise<{
    backend: "dpapi-file" | "keychain";
    path: string | null;
    directory: string | null;
    label: string;
  } | null>;
  getRemoteUrl: () => Promise<string | null>;
  getManifestPath: () => Promise<string | null>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [storage, setStorage] = useState<{
    backend: "dpapi-file" | "keychain";
    path: string | null;
    directory: string | null;
    label: string;
  } | null>(null);
  const [remoteUrl, setRemoteUrl] = useState<string | null>(null);
  const [manifestAbs, setManifestAbs] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const kebabRef = useRef<HTMLButtonElement | null>(null);

  // Fetch the lazy bits whenever the menu opens (and the row is
  // connected — there's nothing to show otherwise).  Each fetch
  // tolerates a null vault / non-real provider by short-circuiting.
  useEffect(() => {
    if (!menuOpen || !row.connected || !vaultPath || !isReal) return;
    let cancelled = false;
    void (async () => {
      const [s, u, m] = await Promise.all([
        getStorageInfo(),
        getRemoteUrl(),
        getManifestPath(),
      ]);
      if (cancelled) return;
      setStorage(s);
      setRemoteUrl(u);
      setManifestAbs(m);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    menuOpen,
    row.connected,
    vaultPath,
    isReal,
    getStorageInfo,
    getRemoteUrl,
    getManifestPath,
  ]);

  // Close on outside-click / Escape — matches every other popover in
  // the app.  Doesn't intercept the kebab itself (that toggles).
  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t)) return;
      if (kebabRef.current?.contains(t)) return;
      setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const openRemote = async () => {
    setMenuOpen(false);
    if (!remoteUrl) return;
    try {
      const mod = await import("@tauri-apps/plugin-opener");
      await mod.openUrl(remoteUrl);
    } catch (err) {
      // Tauri IPC isn't available (pure-browser dev mode, or the
      // opener plugin failed).  Fall back to a regular window.open
      // so the demo flow still feels complete in the browser.
      console.warn("openUrl failed, falling back to window.open:", err);
      try {
        window.open(remoteUrl, "_blank", "noopener,noreferrer");
      } catch (fallbackErr) {
        console.warn("window.open fallback failed:", fallbackErr);
      }
    }
  };

  const revealPath = async (p: string | null) => {
    setMenuOpen(false);
    if (!p) return;
    try {
      const mod = await import("@tauri-apps/plugin-opener");
      await mod.revealItemInDir(p);
    } catch (err) {
      console.warn("revealItemInDir failed:", err);
    }
  };

  return (
    <li className="cp-provider">
      <span className="cp-provider-name">
        <span className="cp-provider-dot" data-color={color} />
        <span>
          {label}
          {isReal && row.connected && row.accountLabel && (
            <span className="cp-provider-meta">
              {" · "}
              {row.accountLabel}
              {row.remoteLabel && ` (${row.remoteLabel})`}
            </span>
          )}
          {isReal && row.lastSyncAt && (
            <span className="cp-provider-meta">
              {" · synced "}
              {formatRelativeTime(row.lastSyncAt)}
            </span>
          )}
          {isReal && row.lastError && (
            <span
              className="cp-provider-meta cp-provider-error"
              title={row.lastError}
            >
              {" · error"}
            </span>
          )}
        </span>
      </span>

      {!isReal ? (
        <div className="cp-sync-actions">
          <button
            className="cp-btn tiny"
            title={`${label} adapter ships in the next slice.`}
            disabled
          >
            Soon
          </button>
        </div>
      ) : !configured ? (
        <div className="cp-sync-actions">
          <button
            className="cp-btn tiny"
            title={providerNote ?? `${label} client id not baked into this build`}
            disabled
          >
            Not built
          </button>
        </div>
      ) : row.connected ? (
        <div className="cp-sync-actions">
          <button
            className="cp-btn tiny"
            disabled={row.busy || !vaultPath}
            onClick={onSyncNow}
            title={`Pull then push to ${label}`}
          >
            {row.busy ? "Working…" : "Sync"}
          </button>
          <button
            ref={kebabRef}
            type="button"
            className="cp-kebab-btn"
            disabled={!vaultPath}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`${label} sync actions`}
            title="More sync actions"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
          >
            ⋮
          </button>
          {menuOpen && (
            <div
              ref={menuRef}
              className="cp-provider-menu"
              role="menu"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                role="menuitem"
                className="cp-provider-menu-item"
                disabled={row.busy}
                onClick={() => {
                  setMenuOpen(false);
                  onPush();
                }}
                title={`Upload local commits to ${label} without pulling`}
              >
                Push only
              </button>
              {supportsPull && (
                <button
                  type="button"
                  role="menuitem"
                  className="cp-provider-menu-item"
                  disabled={row.busy}
                  onClick={() => {
                    setMenuOpen(false);
                    onPull();
                  }}
                  title={`Fetch remote changes from ${label} (fast-forward only)`}
                >
                  Pull only
                </button>
              )}
              <div className="cp-provider-menu-sep" />
              {hasBrowsableRemote && (
                <button
                  type="button"
                  role="menuitem"
                  className="cp-provider-menu-item"
                  disabled={!remoteUrl}
                  onClick={openRemote}
                  title={remoteUrl ?? "No remote URL available"}
                >
                  Open remote in browser
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                className="cp-provider-menu-item"
                disabled={!storage?.path && !storage?.directory}
                onClick={() =>
                  revealPath(storage?.path ?? storage?.directory ?? null)
                }
                title={
                  storage?.backend === "dpapi-file"
                    ? "Open the folder containing the encrypted token file"
                    : "Token lives in the OS keychain — no file to reveal"
                }
              >
                Reveal token storage
              </button>
              <button
                type="button"
                role="menuitem"
                className="cp-provider-menu-item"
                disabled={!manifestAbs}
                onClick={() => revealPath(manifestAbs)}
                title="Open the .lattice/sync-manifest folder for this vault"
              >
                Reveal local manifest
              </button>
              <div className="cp-provider-menu-sep" />
              <button
                type="button"
                role="menuitem"
                className="cp-provider-menu-item danger"
                disabled={row.busy}
                onClick={() => {
                  setMenuOpen(false);
                  onDisconnect();
                }}
                title={`Forget the ${label} token (does not revoke the remote grant)`}
              >
                Disconnect
              </button>
              {storage && (
                <div className="cp-provider-menu-footer">
                  <strong>Tokens</strong>
                  {storage.backend === "dpapi-file" ? (
                    <>
                      DPAPI-encrypted file
                      <br />
                      {storage.path ?? storage.directory ?? "(unknown path)"}
                    </>
                  ) : (
                    <>OS keychain — {storage.label}</>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="cp-sync-actions">
          <button
            className="cp-btn tiny"
            disabled={row.busy || !vaultPath}
            onClick={onConnect}
            title={`Connect ${label}`}
          >
            {row.busy ? "Connecting…" : "Connect"}
          </button>
        </div>
      )}
    </li>
  );
}

/**
 * GitHub Device Code Flow modal.
 *
 * Mounts when the Rust side emits `byoc://device-code` (mid-OAuth).
 * Shows the human-typeable `user_code` big + monospace next to a
 * Copy button, plus a clickable link to the verification URL.  A
 * lightweight countdown clock helps the user notice the 15-minute
 * expiry without us blocking polling on the frontend.
 *
 * No close-on-success hook — the `byocStore.connect` action wipes the
 * pending payload when the IPC resolves.  This component only owns
 * the manual Close button (Escape + click backdrop also dismiss).
 */
function DeviceCodeModal({
  payload,
  onClose,
}: {
  payload: { userCode: string; verificationUri: string; expiresIn: number; interval: number };
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  // Countdown is purely cosmetic — the Rust poller is the source of
  // truth for expiry.  Computed off mount time to dodge a render loop
  // when the parent re-renders on store updates.
  const expiresAt = useRef(Date.now() + payload.expiresIn * 1000);
  const [remaining, setRemaining] = useState(payload.expiresIn);
  useEffect(() => {
    const id = setInterval(() => {
      const secs = Math.max(
        0,
        Math.floor((expiresAt.current - Date.now()) / 1000),
      );
      setRemaining(secs);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Escape closes — matches every other modal in the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(payload.userCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.warn("clipboard write failed:", err);
    }
  };

  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;

  return (
    <div
      className="cp-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cp-modal" role="dialog" aria-modal="true">
        <div className="cp-modal-head">
          <span className="cp-modal-title">Connect GitHub</span>
          <button
            className="cp-iconbtn"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close"
          >
            <IcClose />
          </button>
        </div>
        <div className="cp-modal-body">
          <p className="cp-modal-step">
            1. Open the verification page in your browser:
          </p>
          <a
            className="cp-modal-link"
            href={payload.verificationUri}
            target="_blank"
            rel="noreferrer noopener"
          >
            {payload.verificationUri}
          </a>
          <p className="cp-modal-step">2. Enter this code:</p>
          <div className="cp-modal-code">
            <span className="cp-modal-code-text">{payload.userCode}</span>
            <button
              className="cp-btn tiny"
              onClick={copyCode}
              title="Copy code"
            >
              {copied ? (
                <>
                  <IcCheck /> Copied
                </>
              ) : (
                <>
                  <IcCopy /> Copy
                </>
              )}
            </button>
          </div>
          <p className="cp-modal-foot">
            Lattice will finish automatically once you approve in your
            browser.
            {remaining > 0 && (
              <>
                {" Code expires in "}
                <strong>
                  {mins}:{secs.toString().padStart(2, "0")}
                </strong>
                .
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
