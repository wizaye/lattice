import { useRef, useState } from "react";
import type { FileNode } from "../../state/types";
import {
  IcBookmark,
  IcChevronDown,
  IcCollapseAll,
  IcEdit,
  IcFolder,
  IcGear,
  IcGraph,
  IcHelp,
  IcMoon,
  IcMore,
  IcNewFolder,
  IcPanelLeft,
  IcSearch,
  IcSortAZ,
  IcSun,
} from "../common/Icons";
import { FileTree, type InlineEditState } from "../filetree/FileTree";
import { useVaultStore } from "../../state/vaultStore";
import { VaultPickerMenu } from "../modals/VaultPickerMenu";
import "./LeftSidebar.css";

export type LeftView = "files" | "search" | "bookmarks";

type Props = {
  vaultName: string;
  view: LeftView;
  onChangeView: (v: LeftView) => void;
  files: FileNode[];
  selectedId: string | null;
  onOpenFile: (file: FileNode) => void;
  theme: "dark" | "light";
  onToggleTheme: () => void;
  onOpenSettings: () => void;
  onOpenGraph: () => void;
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
  theme,
  onToggleTheme,
  onOpenSettings,
  onOpenManageVaults,
  onOpenGraph,
  isMac,
  onToggleSidebar,
}: Props) {
  // Vault picker is local state — it's a small popover anchored to the
  // vault button in the footer. The trigger ref is passed to
  // VaultPickerMenu so it can position itself in window coordinates
  // (the menu lives in a portal — see VaultPickerMenu.tsx).
  const [vaultMenuOpen, setVaultMenuOpen] = useState(false);
  const vaultBtnRef = useRef<HTMLButtonElement>(null);
  const knownVaults = [
    "vijay's corp obsidian vault",
    "BoQ",
    vaultName,
  ].filter((v, i, a) => a.indexOf(v) === i);

  const vaultPath = useVaultStore((s) => s.vaultPath);
  const [inlineEdit, setInlineEdit] = useState<InlineEditState>(null);
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
        </div>

        {/* Active view — keyed on `view` so React remounts the subtree
            when the user switches tabs. The remount kicks off the CSS
            `ls-view-fade` animation in LeftSidebar.css, giving a soft
            cross-fade instead of an instant swap. */}
        <div className="ls-content">
          <div key={view} className="ls-view">
            {view === "files" && (
              <FileTree 
                nodes={files} 
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
        <span className="ls-footer-spacer" />
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
    </>
  );
}
