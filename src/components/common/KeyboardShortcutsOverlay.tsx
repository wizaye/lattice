/**
 * KeyboardShortcutsOverlay — full-screen shortcut cheatsheet
 *
 * Appears when the user presses `?` (vim normal mode) or `Ctrl+/`
 * (any mode). Shows all available shortcuts directly ON the current
 * screen, not buried in Settings. Dismissed with Esc or by clicking
 * the backdrop.
 *
 * Inspired by ZenNotes / Linear / Figma style shortcut overlays.
 */

import { createPortal } from "react-dom";
import { useState } from "react";
import "./KeyboardShortcutsOverlay.css";

// ─── Data ────────────────────────────────────────────────────────────────────

interface ShortcutItem {
  keys: string[];   // each string is one physical key chip, e.g. ["Ctrl","K"] or ["?"]
  action: string;
}

interface ShortcutColumn {
  title: string;
  accent: string;
  items: ShortcutItem[];
}

/** Platform-aware modifier: Cmd on Mac, Ctrl elsewhere */
const MOD = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac") ? "⌘" : "Ctrl";

const COLUMNS: ShortcutColumn[] = [
  {
    title: "Navigation",
    accent: "#7c5bf0",
    items: [
      { keys: [MOD, "B"],       action: "Toggle sidebar" },
      { keys: [MOD, "N"],       action: "New tab" },
      { keys: [MOD, "W"],       action: "Close tab" },
      { keys: [MOD, "Shift", "D"], action: "Today's daily note" },
      { keys: [MOD, "Shift", "H"], action: "Hint mode (Vimium) — labels on every button, type to click" },
      { keys: [MOD, "/"],       action: "Show this shortcut panel" },
      { keys: ["?"],            action: "Show shortcuts (vim normal)" },
    ],
  },
  {
    title: "Editor",
    accent: "#0ea5e9",
    items: [
      { keys: [MOD, "S"],       action: "Save file" },
      { keys: ["/"],            action: "Slash-command menu" },
      { keys: ["[", "["],       action: "Wikilink autocomplete" },
      { keys: ["Tab"],          action: "Indent list item" },
      { keys: ["Shift", "Tab"], action: "Dedent list item" },
      { keys: [MOD, "Z"],       action: "Undo" },
      { keys: [MOD, "Y"],       action: "Redo" },
    ],
  },
  {
    title: "Vim — Modes",
    accent: "#22c55e",
    items: [
      { keys: ["i"],   action: "INSERT — before cursor" },
      { keys: ["a"],   action: "INSERT — after cursor" },
      { keys: ["o"],   action: "INSERT — new line below" },
      { keys: ["O"],   action: "INSERT — new line above" },
      { keys: ["v"],   action: "VISUAL — char select" },
      { keys: ["V"],   action: "VISUAL — line select" },
      { keys: ["Esc"], action: "Back to NORMAL" },
    ],
  },
  {
    title: "Vim — Motion",
    accent: "#f59e0b",
    items: [
      { keys: ["h","j","k","l"], action: "← ↓ ↑ →" },
      { keys: ["w"],     action: "Next word" },
      { keys: ["b"],     action: "Previous word" },
      { keys: ["g","g"], action: "Top of file" },
      { keys: ["G"],     action: "Bottom of file" },
      { keys: ["0"],     action: "Line start" },
      { keys: ["$"],     action: "Line end" },
    ],
  },
  {
    title: "Vim — Edit",
    accent: "#ef4444",
    items: [
      { keys: ["d","d"], action: "Delete line" },
      { keys: ["y","y"], action: "Yank (copy) line" },
      { keys: ["p"],     action: "Paste" },
      { keys: ["u"],     action: "Undo" },
      { keys: ["Ctrl","r"], action: "Redo" },
      { keys: ["c","i","w"], action: "Change word" },
      { keys: ["d","i","w"], action: "Delete word" },
      { keys: ["."],     action: "Repeat last change" },
    ],
  },
  {
    title: "Vim — Leader (Space)",
    accent: "#a855f7",
    items: [
      { keys: ["Space", "f"], action: "Files view" },
      { keys: ["Space", "s"], action: "Search view" },
      { keys: ["Space", "g"], action: "Graph view" },
      { keys: ["Space", "k"], action: "Kanban board" },
      { keys: ["Space", "n"], action: "New tab" },
      { keys: ["Space", "w"], action: "Close tab" },
      { keys: ["Space", "d"], action: "Daily note" },
      { keys: ["Space", ","], action: "Settings" },
    ],
  },
];

// ─── Key chip ────────────────────────────────────────────────────────────────

function KeyChip({ value }: { value: string }) {
  return <kbd className="kso-key">{value}</kbd>;
}

// ─── Single shortcut row ─────────────────────────────────────────────────────

function ShortcutEntry({ item }: { item: ShortcutItem }) {
  return (
    <div className="kso-entry">
      <div className="kso-keys">
        {item.keys.map((k, i) => (
          <span key={i} className="kso-key-group">
            {i > 0 && item.keys.length > 1 && !["Space"].includes(item.keys[i - 1]) && (
              <span className="kso-plus">+</span>
            )}
            <KeyChip value={k} />
          </span>
        ))}
      </div>
      <span className="kso-action">{item.action}</span>
    </div>
  );
}

// ─── Overlay ─────────────────────────────────────────────────────────────────

interface Props {
  onClose: () => void;
}

export function KeyboardShortcutsOverlay({ onClose }: Props) {
  const [query, setQuery] = useState("");
  const q = query.toLowerCase();

  const filtered: ShortcutColumn[] = q
    ? COLUMNS.map((col) => ({
        ...col,
        items: col.items.filter(
          (it) =>
            it.action.toLowerCase().includes(q) ||
            it.keys.join(" ").toLowerCase().includes(q),
        ),
      })).filter((col) => col.items.length > 0)
    : COLUMNS;

  return createPortal(
    <div className="kso-backdrop" onMouseDown={onClose}>
      <div className="kso-panel" onMouseDown={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="kso-header">
          <div className="kso-title-row">
            <span className="kso-title">Keyboard Shortcuts</span>
            <span className="kso-hint">Press <kbd className="kso-key kso-key--sm">Esc</kbd> to close</span>
          </div>
          <div className="kso-search-wrap">
            <span className="kso-search-icon">⌕</span>
            <input
              className="kso-search"
              autoFocus
              placeholder="Filter shortcuts…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
            />
          </div>
        </div>

        {/* Columns grid */}
        <div className="kso-body">
          {filtered.length === 0 ? (
            <div className="kso-empty">No shortcuts matched "{query}"</div>
          ) : (
            <div className="kso-grid">
              {filtered.map((col) => (
                <div key={col.title} className="kso-col">
                  <div
                    className="kso-col-title"
                    style={{ borderLeftColor: col.accent, color: col.accent }}
                  >
                    {col.title}
                  </div>
                  <div className="kso-col-items">
                    {col.items.map((item) => (
                      <ShortcutEntry key={item.action} item={item} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="kso-footer">
          <span>Enable <strong>Vim mode</strong> in Settings → Editor to unlock Vim shortcuts</span>
          <span>
            Open with <kbd className="kso-key kso-key--sm">{MOD}</kbd>
            <kbd className="kso-key kso-key--sm">/</kbd> or
            <kbd className="kso-key kso-key--sm">?</kbd> in Normal mode
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
