import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { DropEdge, FileNode, SplitTree, Tab } from "../../state/types";
import {
  findLeaf,
  insertTabAt,
  leaves,
  mapLeaves,
  moveTabWithinLeaf,
  openTabInLeaf,
  removeTabFromLeaf,
  setSplitRatio,
  splitLeaf,
  topRightLeaf,
  uid,
} from "../../state/splitTree";
// Markdown component kept for future reading-mode toggle
import { CodeMirrorEditor } from "./CodeMirrorEditor";
import { MarkdownPreview } from "./MarkdownPreview";
import { PdfView } from "./PdfView";
import "./PdfView.css";
import { SlidesView } from "./SlidesView";
import "./SlidesView.css";
import { CanvasView } from "../canvas/CanvasView";
import { EmptyTab } from "./EmptyTab";
import { setDragImageBelowCursor } from "../common/dragGhost";
import {
  IcArrowDown,
  IcArrowLeft,
  IcArrowRight,
  IcArrowUp,
  IcBook,
  IcBookmark,
  IcCamera,
  IcCheck,
  IcChevronDown,
  IcChevronLeft,
  IcChevronRight,
  IcClose,
  IcCloseAll,
  IcCode,
  IcCopy,
  IcEdit,
  IcEye,
  IcFileAdd,
  IcFilePdf,
  IcFolderOpened,
  IcGear,
  IcHistory,
  IcLink,
  IcLinkExternal,
  IcLocation,
  IcMerge,
  IcMore,
  IcNewFile,
  IcPanelLeft,
  IcPanelRight,
  IcPin,
  IcPinned,
  IcPlus,
  IcReplace,
  IcSearch,
  IcSlideshow,
  IcSplit,
  IcSplitH,
  IcSplitV,
  IcStack,
  IcSwap,
  IcTrash,
  IcUnlink,
} from "../common/Icons";
import { useEditorStore } from "../../state/editorStore";
import { useVaultStore } from "../../state/vaultStore";
import GraphView from "./GraphView";
import { KanbanView } from "./KanbanView";
import { PaperToolbar } from "../paper/PaperToolbar";
import "./EditorArea.css";

/**
 * Walk up an absolute file path looking for an ancestor directory
 * whose `.lattice/paper.toml` is present in the flat vault map.  This
 * is how the EditorArea knows to render a `<PaperToolbar />` above a
 * markdown editor: no filesystem call, just a constant-time lookup in
 * the already-loaded vault tree.
 *
 * Returns the absolute path of the paper root, or `null` when the
 * markdown file is a plain vault note (no enclosing paper project).
 *
 * Both forward- and back-slash separators are supported so this works
 * unchanged on Windows + macOS + Linux.
 */
function paperRootForPath(
  filePath: string,
  flatVault: Map<string, { kind: string }>,
): string | null {
  if (!filePath) return null;
  // Detect the separator the path uses and walk up by trimming the
  // last segment until we either hit a root or find a `.lattice/paper.toml`
  // entry in the flat vault.
  const sep = filePath.includes("\\") && !filePath.includes("/") ? "\\" : "/";
  let cur = filePath;
  // 32 hops is more than enough for any sane vault layout and bounds
  // the loop tightly.
  for (let i = 0; i < 32; i++) {
    const idx = cur.lastIndexOf(sep);
    if (idx <= 0) break;
    cur = cur.slice(0, idx);
    const probe = `${cur}${sep}.lattice${sep}paper.toml`;
    if (flatVault.has(probe)) return cur;
  }
  return null;
}

/**
 * Ask the user what to do with a dirty file before closing its tab.
 * Returns `true` to proceed with the close, `false` to abort.
 *
 * Uses Tauri's native dialog when running inside the app shell
 * (multi-button: Save, Don't Save, Cancel) and falls back to a plain
 * `window.confirm` in browser preview — so plain `vite dev` at
 * localhost still behaves sanely. We dynamically import the dialog
 * plugin so the browser build doesn't choke on the Tauri module.
 */
async function confirmDiscardDirty(
  paths: string[],
  saveAll: (paths: string[]) => Promise<void>,
): Promise<boolean> {
  if (paths.length === 0) return true;
  const summary =
    paths.length === 1
      ? `"${paths[0].split(/[/\\]/).pop()}" has unsaved changes.`
      : `${paths.length} files have unsaved changes.`;
  // Try Tauri's 3-button ask dialog first.
  try {
    const mod = await import("@tauri-apps/plugin-dialog");
    // Tauri's `ask` is yes/no — it doesn't give us a third "Cancel"
    // button, so we run it twice: first ask "Save before closing?"
    // (Save | Don't Save), then if neither was chosen, escape.
    const save = await mod.ask(
      `${summary}\n\nSave changes before closing?`,
      { title: "Unsaved changes", kind: "warning", okLabel: "Save", cancelLabel: "Don't Save" },
    );
    if (save) {
      await saveAll(paths);
    }
    return true;
  } catch {
    // Browser fallback — single OK/Cancel prompt.
    return window.confirm(`${summary}\n\nDiscard unsaved changes?`);
  }
}

type Props = {
  tree: SplitTree;
  vault: Map<string, FileNode>;
  activeLeafId: string;
  onChangeActiveLeaf: (id: string) => void;
  onTreeChange: (next: SplitTree | null) => void;
  /** Called by canvas / markdown editors when the user changes a file's
   *  body. App-level state is the source of truth, so the editor area
   *  doesn't hold its own mirror — it just forwards saves up. */
  onUpdateFileContent?: (fileId: string, content: string) => void;
  leftSidebarCollapsed: boolean;
  onToggleLeftSidebar: () => void;
  rightSidebarCollapsed: boolean;
  onToggleRightSidebar: () => void;
  /** px of right padding to reserve in the topmost pane's tabbar so its
   *  controls don't slide under the floating window-controls cluster. */
  topRightInsetPx: number;
  /** px of left padding to reserve for macos traffic lights when left sidebar is collapsed. */
  topLeftInsetPx: number;
  onOpenFileByPath?: (path: string) => void;
};

/**
 * Editor area — the whole split tree of panes.
 * No outer header: the topmost pane's tabbar IS the top strip and
 * visually aligns with the other columns' 36px headers.
 */
