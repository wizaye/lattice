import { IcEdit, IcSync, IcSyncIgnored } from "../common/Icons";
import "./StatusPill.css";

type Props = {
  hasOpenFile: boolean;
  backlinks: number;
  words: number;
  characters: number;
  /** Whether the current vault is connected to a sync provider. When
   *  false (the default — sync isn't wired yet) the trailing pill icon
   *  renders as a red "no sync" indicator. Once we hook up an actual
   *  sync backend this becomes a real status feed. */
  synced?: boolean;
  /** Number of uncommitted working-tree changes from the VCS store.
   *  When > 0 we paint a small badge over the sync icon so the user
   *  knows there's local work that hasn't been snapshotted yet — same
   *  affordance as VS Code's source-control bottom bar dot. */
  dirtyCount?: number;
  /** Fired when the user clicks the trailing sync indicator. App wires
   *  this to open the Changes view in the left sidebar (and expand the
   *  sidebar if it's currently collapsed) so the pill is the canonical
   *  shortcut into VCS + BYOC controls. Optional so DEV/test renders
   *  of the pill don't have to thread it through. */
  onClickSync?: () => void;
};

/**
 * Floating status pill anchored to the bottom-right corner of the app.
 *
 * When a document is open the pill shows backlinks / word / character
 * counts plus an edit button and ends with a SYNC status indicator.
 * The trailing icon is the only thing rendered when no document is
 * open (matches Obsidian's bottom-right corner: sync status is always
 * visible, even with no active note).
 *
 * The sync icon uses two states:
 *   - `synced = true`  → regular sync glyph in muted color
 *   - `synced = false` → "sync-ignored" (slashed) glyph in red — this
 *                        is the default since we haven't wired up an
 *                        actual sync backend yet.
 */
export function StatusPill({
  hasOpenFile,
  backlinks,
  words,
  characters,
  synced = false,
  dirtyCount = 0,
  onClickSync,
}: Props) {
  if (!hasOpenFile) {
    return (
      <div className="status-pill empty">
        <SyncIndicator
          synced={synced}
          dirtyCount={dirtyCount}
          onClick={onClickSync}
        />
      </div>
    );
  }

  return (
    <div className="status-pill">
      <button className="sp-stat" title="Backlinks">
        <span className="sp-num">{backlinks}</span>
        <span className="sp-lbl">backlinks</span>
      </button>
      <button className="sp-icon" title="Edit">
        <IcEdit />
      </button>
      <span className="sp-stat">
        <span className="sp-num">{words}</span>
        <span className="sp-lbl">words</span>
      </span>
      <span className="sp-stat">
        <span className="sp-num">{characters}</span>
        <span className="sp-lbl">characters</span>
      </span>
      <SyncIndicator
        synced={synced}
        dirtyCount={dirtyCount}
        onClick={onClickSync}
      />
    </div>
  );
}

/**
 * Trailing sync indicator. Kept as a sibling component so both the
 * empty pill and the populated pill render the exact same button —
 * single source of truth for hover / color / icon swap behavior.
 *
 * Clicking the indicator hands off to `onClick` (typically the App-
 * level handler that opens the Changes view in the left sidebar).
 * Title copy reflects both the underlying sync state AND the action,
 * so users get a hint about what the click will do.
 *
 * When `dirtyCount > 0` we overlay a tiny badge bubble on the icon —
 * the same visual cue VS Code uses on its source-control activity-bar
 * entry. We cap the rendered number at 9+ so it never bloats the pill.
 */
function SyncIndicator({
  synced,
  dirtyCount,
  onClick,
}: {
  synced: boolean;
  dirtyCount: number;
  onClick?: () => void;
}) {
  const status = synced ? "Sync up to date" : "Sync not configured";
  const dirtyHint =
    dirtyCount > 0
      ? ` — ${dirtyCount} uncommitted change${dirtyCount === 1 ? "" : "s"}`
      : "";
  const title = onClick
    ? `${status}${dirtyHint} — open Changes`
    : `${status}${dirtyHint}`;
  return (
    <button
      type="button"
      className={`sp-icon sync${synced ? " ok" : " off"}${
        dirtyCount > 0 ? " has-dirty" : ""
      }`}
      title={title}
      aria-label={title}
      onClick={onClick}
    >
      {synced ? <IcSync /> : <IcSyncIgnored />}
      {dirtyCount > 0 && (
        <span className="sp-dirty-badge" aria-hidden>
          {dirtyCount > 9 ? "9+" : dirtyCount}
        </span>
      )}
    </button>
  );
}
