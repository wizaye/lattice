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
}: Props) {
  if (!hasOpenFile) {
    return (
      <div className="status-pill empty">
        <SyncIndicator synced={synced} />
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
      <SyncIndicator synced={synced} />
    </div>
  );
}

/**
 * Trailing sync indicator. Kept as a sibling component so both the
 * empty pill and the populated pill render the exact same button —
 * single source of truth for hover / color / icon swap behavior.
 */
function SyncIndicator({ synced }: { synced: boolean }) {
  const title = synced ? "Sync up to date" : "Sync not configured";
  return (
    <button
      type="button"
      className={`sp-icon sync${synced ? " ok" : " off"}`}
      title={title}
      aria-label={title}
    >
      {synced ? <IcSync /> : <IcSyncIgnored />}
    </button>
  );
}