export function EditorArea(props: Props) {
  const {
    tree,
    vault,
    activeLeafId,
    onChangeActiveLeaf,
    onTreeChange,
    onUpdateFileContent,
    leftSidebarCollapsed,
    onToggleLeftSidebar,
    rightSidebarCollapsed,
    onToggleRightSidebar,
    topRightInsetPx,
    topLeftInsetPx,
    onOpenFileByPath,
  } = props;

  // ---- tab ops ---------------------------------------------------------
  const setLeaf = useCallback(
    (
      leafId: string,
      updater: (
        leaf: Extract<SplitTree, { kind: "leaf" }>,
      ) => SplitTree | null,
    ) => {
      const next = mapLeaves(tree, (leaf) =>
        leaf.id === leafId ? updater(leaf) : leaf,
      );
      onTreeChange(next);
    },
    [tree, onTreeChange],
  );

  const onNewTabInLeaf = useCallback(
    (leafId: string) => {
      const newTab: Tab = {
        id: uid("tab"),
        fileId: null,
        title: "New tab",
      };
      setLeaf(leafId, (leaf) => openTabInLeaf(leaf, newTab));
      onChangeActiveLeaf(leafId);
    },
    [setLeaf, onChangeActiveLeaf],
  );

  const onCloseTab = useCallback(
    async (leafId: string, tabId: string) => {
      // Dirty-tab check: if the file in this tab has unsaved edits,
      // prompt the user to Save / Don't Save (Tauri) or confirm
      // discard (browser fallback). Abort the close if they back out.
      const leaf = findLeaf(tree, leafId);
      const tab = leaf?.tabs.find((t) => t.id === tabId);
      if (tab?.fileId) {
        const es = useEditorStore.getState();
        if (es.dirtyFiles.has(tab.fileId)) {
          const ok = await confirmDiscardDirty([tab.fileId], async (paths) => {
            for (const p of paths) await useEditorStore.getState().saveFile(p);
          });
          if (!ok) return;
        }
      }
      // If this pane belongs to a split, closing the last tab collapses
      // the split (the sibling pane takes over the space). Only the
      // root pane — when it is the entire tree — gets repopulated with
      // a fresh "New tab" so the editor area is never completely empty.
      const isRootLeaf = tree.kind === "leaf" && tree.id === leafId;
      setLeaf(leafId, (leaf) => {
        const next = removeTabFromLeaf(leaf, tabId);
        if (next === null && isRootLeaf) {
          const fresh: Tab = {
            id: uid("tab"),
            fileId: null,
            title: "New tab",
          };
          return {
            kind: "leaf",
            id: leaf.id,
            tabs: [fresh],
            activeTabId: fresh.id,
          };
        }
        return next;
      });
    },
    [tree, setLeaf],
  );

  const onActivateTab = useCallback(
    (leafId: string, tabId: string) => {
      setLeaf(leafId, (leaf) => ({ ...leaf, activeTabId: tabId }));
      onChangeActiveLeaf(leafId);
    },
    [setLeaf, onChangeActiveLeaf],
  );

  // Flip a tab between source-mode (CodeMirror) and reading-mode
  // (MarkdownPreview). Lives at the EditorArea root because it needs
  // the split-tree mutator; the doc-header button in `Pane` just calls
  // this through props.
  //
  // Only toggles between "source" ↔ "preview". "slides" is set via
  // `onSetViewMode` from the DocMoreMenu — keeping the binary toggle
  // here means the doc-header IcBook/IcEdit button stays predictable
  // (one click flips between exactly two states) and never traps the
  // user in slides mode by accident.
  const onToggleViewMode = useCallback(
    (leafId: string, tabId: string) => {
      setLeaf(leafId, (leaf) => ({
        ...leaf,
        tabs: leaf.tabs.map((t) =>
          t.id === tabId
            ? {
                ...t,
                // From "slides" we leave back to "source" — the most
                // common intent is "give me the editor back".
                viewMode: t.viewMode === "preview" ? "source" : "preview",
              }
            : t,
        ),
      }));
    },
    [setLeaf],
  );

  // Set a tab to a specific view mode. Used by the DocMoreMenu where
  // we expose three discrete entries (Reading / Source / Slides) — a
  // toggle isn't enough because there are three states.
  const onSetViewMode = useCallback(
    (leafId: string, tabId: string, mode: "source" | "preview" | "slides") => {
      setLeaf(leafId, (leaf) => ({
        ...leaf,
        tabs: leaf.tabs.map((t) =>
          t.id === tabId ? { ...t, viewMode: mode } : t,
        ),
      }));
    },
    [setLeaf],
  );

  // "Close all" from the tabbar's View-options menu. Mirrors onCloseTab's
  // root-vs-non-root rule: the root pane keeps a single fresh "New tab"
  // (the editor can never be completely empty); any other pane collapses
  // so its sibling absorbs the space.
  const onCloseAllInLeaf = useCallback(
    async (leafId: string) => {
      // Dirty-tab check across every tab in the pane.
      const leaf = findLeaf(tree, leafId);
      const dirty: string[] = [];
      if (leaf) {
        const es = useEditorStore.getState();
        for (const t of leaf.tabs) {
          if (t.fileId && es.dirtyFiles.has(t.fileId)) dirty.push(t.fileId);
        }
      }
      if (dirty.length > 0) {
        const ok = await confirmDiscardDirty(dirty, async (paths) => {
          for (const p of paths) await useEditorStore.getState().saveFile(p);
        });
        if (!ok) return;
      }
      const isRootLeaf = tree.kind === "leaf" && tree.id === leafId;
      setLeaf(leafId, (leaf) => {
        if (isRootLeaf) {
          const fresh: Tab = {
            id: uid("tab"),
            fileId: null,
            title: "New tab",
          };
          return {
            kind: "leaf",
            id: leaf.id,
            tabs: [fresh],
            activeTabId: fresh.id,
          };
        }
        return null;
      });
    },
    [tree, setLeaf],
  );

  // ---- explicit split (from the in-pane Split menu) -------------------
  // Direction maps:
  //   right → horizontal, placeAfter=true   (new pane appears to the right)
  //   left  → horizontal, placeAfter=false  (new pane to the left)
  //   down  → vertical,   placeAfter=true   (new pane below)
  //   up    → vertical,   placeAfter=false  (new pane above)
  // We always seed the new pane with a fresh "New tab" and focus it,
  // so the user's next typing/clicking lands in the just-created split
  // (mirrors Obsidian / VS Code behavior).
  const onSplitInLeaf = useCallback(
    (leafId: string, edge: Exclude<DropEdge, "center">) => {
      const newTab: Tab = {
        id: uid("tab"),
        fileId: null,
        title: "New tab",
      };
      const newLeaf: Extract<SplitTree, { kind: "leaf" }> = {
        kind: "leaf",
        id: uid("leaf"),
        tabs: [newTab],
        activeTabId: newTab.id,
      };
      const direction =
        edge === "left" || edge === "right" ? "horizontal" : "vertical";
      const placeAfter = edge === "right" || edge === "bottom";
      onTreeChange(splitLeaf(tree, leafId, direction, newLeaf, placeAfter));
      onChangeActiveLeaf(newLeaf.id);
    },
    [tree, onTreeChange, onChangeActiveLeaf],
  );

  // ---- drag-to-resize split divider ----------------------------------
  // Fired on every pointermove during a divider drag with the new ratio
  // (already clamped to [0.05, 0.95] by setSplitRatio).
  const onResizeSplit = useCallback(
    (splitId: string, ratio: number) => {
      onTreeChange(setSplitRatio(tree, splitId, ratio));
    },
    [tree, onTreeChange],
  );

  // ---- pin / unpin a tab ---------------------------------------------
  // Pinned tabs:
  //   - skip the "Close all" / "Close others" sweep
  //   - render a pin icon in place of the X close button
  // We don't reorder pinned-first here (Obsidian leaves the tab where
  // the user placed it); the visual marker is enough.
  const onTogglePinTab = useCallback(
    (leafId: string, tabId: string) => {
      setLeaf(leafId, (leaf) => ({
        ...leaf,
        tabs: leaf.tabs.map((t) =>
          t.id === tabId ? { ...t, isPinned: !t.isPinned } : t,
        ),
      }));
    },
    [setLeaf],
  );

  // ---- "Close others" — close every tab in this leaf except `tabId`,
  // honouring pin state. Pinned tabs survive (Obsidian behaviour).
  // Runs the dirty-file gate across the soon-to-close set so the user
  // gets a single combined save/discard prompt instead of one per tab.
  const onCloseOthersInLeaf = useCallback(
    async (leafId: string, tabId: string) => {
      const leaf = findLeaf(tree, leafId);
      if (!leaf) return;
      const victims = leaf.tabs.filter(
        (t) => t.id !== tabId && !t.isPinned,
      );
      if (victims.length === 0) return;
      const dirty: string[] = [];
      const es = useEditorStore.getState();
      for (const t of victims) {
        if (t.fileId && es.dirtyFiles.has(t.fileId)) dirty.push(t.fileId);
      }
      if (dirty.length > 0) {
        const ok = await confirmDiscardDirty(dirty, async (paths) => {
          for (const p of paths) await useEditorStore.getState().saveFile(p);
        });
        if (!ok) return;
      }
      setLeaf(leafId, (leaf) => ({
        ...leaf,
        tabs: leaf.tabs.filter(
          (t) => t.id === tabId || t.isPinned,
        ),
        activeTabId: tabId,
      }));
    },
    [tree, setLeaf],
  );

  // ---- "Copy path" — write the tab's fileId (== absolute path for
  // real vaults) to the system clipboard.
  const onCopyFilePath = useCallback(async (fileId: string) => {
    try {
      await navigator.clipboard.writeText(fileId);
    } catch (err) {
      console.warn("Copy path failed:", err);
    }
  }, []);

  // ---- "Reveal file in navigation" — fire a global event the file
  // tree listens for; it expands ancestors + scrolls the row into
  // view + flashes a highlight. Keeps EditorArea decoupled from
  // FileTree's internal expand-state machine.
  const onRevealFileInNav = useCallback((fileId: string) => {
    window.dispatchEvent(
      new CustomEvent("lattice-reveal-file", { detail: { fileId } }),
    );
  }, []);

  // ---- "Show in system explorer" / "Open in default app" — both go
  // through @tauri-apps/plugin-opener. We dynamic-import so plain
  // `vite dev` (no Tauri) doesn't blow up at module-eval time.
  const onShowInExplorer = useCallback(async (fileId: string) => {
    try {
      const mod = await import("@tauri-apps/plugin-opener");
      await mod.revealItemInDir(fileId);
    } catch (err) {
      console.warn("Show in explorer failed:", err);
    }
  }, []);

  const onOpenInDefaultApp = useCallback(async (fileId: string) => {
    try {
      const mod = await import("@tauri-apps/plugin-opener");
      await mod.openPath(fileId);
    } catch (err) {
      console.warn("Open in default app failed:", err);
    }
  }, []);

  // ---- "Rename" — kicks the file tree's inline-rename UI by firing
  // a global event the FileTree component listens for. This way all
  // rename + link-rewrite logic stays in one place.
  const onRenameFile = useCallback((fileId: string) => {
    window.dispatchEvent(
      new CustomEvent("lattice-rename-file", { detail: { fileId } }),
    );
  }, []);

  // ---- "Delete file" — confirms, removes the file from disk via the
  // existing tauri command, refreshes the vault, then closes every tab
  // that was pointing at it.
  const onDeleteFile = useCallback(
    async (fileId: string) => {
      // Lazy-import the dialog so vite dev (no Tauri) still works.
      let ok = false;
      try {
        const dlg = await import("@tauri-apps/plugin-dialog");
        const name = fileId.split(/[/\\]/).pop() ?? fileId;
        ok = await dlg.confirm(`Delete "${name}"?`, {
          title: "Delete file",
          kind: "warning",
        });
      } catch {
        ok = window.confirm(`Delete "${fileId}"?`);
      }
      if (!ok) return;
      try {
        const { deleteFile } = await import("../../lib/tauriApi");
        await deleteFile(fileId);
        await useVaultStore.getState().refreshTree();
      } catch (err) {
        console.error("Delete failed:", err);
        return;
      }
      // Close any tabs that were pointing at this file. We walk the
      // tree once and produce a new tree with every matching tab
      // removed in one shot — avoids cascading async confirmDiscardDirty
      // prompts that the per-tab onCloseTab path would trigger.
      const next = mapLeaves(tree, (leaf) => {
        const kept = leaf.tabs.filter((t) => t.fileId !== fileId);
        if (kept.length === leaf.tabs.length) return leaf;
        if (kept.length === 0) {
          // Root pane gets a fresh New tab so the editor is never
          // completely empty; non-root collapses (sibling absorbs).
          const isRootLeaf = tree.kind === "leaf" && tree.id === leaf.id;
          if (isRootLeaf) {
            const fresh: Tab = {
              id: uid("tab"),
              fileId: null,
              title: "New tab",
            };
            return {
              kind: "leaf",
              id: leaf.id,
              tabs: [fresh],
              activeTabId: fresh.id,
            };
          }
          return null;
        }
        const activeStillThere = kept.some((t) => t.id === leaf.activeTabId);
        return {
          ...leaf,
          tabs: kept,
          activeTabId: activeStillThere ? leaf.activeTabId : kept[0].id,
        };
      });
      if (next) onTreeChange(next);
      // Also drop any cached dirty bit / content for the deleted file.
      const es = useEditorStore.getState();
      const dirty = new Set(es.dirtyFiles);
      dirty.delete(fileId);
      const contents = { ...es.fileContents };
      delete contents[fileId];
      useEditorStore.setState({ dirtyFiles: dirty, fileContents: contents });
    },
    [tree, onTreeChange],
  );

  // ---- drag and drop ---------------------------------------------------
  const handleDropOnPane = useCallback(
    (leafId: string, edge: DropEdge, data: DT) => {
      // file drag → open in target leaf (with optional split)
      if (data.kind === "file") {
        const file = vault.get(data.fileId);
        if (!file || file.kind === "folder") return;
        const newTab: Tab = {
          id: uid("tab"),
          fileId: file.id,
          title: file.name,
        };
        if (edge === "center") {
          setLeaf(leafId, (leaf) => openTabInLeaf(leaf, newTab));
        } else {
          const newLeaf: Extract<SplitTree, { kind: "leaf" }> = {
            kind: "leaf",
            id: uid("leaf"),
            tabs: [newTab],
            activeTabId: newTab.id,
          };
          const direction =
            edge === "left" || edge === "right" ? "horizontal" : "vertical";
          const placeAfter = edge === "right" || edge === "bottom";
          onTreeChange(splitLeaf(tree, leafId, direction, newLeaf, placeAfter));
          onChangeActiveLeaf(newLeaf.id);
        }
        useEditorStore.getState().loadFile(file.id).then((content) => {
          useVaultStore.getState().updateFileContent(file.id, content);
        });
        return;
      }
      // tab drag → move tab between leaves (or self-rearrange)
      if (data.kind === "tab") {
        const srcLeaf = findLeaf(tree, data.leafId);
        if (!srcLeaf) return;
        const tab = srcLeaf.tabs.find((t) => t.id === data.tabId);
        if (!tab) return;
        if (data.leafId === leafId && edge === "center") return;

        // Remove from source, add to dest. Build a single tree op.
        const moved: Tab = { ...tab };
        let next: SplitTree | null = mapLeaves(tree, (leaf) =>
          leaf.id === data.leafId ? removeTabFromLeaf(leaf, data.tabId) : leaf,
        );
        if (!next) return;

        if (edge === "center") {
          next = mapLeaves(next, (leaf) =>
            leaf.id === leafId ? openTabInLeaf(leaf, moved) : leaf,
          );
        } else {
          const newLeaf: Extract<SplitTree, { kind: "leaf" }> = {
            kind: "leaf",
            id: uid("leaf"),
            tabs: [moved],
            activeTabId: moved.id,
          };
          const direction =
            edge === "left" || edge === "right" ? "horizontal" : "vertical";
          const placeAfter = edge === "right" || edge === "bottom";
          next = splitLeaf(next, leafId, direction, newLeaf, placeAfter);
          onChangeActiveLeaf(newLeaf.id);
        }
        onTreeChange(next);
      }
    },
    [tree, vault, setLeaf, onTreeChange, onChangeActiveLeaf],
  );

  // ---- drop INTO the tabbar (insert at index, or reorder) -------------
  // The tabbar drop is a separate target from the pane body drop:
  //   - File drag  → insert a new tab at `index`.
  //   - Tab drag, same leaf → reorder via moveTabWithinLeaf.
  //   - Tab drag, other leaf → remove from source then insertTabAt.
  // Index is computed in the Pane component from cursor X relative to
  // each tab's midpoint (drop before tab i if cursor < tab.midX).
  const handleDropOnTabbar = useCallback(
    (leafId: string, index: number, data: DT) => {
      if (data.kind === "file") {
        const file = vault.get(data.fileId);
        if (!file || file.kind === "folder") return;
        const newTab: Tab = {
          id: uid("tab"),
          fileId: file.id,
          title: file.name,
        };
        setLeaf(leafId, (leaf) => insertTabAt(leaf, newTab, index));
        onChangeActiveLeaf(leafId);
        useEditorStore.getState().loadFile(file.id).then((content) => {
          useVaultStore.getState().updateFileContent(file.id, content);
        });
        return;
      }
      if (data.kind === "tab") {
        const srcLeaf = findLeaf(tree, data.leafId);
        if (!srcLeaf) return;
        const tab = srcLeaf.tabs.find((t) => t.id === data.tabId);
        if (!tab) return;

        if (data.leafId === leafId) {
          // same-leaf reorder
          setLeaf(leafId, (leaf) =>
            moveTabWithinLeaf(leaf, data.tabId, index),
          );
          return;
        }

        // cross-leaf move
        const moved: Tab = { ...tab };
        let next: SplitTree | null = mapLeaves(tree, (leaf) =>
          leaf.id === data.leafId
            ? removeTabFromLeaf(leaf, data.tabId)
            : leaf,
        );
        if (!next) return;
        next = mapLeaves(next, (leaf) =>
          leaf.id === leafId ? insertTabAt(leaf, moved, index) : leaf,
        );
        if (!next) return;
        onTreeChange(next);
        onChangeActiveLeaf(leafId);
      }
    },
    [tree, vault, setLeaf, onTreeChange, onChangeActiveLeaf],
  );

  // ---- find the topmost-leftmost / topmost-rightmost leaves -----------
  // Top-LEFT pane owns the macOS traffic-light inset + the panel-LEFT
  // toggle that shows when the left sidebar is collapsed.
  // Top-RIGHT pane owns the Windows window-controls inset + the panel-
  // RIGHT toggle. When there's no split, these are the same leaf.
  const topLeftLeafId = useMemo(() => leaves(tree)[0]?.id, [tree]);
  const topRightLeafId = useMemo(() => topRightLeaf(tree).id, [tree]);

  return (
    <div className="editor-area">
      <RenderTree
        node={tree}
        activeLeafId={activeLeafId}
        vault={vault}
        onActivateTab={onActivateTab}
        onCloseTab={onCloseTab}
        onCloseAll={onCloseAllInLeaf}
        onCloseOthers={onCloseOthersInLeaf}
        onTogglePinTab={onTogglePinTab}
        onNewTab={onNewTabInLeaf}
        onSplit={onSplitInLeaf}
        onResizeSplit={onResizeSplit}
        onChangeActiveLeaf={onChangeActiveLeaf}
        onDropOnPane={handleDropOnPane}
        onDropOnTabbar={handleDropOnTabbar}
        onUpdateFileContent={onUpdateFileContent}
        onToggleViewMode={onToggleViewMode}
        onSetViewMode={onSetViewMode}
        onCopyFilePath={onCopyFilePath}
        onRevealFileInNav={onRevealFileInNav}
        onShowInExplorer={onShowInExplorer}
        onOpenInDefaultApp={onOpenInDefaultApp}
        onRenameFile={onRenameFile}
        onDeleteFile={onDeleteFile}
        topLeftLeafId={topLeftLeafId}
        topRightLeafId={topRightLeafId}
        leftSidebarCollapsed={leftSidebarCollapsed}
        onToggleLeftSidebar={onToggleLeftSidebar}
        rightSidebarCollapsed={rightSidebarCollapsed}
        onToggleRightSidebar={onToggleRightSidebar}
        topRightInsetPx={topRightInsetPx}
        topLeftInsetPx={topLeftInsetPx}
        onOpenFileByPath={onOpenFileByPath}
      />
    </div>
  );
}

