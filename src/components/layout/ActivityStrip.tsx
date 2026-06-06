import {
  IcCalendar,
  IcFiles,
  IcGraph,
  IcGrid,
  IcKanban,
  IcTerminal,
} from "../common/Icons";

/**
 * Vertical icon column for the L-strip body.
 *
 * Only "Graph view" is wired today \u2014 the other glyphs are placeholders
 * for features that haven't shipped (Canvas pane, Calendar, Files
 * search, Terminal, Kanban). Earlier they were silently inert, which
 * read as broken buttons. We now mark them `disabled` so the cursor
 * shows the not-allowed state, the title surfaces "(Coming soon)",
 * and visually they sit dimmed instead of pretending to be active.
 */
export function LeftActivityStrip({ onOpenGraph }: { onOpenGraph?: () => void }) {
  const icons = [
    { Icon: IcGraph, title: "Graph view", onClick: onOpenGraph },
    { Icon: IcGrid, title: "Canvas (Coming soon)", onClick: undefined },
    { Icon: IcCalendar, title: "Calendar (Coming soon)", onClick: undefined },
    { Icon: IcFiles, title: "All files (Coming soon)", onClick: undefined },
    { Icon: IcTerminal, title: "Terminal (Coming soon)", onClick: undefined },
    { Icon: IcKanban, title: "Kanban (Coming soon)", onClick: undefined },
  ];
  return (
    <div className="lstrip-body">
      {icons.map(({ Icon, title, onClick }, i) => (
        <button
          key={i}
          className="icon-btn lstrip-icon"
          title={title}
          disabled={!onClick}
          onClick={onClick}
        >
          <Icon />
        </button>
      ))}
    </div>
  );
}
