import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import type { FileNode, SplitTree, Tab } from "./state/types";
import { useVaultStore } from "./state/vaultStore";
import { useEditorStore } from "./state/editorStore";
import { pickVaultFolder, createFolder as createFolderOnDisk } from "./lib/tauriApi";
import {
  GRAPH_TAB_FILE_ID,
  VAULT_NAME as MOCK_VAULT_NAME,
  initialVault,
} from "./state/mockVault";
import {
  findLeaf,
  leaves,
  mapLeaves,
  openTabInLeaf,
  uid,
} from "./state/splitTree";
import { LeftSidebar, type LeftView } from "./components/layout/LeftSidebar";
import { RightSidebar } from "./components/layout/RightSidebar";
import { LeftActivityStrip } from "./components/layout/ActivityStrip";
import { EditorArea } from "./components/editor/EditorArea";
import { WindowControls } from "./components/layout/TopBar";
import { StatusPill } from "./components/layout/StatusPill";
import { SettingsModal } from "./components/modals/SettingsModal";
import {
  ManageVaultsModal,
  type Vault,
} from "./components/modals/ManageVaultsModal";
import { IcPanelLeft } from "./components/common/Icons";
import { useDragResize } from "./hooks/useDragResize";

const LEFT_MIN = 160;
const LEFT_MAX = 520;
const LEFT_DEFAULT = 240;
const RIGHT_MIN = 200;
const RIGHT_MAX = 520;
const RIGHT_DEFAULT = 280;
const STRIP_W = 36;

function makeInitialTree(): { tree: SplitTree; activeLeafId: string } {
  // Open the GraphView by default so the user lands on something
  // visual (and so the hard-coded "Graph View" entry in the file tree
  // is highlighted on first paint). EditorArea recognises this special
  // fileId and renders <GraphView/> instead of an editor.
  const tab: Tab = {
    id: uid("tab"),
    fileId: GRAPH_TAB_FILE_ID,
    title: "Graph View",
  };
  const leafId = uid("leaf");
  return {
    tree: { kind: "leaf", id: leafId, tabs: [tab], activeTabId: tab.id },
    activeLeafId: leafId,
  };
}

function countWords(md: string): { words: number; characters: number } {
  const stripped = md
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]*`/g, "")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/[#>*_`\-]/g, "")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1");
  const words = stripped.split(/\s+/).filter(Boolean).length;
  const characters = md.length;
  return { words, characters };
}

type BacklinkRef = { fileId: string; fileName: string };
type OutgoingRef = { name: string };
type HeadingRef = { level: number; text: string };

function collectBacklinks(
  target: string,
  vault: Map<string, FileNode>,
): BacklinkRef[] {
  const t = target.toLowerCase();
  const out: BacklinkRef[] = [];
  vault.forEach((node) => {
    if (node.kind !== "file" || !node.content) return;
    const re = /\[\[([^\]]+)\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(node.content))) {
      if (m[1].toLowerCase() === t) {
        out.push({ fileId: node.id, fileName: node.name });
        break; // count each file at most once in the backlinks list
      }
    }
  });
  return out;
}

function collectOutgoing(content: string): OutgoingRef[] {
  const re = /\[\[([^\]]+)\]\]/g;
  const seen = new Set<string>();
  const out: OutgoingRef[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const name = m[1].split("|")[0].trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name });
  }
  return out;
}

function collectTags(content: string): string[] {
  // strip fenced code blocks so #foo inside ``` ``` isn't picked up
  const stripped = content.replace(/```[\s\S]*?```/g, "");
  const re = /(?:^|\s)#([A-Za-z0-9_\-/]+)/g;
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped))) {
    const key = m[1].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m[1]);
  }
  return out;
}