type DT =
  | { kind: "file"; fileId: string }
  | { kind: "tab"; leafId: string; tabId: string };

function readDT(e: React.DragEvent): DT | null {
  const tabJson = e.dataTransfer.getData("application/x-lattice-tab");
  if (tabJson) {
    try {
      const o = JSON.parse(tabJson) as { leafId: string; tabId: string };
      return { kind: "tab", leafId: o.leafId, tabId: o.tabId };
    } catch {
      /* ignore */
    }
  }
  const fileId = e.dataTransfer.getData("application/x-lattice-file-id");
  if (fileId) return { kind: "file", fileId };
  return null;
}

// ---------------------------------------------------------------------------

type RenderProps = {
  node: SplitTree;
  activeLeafId: string;
  vault: Map<string, FileNode>;
  onActivateTab: (leafId: string, tabId: string) => void;
  onCloseTab: (leafId: string, tabId: string) => void;
  onCloseAll: (leafId: string) => void;
  onCloseOthers: (leafId: string, tabId: string) => void;
  onTogglePinTab: (leafId: string, tabId: string) => void;
  onNewTab: (leafId: string) => void;
  onSplit: (leafId: string, edge: Exclude<DropEdge, "center">) => void;
  onResizeSplit: (splitId: string, ratio: number) => void;
  onChangeActiveLeaf: (id: string) => void;
  onDropOnPane: (leafId: string, edge: DropEdge, data: DT) => void;
  onDropOnTabbar: (leafId: string, index: number, data: DT) => void;
  /** Forwarded to Pane bodies so editors (canvas, future markdown
   *  WYSIWYG) can persist edits without bouncing through context. */
  onUpdateFileContent?: (fileId: string, content: string) => void;
  /** Toggle a tab between source (CodeMirror) and reading mode
   *  (MarkdownPreview). Implemented at the EditorArea root because
   *  that's where the split-tree mutator (setLeaf) lives. */
  onToggleViewMode: (leafId: string, tabId: string) => void;
  /** Set a tab's view mode to a specific value. Used by the
   *  DocMoreMenu's 3-state Reading/Source/Slides switcher. */
  onSetViewMode: (
    leafId: string,
    tabId: string,
    mode: "source" | "preview" | "slides",
  ) => void;
  /** File-action callbacks used by both DocMoreMenu (3-dot in the
   *  doc header) and the tab right-click TabContextMenu. They live
   *  at the root because they need access to the split tree and the
   *  vault store. */
  onCopyFilePath: (fileId: string) => void;
  onRevealFileInNav: (fileId: string) => void;
  onShowInExplorer: (fileId: string) => void;
  onOpenInDefaultApp: (fileId: string) => void;
  onRenameFile: (fileId: string) => void;
  onDeleteFile: (fileId: string) => void;
  topLeftLeafId?: string;
  topRightLeafId?: string;
  leftSidebarCollapsed: boolean;
  onToggleLeftSidebar: () => void;
  rightSidebarCollapsed: boolean;
  onToggleRightSidebar: () => void;
  topRightInsetPx: number;
  topLeftInsetPx: number;
  onOpenFileByPath?: (path: string) => void;
};

function RenderTree(props: RenderProps) {
  const { node } = props;

  if (node.kind === "leaf") {
    return <Pane {...props} leaf={node} />;
  }

  return <SplitNode {...props} node={node} />;
}

/**
 * Renders one split node and its draggable divider.
 *
 * The divider drag captures container dimensions + the starting ratio
 * at pointerdown so that intermediate state updates don't disturb the
 * math — each move recomputes the absolute new ratio from the cursor's
 * position relative to drag start, then clamps to [0.05, 0.95] via
 * setSplitRatio in the parent. Using setPointerCapture keeps the drag
 * alive even if the cursor leaves the divider element.
 */
