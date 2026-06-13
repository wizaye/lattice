/**
 * Keycap — renders a single keyboard key exactly as ZenNotes does:
 * bordered monospace chip.  Keys like "Ctrl+K" are split on "+" so
 * each token gets its own chip separated by "+".
 */

import "./Keycap.css";

interface KeycapProps {
  /** e.g. "Ctrl+K", "Space", "g g", "Esc" */
  value: string;
  subtle?: boolean;
}

/** Split "Ctrl+Shift+K" → ["Ctrl","Shift","K"].  Preserves "+" itself. */
function tokenise(value: string): string[] {
  return value.split("+").flatMap((part) =>
    part.trim() === "" ? ["+"] : [part.trim()],
  );
}

export function Keycap({ value, subtle = false }: KeycapProps) {
  const tokens = tokenise(value);
  return (
    <span className={`keycap-group${subtle ? " keycap-subtle" : ""}`}>
      {tokens.map((tok, i) => (
        <span key={i} className="keycap-token">
          {tok}
        </span>
      ))}
    </span>
  );
}

/**
 * ShortcutRow — one row in a keybinding reference table.
 * Renders the key(s), the action name, and an optional description.
 */
interface ShortcutRowProps {
  /** e.g. "Ctrl+K" or "g g" — may contain "/" as separator for alternatives */
  keys: string;
  action: string;
  detail?: string;
}

export function ShortcutRow({ keys, action, detail }: ShortcutRowProps) {
  // "Ctrl+K / Ctrl+J" → two separate Keycaps joined by "/"
  const alternatives = keys.split(" / ");

  return (
    <div className="shortcut-row">
      <div className="shortcut-row-keys">
        {alternatives.map((alt, i) => (
          <span key={i} className="shortcut-row-alt">
            {i > 0 && <span className="shortcut-row-sep">/</span>}
            <Keycap value={alt} />
          </span>
        ))}
      </div>
      <div className="shortcut-row-body">
        <span className="shortcut-row-action">{action}</span>
        {detail && <span className="shortcut-row-detail">{detail}</span>}
      </div>
    </div>
  );
}
