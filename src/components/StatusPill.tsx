import { IcBook, IcEdit } from "./Icons";
import "./StatusPill.css";

type Props = {
  hasOpenFile: boolean;
  backlinks: number;
  words: number;
  characters: number;
};

/**
 * Floating status pill anchored to the bottom-right corner of the app.
 * When a document is open it shows backlinks / word / character counts
 * plus an edit and a reading-mode toggle. When no doc is open it
 * collapses to a single reading-mode icon (matches the empty-state in
 * Obsidian's bottom-right corner).
 *
 * Sits as a sibling of all columns and floats above them; the leading
 * edge is rounded to give a subtle "gooey" feel that flows out of the
 * window edges.
 */
export function StatusPill({ hasOpenFile, backlinks, words, characters }: Props) {
  if (!hasOpenFile) {
    return (
      <div className="status-pill empty">
        <button className="sp-icon" title="Reading mode">
          <IcBook />
        </button>
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
      <button className="sp-icon" title="Reading mode">
        <IcBook />
      </button>
    </div>
  );
}