function SplitNode(
  props: Omit<RenderProps, "node"> & {
    node: Extract<SplitTree, { kind: "split" }>;
  },
) {
  const { node, onResizeSplit } = props;
  const isHorizontal = node.direction === "horizontal";
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<
    | {
        startCoord: number;
        startRatio: number;
        containerSize: number;
      }
    | null
  >(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const size = isHorizontal ? rect.width : rect.height;
      if (size <= 0) return;
      dragRef.current = {
        startCoord: isHorizontal ? e.clientX : e.clientY,
        startRatio: node.ratio,
        containerSize: size,
      };
      // setPointerCapture can throw NotFoundError if the pointer id
      // is not currently active (e.g. synthetic events in tests).
      try {
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      } catch {
        /* not capturable — drag still works via window pointermove */
      }
      document.body.style.cursor = isHorizontal ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
    },
    [isHorizontal, node.ratio],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const current = isHorizontal ? e.clientX : e.clientY;
      const delta = current - d.startCoord;
      const newRatio =
        (d.startRatio * d.containerSize + delta) / d.containerSize;
      onResizeSplit(node.id, newRatio);
    },
    [isHorizontal, node.id, onResizeSplit],
  );

  const endDrag = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    try {
      (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    } catch {
      /* not captured — nothing to release */
    }
  }, []);

  return (
    <div
      ref={containerRef}
      className={`split ${isHorizontal ? "horizontal" : "vertical"}`}
    >
      <div
        className="split-child"
        style={flexBasis(node.ratio, isHorizontal)}
      >
        <RenderTree {...props} node={node.a} />
      </div>
      <div
        className={`split-divider ${
          isHorizontal ? "vertical" : "horizontal"
        }`}
        role="separator"
        aria-orientation={isHorizontal ? "vertical" : "horizontal"}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="split-divider-hit" />
      </div>
      <div
        className="split-child"
        style={flexBasis(1 - node.ratio, isHorizontal)}
      >
        <RenderTree {...props} node={node.b} />
      </div>
    </div>
  );
}

function flexBasis(ratio: number, _isHorizontal: boolean): React.CSSProperties {
  return { flex: `${ratio} 1 0`, minWidth: 0, minHeight: 0 };
}

// ---------------------------------------------------------------------------

type PaneProps = RenderProps & {
  leaf: Extract<SplitTree, { kind: "leaf" }>;
};

