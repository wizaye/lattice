import {
  IcBook,
  IcCalendar,
  IcCloudUpload,
  IcFiles,
  IcGraph,
  IcGrid,
  IcKanban,
  IcSourceControl,
  IcTerminal,
} from "../common/Icons";
import type { LeftView } from "./LeftSidebar";

/**
 * Vertical icon column for the L-strip body.
 *
 * Mirrors VS Code's activity bar: each icon is a "view" entry that
 * either toggles the sidebar open (when clicking an *inactive* view,
 * or when the sidebar is collapsed) or collapses the sidebar (when
 * clicking the *currently active* view while the sidebar is already
 * open).  Owning the routing here — instead of in the sidebar
 * header — keeps the two columns honest: the strip is always
 * visible, so view-switching is always one click away even when the
 * sidebar is collapsed.
 *
 * Live entries today: Graph, Calendar, Source-control (changes).
 * The other glyphs are placeholders for features that haven't
 * shipped (Canvas pane, all-files search, Terminal, Kanban) and
 * stay `disabled` so the cursor shows the not-allowed state and the
 * title surfaces "(Coming soon)".
 */
type Props = {
  /** The currently-selected sidebar view. Used to highlight the
   *  active strip icon and to drive the toggle-collapse behaviour. */
  view: LeftView;
  /** Switch the sidebar to a different view. */
  onChangeView: (v: LeftView) => void;
  /** Whether the sidebar column is currently collapsed. */
  leftCollapsed: boolean;
  /** Toggle the sidebar's collapsed state. Called when re-clicking
   *  the already-active view (collapse) or when clicking any view
   *  while the sidebar is hidden (expand). */
  onToggleSidebar: () => void;
  /** Open the standalone graph window (already wired before this
   *  refactor — not routed through the sidebar). */
  onOpenGraph?: () => void;
  /** Open the full Kanban board in the editor pane (virtual tab). */
  onOpenKanban?: () => void;
  /** Open the New Paper modal (Slice C). */
  onOpenNewPaper?: () => void;
  /** Open the Publish wizard (Slice D). */
  onOpenPublishWizard?: () => void;
};

type StripEntry =
  | { kind: "view"; Icon: typeof IcCalendar; title: string; target: LeftView }
  | { kind: "action"; Icon: typeof IcCalendar; title: string; onClick?: () => void }
  | { kind: "disabled"; Icon: typeof IcCalendar; title: string };

export function LeftActivityStrip({
  view,
  onChangeView,
  leftCollapsed,
  onToggleSidebar,
  onOpenGraph,
  onOpenKanban,
  onOpenNewPaper,
  onOpenPublishWizard,
}: Props) {
  // Route a view click: switch view + ensure the sidebar is open,
  // unless we're re-clicking the active view while the sidebar is
  // open — in which case collapse.
  const routeView = (target: LeftView) => {
    if (!leftCollapsed && view === target) {
      onToggleSidebar();
      return;
    }
    onChangeView(target);
    if (leftCollapsed) onToggleSidebar();
  };

  const entries: StripEntry[] = [
    { kind: "action",   Icon: IcGraph,         title: "Graph view",                      onClick: onOpenGraph },
    { kind: "view",     Icon: IcCalendar,       title: "Calendar & daily notes",          target: "calendar" },
    { kind: "view",     Icon: IcSourceControl,  title: "Changes (version control & sync)", target: "changes" },
    { kind: "view",     Icon: IcGrid,           title: "Canvas files",                    target: "canvas" },
    { kind: "view",     Icon: IcFiles,          title: "All files",                       target: "files" },
    { kind: "disabled", Icon: IcTerminal,       title: "Terminal (Coming soon)" },
    // Kanban opens as a full editor tab — not a sidebar panel.
    { kind: "action",   Icon: IcKanban,         title: "Kanban board",                    onClick: onOpenKanban },
    // Separator-like gap between nav and utility actions
    { kind: "action",   Icon: IcBook,           title: "New paper (Slice C)",             onClick: onOpenNewPaper },
    { kind: "action",   Icon: IcCloudUpload,    title: "Publish vault",                   onClick: onOpenPublishWizard },
  ];

  return (
    <div className="lstrip-body">
      {entries.map((entry, i) => {
        const { Icon, title } = entry;
        if (entry.kind === "view") {
          const active = !leftCollapsed && view === entry.target;
          return (
            <button
              key={i}
              className={`icon-btn lstrip-icon${active ? " active" : ""}`}
              title={title}
              onClick={() => routeView(entry.target)}
            >
              <Icon />
            </button>
          );
        }
        if (entry.kind === "action") {
          return (
            <button
              key={i}
              className="icon-btn lstrip-icon"
              title={title}
              disabled={!entry.onClick}
              onClick={entry.onClick}
            >
              <Icon />
            </button>
          );
        }
        return (
          <button key={i} className="icon-btn lstrip-icon" title={title} disabled>
            <Icon />
          </button>
        );
      })}
    </div>
  );
}
