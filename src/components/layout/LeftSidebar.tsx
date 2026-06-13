import { useRef, useState } from "react";
import type { FileNode } from "../../state/types";
import {
  IcBookmark,
  IcChevronDown,
  IcCollapseAll,
  IcEdit,
  IcFolder,
  IcGear,
  IcHelp,
  IcMoon,
  IcMore,
  IcNewFolder,
  IcPanelLeft,
  IcRefresh,
  IcSearch,
  IcSortAZ,
  IcSun,
  IcTrash,
} from "../common/Icons";
import { FileTree, type InlineEditState } from "../filetree/FileTree";
import { useVaultStore } from "../../state/vaultStore";
import { useVcsStore } from "../../state/vcsStore";
import { VaultPickerMenu } from "../modals/VaultPickerMenu";
import { ChangesPanel } from "./ChangesPanel";
import { CalendarPanel } from "../calendar/CalendarPanel";
import { CanvasListPanel } from "./CanvasListPanel";
import { TrashPanel } from "./TrashPanel";
import { confirm } from "@tauri-apps/plugin-dialog";
import "./LeftSidebar.css";

// `changes` is the VCS + BYOC home (see docs/impl-v2.md §4 + §5.2).
// It's deep-linked from the status-pill sync indicator so the same
// surface is reachable from both the activity strip and the bottom-
// right corner of the app — single source of truth for "sync state".
//
// `calendar` (v2 §1.5) hosts the unified calendar surface — events
// (today: local; later: Outlook/Google/Apple/Cal.com) + the journal
// CTA (v2 §2.3) so the calendar IS the daily-notes entry point.
//
// Both `changes` and `calendar` are entered through the L-strip
// (see [`LeftActivityStrip`]) so the header here only carries the
// in-vault navigation tabs (files / search / bookmarks).
export type LeftView =
  | "files"
  | "search"
  | "bookmarks"
  | "changes"
  | "calendar"
  | "canvas"
  | "trash";

type Props = {
  vaultName: string;
  view: LeftView;
  onChangeView: (v: LeftView) => void;
  files: FileNode[];
  selectedId: string | null;
  onOpenFile: (file: FileNode) => void;
  /**
   * Open an arbitrary vault file by absolute path.  Forwarded down
   * to the [`CalendarPanel`] so clicking "Open today's journal" or
   * an event's linked note lands in a tab using the same code path
   * the file tree uses.
   */
  onOpenFileByPath: (path: string) => void;
  theme: "dark" | "light";
  onToggleTheme: () => void;
  onOpenSettings: () => void;

  /** Open the Manage Vaults modal — invoked from the vault picker's
   *  "Manage vaults\u2026" item. The sidebar only forwards the click;
   *  modal state lives in App so the modal can render at the top of
   *  the tree (above the sidebars). */
  onOpenManageVaults: () => void;
  isMac: boolean;
  onToggleSidebar: () => void;
};

/**
 * Left sidebar column — header (view switcher) + body (active panel) + footer.
 */