function Pane(props: PaneProps) {
  const {
    leaf,
    activeLeafId,
    vault,
    onActivateTab,
    onCloseTab,
    onCloseAll,
    onCloseOthers,
    onTogglePinTab,
    onNewTab,
    onSplit,
    onChangeActiveLeaf,
    onDropOnPane,
    onDropOnTabbar,
    onUpdateFileContent,
    onToggleViewMode,
    onSetViewMode,
    onCopyFilePath,
    onRevealFileInNav,
    onShowInExplorer,
    onOpenInDefaultApp,
    onRenameFile,
    onDeleteFile,
    topLeftLeafId,
    topRightLeafId,
    leftSidebarCollapsed,
    onToggleLeftSidebar,
    rightSidebarCollapsed,
    onToggleRightSidebar,
    topRightInsetPx,
    topLeftInsetPx,
    onOpenFileByPath,
  } = props;

  const isActive = leaf.id === activeLeafId;
  const isTopLeft = leaf.id === topLeftLeafId;
  const isTopRight = leaf.id === topRightLeafId;
  const activeTab = leaf.tabs.find((t) => t.id === leaf.activeTabId);
  // The canvas tool has its own in-pane controls (export, zoom HUD,
  // tool palette). Showing the markdown reading-mode + per-file More
  // menu on top of it looks duplicative, so hide those entries
  // whenever the active tab is a canvas document.
  const activeFile = activeTab?.fileId ? vault.get(activeTab.fileId) : null;
  const isCanvasTab = activeFile?.kind === "canvas";
  // PDF tabs render a non-editable pdfjs viewer (PdfView). Hide the
  // markdown-specific doc chrome (reading-mode toggle, DocMoreMenu
  // items like Find/Replace) since none of them apply.
  const isPdfTab = activeFile?.kind === "pdf";
  // Graph view is a virtual tab (`fileId === "__graph__"`) with no
  // backing FileNode. It needs a graph-specific More menu (Split
  // right / Split down / Copy screenshot / Bookmark) rather than the
  // markdown DocMoreMenu, which is full of file-only items like
  // Rename, Export to PDF, Find/Replace.
  const isGraphTab  = activeTab?.fileId === "__graph__";
  const isKanbanTab = activeTab?.fileId === "__kanban__";

  const paneRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const [dropEdge, setDropEdge] = useState<DropEdge | null>(null);
  // Tabbar insertion indicator: `idx` = the array slot we'd insert at,
  // `left` = the px offset (within .pane-tabs) where the indicator line
  // should render. Null when no drag is hovering the tabbar.
  const [tabInsert, setTabInsert] = useState<
    { idx: number; left: number } | null
  >(null);

  const calcEdge = (e: React.DragEvent): DropEdge => {
    const el = paneRef.current;
    if (!el) return "center";
    const rect = el.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    const m = 0.2;
    if (x < m) return "left";
    if (x > 1 - m) return "right";
    if (y < m) return "top";
    if (y > 1 - m) return "bottom";
    return "center";
  };

  // Compute insertion index + indicator left-offset based on cursor X.
  // Iterates each rendered `.tab` and picks the first one whose mid-X
  // is past the cursor (= drop BEFORE that tab). If past the last tab,
  // returns `tabs.length` (= append). Left is measured against the
  // `.pane-tabs` container so the indicator can be positioned with a
  // simple `left: <px>` style.
  const calcTabInsert = (e: React.DragEvent): { idx: number; left: number } => {
    const container = tabsRef.current;
    if (!container) return { idx: leaf.tabs.length, left: 0 };
    const tabs = Array.from(
      container.querySelectorAll<HTMLElement>(":scope > .tab"),
    );
    const cRect = container.getBoundingClientRect();
    if (tabs.length === 0) return { idx: 0, left: 0 };
    for (let i = 0; i < tabs.length; i++) {
      const r = tabs[i].getBoundingClientRect();
      if (e.clientX < r.left + r.width / 2) {
        return { idx: i, left: r.left - cRect.left };
      }
    }
    const last = tabs[tabs.length - 1].getBoundingClientRect();
    return { idx: tabs.length, left: last.right - cRect.left };
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropEdge(calcEdge(e));
  };
  const onDragLeave = (e: React.DragEvent) => {
    // dragleave fires every time the cursor crosses INTO a child node,
    // so we can't use `currentTarget === target`. Instead check
    // relatedTarget (the element being entered) \u2014 only clear if the
    // pointer actually moved to something outside this pane.
    const next = e.relatedTarget as Node | null;
    if (!next || !e.currentTarget.contains(next)) {
      setDropEdge(null);
    }
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const edge = calcEdge(e);
    const data = readDT(e);
    setDropEdge(null);
    if (!data) return;
    onDropOnPane(leaf.id, edge, data);
  };

  // ---- safety net: clear overlays on global dragend / drop -----------
  // Without this, the .drop-overlay can stick on a pane when the user
  // hovers it then drops elsewhere (the destination's drop handler only
  // clears its own dropEdge, not other panes that were passed over).
  // `dragend` fires on the SOURCE no matter where the drag ended (drop,
  // cancel, escape). `drop` is a belt-and-suspenders fallback in case
  // dragend gets swallowed by Tauri's webview.
  useEffect(() => {
    const clear = () => {
      setDropEdge(null);
      setTabInsert(null);
    };
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, []);

  // Tabbar drop handlers — stopPropagation so the pane's edge overlay
  // doesn't ALSO fire (the tabbar is a more specific drop target).
  const onTabbarDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    setDropEdge(null);
    setTabInsert(calcTabInsert(e));
  };
  const onTabbarDragLeave = (e: React.DragEvent) => {
    // Only clear when the pointer actually exited the tabbar (not just
    // moved to a child). relatedTarget is the element being entered.
    const next = e.relatedTarget as Node | null;
    if (!next || !e.currentTarget.contains(next)) {
      setTabInsert(null);
    }
  };
  const onTabbarDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const data = readDT(e);
    const { idx } = calcTabInsert(e);
    setTabInsert(null);
    setDropEdge(null);
    if (!data) return;
    onDropOnTabbar(leaf.id, idx, data);
  };

  return (
    <div
      ref={paneRef}
      className={`pane${isActive ? " active" : ""}`}
      onMouseDown={() => onChangeActiveLeaf(leaf.id)}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Pane tabbar */}
      <div
        className="pane-tabbar"
        style={{
          // Left inset (mac traffic-lights) only on the top-left pane.
          paddingLeft: isTopLeft && topLeftInsetPx ? topLeftInsetPx : undefined,
          // Right inset (Windows window-controls cluster) only on the
          // top-right pane — so after a split-right the controls don't
          // overlap the left pane's tabbar.
          paddingRight: isTopRight && topRightInsetPx ? topRightInsetPx : undefined,
        }}
        onDragOver={onTabbarDragOver}
        onDragLeave={onTabbarDragLeave}
        onDrop={onTabbarDrop}
      >
        {isTopLeft && leftSidebarCollapsed && topLeftInsetPx > 0 && (
          <button
            className="icon-btn tiny"
            title="Show left sidebar"
            onClick={onToggleLeftSidebar}
            style={{ marginRight: 6 }}
          >
            <IcPanelLeft open={false} />
          </button>
        )}
        <div className="pane-tabs" ref={tabsRef}>
          {leaf.tabs.map((t) => (
            <TabButton
              key={t.id}
              leafId={leaf.id}
              tab={t}
              active={t.id === leaf.activeTabId}
              tabCount={leaf.tabs.length}
              onActivate={() => onActivateTab(leaf.id, t.id)}
              onClose={() => onCloseTab(leaf.id, t.id)}
              onCloseOthers={() => onCloseOthers(leaf.id, t.id)}
              onCloseAll={() => onCloseAll(leaf.id)}
              onTogglePin={() => onTogglePinTab(leaf.id, t.id)}
              onToggleViewMode={() => onToggleViewMode(leaf.id, t.id)}
              onSplit={(edge) => onSplit(leaf.id, edge)}
              onCopyPath={() => t.fileId && onCopyFilePath(t.fileId)}
              onRevealInNav={() => t.fileId && onRevealFileInNav(t.fileId)}
              onShowInExplorer={() => t.fileId && onShowInExplorer(t.fileId)}
              onOpenInDefaultApp={() =>
                t.fileId && onOpenInDefaultApp(t.fileId)
              }
              onRename={() => t.fileId && onRenameFile(t.fileId)}
              onDelete={() => t.fileId && onDeleteFile(t.fileId)}
            />
          ))}
          {tabInsert && (
            <div
              className="tab-insertion"
              style={{ left: tabInsert.left }}
            />
          )}
        </div>
        {/* `+` lives OUTSIDE `.pane-tabs` so it stays pinned next to
            the last tab even when the tab list overflows and scrolls
            (otherwise the + would scroll off-screen). */}
        <button
          className="tab-new"
          title="New tab"
          onClick={() => onNewTab(leaf.id)}
        >
          <IcPlus />
        </button>

        {/* drag spacer so users can drag the borderless window */}
        <div className="pane-drag" data-tauri-drag-region />

        {/* right-edge tabbar controls (only the two Obsidian shows up here) */}
        <div className="pane-actions">
          <TabbarOptionsMenu
            onNewTab={() => onNewTab(leaf.id)}
            onCloseAll={() => onCloseAll(leaf.id)}
          />
          {isTopRight && (
            <button
              className="icon-btn tiny"
              title={rightSidebarCollapsed ? "Show right sidebar" : "Hide right sidebar"}
              onClick={onToggleRightSidebar}
            >
              <IcPanelRight open={!rightSidebarCollapsed} />
            </button>
          )}
        </div>
      </div>

      {/* In-pane document header (back/forward, centered title, reading mode, more) */}
      <div className="pane-doc-header">
        <div className="pane-doc-nav">
          <button className="icon-btn tiny" title="Back" disabled>
            <IcChevronLeft />
          </button>
          <button className="icon-btn tiny" title="Forward" disabled>
            <IcChevronRight />
          </button>
        </div>
        <div className="pane-doc-title">{activeTab?.title ?? ""}</div>
        <div className="pane-doc-actions">
          <SplitMenuButton
            onSplit={(edge) => onSplit(leaf.id, edge)}
          />
          {activeTab?.fileId && !isCanvasTab && !isPdfTab && !isGraphTab && !isKanbanTab && (
            <button
              className="icon-btn tiny"
              title={activeTab.viewMode === "preview" ? "Edit mode" : "Reading mode"}
              aria-pressed={activeTab.viewMode === "preview"}
              onClick={() => onToggleViewMode(leaf.id, activeTab.id)}
            >
              {activeTab.viewMode === "preview" ? <IcEdit /> : <IcBook />}
            </button>
          )}
          {isGraphTab ? (
            <GraphMoreMenu
              onClose={
                activeTab
                  ? () => onCloseTab(leaf.id, activeTab.id)
                  : undefined
              }
            />
          ) : isKanbanTab ? (
            <KanbanMoreMenu
              onClose={
                activeTab
                  ? () => onCloseTab(leaf.id, activeTab.id)
                  : undefined
              }
            />
          ) : isCanvasTab ? (
            <CanvasMoreMenu
              onClose={
                activeTab
                  ? () => onCloseTab(leaf.id, activeTab.id)
                  : undefined
              }
              onCopyPath={
                activeTab?.fileId
                  ? () => onCopyFilePath(activeTab.fileId!)
                  : undefined
              }
              onRevealInNav={
                activeTab?.fileId
                  ? () => onRevealFileInNav(activeTab.fileId!)
                  : undefined
              }
              onShowInExplorer={
                activeTab?.fileId
                  ? () => onShowInExplorer(activeTab.fileId!)
                  : undefined
              }
              onOpenInDefaultApp={
                activeTab?.fileId
                  ? () => onOpenInDefaultApp(activeTab.fileId!)
                  : undefined
              }
              onRename={
                activeTab?.fileId
                  ? () => onRenameFile(activeTab.fileId!)
                  : undefined
              }
              onDelete={
                activeTab?.fileId
                  ? () => onDeleteFile(activeTab.fileId!)
                  : undefined
              }
            />
          ) : (
            <DocMoreMenu
              hasFile={!!activeTab?.fileId}
              isPdf={isPdfTab}
              onClose={
                activeTab
                  ? () => onCloseTab(leaf.id, activeTab.id)
                  : undefined
              }
              onToggleViewMode={
                activeTab
                  ? () => onToggleViewMode(leaf.id, activeTab.id)
                  : undefined
              }
              onSetViewMode={
                activeTab
                  ? (mode) => onSetViewMode(leaf.id, activeTab.id, mode)
                  : undefined
              }
              viewMode={activeTab?.viewMode ?? "source"}
              onCopyPath={
                activeTab?.fileId
                  ? () => onCopyFilePath(activeTab.fileId!)
                  : undefined
              }
              onRevealInNav={
                activeTab?.fileId
                  ? () => onRevealFileInNav(activeTab.fileId!)
                  : undefined
              }
              onShowInExplorer={
                activeTab?.fileId
                  ? () => onShowInExplorer(activeTab.fileId!)
                  : undefined
              }
              onOpenInDefaultApp={
                activeTab?.fileId
                  ? () => onOpenInDefaultApp(activeTab.fileId!)
                  : undefined
              }
              onRename={
                activeTab?.fileId
                  ? () => onRenameFile(activeTab.fileId!)
                  : undefined
              }
              onDelete={
                activeTab?.fileId
                  ? () => onDeleteFile(activeTab.fileId!)
                  : undefined
              }
            />
          )}
        </div>
      </div>

      {/* Body */}
      <div className="pane-body">
        {activeTab ? (
          activeTab.fileId ? (
            (() => {
              if (activeTab.fileId === "__graph__") {
                return <GraphView onOpenFile={onOpenFileByPath!} />;
              }
              if (activeTab.fileId === "__kanban__") {
                return <KanbanView onOpenFileByPath={onOpenFileByPath} />;
              }
              const file = vault.get(activeTab.fileId);
              // Folder rows shouldn't be openable in tabs, and a stale
              // tab pointing at a deleted file falls back to EmptyTab.
              if (!file || file.kind === "folder") {
                return (
                  <EmptyTab
                    onCreate={() => onNewTab(leaf.id)}
                    onGoToFile={() => onNewTab(leaf.id)}
                    onClose={() => onCloseTab(leaf.id, activeTab.id)}
                  />
                );
              }
              // JSON Canvas — interactive infinite-board editor.
              // Persists by serializing back to the on-disk format
              // (tab-indented per Obsidian's convention) on every edit.
              if (file.kind === "canvas") {
                return (
                  <CanvasView
                    source={file.content ?? ""}
                    onChange={(json) =>
                      onUpdateFileContent?.(file.id, json)
                    }
                    fileId={file.id}
                  />
                );
              }
              // PDF — non-editable pdfjs viewer. For mock-vault entries
              // we pass the embedded base64 string (mock vault has no
              // backing disk path); for real vaults we pass the file
              // id as the absolute path, and PdfView calls the
              // `read_file_bytes` Tauri IPC to slurp the binary.
              if (file.kind === "pdf") {
                return (
                  <PdfView
                    filePath={file.id}
                    base64={file.content}
                    fileName={file.name}
                  />
                );
              }
              // Slides view — Reveal.js-driven slide deck rendered
              // from the same markdown that source/reading mode show.
              // Slide breaks: `---` (horizontal), `--` (vertical).
              // Checked BEFORE the "preview" branch because both are
              // markdown view modes and we want slides to win when
              // selected.
              if (activeTab.viewMode === "slides") {
                return (
                  <div className="markdown-slides-host">
                    <SlidesView source={file.content ?? ""} />
                  </div>
                );
              }
              // Default: markdown editor view. Tab-level `viewMode`
              // toggles between source (CodeMirror) and reading mode
              // (markdown-it rendered HTML via MarkdownPreview). The
              // toggle button lives in the doc header above.
              //
              // When this markdown file lives inside a paper project
              // (i.e. an ancestor directory contains a
              // `.lattice/paper.toml`), we slot a `<PaperToolbar />`
              // above the editor so the user can compile to PDF
              // without leaving the buffer.  Detection is a
              // constant-time walk over the flat vault map; null
              // means "plain note, no toolbar".
              const paperRoot = paperRootForPath(file.id, vault);
              const editorBody =
                activeTab.viewMode === "preview" ? (
                  <div className="markdown-preview-host">
                    <MarkdownPreview source={file.content ?? ""} fileId={file.id} />
                  </div>
                ) : (
                  <CodeMirrorEditor
                    content={file.content ?? ""}
                    filePath={file.id}
                    onChange={(c) =>
                      onUpdateFileContent?.(file.id, c)
                    }
                    onSave={() => {
                      useEditorStore.getState().saveFile(file.id);
                    }}
                  />
                );
              if (paperRoot) {
                return (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      height: "100%",
                      minHeight: 0,
                    }}
                  >
                    <PaperToolbar paperAbsPath={paperRoot} />
                    <div style={{ flex: "1 1 auto", minHeight: 0, display: "flex" }}>
                      <div style={{ flex: "1 1 auto", minHeight: 0 }}>
                        {editorBody}
                      </div>
                    </div>
                  </div>
                );
              }
              return editorBody;
            })()
          ) : (
            <EmptyTab
              onCreate={() => onNewTab(leaf.id)}
              onGoToFile={() => onNewTab(leaf.id)}
              onClose={() => onCloseTab(leaf.id, activeTab.id)}
            />
          )
        ) : (
          <EmptyTab
            onCreate={() => onNewTab(leaf.id)}
            onGoToFile={() => onNewTab(leaf.id)}
            onClose={() => {
              /* no-op */
            }}
          />
        )}
      </div>

      {/* Drop overlay */}
      {dropEdge && <DropOverlay edge={dropEdge} />}
    </div>
  );
}

