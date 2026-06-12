import { useMemo, useState } from "react";
import { ShortcutRow } from "./Keycap";
import "./HelpShortcutsPanel.css";

// ─── Data ────────────────────────────────────────────────────────────────────

interface ShortcutItem {
  keys: string;
  action: string;
  detail?: string;
}

interface ShortcutSection {
  id: string;
  title: string;
  description: string;
  items: ShortcutItem[];
}

const SHORTCUT_SECTIONS: ShortcutSection[] = [
  {
    id: "global",
    title: "Global",
    description: "Work anywhere in the app — no note needs to be open.",
    items: [
      { keys: "Ctrl+B", action: "Toggle left sidebar", detail: "Show or hide the file tree and panels." },
      { keys: "Ctrl+N", action: "New tab", detail: "Opens a blank tab in the active pane." },
      { keys: "Ctrl+W", action: "Close tab", detail: "Closes the active tab." },
      { keys: "Ctrl+S", action: "Save file", detail: "Saves the current note to disk." },
      { keys: "Ctrl+Shift+D", action: "Open today's daily note", detail: "Creates or opens the journal entry for today." },
    ],
  },
  {
    id: "editor",
    title: "Editor",
    description: "Keybindings active while a note is focused.",
    items: [
      { keys: "/", action: "Slash command menu", detail: "Type / at line start for quick inserts (headings, tasks, callouts…)." },
      { keys: "[[", action: "Wikilink autocomplete", detail: "Begin a [[wikilink]] to another note." },
      { keys: "Tab", action: "Indent list item", detail: "Indents the current list line, renumbering ordered lists." },
      { keys: "Shift+Tab", action: "Dedent list item", detail: "Removes one indent level." },
      { keys: "Ctrl+Z / Ctrl+Y", action: "Undo / Redo", detail: "Full history including multi-cursor edits." },
    ],
  },
  {
    id: "vim-modes",
    title: "Vim — Modes",
    description: "Enable Vim mode in Settings → Editor. The status bar shows NORMAL / INSERT / VISUAL.",
    items: [
      { keys: "i", action: "Insert before cursor", detail: "Switches to INSERT mode at cursor position." },
      { keys: "I", action: "Insert at line start", detail: "Jumps to the first non-blank character and enters INSERT." },
      { keys: "a", action: "Append after cursor", detail: "Enters INSERT one character to the right." },
      { keys: "A", action: "Append at line end", detail: "Jumps to end of line and enters INSERT." },
      { keys: "o", action: "New line below", detail: "Opens a blank line below and enters INSERT." },
      { keys: "O", action: "New line above", detail: "Opens a blank line above and enters INSERT." },
      { keys: "v / V", action: "Visual / line select", detail: "Character or full-line selection mode." },
      { keys: "Esc", action: "Return to NORMAL", detail: "Also dismisses autocomplete popups." },
    ],
  },
  {
    id: "vim-motion",
    title: "Vim — Motion",
    description: "Move the cursor without switching to INSERT mode.",
    items: [
      { keys: "h / j / k / l", action: "Left / Down / Up / Right", detail: "Character-by-character movement." },
      { keys: "w / W", action: "Next word / WORD", detail: "Jump to start of next word (WORD ignores punctuation)." },
      { keys: "b / B", action: "Prev word / WORD", detail: "Jump to start of previous word." },
      { keys: "e / E", action: "Word end / WORD end", detail: "Jump to last character of next word." },
      { keys: "0 / ^", action: "Line start / first non-blank", detail: "0 goes to column 0; ^ goes to the first non-space." },
      { keys: "$", action: "Line end", detail: "Moves to the last character on the line." },
      { keys: "gg / G", action: "File top / bottom", detail: "Jump to first or last line." },
      { keys: "{ / }", action: "Paragraph back / forward", detail: "Hop between empty-line-delimited blocks." },
      { keys: "Ctrl+U / Ctrl+D", action: "Half-page up / down", detail: "Scroll without moving the cursor from screen." },
      { keys: "f{c} / F{c}", action: "Find char forward / back", detail: "Jump to next/prev occurrence of char c on the line." },
    ],
  },
  {
    id: "vim-edit",
    title: "Vim — Editing",
    description: "Operators that modify text. Combine with motions: d+w deletes a word.",
    items: [
      { keys: "x / X", action: "Delete char under / before cursor" },
      { keys: "dd / D", action: "Delete line / to end of line" },
      { keys: "cc / C", action: "Change line / to end of line", detail: "Deletes and enters INSERT." },
      { keys: "yy / Y", action: "Yank (copy) line" },
      { keys: "p / P", action: "Paste after / before cursor" },
      { keys: "r{c}", action: "Replace single char with c", detail: "Press r then the replacement character." },
      { keys: "u / Ctrl+R", action: "Undo / Redo" },
      { keys: ".", action: "Repeat last change", detail: "Dots repeat the last insert or operator." },
      { keys: "J", action: "Join line below", detail: "Merges next line onto end of current." },
      { keys: ">> / <<", action: "Indent / Dedent line" },
    ],
  },
  {
    id: "vim-text-objects",
    title: "Vim — Text Objects",
    description: "Combine with c (change), d (delete), or y (yank). i = inner, a = around.",
    items: [
      { keys: "ciw / diw / yiw", action: "Change / delete / yank word" },
      { keys: "ci\" / di\"", action: "Inside double quotes" },
      { keys: "ci' / di'", action: "Inside single quotes" },
      { keys: "ci( / di(", action: "Inside parentheses" },
      { keys: "ci[ / di[", action: "Inside square brackets" },
      { keys: "ci{ / di{", action: "Inside curly braces" },
      { keys: "cap / dap", action: "Around paragraph", detail: "Includes surrounding blank lines." },
    ],
  },
  {
    id: "vim-search",
    title: "Vim — Search",
    description: "Search inside the current note.",
    items: [
      { keys: "/{pattern}", action: "Search forward", detail: "Press Enter to confirm, Esc to cancel." },
      { keys: "?{pattern}", action: "Search backward" },
      { keys: "n / N", action: "Next / previous match" },
      { keys: "*", action: "Search word under cursor", detail: "Forward search for the exact word." },
      { keys: "#", action: "Search word backward" },
    ],
  },
  {
    id: "vim-macros",
    title: "Vim — Macros & Registers",
    description: "Record and replay sequences of keystrokes.",
    items: [
      { keys: "q{a}", action: "Record macro into register a", detail: "Replace a with any letter a–z." },
      { keys: "q", action: "Stop recording" },
      { keys: "@{a}", action: "Replay macro from register a" },
      { keys: "@@", action: "Replay last macro" },
      { keys: "\"{a}y / \"{a}p", action: "Yank into / paste from register a" },
    ],
  },
];