export function LeftSidebar({
  vaultName,
  view,
  onChangeView,
  files,
  selectedId,
  onOpenFile,
  onOpenFileByPath,
  theme,
  onToggleTheme,
  onOpenSettings,
  onOpenManageVaults,
  isMac,
  onToggleSidebar,
}: Props) {
  // Vault picker is local state — it's a small popover anchored to the
  // vault button in the footer. The trigger ref is passed to
  // VaultPickerMenu so it can position itself in window coordinates
  // (the menu lives in a portal — see VaultPickerMenu.tsx).
  const [vaultMenuOpen, setVaultMenuOpen] = useState(false);
  const vaultBtnRef = useRef<HTMLButtonElement>(null);
  const knownVaults = [vaultName].filter(Boolean);

  const vaultPath = useVaultStore((s) => s.vaultPath);
  // Subscribe to VCS state ONLY for the bits the sidebar header /
  // toolbar need.  Subscribing to the whole status object would cause
  // pointless re-renders on every commit; we only need the spinner
  // flag here.
  const vcsRefreshing = useVcsStore((s) => s.refreshing);
  const vcsRefresh = useVcsStore((s) => s.refresh);
  const [inlineEdit, setInlineEdit] = useState<InlineEditState>(null);

  const trashNode = files.find((n) => n.name === "trash" && n.kind === "folder");
  const trashItems = trashNode?.children || [];

  const handleEmptyTrash = async () => {
    const doEmpty = await confirm("Are you sure you want to permanently delete all items in the Trash?", {
      title: "Empty Trash",
      kind: "warning",
    });
    if (doEmpty) {
      try {
        const { emptyTrash } = await import("../../lib/tauriApi");
        await emptyTrash();
        useVaultStore.getState().refreshTree();
      } catch (err) {
        console.error("Empty trash failed:", err);
      }
    }
  };
  return (
    <>
      {/* Header — view switcher tabs */}
      <div className="col-header ls-header" data-tauri-drag-region style={isMac ? { paddingLeft: 40 } : {}}>
        <button
          className={`icon-btn${view === "files" ? " active" : ""}`}
          title="Files"
          onClick={() => onChangeView("files")}
        >
          <IcFolder />
        </button>
        <button
          className={`icon-btn${view === "search" ? " active" : ""}`}
          title="Search"
          onClick={() => onChangeView("search")}
        >
          <IcSearch />
        </button>
        <button
          className={`icon-btn${view === "bookmarks" ? " active" : ""}`}
          title="Bookmarks"
          onClick={() => onChangeView("bookmarks")}
        >
          <IcBookmark />
        </button>
        <button
          className={`icon-btn${view === "trash" ? " active" : ""}`}
          title="Trash"
          onClick={() => onChangeView("trash")}
        >
          <IcTrash />
        </button>
        <div className="ls-header-drag" data-tauri-drag-region />
        {isMac && (
          <button
            className="icon-btn tiny ls-toggle-btn"
            title="Hide left sidebar"
            onClick={onToggleSidebar}
            style={{ marginRight: 6 }}
          >
            <IcPanelLeft open={true} />
          </button>
        )}
      </div>

      {/* Body */}
      <div className="col-body">
        {/* Toolbar */}
        <div className="ls-toolbar">
          {view === "files" && (
            <>
              <button className="icon-btn tiny" title="New note" onClick={() => vaultPath && setInlineEdit({ path: vaultPath, type: "newFile" })}>
                <IcEdit />
              </button>
              <button className="icon-btn tiny" title="New folder" onClick={() => vaultPath && setInlineEdit({ path: vaultPath, type: "newFolder" })}>
                <IcNewFolder />
              </button>

              <button className="icon-btn tiny" title="Sort">
                <IcSortAZ />
              </button>
              <button className="icon-btn tiny" title="Collapse all">
                <IcCollapseAll />
              </button>
              <span className="ls-toolbar-spacer" />
              <button className="icon-btn tiny" title="More">
                <IcMore />
              </button>
            </>
          )}
          {view === "search" && (
            <input
              className="ls-search-input"
              type="text"
              placeholder="Search…"
            />
          )}
          {view === "bookmarks" && (
            <>
              <span className="ls-toolbar-label">Bookmarks</span>
              <span className="ls-toolbar-spacer" />
              <button className="icon-btn tiny" title="More">
                <IcMore />
              </button>
            </>
          )}
          {view === "changes" && (
            <>
              <span className="ls-toolbar-label">Changes</span>
              <span className="ls-toolbar-spacer" />
              <button
                className="icon-btn tiny"
                title={
                  vcsRefreshing
                    ? "Refreshing…"
                    : "Refresh version-control status"
                }
                // Disable only when there's literally no vault to scan;
                // the spinner is for cosmetics — the store debounces
                // so spamming the click is harmless.
                onClick={() => vaultPath && void vcsRefresh(vaultPath)}
                disabled={!vaultPath}
              >
                <IcRefresh />
              </button>
              <button className="icon-btn tiny" title="More">
                <IcMore />
              </button>
            </>
          )}
          {view === "calendar" && (
            <>
              <span className="ls-toolbar-label">Calendar</span>
              <span className="ls-toolbar-spacer" />
            </>
          )}
          {view === "canvas" && (
            <>
              <span className="ls-toolbar-label">Canvas files</span>
              <span className="ls-toolbar-spacer" />
            </>
          )}
          {view === "trash" && (
            <>
              <span className="ls-toolbar-label">Trash ({trashItems.length})</span>
              <span className="ls-toolbar-spacer" />
              {trashItems.length > 0 && (
                <button
                  className="icon-btn tiny"
                  title="Empty Trash"
                  onClick={handleEmptyTrash}
                  style={{ color: "var(--text-accent-hover, #ff6b6b)" }}
                >
                  <IcTrash />
                </button>
              )}
            </>
          )}
        </div>

        {/* Active view — keyed on `view` so React remounts the subtree
            when the user switches tabs. The remount kicks off the CSS
            `ls-view-fade` animation in LeftSidebar.css, giving a soft
            cross-fade instead of an instant swap. */}
        <div className="ls-content">
          <div key={view} className="ls-view">
            {view === "files" && (
              <FileTree 
                nodes={files.filter((n) => n.name !== "trash")} 
                selectedId={selectedId} 
                onOpen={onOpenFile} 
                inlineEdit={inlineEdit}
                setInlineEdit={setInlineEdit}
                vaultPath={vaultPath}
              />
            )}
            {view === "search" && (
              <div className="ls-empty">Type to search the vault.</div>
            )}
            {view === "bookmarks" && (
              <div className="ls-empty">No bookmarks yet.</div>
            )}
            {view === "changes" && <ChangesPanel />}
            {view === "calendar" && (
              <CalendarPanel onOpenFileByPath={onOpenFileByPath} />
            )}
            {view === "canvas" && (
              <CanvasListPanel onOpenFile={onOpenFile} />
            )}
            {view === "trash" && <TrashPanel />}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="col-footer ls-footer">
        <div className="ls-vault-wrap">
          <button
            ref={vaultBtnRef}
            className="ls-vault"
            title="Switch vault"
            onClick={() => setVaultMenuOpen((o) => !o)}
          >
            <IcChevronDown />
            <span className="ls-vault-name">{vaultName}</span>
          </button>
          {vaultMenuOpen && (
            <VaultPickerMenu
              anchor={vaultBtnRef.current}
              vaults={knownVaults}
              active={vaultName}
              onSelect={() => {
                // Vault switching is not wired to real storage yet —
                // close the menu so the UX is correct end-to-end.
                setVaultMenuOpen(false);
              }}
              onManage={() => {
                setVaultMenuOpen(false);
                onOpenManageVaults();
              }}
              onClose={() => setVaultMenuOpen(false)}
            />
          )}
        </div>
        {/* Trailing icons are grouped so they always sit at the right
            and never get squeezed out — the vault label ellipsizes
            instead. (See LeftSidebar.css `.ls-footer-icons`.) */}
        <div className="ls-footer-icons">
          <button
            className="icon-btn tiny"
            title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            aria-label="Toggle theme"
            onClick={onToggleTheme}
          >
            {theme === "dark" ? <IcSun /> : <IcMoon />}
          </button>
          <button className="icon-btn tiny" title="Help">
            <IcHelp />
          </button>
          <button
            className="icon-btn tiny"
            title="Settings"
            onClick={onOpenSettings}
          >
            <IcGear />
          </button>
        </div>
      </div>
    </>
  );
}