function DropOverlay({ edge }: { edge: DropEdge }) {
  return <div className={`drop-overlay ${edge}`} />;
}

// ---------------------------------------------------------------------------

type TabBtnProps = {
  leafId: string;
  tab: Tab;
  active: boolean;
  /** Total tabs in the parent leaf — used by the right-click menu to
   *  grey out "Close others" when there's only one tab. */
  tabCount: number;
  onActivate: () => void;
  onClose: () => void | Promise<void>;
  onCloseOthers: () => void | Promise<void>;
  onCloseAll: () => void | Promise<void>;
  onTogglePin: () => void;
  onToggleViewMode: () => void;
  onSplit: (edge: Exclude<DropEdge, "center">) => void;
  /** File-action callbacks. All no-op for empty (fileId==null) tabs;
   *  the menu greys them out in that case. */
  onCopyPath: () => void;
  onRevealInNav: () => void;
  onShowInExplorer: () => void;
  onOpenInDefaultApp: () => void;
  onRename: () => void;
  onDelete: () => void;
};

function TabButton({
  leafId,
  tab,
  active,
  tabCount,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseAll,
  onTogglePin,
  onToggleViewMode,
  onSplit,
  onCopyPath,
  onRevealInNav,
  onShowInExplorer,
  onOpenInDefaultApp,
  onRename,
  onDelete,
}: TabBtnProps) {
  // Exit animation: when the user clicks ×, flip `closing` true so the
  // CSS animation plays in place (subtle fade + horizontal collapse),
  // then call the parent's onClose once it finishes. Keep this fast
  // (~140 ms) so the UI never feels sluggish — just removes the robotic
  // pop that an instant unmount produces. If the parent has already
  // dropped the tab we just unmount immediately (the timer is a no-op).
  const [closing, setClosing] = useState(false);
  const closeTimerRef = useRef<number | null>(null);
  const isDirty = useEditorStore((s) => tab.fileId ? s.dirtyFiles.has(tab.fileId) : false);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  const triggerClose = useCallback(() => {
    if (closing) return;
    // Dirty-tab gate: the parent's onClose runs the unsaved-changes
    // dialog when the file has pending edits. We MUST let that dialog
    // appear BEFORE the close animation — otherwise the tab visibly
    // slides out a few frames before the prompt, which reads as "the
    // close already happened and the popup is showing up too late."
    // For dirty files we skip the slide animation entirely (the modal
    // dialog itself is the visual transition); for clean files we
    // keep the smooth 140 ms exit.
    if (isDirty) {
      void onClose();
      return;
    }
    setClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      onClose();
    }, 140);
  }, [closing, onClose, isDirty]);

  const onDragStart = (e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(
      "application/x-lattice-tab",
      JSON.stringify({ leafId, tabId: tab.id }),
    );
    e.dataTransfer.setData("text/plain", tab.title);
    // Floating chip below-right of the cursor instead of the default
    // washed-out copy of the tab element.
    setDragImageBelowCursor(e, tab.title);
  };

  // Cursor-positioned right-click menu state. We store the click x/y
  // and let TabContextMenu portal itself to document.body so the menu
  // can overflow the tab bar (which has overflow: hidden).
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(
    null,
  );

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Activate the tab on right-click as well — matches VS Code /
    // Obsidian behaviour and avoids the surprise where you act on a
    // tab that isn't visible in the editor body.
    if (!active) onActivate();
    setMenuAt({ x: e.clientX, y: e.clientY });
  };

  // Pinned tabs swap the close (×) button for a pin icon, and clicking
  // the pin unpins (rather than closes). This matches Obsidian's
  // affordance — the pin icon is the same target zone the close button
  // used to occupy so muscle memory still works.
  const isPinned = !!tab.isPinned;

  return (
    <>
      <div
        className={`tab${active ? " active" : ""}${closing ? " closing" : ""}${
          isPinned ? " pinned" : ""
        }`}
        data-file-id={tab.fileId ?? undefined}
        draggable={!closing}
        onDragStart={onDragStart}
        onMouseDown={closing ? undefined : onActivate}
        onAuxClick={(e) => {
          if (e.button === 1 && !isPinned) triggerClose();
        }}
        onContextMenu={onContextMenu}
        // aria-label, not title — native OS tooltip would otherwise
        // overlap the Ctrl+hover preview popover.
        aria-label={tab.title}
      >
        <span className="tab-title">{tab.title}</span>
        {isPinned ? (
          <button
            className="tab-close pinned"
            title="Unpin"
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin();
            }}
          >
            <div className="close-icon">
              <IcPinned />
            </div>
          </button>
        ) : (
          <button
            className={`tab-close ${isDirty ? "dirty" : ""}`}
            title="Close"
            onClick={(e) => {
              e.stopPropagation();
              triggerClose();
            }}
          >
            {isDirty && <div className="dirty-dot" />}
            <div className="close-icon">
              <IcClose />
            </div>
          </button>
        )}
      </div>
      {menuAt && (
        <TabContextMenu
          x={menuAt.x}
          y={menuAt.y}
          tab={tab}
          tabCount={tabCount}
          onDismiss={() => setMenuAt(null)}
          onClose={triggerClose}
          onCloseOthers={onCloseOthers}
          onCloseAll={onCloseAll}
          onTogglePin={onTogglePin}
          onToggleViewMode={onToggleViewMode}
          onSplit={onSplit}
          onCopyPath={onCopyPath}
          onRevealInNav={onRevealInNav}
          onShowInExplorer={onShowInExplorer}
          onOpenInDefaultApp={onOpenInDefaultApp}
          onRename={onRename}
          onDelete={onDelete}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

/**
 * Shared flyout-menu plumbing used by every in-pane dropdown
 * (SplitMenuButton, TabbarOptionsMenu, DocMoreMenu, GraphMoreMenu).
 *
 * The trigger button lives inside `.pane-tabbar` or `.pane-doc-header`,
 * both of which use `overflow: hidden` as a defence-in-depth clip so
 * tabs / titles never bleed past the column edge when the pane is
 * squeezed thin. That clip also eats any `position:absolute` dropdown
 * anchored to the wrapper, which made the Split + View-options +
 * More menus appear to "go behind" the editor.
 *
 * The fix: portal the menu to `document.body` with `position:fixed`,
 * right-anchored under the trigger button (matching the old CSS
 * `top: 100%+4 / right: 0` placement). Outside-click / Esc / scroll
 * close behaviour matches the existing TabContextMenu.
 *
 * Returns refs + state the caller wires into the trigger and the
 * portaled menu wrapper.
 */
function useFlyoutMenu() {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const openMenu = useCallback(() => {
    const btn = buttonRef.current;
    if (!btn) {
      setOpen(true);
      return;
    }
    const r = btn.getBoundingClientRect();
    const margin = 6;
    setMenuStyle({
      position: "fixed",
      top: r.bottom + 4,
      // Right-anchor so the menu opens leftward from the trigger,
      // matching the old `right: 0` CSS placement. Clamp so the
      // menu never gets pushed off the left edge on tiny windows.
      right: Math.max(margin, window.innerWidth - r.right),
      zIndex: 2000,
    });
    setOpen(true);
  }, []);

  const closeMenu = useCallback(() => setOpen(false), []);
  const toggleOpen = useCallback(() => {
    if (open) closeMenu();
    else openMenu();
  }, [open, openMenu, closeMenu]);

  // Outside-click / Esc / scroll / blur all dismiss. Scroll close
  // mirrors TabContextMenu — the fixed-position menu would otherwise
  // appear detached from its trigger when the user scrolls the
  // underlying editor.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeMenu();
      }
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (menuRef.current?.contains(t)) return;
      if (buttonRef.current?.contains(t)) return;
      closeMenu();
    };
    const onScroll = () => closeMenu();
    const onResize = () => closeMenu();
    const onBlur = () => closeMenu();
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("blur", onBlur);
    };
  }, [open, closeMenu]);

  return { open, menuStyle, buttonRef, menuRef, toggleOpen, closeMenu };
}

// ---------------------------------------------------------------------------

/**
 * In-pane "Split" control — a single icon button with a small flyout
 * exposing the 4 split directions (right / down / left / up).
 *
 * Lives in `.pane-doc-actions` immediately before the reading-mode
 * (book) button so the user can split the current pane without having
 * to drag a tab onto a pane edge.
 *
 * Close behavior mirrors VaultPickerMenu:
 *   - Esc.
 *   - Pointerdown outside the wrapper.
 *   - Selecting an item.
 */
function SplitMenuButton({
  onSplit,
}: {
  onSplit: (edge: Exclude<DropEdge, "center">) => void;
}) {
  const { open, menuStyle, buttonRef, menuRef, toggleOpen, closeMenu } =
    useFlyoutMenu();

  const pick = (edge: Exclude<DropEdge, "center">) => {
    closeMenu();
    onSplit(edge);
  };

  return (
    <>
      <button
        ref={buttonRef}
        className={`icon-btn tiny${open ? " active" : ""}`}
        title="Split pane"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggleOpen}
      >
        <IcSplit />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="split-menu"
            role="menu"
            style={menuStyle}
          >
            <button
              role="menuitem"
              className="split-menu-item"
              onClick={() => pick("right")}
            >
              <IcArrowRight className="split-menu-icon" />
              <span>Split right</span>
            </button>
            <button
              role="menuitem"
              className="split-menu-item"
              onClick={() => pick("bottom")}
            >
              <IcArrowDown className="split-menu-icon" />
              <span>Split down</span>
            </button>
            <button
              role="menuitem"
              className="split-menu-item"
              onClick={() => pick("left")}
            >
              <IcArrowLeft className="split-menu-icon" />
              <span>Split left</span>
            </button>
            <button
              role="menuitem"
              className="split-menu-item"
              onClick={() => pick("top")}
            >
              <IcArrowUp className="split-menu-icon" />
              <span>Split up</span>
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}

// ---------------------------------------------------------------------------