// ─── helpers ─────────────────────────────────────────────────────────────────

function matchesQuery(query: string, ...fields: (string | undefined)[]): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return fields.some((f) => f?.toLowerCase().includes(q));
}

// ─── Component ───────────────────────────────────────────────────────────────

interface Props {
  /** When true render without the heading (used inside Settings panel). */
  inline?: boolean;
}

export function HelpShortcutsPanel({ inline = false }: Props) {
  const [query, setQuery] = useState("");

  const sections = useMemo(() => {
    if (!query.trim()) return SHORTCUT_SECTIONS;
    return SHORTCUT_SECTIONS.map((section) => {
      const items = section.items.filter((item) =>
        matchesQuery(query, section.title, item.keys, item.action, item.detail),
      );
      if (items.length > 0 || matchesQuery(query, section.title, section.description)) {
        return { ...section, items };
      }
      return null;
    }).filter(Boolean) as ShortcutSection[];
  }, [query]);

  const totalItems = sections.reduce((n, s) => n + s.items.length, 0);

  return (
    <div className="hsp-root">
      {!inline && (
        <div className="hsp-header">
          <h2 className="hsp-title">Keyboard Shortcuts</h2>
          <p className="hsp-subtitle">
            All keybindings for Lattice. Enable <strong>Vim mode</strong> in
            Settings → Editor to unlock the Vim sections.
          </p>
        </div>
      )}

      {/* Search bar */}
      <div className="hsp-search-wrap">
        <span className="hsp-search-icon">⌕</span>
        <input
          className="hsp-search"
          type="text"
          placeholder='Filter shortcuts, e.g. "delete" or "undo"…'
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus={!inline}
        />
        {query && (
          <button className="hsp-search-clear" onClick={() => setQuery("")}>
            ✕
          </button>
        )}
      </div>

      {query.trim() && (
        <div className="hsp-count">
          {totalItems} result{totalItems !== 1 ? "s" : ""} for "{query}"
        </div>
      )}

      {/* Sections */}
      {sections.length === 0 ? (
        <div className="hsp-empty">No shortcuts matched "{query}"</div>
      ) : (
        <div className="hsp-sections">
          {sections.map((section) => (
            <div key={section.id} className="hsp-section">
              <div className="hsp-section-header">
                <div className="hsp-section-title">{section.title}</div>
                <div className="hsp-section-desc">{section.description}</div>
              </div>
              <div className="hsp-section-rows">
                {section.items.map((item) => (
                  <ShortcutRow
                    key={`${section.id}-${item.keys}`}
                    keys={item.keys}
                    action={item.action}
                    detail={item.detail}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