function collectHeadings(content: string): HeadingRef[] {
  const out: HeadingRef[] = [];
  let inFence = false;
  for (const raw of content.split(/\r?\n/)) {
    if (/^```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw);
    if (!m) continue;
    out.push({ level: m[1].length, text: m[2] });
  }
  return out;
}

export default function App() {
  // ---- Vault & active file -------------------------------------------------
  // Vault state is managed by zustand. The store reads from the real
  // filesystem via Tauri commands. Components receive the same props
  // they always did — only the data source changed.
  const vaultNodes = useVaultStore((s) => s.fileTree);
  const vault = useVaultStore((s) => s.flatVault);
  const vaultPath = useVaultStore((s) => s.vaultPath);
  void vaultPath; // reserved for future backend backlinks call
  const vaultName = useVaultStore((s) => s.vaultName) || "Lattice";

  // ── Bootstrap a mock vault on first mount ─────────────────────────────
  // Without this, the file tree is empty on startup (nobody has picked a
  // real folder yet) and GraphView spins forever waiting for vaultPath.
  // We populate the vault store with the hard-coded `initialVault` and
  // seed the editor store with every markdown body so `loadFile(id)`
  // resolves instantly without going to disk. Using the synthetic path
  // `__mock__` signals "in-memory only" to GraphView, which then builds
  // the graph from the in-memory wikilinks instead of calling the Rust
  // backend (which would error out on a non-existent folder path).
  // Skipped if the user has already opened a real vault.
  useEffect(() => {
    const state = useVaultStore.getState();
    if (state.vaultPath || state.fileTree.length > 0) return;

    const flat = new Map<string, FileNode>();
    const walk = (n: FileNode) => {
      flat.set(n.id, n);
      n.children?.forEach(walk);
    };
    initialVault.forEach(walk);

    useVaultStore.setState({
      vaultPath: "__mock__",
      vaultName: MOCK_VAULT_NAME,
      fileTree: initialVault,
      flatVault: flat,
    });

    // Pre-seed the editor store so loadFile resolves synchronously for
    // every mock file (no disk call) and the graph indexer can read
    // markdown bodies for wiki-link extraction.
    const seeded: Record<string, string> = {};
    flat.forEach((node) => {
      if (node.kind === "folder" || node.kind === "graph") return;
      if (typeof node.content === "string") {
        seeded[node.id] = node.content;
      }
    });
    useEditorStore.setState((prev) => ({
      fileContents: { ...prev.fileContents, ...seeded },
    }));
  }, []);

  // Debounce timer ref for auto-saving file content to disk
  /** Write back the new body for a file (markdown or canvas). Updates
   *  the in-memory vault tree + editor store, and marks it dirty. */
  const onUpdateFileContent = useCallback(
    (fileId: string, content: string) => {
      // Update zustand vault store (in-memory tree)
      useVaultStore.getState().updateFileContent(fileId, content);
      // Update editor store (content cache)
      useEditorStore.getState().setFileContent(fileId, content);
      useEditorStore.getState().markDirty(fileId);
    },
    [],
  );

  // ---- Editor split-tree --------------------------------------------------
  const init = useMemo(makeInitialTree, []);
  const [tree, setTree] = useState<SplitTree>(init.tree);
  const [activeLeafId, setActiveLeafId] = useState(init.activeLeafId);

  const isMac = typeof window !== "undefined" && navigator.userAgent.includes("Mac");

  // ensure activeLeafId stays valid when tree changes
  useEffect(() => {
    if (!findLeaf(tree, activeLeafId)) {
      const first = leaves(tree)[0];
      if (first) setActiveLeafId(first.id);
    }
  }, [tree, activeLeafId]);

  const onTreeChange = useCallback((next: SplitTree | null) => {
    if (next) setTree(next);
    else {
      // tree collapsed to nothing — re-init with a fresh empty leaf
      const fresh = makeInitialTree();
      setTree(fresh.tree);
      setActiveLeafId(fresh.activeLeafId);
    }
  }, []);

  // ---- Sidebar state ------------------------------------------------------
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [leftWidth, setLeftWidth] = useState(LEFT_DEFAULT);
  const [rightWidth, setRightWidth] = useState(RIGHT_DEFAULT);
  const [leftView, setLeftView] = useState<LeftView>("files");

  // Transient “this sidebar is currently sliding open/closed” flag. It
  // gates the CSS `transition: width` so dragging the resize handle stays
  // instant (no easing), while toggling open/closed plays a smooth slide.
  const [leftAnimating, setLeftAnimating] = useState(false);
  const [rightAnimating, setRightAnimating] = useState(false);
  const toggleLeftSidebar = useCallback(() => {
    setLeftAnimating(true);
    setLeftCollapsed((c) => !c);
    window.setTimeout(() => setLeftAnimating(false), 240);
  }, []);
  const toggleRightSidebar = useCallback(() => {
    setRightAnimating(true);
    setRightCollapsed((c) => !c);
    window.setTimeout(() => setRightAnimating(false), 240);
  }, []);

  // ---- Settings modal -----------------------------------------------------
  const [settingsOpen, setSettingsOpen] = useState(false);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  // ---- Manage Vaults modal -----------------------------------------------
  // The list of known vaults is local-only for now (no filesystem yet).
  // First entry is hard-coded to match the active VAULT_NAME so the
  // modal can render an "Open" badge on the currently-loaded vault.
  // Real wiring (create folder, open folder picker, etc.) lands later
  // — the modal already exposes typed callbacks so swapping in Tauri
  // commands is a one-file change.
  const [vaultsOpen, setVaultsOpen] = useState(false);
  const [knownVaults, setKnownVaults] = useState<Vault[]>(() => {
    // Load known vaults from localStorage
    try {
      const stored = window.localStorage.getItem("lattice.knownVaults");
      if (stored) return JSON.parse(stored);
    } catch { /* ignore */ }
    return [];
  });

  // Persist known vaults to localStorage
  useEffect(() => {
    try {
      window.localStorage.setItem("lattice.knownVaults", JSON.stringify(knownVaults));
    } catch { /* ignore */ }
  }, [knownVaults]);

  const openManageVaults = useCallback(() => setVaultsOpen(true), []);
  const closeManageVaults = useCallback(() => setVaultsOpen(false), []);

  const doOpenVaultByPath = useCallback(async (path: string) => {
    await useVaultStore.getState().openVault(path);
    const name = path.split(/[/\\]/).filter(Boolean).pop() ?? "Vault";
    // Add to known vaults if not already there
    setKnownVaults((vs) => {
      if (vs.some((v) => v.path === path)) return vs;
      return [...vs, { id: `vault-${Date.now()}`, name, path }];
    });
  }, []);

  const onOpenVault = useCallback((id: string) => {
    const v = knownVaults.find((vault) => vault.id === id);
    if (v) {
      doOpenVaultByPath(v.path);
    }
    setVaultsOpen(false);
  }, [knownVaults, doOpenVaultByPath]);

  const onRemoveVault = useCallback((id: string) => {
    setKnownVaults((vs) => vs.filter((v) => v.id !== id));
  }, []);

  const onCreateNewVault = useCallback(async () => {
    const selected = await pickVaultFolder();
    if (selected) {
      try {
        await createFolderOnDisk(selected);
      } catch { /* folder might already exist, that's ok */ }
      await doOpenVaultByPath(selected);
      setVaultsOpen(false);
    }
  }, [doOpenVaultByPath]);

  const onOpenFolderAsVault = useCallback(async () => {
    const selected = await pickVaultFolder();
    if (selected) {
      await doOpenVaultByPath(selected);
      setVaultsOpen(false);
    }
  }, [doOpenVaultByPath]);

  const onOpenExistingVault = useCallback(async () => {
    // Same as open folder for now
    const selected = await pickVaultFolder();
    if (selected) {
      await doOpenVaultByPath(selected);
      setVaultsOpen(false);
    }
  }, [doOpenVaultByPath]);

  // ---- Theme --------------------------------------------------------------
  type Theme = "dark" | "light";
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === "undefined") return "dark";
    const stored = window.localStorage.getItem("lattice.theme");
    return stored === "light" ? "light" : "dark";
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem("lattice.theme", theme);
    } catch {
      /* ignore quota / disabled storage */
    }
  }, [theme]);
  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }, []);

  const leftStartRef = useRef(LEFT_DEFAULT);
  const rightStartRef = useRef(RIGHT_DEFAULT);

  const [dragging, setDragging] = useState<"left" | "right" | null>(null);

  const beginLeftDrag = useCallback(() => {
    leftStartRef.current = leftWidth;
    setDragging("left");
  }, [leftWidth]);
  const beginRightDrag = useCallback(() => {
    rightStartRef.current = rightWidth;
    setDragging("right");
  }, [rightWidth]);
  const endDrag = useCallback(() => setDragging(null), []);

  const onLeftDelta = useCallback((d: number) => {
    setLeftWidth(
      Math.max(LEFT_MIN, Math.min(LEFT_MAX, leftStartRef.current + d)),
    );
  }, []);
  const onRightDelta = useCallback((d: number) => {
    setRightWidth(
      Math.max(RIGHT_MIN, Math.min(RIGHT_MAX, rightStartRef.current - d)),
    );
  }, []);

  const leftPointerDown = useDragResize("x", onLeftDelta, endDrag);
  const rightPointerDown = useDragResize("x", onRightDelta, endDrag);

  // ---- Active file & metrics ---------------------------------------------
  const activeFile = useMemo<FileNode | null>(() => {
    const leaf = findLeaf(tree, activeLeafId);
    if (!leaf) return null;
    const tab = leaf.tabs.find((t) => t.id === leaf.activeTabId);
    if (!tab || !tab.fileId) return null;
    const f = vault.get(tab.fileId);
    return f && f.kind === "file" ? f : null;
  }, [tree, activeLeafId, vault]);

  const backlinks = useMemo<BacklinkRef[]>(() => {
    if (!activeFile) return [];
    return collectBacklinks(activeFile.name, vault);
  }, [activeFile, vault]);

  const outgoing = useMemo<OutgoingRef[]>(() => {
    if (!activeFile || !activeFile.content) return [];
    return collectOutgoing(activeFile.content);
  }, [activeFile]);

  const tags = useMemo<string[]>(() => {
    if (!activeFile || !activeFile.content) return [];
    return collectTags(activeFile.content);
  }, [activeFile]);

  const headings = useMemo<HeadingRef[]>(() => {
    if (!activeFile || !activeFile.content) return [];
    return collectHeadings(activeFile.content);
  }, [activeFile]);

  const metrics = useMemo(() => {
    if (!activeFile)
      return { backlinks: 0, words: 0, characters: 0 } as const;
    const { words, characters } = countWords(activeFile.content ?? "");
    return {
      backlinks: backlinks.length,
      words,
      characters,
    };
  }, [activeFile, backlinks]);

  // ---- Open file from sidebar --------------------------------------------
  const openFile = useCallback(
    (file: FileNode) => {
      if (file.kind === "folder") return;
      // The hard-coded "Graph View" entry in the vault opens the
      // GraphView virtual tab, not a markdown editor. We route to the
      // same logic as the activity-strip graph button so a single tab
      // is reused when the graph is already open in this leaf.
      if (file.kind === "graph") {
        const newTab: Tab = {
          id: uid("tab"),
          fileId: GRAPH_TAB_FILE_ID,
          title: "Graph View",
        };
        setTree((prev) => {
          const leaf = findLeaf(prev, activeLeafId) || leaves(prev)[0];
          if (!leaf) return prev;
          const existing = leaf.tabs.find(
            (t) => t.fileId === GRAPH_TAB_FILE_ID,
          );
          if (existing) {
            if (leaf.activeTabId === existing.id) return prev;
            return (
              mapLeaves(prev, (l) =>
                l.id === leaf.id ? { ...l, activeTabId: existing.id } : l,
              ) || prev
            );
          }
          return (
            mapLeaves(prev, (l) =>
              l.id === leaf.id ? openTabInLeaf(l, newTab) : l,
            ) || prev
          );
        });
        return;
      }
      const tab: Tab = { id: uid("tab"), fileId: file.id, title: file.name };
      const next = mapLeaves(tree, (leaf) =>
        leaf.id === activeLeafId ? openTabInLeaf(leaf, tab) : leaf,
      );
      if (next) setTree(next);
      // Mock-vault files (vaultPath === "__mock__") already have their
      // content seeded in editorStore by the bootstrap effect, so the
      // loadFile call below short-circuits via the cache and never hits
      // the (non-existent) Rust backend.
      useEditorStore.getState().loadFile(file.id).then((content) => {
        // Also update the vault store so the file tree has content for
        // backlinks/outgoing/tags computation
        useVaultStore.getState().updateFileContent(file.id, content);
      }).catch((err) => {
        console.error("Failed to load file:", err);
      });
    },
    [tree, activeLeafId],
  );

  const onOpenFileByPath = useCallback((path: string) => {
    const file = vault.get(path);
    if (file) openFile(file);
  }, [vault, openFile]);

  const onOpenGraph = useCallback(() => {
    const newTab: Tab = {
      id: uid("tab"),
      fileId: "__graph__",
      title: "Graph View",
    };
    setTree((prev) => {
      const leaf = findLeaf(prev, activeLeafId) || leaves(prev)[0];
      if (!leaf) return prev;

      const existing = leaf.tabs.find((t) => t.fileId === "__graph__");
      if (existing) {
        // Already active in this pane — return prev unchanged so React
        // doesn't reconcile EditorArea and force GraphView to remount.
        // Remounting re-runs force-graph's zoomToFit, which is what
        // made the graph "zoom itself" when the user clicked the
        // sidebar graph button while the graph tab was already open.
        if (leaf.activeTabId === existing.id) return prev;
        return (
          mapLeaves(prev, (l) =>
            l.id === leaf.id ? { ...l, activeTabId: existing.id } : l,
          ) || prev
        );
      }

      return (
        mapLeaves(prev, (l) =>
          l.id === leaf.id ? openTabInLeaf(l, newTab) : l,
        ) || prev
      );
    });
  }, [activeLeafId]);

  // ---- Wikilink navigation ------------------------------------------------
  // The CodeMirror editor dispatches a custom event when a [[wikilink]] is
  // clicked. We listen for it here and open the target file.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.target) return;
      const linkTarget = detail.target as string;
      // Search the vault tree for a file matching the link target
      const flat = useVaultStore.getState().flatVault;
      let found: FileNode | null = null;
      flat.forEach((node) => {
        if (found) return;
        if (node.kind === "folder") return;
        // Match by name (without extension)
        const nameWithout = node.name.replace(/\.md$/i, "").replace(/\.canvas$/i, "");
        if (nameWithout.toLowerCase() === linkTarget.toLowerCase()) {
          found = node;
        }
      });
      if (found) {
        openFile(found);
      }
    };
    window.addEventListener("lattice-open-wikilink", handler);
    return () => window.removeEventListener("lattice-open-wikilink", handler);
  }, [openFile]);

  // ---- Keyboard shortcuts -------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleLeftSidebar();
      } else if (e.key.toLowerCase() === "n") {
        e.preventDefault();
        const tab: Tab = { id: uid("tab"), fileId: null, title: "New tab" };
        const next = mapLeaves(tree, (leaf) =>
          leaf.id === activeLeafId ? openTabInLeaf(leaf, tab) : leaf,
        );
        if (next) setTree(next);
      } else if (e.key.toLowerCase() === "w") {
        e.preventDefault();
        const leaf = findLeaf(tree, activeLeafId);
        if (!leaf) return;
        const tabId = leaf.activeTabId;
        const next = mapLeaves(tree, (l) => {
          if (l.id !== leaf.id) return l;
          const remaining = l.tabs.filter((t) => t.id !== tabId);
          if (remaining.length === 0) return null;
          return {
            ...l,
            tabs: remaining,
            activeTabId: remaining[remaining.length - 1].id,
          };
        });
        if (next) setTree(next);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tree, activeLeafId]);

  // ---- Resize handle X positions (full-height overlays) ------------------
  // x = left edge of the handle. Hidden while the sidebar is mid-animation
  // so the handle doesn’t snap to the final position before the column
  // catches up.
  const leftHandleX =
    !leftCollapsed && !leftAnimating
      ? STRIP_W + leftWidth - 3 /* center the 6px zone on the edge */
      : null;
  const rightHandleX =
    !rightCollapsed && !rightAnimating
      ? `calc(100% - ${rightWidth + 3}px)`
      : null;

  return (
    <div className="lattice-app">
      {/* ===== L strip column ===== */}
      <div className="col lstrip">
        <div className="col-header center" data-tauri-drag-region>
          {!isMac && (
            <button
              className="icon-btn tiny"
              title={leftCollapsed ? "Show left sidebar" : "Hide left sidebar"}
              onClick={toggleLeftSidebar}
            >
              <IcPanelLeft open={!leftCollapsed} />
            </button>
          )}
        </div>
        <div className="col-body">
          <LeftActivityStrip onOpenGraph={onOpenGraph} />
        </div>
      </div>

      {/* ===== L sidebar column ===== */}
      <div
        className={`col lsidebar${leftAnimating ? " animating" : ""}${
          leftCollapsed ? " collapsed" : ""
        }`}
        style={{ width: leftCollapsed ? 0 : leftWidth }}
        aria-hidden={leftCollapsed}
      >
        <div className="sidebar-inner" style={{ width: leftWidth }}>
          <LeftSidebar
            vaultName={vaultName}
            view={leftView}
            onChangeView={setLeftView}
            files={vaultNodes}
            selectedId={activeFile?.id ?? null}
            onOpenFile={openFile}
            theme={theme}
            onToggleTheme={toggleTheme}
            onOpenSettings={openSettings}
            onOpenManageVaults={openManageVaults}
            isMac={isMac}
            onToggleSidebar={toggleLeftSidebar}
          />
        </div>
      </div>

      {/* ===== Editor column (no header — pane tabbar is the top strip) ===== */}
      <div className="col editor">
        <EditorArea
          tree={tree}
          vault={vault}
          activeLeafId={activeLeafId}
          onChangeActiveLeaf={setActiveLeafId}
          onTreeChange={onTreeChange}
          onUpdateFileContent={onUpdateFileContent}
          onOpenFileByPath={onOpenFileByPath}
          leftSidebarCollapsed={leftCollapsed}
          onToggleLeftSidebar={toggleLeftSidebar}
          rightSidebarCollapsed={rightCollapsed}
          onToggleRightSidebar={toggleRightSidebar}
          topRightInsetPx={isMac || !rightCollapsed ? 0 : 146 /* only reserve room for the window-controls cluster when the right sidebar is hidden \u2014 otherwise the controls sit over the sidebar, not the editor */}
          topLeftInsetPx={isMac && leftCollapsed ? 40 : 0}
        />
      </div>

      {/* ===== R sidebar column ===== */}
      <div
        className={`col rsidebar${rightAnimating ? " animating" : ""}${
          rightCollapsed ? " collapsed" : ""
        }`}
        style={{ width: rightCollapsed ? 0 : rightWidth }}
        aria-hidden={rightCollapsed}
      >
        <div className="sidebar-inner" style={{ width: rightWidth }}>
          <RightSidebar
            hasOpenFile={activeFile !== null}
            backlinks={backlinks}
            outgoing={outgoing}
            tags={tags}
            headings={headings}
          />
        </div>
      </div>

      {/* ===== Floating status pill (bottom-right, always visible) ===== */}
      <StatusPill
        hasOpenFile={activeFile !== null}
        backlinks={metrics.backlinks}
        words={metrics.words}
        characters={metrics.characters}
      />

      {/* ===== Floating window controls (always at top right) ===== */}
      <WindowControls />

      {/* ===== Full-height sidebar resize handles ===== */}
      {leftHandleX !== null && (
        <div
          className={`resize-handle${dragging === "left" ? " dragging" : ""}`}
          style={{ left: leftHandleX }}
          onPointerDown={(e) => {
            beginLeftDrag();
            leftPointerDown(e);
          }}
        />
      )}
      {rightHandleX !== null && (
        <div
          className={`resize-handle${dragging === "right" ? " dragging" : ""}`}
          style={{ left: rightHandleX }}
          onPointerDown={(e) => {
            beginRightDrag();
            rightPointerDown(e);
          }}
        />
      )}

      {/* ===== Settings overlay (floats above everything) ===== */}
      <SettingsModal
        open={settingsOpen}
        onClose={closeSettings}
        theme={theme}
        onToggleTheme={toggleTheme}
      />

      {/* ===== Manage Vaults overlay (z-index above settings) ===== */}
      <ManageVaultsModal
        open={vaultsOpen}
        vaults={knownVaults}
        activeVaultName={vaultName}
        onOpenVault={onOpenVault}
        onRemoveFromList={onRemoveVault}
        onCreateNewVault={onCreateNewVault}
        onOpenFolderAsVault={onOpenFolderAsVault}
        onOpenExistingVault={onOpenExistingVault}
        onClose={closeManageVaults}
      />
    </div>
  );
}
