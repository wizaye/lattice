import { useEffect, useMemo, useRef, useState } from "react";
import { useVaultStore } from "../../state/vaultStore";
import { useVcsStore } from "../../state/vcsStore";
import {
  statusGlyph,
  statusLabel,
  type BranchInfo,
  type FileChange,
} from "../../lib/vcs";
import {
  IcCheck,
  IcClose,
  IcCloud,
  IcCloudUpload,
  IcCopy,
  IcDiff,
  IcDiscard,
  IcGitBranch,
  IcGitCommit,
  IcHistory,
  IcRefresh,
  IcSparkle,
  IcSync,
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
  // The `historyFetchedFor` ref still gates the call so we don't
  // re-hit the IPC on every render — exactly the same once-per-vault
  // semantics the toggle handler enforces.
  useEffect(() => {
    if (!vaultPath || vaultPath === "__mock__") return;
    if (!initialised) return;
    if (historyFetchedFor.current === vaultPath) return;
    historyFetchedFor.current = vaultPath;
    void refreshHistory(vaultPath, 100);
    void refreshGraph(vaultPath, 200);
  }, [vaultPath, initialised, refreshHistory, refreshGraph]);

  // When we discover the vault isn't tracked, fetch the preview count
  // ONCE per vault so the Enable CTA can show "Enable & commit N files"
  // without us walking the worktree on every status refresh.
  useEffect(() => {
    if (!vaultPath || vaultPath === "__mock__") return;
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
    if (!vaultPath || vaultPath === "__mock__") return;
    await initRepo(vaultPath);
  };

  const onCommit = async () => {
    if (!vaultPath || vaultPath === "__mock__") return;
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
    if (!vaultPath || vaultPath === "__mock__") return;
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
    // refresh is a good moment to re-pull them too — cheap calls.
    if (historyFetchedFor.current === vaultPath) {
      void refreshHistory(vaultPath, 100);
      void refreshGraph(vaultPath, 200);
    }
    if (branchesFetchedFor.current === vaultPath) {
      void refreshBranches(vaultPath);
    }
  };

  // The mock vault uses the sentinel path "__mock__" which has no
  // real disk location — VCS commands would fail.  Render a friendly
  // notice instead of empty checkboxes.
  const isMockVault = vaultPath === "__mock__";
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
          {isMockVault ? (
            <div className="cp-empty">
              <IcGitCommit />
              <span>Open a real vault folder to enable version control.</span>
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

          {initialised && !isMockVault && totalCount > 0 && (
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
          {isMockVault ? (
            <div className="cp-empty">
              <IcGitCommit />
              <span>Open a real vault folder to see commit history.</span>
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
      <details className="cp-section" onToggle={onBranchesToggle}>
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
          {isMockVault ? (
            <div className="cp-empty">
              <IcGitBranch />
              <span>Open a real vault folder to manage branches.</span>
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
            <span className={`cp-badge ${initialised ? "muted" : "danger"}`}>
              {initialised ? "Off" : "VCS required"}
            </span>
          </span>
        </summary>

        <div className="cp-section-body">
          {!initialised && !isMockVault ? (
            // Sync gates on VCS — there's nothing meaningful to push
            // until we have commits.  Surface this clearly so the
            // user knows the path: enable VCS → connect a provider →
            // push.  Saves them clicking Connect and getting an
            // opaque error.
            <>
              <div className="cp-empty">
                <IcCloud />
                <span>
                  Enable version control above to set up sync providers.
                </span>
              </div>
              <p className="cp-hint">
                Sync pushes the vault's git history to your chosen
                provider — GitHub, Google Drive, Dropbox, iCloud or
                WebDAV. End-to-end encrypted before it leaves the
                device.
              </p>
            </>
          ) : (
            <>
              <p className="cp-hint">
                Bring your own cloud. Vault data is end-to-end encrypted
                before it leaves the device. Slice 5 lights this up.
              </p>

              <ul className="cp-provider-list">
                {BYOC_PROVIDERS.map((p) => (
                  <li key={p.id} className="cp-provider">
                    <span className="cp-provider-name">
                      <span
                        className="cp-provider-dot"
                        data-color={p.color}
                      />
                      {p.label}
                    </span>
                    <button
                      className="cp-btn tiny"
                      title={`Connect ${p.label} (coming soon)`}
                      disabled
                    >
                      {p.ready ? "Connect" : "Soon"}
                    </button>
                  </li>
                ))}
              </ul>

              <div className="cp-sync-actions">
                <button
                  className="cp-btn ghost"
                  disabled
                  title="Push local commits (coming soon)"
                >
                  <IcCloudUpload /> Push
                </button>
                <button
                  className="cp-btn ghost"
                  disabled
                  title="Fetch remote changes (coming soon)"
                >
                  <IcRefresh /> Pull
                </button>
                <button
                  className="cp-btn ghost"
                  disabled
                  title="Reconnect (coming soon)"
                >
                  <IcSync /> Resync
                </button>
              </div>
            </>
          )}
        </div>
      </details>

      {/* Refresh hint pinned at the bottom — lets the user know the
          panel auto-refreshes but also exposes the manual trigger. */}
      {!isMockVault && (
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
 * BYOC providers shipped with v1 — see docs/impl-v2.md §5.2.
 *
 * Order is shown left-to-right by user-base / parity priority. `ready`
 * gates the connect CTA copy: once the Rust adapter lands we flip the
 * flag here and the button picks up the new label automatically. The
 * dot color is purely cosmetic so the row reads at a glance.
 */
const BYOC_PROVIDERS: Array<{
  id: string;
  label: string;
  color: "github" | "google" | "microsoft" | "dropbox" | "apple" | "webdav";
  ready: boolean;
}> = [
  { id: "github", label: "GitHub", color: "github", ready: false },
  { id: "gdrive", label: "Google Drive", color: "google", ready: false },
  { id: "onedrive", label: "OneDrive", color: "microsoft", ready: false },
  { id: "dropbox", label: "Dropbox", color: "dropbox", ready: false },
  { id: "icloud", label: "iCloud Drive", color: "apple", ready: false },
  { id: "webdav", label: "WebDAV", color: "webdav", ready: false },
];

// Re-export for the toolbar so the "More" menu can offer "Discard all"
// once we wire the real command. Keeps the icon import surface in one
// file — easier to grep when we finally ship VCS.
export const ChangesPanelIcons = {
  Discard: IcDiscard,
  Refresh: IcRefresh,
};
