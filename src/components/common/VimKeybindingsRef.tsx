import { useState } from "react";
import "./VimKeybindingsRef.css";

interface KeyGroup {
  title: string;
  keys: { key: string; desc: string }[];
}

const VIM_GROUPS: KeyGroup[] = [
  {
    title: "Modes",
    keys: [
      { key: "i", desc: "Insert before cursor" },
      { key: "I", desc: "Insert at line start" },
      { key: "a", desc: "Append after cursor" },
      { key: "A", desc: "Append at line end" },
      { key: "o", desc: "New line below, insert" },
      { key: "O", desc: "New line above, insert" },
      { key: "v", desc: "Visual (char select)" },
      { key: "V", desc: "Visual line select" },
      { key: "Esc", desc: "Return to Normal mode" },
    ],
  },
  {
    title: "Motion",
    keys: [
      { key: "h j k l", desc: "Left / Down / Up / Right" },
      { key: "w / W", desc: "Next word / WORD" },
      { key: "b / B", desc: "Prev word / WORD" },
      { key: "e / E", desc: "Word end / WORD end" },
      { key: "0 / ^", desc: "Line start / first non-blank" },
      { key: "$", desc: "Line end" },
      { key: "gg / G", desc: "File top / bottom" },
      { key: "{ / }", desc: "Paragraph backward / forward" },
      { key: "% ", desc: "Jump to matching bracket" },
      { key: "f{c} / F{c}", desc: "Find char forward / back" },
      { key: "t{c} / T{c}", desc: "Till char forward / back" },
      { key: "Ctrl-u / Ctrl-d", desc: "Half-page up / down" },
    ],
  },
  {
    title: "Editing",
    keys: [
      { key: "x / X", desc: "Delete char / before cursor" },
      { key: "r{c}", desc: "Replace single char" },
      { key: "dd / D", desc: "Delete line / to end" },
      { key: "cc / C", desc: "Change line / to end" },
      { key: "yy / Y", desc: "Yank line" },
      { key: "p / P", desc: "Paste after / before" },
      { key: "u / Ctrl-r", desc: "Undo / Redo" },
      { key: ". ", desc: "Repeat last change" },
      { key: "J", desc: "Join line below" },
      { key: "~", desc: "Toggle case" },
      { key: ">> / <<", desc: "Indent / Dedent line" },
    ],
  },
  {
    title: "Text Objects",
    keys: [
      { key: "ciw / diw / yiw", desc: "Change / delete / yank word" },
      { key: "ci\" / di\"", desc: "Change / delete inside quotes" },
      { key: "ci( / di(", desc: "Change / delete inside parens" },
      { key: "ci[ / di[", desc: "Change / delete inside brackets" },
      { key: "ci{ / di{", desc: "Change / delete inside braces" },
      { key: "cit / dit", desc: "Change / delete inside tag" },
      { key: "cap / dap", desc: "Change / delete paragraph" },
    ],
  },
  {
    title: "Search",
    keys: [
      { key: "/{pattern}", desc: "Search forward" },
      { key: "?{pattern}", desc: "Search backward" },
      { key: "n / N", desc: "Next / previous match" },
      { key: "*", desc: "Search word under cursor" },
      { key: "#", desc: "Search word backward" },
    ],
  },
  {
    title: "Visual Mode",
    keys: [
      { key: "v then motion", desc: "Select text" },
      { key: "V then j/k", desc: "Select lines" },
      { key: "d / x", desc: "Delete selection" },
      { key: "y", desc: "Yank (copy) selection" },
      { key: "c", desc: "Change selection" },
      { key: "> / <", desc: "Indent / dedent" },
      { key: "~", desc: "Toggle case" },
    ],
  },
  {
    title: "Macros & Registers",
    keys: [
      { key: "q{a}", desc: "Record macro into register a" },
      { key: "q", desc: "Stop recording" },
      { key: "@{a}", desc: "Replay macro from register a" },
      { key: "@@", desc: "Replay last macro" },
      { key: "\"{a}y", desc: "Yank into register a" },
      { key: "\"{a}p", desc: "Paste from register a" },
    ],
  },
  {
    title: "Lattice-Specific",
    keys: [
      { key: "Ctrl-s", desc: "Save file (any mode)" },
      { key: "Esc", desc: "Normal mode (also dismisses autocomplete)" },
      { key: "/ in insert", desc: "Opens slash-command menu" },
      { key: "[[  in insert", desc: "Opens wikilink autocomplete" },
    ],
  },
];

interface Props {
  /** If true, render inline (no modal chrome). Defaults to false (panel in settings). */
  inline?: boolean;
}

export function VimKeybindingsRef({ inline = false }: Props) {
  const [filter, setFilter] = useState("");
  const q = filter.toLowerCase();

  const groups = q
    ? VIM_GROUPS.map((g) => ({
        ...g,
        keys: g.keys.filter(
          (k) => k.key.toLowerCase().includes(q) || k.desc.toLowerCase().includes(q),
        ),
      })).filter((g) => g.keys.length > 0)
    : VIM_GROUPS;

  return (
    <div className={`vkr-root${inline ? " vkr-inline" : ""}`}>
      {!inline && (
        <div className="vkr-header">
          <h2 className="vkr-title">Vim Keybindings</h2>
          <p className="vkr-subtitle">
            Enable vim mode in <strong>Settings → Editor → Vim mode</strong>.
            The mode badge (NORMAL / INSERT / VISUAL) appears in the status bar.
          </p>
        </div>
      )}

      <input
        className="vkr-filter"
        type="text"
        placeholder="Filter keybindings…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />

      <div className="vkr-groups">
        {groups.map((group) => (
          <div key={group.title} className="vkr-group">
            <div className="vkr-group-title">{group.title}</div>
            <table className="vkr-table">
              <tbody>
                {group.keys.map(({ key, desc }) => (
                  <tr key={key} className="vkr-row">
                    <td className="vkr-key">
                      {key.split(" / ").map((k, i) => (
                        <span key={i}>
                          {i > 0 && <span className="vkr-sep"> / </span>}
                          <kbd className="vkr-kbd">{k}</kbd>
                        </span>
                      ))}
                    </td>
                    <td className="vkr-desc">{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        {groups.length === 0 && (
          <div className="vkr-empty">No keybindings match "{filter}"</div>
        )}
      </div>
    </div>
  );
}
