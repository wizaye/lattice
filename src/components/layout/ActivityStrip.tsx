import {
  IcCalendar,
  IcFiles,
  IcGraph,
  IcGrid,
  IcKanban,
  IcTerminal,
} from "../common/Icons";

/** Vertical icon column for the L-strip body. */
export function LeftActivityStrip({ onOpenGraph }: { onOpenGraph?: () => void }) {
  const icons = [
    { Icon: IcGraph, title: "Graph view" },
    { Icon: IcGrid, title: "Canvas" },
    { Icon: IcCalendar, title: "Calendar" },
    { Icon: IcFiles, title: "All files" },
    { Icon: IcTerminal, title: "Terminal" },
    { Icon: IcKanban, title: "Kanban" },
  ];
  return (
    <div className="lstrip-body">
      {icons.map(({ Icon, title }, i) => (
        <button key={i} className="icon-btn lstrip-icon" title={title} onClick={title === "Graph view" ? onOpenGraph : undefined}>
          <Icon />
        </button>
      ))}
    </div>
  );
}