/**
 * Tabbar "View options" dropdown — the chevron-down button in the
 * right-edge cluster of each pane's tabbar, immediately next to the
 * right-sidebar toggle. Mirrors Obsidian's menu with three items:
 *
 *   Stack tabs    — visual stub (no real stacking layout yet)
 *   Close all     — calls onCloseAll for this pane
 *   New tab    \u2713  — calls onNewTab; marked active because plain
 *                    "open a new tab" is the default behavior of the
 *                    `+` button right next to it.
 *
 * Close behavior mirrors SplitMenuButton (Esc + outside click).
 */
function TabbarOptionsMenu({
  onCloseAll,
  onNewTab,
}: {
  onCloseAll: () => void;
  onNewTab: () => void;
}) {
  const { open, menuStyle, buttonRef, menuRef, toggleOpen, closeMenu } =
    useFlyoutMenu();

  return (
    <>
      <button
        ref={buttonRef}
        className={`icon-btn tiny${open ? " active" : ""}`}
        title="View options"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggleOpen}
      >
        <IcChevronDown />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="split-menu tabbar-menu"
            role="menu"
            style={menuStyle}
          >
            <button
              role="menuitem"
              className="split-menu-item"
              onClick={closeMenu}
            >
              <IcStack className="split-menu-icon" />
              <span>Stack tabs</span>
            </button>
            <button
              role="menuitem"
              className="split-menu-item"
              onClick={() => {
                closeMenu();
                onCloseAll();
              }}
            >
              <IcCloseAll className="split-menu-icon" />
              <span>Close all</span>
            </button>
            <button
              role="menuitem"
              className="split-menu-item"
              onClick={() => {
                closeMenu();
                onNewTab();
              }}
            >
              <IcNewFile className="split-menu-icon" />
              <span>New tab</span>
              <IcCheck className="split-menu-trailing" />
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}

// ---------------------------------------------------------------------------

/**
 * Document "More options" 3-dot menu in `.pane-doc-actions`. Mirrors
 * Obsidian's per-file context menu (Backlinks, Reading view, Split,
 * Rename, Export, Find, Copy path, Delete, etc.).
 *
 * Wired items:
 *   - Reading view / Source mode → onToggleViewMode (current state
 *     read from `viewMode` prop so the highlighted row matches reality)
 *   - Rename… → onRename (opens the file-tree inline-rename UI)
 *   - Copy path → onCopyPath (writes the absolute path to clipboard)
 *   - Open in default app → onOpenInDefaultApp
 *   - Show in system explorer → onShowInExplorer
 *   - Reveal file in navigation → onRevealInNav
 *   - Delete file → onDelete (confirms + removes from disk + closes tabs)
 *
 * Still visual-only (no backing implementation yet): Backlinks in
 * document, Open in new window, Move file to, Bookmark, Merge,
 * Add file property, Export to PDF, Find, Replace,
 * Open version history, Open linked view.
 * `hasFile=false` (empty "New tab") hides the file-only items.
 */
function DocMoreMenu({
  hasFile,
  isPdf = false,
  onClose,
  onToggleViewMode,
  onSetViewMode,
  viewMode,
  onCopyPath,
  onRevealInNav,
  onShowInExplorer,
  onOpenInDefaultApp,
  onRename,
  onDelete,
}: {
  hasFile: boolean;
  /** True when the active tab is a PDF — suppresses the
   *  Reading/Source/Slides view-mode triple (PDFs have a fixed,
   *  non-editable viewer). All file-action items (Rename, Copy path,
   *  etc.) still show through. */
  isPdf?: boolean;
  onClose?: () => void;
  onToggleViewMode?: () => void;
  /** Discrete view-mode setter — used by the 3 mode-switcher items
   *  (Reading / Source / Slides). When omitted those items fall back
   *  to `onToggleViewMode` for the binary case. */
  onSetViewMode?: (mode: "source" | "preview" | "slides") => void;
  viewMode?: "source" | "preview" | "slides";
  onCopyPath?: () => void;
  onRevealInNav?: () => void;
  onShowInExplorer?: () => void;
  onOpenInDefaultApp?: () => void;
  onRename?: () => void;
  onDelete?: () => void;
}) {
  const { open, menuStyle, buttonRef, menuRef, toggleOpen, closeMenu } =
    useFlyoutMenu();

  // Helper for wireable items: closes the menu then runs the action.
  const run = (fn: () => void) => () => {
    closeMenu();
    fn();
  };

  // Helper for stub items: just closes the menu.
  const stub = () => closeMenu();

  return (
    <>
      <button
        ref={buttonRef}
        className={`icon-btn tiny${open ? " active" : ""}`}
        title="More options"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggleOpen}
      >
        <IcMore />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="split-menu doc-more-menu"
            role="menu"
            style={menuStyle}
          >
            {hasFile && (
            <>
              <button role="menuitem" className="split-menu-item" onClick={stub}>
                <IcLink className="split-menu-icon" />
                <span>Backlinks in document</span>
              </button>
              {!isPdf && (
                <>
                  <button
                    role="menuitem"
                    className="split-menu-item"
                    onClick={
                      onSetViewMode
                        ? run(() => onSetViewMode("preview"))
                        : onToggleViewMode && viewMode === "source"
                          ? run(onToggleViewMode)
                          : stub
                    }
                  >
                    <IcEye className="split-menu-icon" />
                    <span>Reading view</span>
                    {viewMode === "preview" && (
                      <IcCheck className="split-menu-trailing" />
                    )}
                  </button>
                  <button
                    role="menuitem"
                    className="split-menu-item"
                    onClick={
                      onSetViewMode
                        ? run(() => onSetViewMode("source"))
                        : onToggleViewMode && viewMode === "preview"
                          ? run(onToggleViewMode)
                          : stub
                    }
                  >
                    <IcCode className="split-menu-icon" />
                    <span>Source mode</span>
                    {viewMode === "source" && (
                      <IcCheck className="split-menu-trailing" />
                    )}
                  </button>
                  {/* Slides view — only meaningful when `onSetViewMode`
                      is wired (the discrete setter knows how to land
                      on "slides"; the binary toggle can only flip
                      preview↔source). Disabled gracefully otherwise. */}
                  <button
                    role="menuitem"
                    className="split-menu-item"
                    onClick={
                      onSetViewMode
                        ? run(() => onSetViewMode("slides"))
                        : stub
                    }
                    disabled={!onSetViewMode}
                  >
                    <IcSlideshow className="split-menu-icon" />
                    <span>Slides view</span>
                    {viewMode === "slides" && (
                      <IcCheck className="split-menu-trailing" />
                    )}
                  </button>
                </>
              )}
              <div className="split-menu-divider" role="separator" />
            </>
          )}

          {/* NOTE: Split right / Split down are intentionally NOT in
              this menu. The dedicated SplitMenuButton (icon to the
              left of this More button) already exposes all 4 split
              directions in its own flyout — duplicating them here was
              redundant and confusing. */}
          <button role="menuitem" className="split-menu-item" onClick={stub}>
            <IcLinkExternal className="split-menu-icon" />
            <span>Open in new window</span>
          </button>

          {hasFile && (
            <>
              <div className="split-menu-divider" role="separator" />
              <button
                role="menuitem"
                className="split-menu-item"
                onClick={onRename ? run(onRename) : stub}
              >
                <IcEdit className="split-menu-icon" />
                <span>Rename…</span>
              </button>
              <button role="menuitem" className="split-menu-item" onClick={stub}>
                <IcSwap className="split-menu-icon" />
                <span>Move file to…</span>
              </button>
              <button role="menuitem" className="split-menu-item" onClick={stub}>
                <IcBookmark className="split-menu-icon" />
                <span>Bookmark…</span>
              </button>
              <button role="menuitem" className="split-menu-item" onClick={stub}>
                <IcMerge className="split-menu-icon" />

                <span>Merge entire file with…</span>
              </button>
              <button role="menuitem" className="split-menu-item" onClick={stub}>
                <IcFileAdd className="split-menu-icon" />
                <span>Add file property</span>
              </button>

              <div className="split-menu-divider" role="separator" />
              <button role="menuitem" className="split-menu-item" onClick={stub}>
                <IcFilePdf className="split-menu-icon" />
                <span>Export to PDF…</span>
              </button>

              <div className="split-menu-divider" role="separator" />
              <button
                role="menuitem"
                className="split-menu-item"
                onClick={run(() => {
                  window.dispatchEvent(
                    new CustomEvent("lattice-editor-find", {
                      detail: { filePath: null },
                    }),
                  );
                })}
              >
                <IcSearch className="split-menu-icon" />
                <span>Find…</span>
              </button>
              <button
                role="menuitem"
                className="split-menu-item"
                onClick={run(() => {
                  window.dispatchEvent(
                    new CustomEvent("lattice-editor-find", {
                      detail: { filePath: null, withReplace: true },
                    }),
                  );
                })}
              >
                <IcReplace className="split-menu-icon" />
                <span>Replace…</span>
              </button>

              <div className="split-menu-divider" role="separator" />
              <button
                role="menuitem"
                className="split-menu-item"
                onClick={onCopyPath ? run(onCopyPath) : stub}
              >
                <IcCopy className="split-menu-icon" />
                <span>Copy path</span>
              </button>
              <button role="menuitem" className="split-menu-item" onClick={stub}>
                <IcHistory className="split-menu-icon" />
                <span>Open version history</span>
              </button>
              <button role="menuitem" className="split-menu-item" onClick={stub}>
                <IcLink className="split-menu-icon" />
                <span>Open linked view</span>
                <IcChevronRight className="split-menu-trailing" />
              </button>

              <div className="split-menu-divider" role="separator" />
              <button
                role="menuitem"
                className="split-menu-item"
                onClick={onOpenInDefaultApp ? run(onOpenInDefaultApp) : stub}
              >
                <IcLinkExternal className="split-menu-icon" />
                <span>Open in default app</span>
              </button>
              <button
                role="menuitem"
                className="split-menu-item"
                onClick={onShowInExplorer ? run(onShowInExplorer) : stub}
              >
                <IcFolderOpened className="split-menu-icon" />
                <span>Show in system explorer</span>
              </button>
              <button
                role="menuitem"
                className="split-menu-item"
                onClick={onRevealInNav ? run(onRevealInNav) : stub}
              >
                <IcLocation className="split-menu-icon" />
                <span>Reveal file in navigation</span>
              </button>

              {(onDelete || onClose) && (
                <>
                  <div className="split-menu-divider" role="separator" />
                  <button
                    role="menuitem"
                    className="split-menu-item danger"
                    onClick={run(onDelete ?? onClose!)}
                  >
                    <IcTrash className="split-menu-icon" />
                    <span>Delete file</span>
                  </button>
                </>
              )}
            </>
          )}
          </div>,
          document.body,
        )}
    </>
  );
}

