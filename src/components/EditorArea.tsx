import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { DropEdge, FileNode, SplitTree, Tab } from "../state/types";
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
  uid,
} from "../state/splitTree";
import { Markdown } from "./Markdown";
import { EmptyTab } from "./EmptyTab";
import { setDragImageBelowCursor } from "./dragGhost";
import {
  IcArrowDown,
  IcArrowLeft,
  IcArrowRight,
  IcArrowUp,
  IcBook,
  IcBookmark,
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
  IcHistory,
  IcLink,
  IcLinkExternal,
  IcLocation,
  IcMerge,
  IcMore,
  IcNewFile,
  IcPanelRight,
  IcPlus,
  IcReplace,
  IcSearch,
  IcSplit,
  IcStack,
  IcSwap,
  IcTrash,
} from "./Icons";
import "./EditorArea.css";

type Props = {
  tree: SplitTree;
  vault: Map<string, FileNode>;
  activeLeafId: string;
  onChangeActiveLeaf: (id: string) => void;
  onTreeChange: (next: SplitTree | null) => void;
  rightSidebarCollapsed: boolean;
  onToggleRightSidebar: () => void;
  /** px of right padding to reserve in the topmost pane's tabbar so its
   *  controls don't slide under the floating window-controls cluster. */
  topRightInsetPx: number;
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
    rightSidebarCollapsed,
    onToggleRightSidebar,
    topRightInsetPx,
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
    (leafId: string, tabId: string) => {
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

  // "Close all" from the tabbar's View-options menu. Mirrors onCloseTab's
  // root-vs-non-root rule: the root pane keeps a single fresh "New tab"
  // (the editor can never be completely empty); any other pane collapses
  // so its sibling absorbs the space.
  const onCloseAllInLeaf = useCallback(
    (leafId: string) => {
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

  // ---- drag and drop ---------------------------------------------------
  const handleDropOnPane = useCallback(
    (leafId: string, edge: DropEdge, data: DT) => {
      // file drag → open in target leaf (with optional split)
      if (data.kind === "file") {
        const file = vault.get(data.fileId);
        if (!file || file.kind !== "file") return;
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
        if (!file || file.kind !== "file") return;
        const newTab: Tab = {
          id: uid("tab"),
          fileId: file.id,
          title: file.name,
        };
        setLeaf(leafId, (leaf) => insertTabAt(leaf, newTab, index));
        onChangeActiveLeaf(leafId);
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

  // ---- find the topmost-leftmost leaf so we know where to put the
  //      panel-right toggle + window-controls inset ----------------------
  const topLeftLeafId = useMemo(() => leaves(tree)[0]?.id, [tree]);

  return (
    <div className="editor-area">
      <RenderTree
        node={tree}
        activeLeafId={activeLeafId}
        vault={vault}
        onActivateTab={onActivateTab}
        onCloseTab={onCloseTab}
        onCloseAll={onCloseAllInLeaf}
        onNewTab={onNewTabInLeaf}
        onSplit={onSplitInLeaf}
        onResizeSplit={onResizeSplit}
        onChangeActiveLeaf={onChangeActiveLeaf}
        onDropOnPane={handleDropOnPane}
        onDropOnTabbar={handleDropOnTabbar}
        topLeftLeafId={topLeftLeafId}
        rightSidebarCollapsed={rightSidebarCollapsed}
        onToggleRightSidebar={onToggleRightSidebar}
        topRightInsetPx={topRightInsetPx}
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
  onNewTab: (leafId: string) => void;
  onSplit: (leafId: string, edge: Exclude<DropEdge, "center">) => void;
  onResizeSplit: (splitId: string, ratio: number) => void;
  onChangeActiveLeaf: (id: string) => void;
  onDropOnPane: (leafId: string, edge: DropEdge, data: DT) => void;
  onDropOnTabbar: (leafId: string, index: number, data: DT) => void;
  topLeftLeafId?: string;
  rightSidebarCollapsed: boolean;
  onToggleRightSidebar: () => void;
  topRightInsetPx: number;
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
    onNewTab,
    onSplit,
    onChangeActiveLeaf,
    onDropOnPane,
    onDropOnTabbar,
    topLeftLeafId,
    rightSidebarCollapsed,
    onToggleRightSidebar,
    topRightInsetPx,
  } = props;

  const isActive = leaf.id === activeLeafId;
  const isTopLeft = leaf.id === topLeftLeafId;
  const activeTab = leaf.tabs.find((t) => t.id === leaf.activeTabId);

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
        style={
          isTopLeft && rightSidebarCollapsed
            ? { paddingRight: topRightInsetPx }
            : undefined
        }
        onDragOver={onTabbarDragOver}
        onDragLeave={onTabbarDragLeave}
        onDrop={onTabbarDrop}
      >
        <div className="pane-tabs" ref={tabsRef}>
          {leaf.tabs.map((t) => (
            <TabButton
              key={t.id}
              leafId={leaf.id}
              tab={t}
              active={t.id === leaf.activeTabId}
              onActivate={() => onActivateTab(leaf.id, t.id)}
              onClose={() => onCloseTab(leaf.id, t.id)}
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
          {isTopLeft && (
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
          {activeTab?.fileId && (
            <button className="icon-btn tiny" title="Reading mode">
              <IcBook />
            </button>
          )}
          <DocMoreMenu
            hasFile={!!activeTab?.fileId}
            onSplit={(edge) => onSplit(leaf.id, edge)}
            onClose={
              activeTab
                ? () => onCloseTab(leaf.id, activeTab.id)
                : undefined
            }
          />
        </div>
      </div>

      {/* Body */}
      <div className="pane-body">
        {activeTab ? (
          activeTab.fileId ? (
            (() => {
              const file = vault.get(activeTab.fileId);
              if (!file || file.kind !== "file") {
                return (
                  <EmptyTab
                    onCreate={() => onNewTab(leaf.id)}
                    onGoToFile={() => onNewTab(leaf.id)}
                    onClose={() => onCloseTab(leaf.id, activeTab.id)}
                  />
                );
              }
              return (
                <div className="pane-doc">
                  <Markdown source={file.content ?? ""} />
                </div>
              );
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
  onActivate: () => void;
  onClose: () => void;
};

function TabButton({ leafId, tab, active, onActivate, onClose }: TabBtnProps) {
  // Exit animation: when the user clicks ×, flip `closing` true so the
  // CSS animation plays in place (subtle fade + horizontal collapse),
  // then call the parent's onClose once it finishes. Keep this fast
  // (~140 ms) so the UI never feels sluggish — just removes the robotic
  // pop that an instant unmount produces. If the parent has already
  // dropped the tab we just unmount immediately (the timer is a no-op).
  const [closing, setClosing] = useState(false);
  const closeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  const triggerClose = useCallback(() => {
    if (closing) return;
    setClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      onClose();
    }, 140);
  }, [closing, onClose]);

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

  return (
    <div
      className={`tab${active ? " active" : ""}${closing ? " closing" : ""}`}
      draggable={!closing}
      onDragStart={onDragStart}
      onMouseDown={closing ? undefined : onActivate}
      onAuxClick={(e) => {
        if (e.button === 1) triggerClose();
      }}
      title={tab.title}
    >
      <span className="tab-title">{tab.title}</span>
      <button
        className="tab-close"
        title="Close"
        onClick={(e) => {
          e.stopPropagation();
          triggerClose();
        }}
      >
        <IcClose />
      </button>
    </div>
  );
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
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    const onDown = (e: PointerEvent) => {
      const el = wrapRef.current;
      if (!el) return;
      if (e.target instanceof Node && el.contains(e.target)) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [open]);

  const pick = (edge: Exclude<DropEdge, "center">) => {
    setOpen(false);
    onSplit(edge);
  };

  return (
    <div className="split-menu-wrap" ref={wrapRef}>
      <button
        className={`icon-btn tiny${open ? " active" : ""}`}
        title="Split pane"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <IcSplit />
      </button>
      {open && (
        <div className="split-menu" role="menu">
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
        </div>
      )}
    </div>
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
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    const onDown = (e: PointerEvent) => {
      const el = wrapRef.current;
      if (!el) return;
      if (e.target instanceof Node && el.contains(e.target)) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [open]);

  return (
    <div className="split-menu-wrap" ref={wrapRef}>
      <button
        className={`icon-btn tiny${open ? " active" : ""}`}
        title="View options"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <IcChevronDown />
      </button>
      {open && (
        <div className="split-menu tabbar-menu" role="menu">
          <button
            role="menuitem"
            className="split-menu-item"
            onClick={() => setOpen(false)}
          >
            <IcStack className="split-menu-icon" />
            <span>Stack tabs</span>
          </button>
          <button
            role="menuitem"
            className="split-menu-item"
            onClick={() => {
              setOpen(false);
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
              setOpen(false);
              onNewTab();
            }}
          >
            <IcNewFile className="split-menu-icon" />
            <span>New tab</span>
            <IcCheck className="split-menu-trailing" />
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * Document "More options" 3-dot menu in `.pane-doc-actions`. Mirrors
 * Obsidian's per-file context menu (Backlinks, Reading view, Split,
 * Rename, Export, Find, Copy path, Delete, etc.).
 *
 * Only a few items are wired to real handlers:
 *   - Split right / Split down \u2192 onSplit(edge)
 *   - Delete file \u2192 onClose (closes the tab \u2014 the vault is mock so
 *     we treat "delete" as "remove from view")
 *
 * The rest are visual-only entries that match Obsidian's menu so the
 * UI feels complete even though the underlying ops are not yet built.
 * `hasFile=false` (empty "New tab") hides the file-only items.
 */
function DocMoreMenu({
  hasFile,
  onSplit,
  onClose,
}: {
  hasFile: boolean;
  onSplit: (edge: Exclude<DropEdge, "center">) => void;
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    const onDown = (e: PointerEvent) => {
      const el = wrapRef.current;
      if (!el) return;
      if (e.target instanceof Node && el.contains(e.target)) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [open]);

  // Helper for wireable items: closes the menu then runs the action.
  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  // Helper for stub items: just closes the menu.
  const stub = () => setOpen(false);

  return (
    <div className="split-menu-wrap" ref={wrapRef}>
      <button
        className={`icon-btn tiny${open ? " active" : ""}`}
        title="More options"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <IcMore />
      </button>
      {open && (
        <div className="split-menu doc-more-menu" role="menu">
          {hasFile && (
            <>
              <button role="menuitem" className="split-menu-item" onClick={stub}>
                <IcLink className="split-menu-icon" />
                <span>Backlinks in document</span>
              </button>
              <button role="menuitem" className="split-menu-item" onClick={stub}>
                <IcEye className="split-menu-icon" />
                <span>Reading view</span>
              </button>
              <button role="menuitem" className="split-menu-item" onClick={stub}>
                <IcCode className="split-menu-icon" />
                <span>Source mode</span>
              </button>
              <div className="split-menu-divider" role="separator" />
            </>
          )}

          <button
            role="menuitem"
            className="split-menu-item"
            onClick={run(() => onSplit("right"))}
          >
            <IcArrowRight className="split-menu-icon" />
            <span>Split right</span>
          </button>
          <button
            role="menuitem"
            className="split-menu-item"
            onClick={run(() => onSplit("bottom"))}
          >
            <IcArrowDown className="split-menu-icon" />
            <span>Split down</span>
          </button>
          <button role="menuitem" className="split-menu-item" onClick={stub}>
            <IcLinkExternal className="split-menu-icon" />
            <span>Open in new window</span>
          </button>

          {hasFile && (
            <>
              <div className="split-menu-divider" role="separator" />
              <button role="menuitem" className="split-menu-item" onClick={stub}>
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
              <button role="menuitem" className="split-menu-item" onClick={stub}>
                <IcSearch className="split-menu-icon" />
                <span>Find…</span>
              </button>
              <button role="menuitem" className="split-menu-item" onClick={stub}>
                <IcReplace className="split-menu-icon" />
                <span>Replace…</span>
              </button>

              <div className="split-menu-divider" role="separator" />
              <button role="menuitem" className="split-menu-item" onClick={stub}>
                <IcCopy className="split-menu-icon" />
                <span>Copy path</span>
                <IcChevronRight className="split-menu-trailing" />
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
              <button role="menuitem" className="split-menu-item" onClick={stub}>
                <IcLinkExternal className="split-menu-icon" />
                <span>Open in default app</span>
              </button>
              <button role="menuitem" className="split-menu-item" onClick={stub}>
                <IcFolderOpened className="split-menu-icon" />
                <span>Show in system explorer</span>
              </button>
              <button role="menuitem" className="split-menu-item" onClick={stub}>
                <IcLocation className="split-menu-icon" />
                <span>Reveal file in navigation</span>
              </button>

              {onClose && (
                <>
                  <div className="split-menu-divider" role="separator" />
                  <button
                    role="menuitem"
                    className="split-menu-item danger"
                    onClick={run(onClose)}
                  >
                    <IcTrash className="split-menu-icon" />
                    <span>Delete file</span>
                  </button>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
