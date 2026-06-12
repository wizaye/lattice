import { createPortal } from "react-dom";
import { Keycap } from "./Keycap";
import "./WhichKeyOverlay.css";

export interface WhichKeyItem {
  keyLabel: string;
  label: string;
  detail?: string;
}

interface Props {
  /** The prefix key already pressed, e.g. "Space" */
  prefix: string;
  title: string;
  items: WhichKeyItem[];
  detail?: string;
}

/**
 * WhichKeyOverlay — a bottom-center HUD inspired by which-key.nvim and
 * ZenNotes' WhichKeyOverlay.tsx.
 *
 * Shows the available continuations after a leader/prefix key is pressed.
 * Rendered into document.body via a portal so it floats above everything.
 */
export function WhichKeyOverlay({
  prefix,
  title,
  items,
  detail = "Press a key to continue or Esc to cancel.",
}: Props) {
  if (items.length === 0) return null;

  const twoColumn = items.length > 4;
  const oddCount = items.length % 2 === 1;

  return createPortal(
    <div className="wk-backdrop">
      <div className="wk-panel">
        {/* Header */}
        <div className="wk-header">
          <div className="wk-prefix-badge">
            <Keycap value={prefix} />
          </div>
          <div className="wk-header-text">
            <div className="wk-title">{title}</div>
            <div className="wk-detail">{detail}</div>
          </div>
        </div>

        {/* Grid of shortcut continuations */}
        <div className={`wk-grid${twoColumn ? " wk-grid--two" : ""}`}>
          {items.map((item, i) => (
            <div
              key={item.keyLabel}
              className={[
                "wk-item",
                twoColumn && i % 2 === 1 ? "wk-item--right" : "",
                twoColumn && oddCount && i === items.length - 1 ? "wk-item--full" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <div className="wk-item-key">
                <Keycap value={item.keyLabel} />
              </div>
              <div className="wk-item-body">
                <div className="wk-item-label">{item.label}</div>
                {item.detail && (
                  <div className="wk-item-desc">{item.detail}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