// ---------------------------------------------------------------------------

/**
 * Tab right-click context menu — cursor-positioned twin of DocMoreMenu,
 * scoped to one tab.
 */
function TabContextMenu({
  x, y, tab, tabCount,
  onDismiss, onClose, onCloseOthers, onCloseAll, onTogglePin,
  onToggleViewMode, onSplit, onCopyPath, onRevealInNav,
  onShowInExplorer, onOpenInDefaultApp, onRename, onDelete,
}: {
  x: number; y: number;
  tab: Tab;
  tabCount: number;
  onDismiss: () => void;
  onClose: () => void;
  onCloseOthers: () => void | Promise<void>;
  onCloseAll: () => void | Promise<void>;
  onTogglePin: () => void;
  onToggleViewMode: () => void;
  onSplit: (edge: Exclude<DropEdge, "center">) => void;
  onCopyPath: () => void;
  onRevealInNav: () => void;
  onShowInExplorer: () => void;
  onOpenInDefaultApp: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({ position: "fixed", top: y, left: x, zIndex: 2000, visibility: "hidden" });

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const margin = 6;
    let left = x, top = y;
    if (left + r.width + margin > vw) left = vw - r.width - margin;
    if (top + r.height + margin > vh) top = vh - r.height - margin;
    setStyle({ position: "fixed", top, left, zIndex: 2000, visibility: "visible" });
  }, [x, y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onDismiss(); } };
    const onDown = (e: PointerEvent) => { if (!(e.target instanceof Node) || menuRef.current?.contains(e.target)) return; onDismiss(); };
    const onScroll = () => onDismiss();
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [onDismiss]);

  const run = (fn: () => void) => () => { onDismiss(); fn(); };
  const hasFile = !!tab.fileId;
  const isPinned = !!tab.isPinned;

  return createPortal(
    <div
      ref={menuRef}
      className="split-menu tab-context-menu"
      role="menu"
      style={style}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button role="menuitem" className="split-menu-item" disabled={isPinned} onClick={run(onClose)}>
        <IcClose className="split-menu-icon" />
        <span>Close</span>
      </button>
      <button role="menuitem" className="split-menu-item" disabled={tabCount <= 1} onClick={run(onCloseOthers)}>
        <IcCloseAll className="split-menu-icon" />
        <span>Close others</span>
      </button>
      <button role="menuitem" className="split-menu-item" onClick={run(onCloseAll)}>
        <IcCloseAll className="split-menu-icon" />
        <span>Close all</span>
      </button>
      <div className="split-menu-divider" role="separator" />
      <button role="menuitem" className="split-menu-item" onClick={run(onTogglePin)}>
        {isPinned ? <IcPin className="split-menu-icon" /> : <IcPinned className="split-menu-icon" />}
        <span>{isPinned ? "Unpin" : "Pin"}</span>
      </button>
      {hasFile && (
        <>
          <div className="split-menu-divider" role="separator" />
          <button role="menuitem" className="split-menu-item" onClick={run(onToggleViewMode)}>
            <IcEye className="split-menu-icon" />
            <span>Toggle reading view</span>
          </button>
        </>
      )}
      <div className="split-menu-divider" role="separator" />
      <button role="menuitem" className="split-menu-item" onClick={run(() => onSplit("right"))}>
        <IcSplitH className="split-menu-icon" />
        <span>Split right</span>
      </button>
      <button role="menuitem" className="split-menu-item" onClick={run(() => onSplit("bottom"))}>
        <IcSplitV className="split-menu-icon" />
        <span>Split down</span>
      </button>
      {hasFile && (
        <>
          <div className="split-menu-divider" role="separator" />
          <button role="menuitem" className="split-menu-item" onClick={run(onCopyPath)}>
            <IcCopy className="split-menu-icon" />
            <span>Copy path</span>
          </button>
          <button role="menuitem" className="split-menu-item" onClick={run(onRevealInNav)}>
            <IcLocation className="split-menu-icon" />
            <span>Reveal file in navigation</span>
          </button>
          <button role="menuitem" className="split-menu-item" onClick={run(onShowInExplorer)}>
            <IcFolderOpened className="split-menu-icon" />
            <span>Show in system explorer</span>
          </button>
          <button role="menuitem" className="split-menu-item" onClick={run(onOpenInDefaultApp)}>
            <IcLinkExternal className="split-menu-icon" />
            <span>Open in default app</span>
          </button>
          <div className="split-menu-divider" role="separator" />
          <button role="menuitem" className="split-menu-item" onClick={run(onRename)}>
            <IcEdit className="split-menu-icon" />
            <span>Rename…</span>
          </button>
          <button role="menuitem" className="split-menu-item danger" onClick={run(onDelete)}>
            <IcTrash className="split-menu-icon" />
            <span>Delete file</span>
          </button>
          <div className="split-menu-divider" role="separator" />
          <button role="menuitem" className="split-menu-item" disabled title="Coming soon">
            <IcUnlink className="split-menu-icon" />
            <span>Unlink tab</span>
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// GraphMoreMenu, KanbanMoreMenu, CanvasMoreMenu — slim menus for virtual tabs.
// ---------------------------------------------------------------------------

function GraphMoreMenu({ onClose }: { onClose?: () => void }) {
  const { open, menuStyle, buttonRef, menuRef, toggleOpen, closeMenu } = useFlyoutMenu();
  const run = (fn: () => void) => () => { closeMenu(); fn(); };
  const stub = () => closeMenu();
  return (
    <>
      <button ref={buttonRef} className={`icon-btn tiny${open ? " active" : ""}`} title="More options" onClick={toggleOpen}>
        <IcMore />
      </button>
      {open && createPortal(
        <div ref={menuRef} className="split-menu" role="menu" style={menuStyle}>
          <button role="menuitem" className="split-menu-item" onClick={stub}>
            <IcCamera className="split-menu-icon" />
            <span>Copy screenshot</span>
          </button>
          <button role="menuitem" className="split-menu-item" onClick={stub}>
            <IcBookmark className="split-menu-icon" />
            <span>Bookmark</span>
          </button>
          {onClose && (
            <>
              <div className="split-menu-divider" role="separator" />
              <button role="menuitem" className="split-menu-item" onClick={run(onClose)}>
                <IcClose className="split-menu-icon" />
                <span>Close</span>
              </button>
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}

function KanbanMoreMenu({ onClose }: { onClose?: () => void }) {
  const { open, menuStyle, buttonRef, menuRef, toggleOpen, closeMenu } = useFlyoutMenu();
  const run = (fn: () => void) => () => { closeMenu(); fn(); };
  const stub = () => closeMenu();
  return (
    <>
      <button ref={buttonRef} className={`icon-btn tiny${open ? " active" : ""}`} title="More options" onClick={toggleOpen}>
        <IcMore />
      </button>
      {open && createPortal(
        <div ref={menuRef} className="split-menu" role="menu" style={menuStyle}>
          <button role="menuitem" className="split-menu-item" onClick={stub}>
            <IcGear className="split-menu-icon" />
            <span>Configure board…</span>
          </button>
          {onClose && (
            <>
              <div className="split-menu-divider" role="separator" />
              <button role="menuitem" className="split-menu-item" onClick={run(onClose)}>
                <IcClose className="split-menu-icon" />
                <span>Close</span>
              </button>
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}

function CanvasMoreMenu({
  onClose, onCopyPath, onRevealInNav, onShowInExplorer,
  onOpenInDefaultApp, onRename, onDelete,
}: {
  onClose?: () => void;
  onCopyPath?: () => void;
  onRevealInNav?: () => void;
  onShowInExplorer?: () => void;
  onOpenInDefaultApp?: () => void;
  onRename?: () => void;
  onDelete?: () => void;
}) {
  const { open, menuStyle, buttonRef, menuRef, toggleOpen, closeMenu } = useFlyoutMenu();
  const run = (fn: () => void) => () => { closeMenu(); fn(); };
  const stub = () => closeMenu();
  return (
    <>
      <button ref={buttonRef} className={`icon-btn tiny${open ? " active" : ""}`} title="More options" onClick={toggleOpen}>
        <IcMore />
      </button>
      {open && createPortal(
        <div ref={menuRef} className="split-menu" role="menu" style={menuStyle}>
          <button role="menuitem" className="split-menu-item" onClick={onRename ? run(onRename) : stub}>
            <IcEdit className="split-menu-icon" />
            <span>Rename…</span>
          </button>
          {onCopyPath && (
            <button role="menuitem" className="split-menu-item" onClick={run(onCopyPath)}>
              <IcCopy className="split-menu-icon" />
              <span>Copy path</span>
            </button>
          )}
          {onRevealInNav && (
            <button role="menuitem" className="split-menu-item" onClick={run(onRevealInNav)}>
              <IcLocation className="split-menu-icon" />
              <span>Reveal in navigation</span>
            </button>
          )}
          {onShowInExplorer && (
            <button role="menuitem" className="split-menu-item" onClick={run(onShowInExplorer)}>
              <IcFolderOpened className="split-menu-icon" />
              <span>Show in system explorer</span>
            </button>
          )}
          {onOpenInDefaultApp && (
            <button role="menuitem" className="split-menu-item" onClick={run(onOpenInDefaultApp)}>
              <IcLinkExternal className="split-menu-icon" />
              <span>Open in default app</span>
            </button>
          )}
          {onDelete && (
            <>
              <div className="split-menu-divider" role="separator" />
              <button role="menuitem" className="split-menu-item danger" onClick={run(onDelete)}>
                <IcTrash className="split-menu-icon" />
                <span>Delete canvas</span>
              </button>
            </>
          )}
          {onClose && (
            <>
              <div className="split-menu-divider" role="separator" />
              <button role="menuitem" className="split-menu-item" onClick={run(onClose)}>
                <IcClose className="split-menu-icon" />
                <span>Close</span>
              </button>
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
