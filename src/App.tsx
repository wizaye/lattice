import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import type { FileNode, SplitTree, Tab } from "./state/types";
import { useVaultStore } from "./state/vaultStore";
import { useEditorStore } from "./state/editorStore";
import { useSettingsStore } from "./state/settingsStore";
import { pickVaultFolder, createFolder as createFolderOnDisk } from "./lib/tauriApi";
import { GRAPH_TAB_FILE_ID } from "./state/mockVault";
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
import { useVcsStore, selectDirtyCount } from "./state/vcsStore";
import {
  type BacklinkGroup,
  type MentionGroup,
  type OutgoingRef,
  type HeadingRef,
  collectHeadings,
  collectOutgoing,
  collectTags,
  computeBacklinks,
  computeUnlinkedMentions,
  countMentions,
  countWords,
} from "./lib/backlinks";
import { SettingsModal } from "./components/modals/SettingsModal";
import {
  ManageVaultsModal,
  type Vault,
} from "./components/modals/ManageVaultsModal";
import { NewPaperModal } from "./components/modals/NewPaperModal";
import { PublishWizard } from "./components/modals/PublishWizard";
import { IcPanelLeft } from "./components/common/Icons";
import { useDragResize } from "./hooks/useDragResize";
import { OnboardingShell } from "./components/onboarding/OnboardingShell";
import {
  useOnboardingStore,
  shouldShowOnboarding,
} from "./components/onboarding/state/onboardingStore";

const LEFT_MIN = 160;
const LEFT_DEFAULT = 240;
const RIGHT_MIN = 200;
const RIGHT_DEFAULT = 280;
const STRIP_W = 36;
// Auto-collapse threshold: dragging the splitter inward past this
// many pixels below the panel's minimum width snaps the panel into
// collapsed mode (matches the VS Code / Obsidian convention). The
// stored width is preserved so toggling the panel open later
// restores it to its previous size.
const LEFT_COLLAPSE_AT = LEFT_MIN - 40;
const RIGHT_COLLAPSE_AT = RIGHT_MIN - 40;

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

// NOTE: word counting, backlinks, outgoing, tags, and headings all live in
// `src/lib/backlinks.ts`. Inlining them here historically caused two bugs:
//   1. `BacklinkRef[]` shape leaked into RightSidebar (which expects
//      `BacklinkGroup[]` with snippets) and threw at render → blank screen.
//   2. `[[Target|Alias]]` and `[[Target#anchor]]` never matched because
//      the comparison used the raw match group instead of the cleaned
//      target. Keep all collectors in the shared module.

export default function App() {
  // ---- Vault & active file -------------------------------------------------
  // Vault state is managed by zustand. The store reads from the real
  // filesystem via Tauri commands. Components receive the same props
  // they always did — only the data source changed.
  const vaultNodes = useVaultStore((s) => s.fileTree);
  const vault = useVaultStore((s) => s.flatVault);
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const vaultName = useVaultStore((s) => s.vaultName) || "Lattice";

  // Live VCS dirty-count for the status-pill badge. Stays at 0 until
  // the first refresh resolves (and falls back to 0 when no vault is
  // open). Subscribing via the dedicated selector keeps re-renders
  // limited to changes in the count specifically — the rest of the
  // VcsStore (history, errors, etc.) doesn't touch App.
  const dirtyCount = useVcsStore(selectDirtyCount);

  // ── Auto-restore the last opened vault on first mount ──────────────────
  // Reads the persisted vault path from localStorage and silently re-opens
  // it. If no path is stored the app starts with an empty file tree — the
  // user picks a folder via the sidebar or Manage Vaults modal.
  useEffect(() => {
    const state = useVaultStore.getState();
    if (state.vaultPath || state.fileTree.length > 0) return;
    if (!useSettingsStore.getState().autoRestoreVault) return;

    try {
      const lastPath = window.localStorage.getItem("lattice.lastVaultPath");
      if (lastPath) {
        void useVaultStore.getState().openVault(lastPath).catch(() => {
          // Folder may have been moved/deleted — silently clear the stored path
          window.localStorage.removeItem("lattice.lastVaultPath");
        });
      }
    } catch {
      /* localStorage disabled — start empty */
    }
  }, []);

  // ── Persist the current vault path whenever it changes ─────────────────
  useEffect(() => {
    if (!vaultPath) return;
    try {
      window.localStorage.setItem("lattice.lastVaultPath", vaultPath);
    } catch {
      /* ignore quota / disabled storage */
    }
  }, [vaultPath]);

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

  // ── Kick off VCS status refresh whenever the active vault changes.
  // We skip the synthetic mock-vault sentinel (no real filesystem) and
  // call `reset()` so any stale status from a previously-open vault is
  // cleared instantly — otherwise the sidebar/pill briefly show numbers
  // from the OLD vault while the new refresh is in flight.
  //
  // After the status refresh resolves, we ALSO warm up the three
  // derived views (commit history, graph DAG, branches list) — but
  // ONLY when the vault is actually tracked (`status.initialized`).
  // The Changes panel used to lazy-load these on first render of
  // each section, which left the user staring at empty cards after
  // opening a vault until they clicked into history/branches.  By
  // priming the store here we make the panel feel instant when the
  // user navigates to it, regardless of which left view was last
  // active.  All three IPCs are cheap (single `git` subprocess) and
  // fire in parallel.
  //
  // Re-runs only when `vaultPath` itself changes (NOT every render),
  // so the cost is essentially zero for normal use. The refresh call
  // is debounced inside `vcsStore` to coalesce rapid switches.
  useEffect(() => {
    const store = useVcsStore.getState();
    if (!vaultPath) {
      store.reset();
      return;
    }
    let cancelled = false;
    void (async () => {
      await store.refresh(vaultPath);
      if (cancelled) return;
      const fresh = useVcsStore.getState();
      if (fresh.cacheKey !== vaultPath) return;
      if (!fresh.status?.initialized) return;
      void fresh.refreshHistory(vaultPath, 100);
      void fresh.refreshGraph(vaultPath, 200);
      void fresh.refreshBranches(vaultPath);
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultPath]);

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

  // ---- New Paper modal (Slice C) -----------------------------------------
  // The modal scaffolds a `paper.toml`-anchored folder via the real
  // `paper_create` IPC.  We surface it from the LeftSidebar footer
  // (next to Settings) AND respond to a `lattice-open-new-paper`
  // window event so future entry points (file-tree right-click,
  // command palette, etc.) don't need to thread props through the
  // whole tree.
  const [newPaperOpen, setNewPaperOpen] = useState(false);
  const openNewPaper = useCallback(() => setNewPaperOpen(true), []);
  const closeNewPaper = useCallback(() => setNewPaperOpen(false), []);

  // ---- Publish wizard (Slice D) ------------------------------------------
  const [publishOpen, setPublishOpen] = useState(false);
  const openPublishWizard = useCallback(() => setPublishOpen(true), []);
  const closePublishWizard = useCallback(() => setPublishOpen(false), []);

  // Cross-cutting: let any component dispatch a CustomEvent to open
  // either modal without needing the callback in scope.
  useEffect(() => {
    const onNewPaper = () => setNewPaperOpen(true);
    const onPublish = () => setPublishOpen(true);
    window.addEventListener("lattice-open-new-paper", onNewPaper);
    window.addEventListener("lattice-open-publish-wizard", onPublish);
    return () => {
      window.removeEventListener("lattice-open-new-paper", onNewPaper);
      window.removeEventListener("lattice-open-publish-wizard", onPublish);
    };
  }, []);

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

  // ---- Settings CSS Injection ----------------------------------------------
  const accentColor = useSettingsStore((s) => s.accentColor);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const fontFamily = useSettingsStore((s) => s.fontFamily);
  const density = useSettingsStore((s) => s.density);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--accent", accentColor);
    root.style.setProperty("--editor-font-size", `${fontSize}px`);
    root.style.setProperty("--font-text", fontFamily);
    root.dataset.density = density;
  }, [accentColor, fontSize, fontFamily, density]);

  const leftStartRef = useRef(LEFT_DEFAULT);
  const rightStartRef = useRef(RIGHT_DEFAULT);

  const [dragging, setDragging] = useState<"left" | "right" | null>(null);

  // Track window width so the resize clamps know how much room is
  // actually available between the two sidebars. We only care about
  // x-axis changes for the splitter math, but innerHeight is cheap.
  const [windowWidth, setWindowWidth] = useState<number>(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth,
  );
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const beginLeftDrag = useCallback(() => {
    leftStartRef.current = leftWidth;
    setDragging("left");
  }, [leftWidth]);
  const beginRightDrag = useCallback(() => {
    rightStartRef.current = rightWidth;
    setDragging("right");
  }, [rightWidth]);
  const endDrag = useCallback(() => setDragging(null), []);

  // The active cap for each sidebar respects the OPPOSING side's
  // MIN width: when stretched fully, the opposing sidebar should
  // still get at least its MIN reserved. Without this, the opposing
  // sidebar's header content (e.g., the right sidebar's tabbed
  // panel strip) gets squeezed into a region too narrow for its
  // intrinsic chrome and ends up sliding under the floating
  // window-controls cluster (min/max/close). Matches Obsidian where
  // each sidebar's drag-handle stops at exactly the point where the
  // other sidebar would be reduced to its minimum.
  const leftMaxDynamic = Math.max(
    LEFT_MIN,
    windowWidth - STRIP_W - (rightCollapsed ? 0 : RIGHT_MIN),
  );
  const rightMaxDynamic = Math.max(
    RIGHT_MIN,
    windowWidth - STRIP_W - (leftCollapsed ? 0 : LEFT_MIN),
  );

  // Refs mirror the collapsed state so the pointer-move callback
  // (which uses a stale closure) can read the current value without
  // re-creating itself on every state change.
  const leftCollapsedRef = useRef(leftCollapsed);
  const rightCollapsedRef = useRef(rightCollapsed);
  useEffect(() => {
    leftCollapsedRef.current = leftCollapsed;
  }, [leftCollapsed]);
  useEffect(() => {
    rightCollapsedRef.current = rightCollapsed;
  }, [rightCollapsed]);
  // Refs for the current widths too — the drag handler reads them
  // (for the push-the-opposing-sidebar-inward behaviour below) but we
  // do NOT want them in the useCallback deps, because that would
  // rebind the window pointermove listener on every pixel of every
  // drag, causing visible jitter.
  const leftWidthRef = useRef(leftWidth);
  const rightWidthRef = useRef(rightWidth);
  useEffect(() => {
    leftWidthRef.current = leftWidth;
  }, [leftWidth]);
  useEffect(() => {
    rightWidthRef.current = rightWidth;
  }, [rightWidth]);

  const onLeftDelta = useCallback(
    (d: number) => {
      const requested = leftStartRef.current + d;
      // Past the collapse threshold? Snap shut and stop tracking
      // width updates for the rest of this drag.
      if (requested < LEFT_COLLAPSE_AT) {
        if (!leftCollapsedRef.current) {
          setLeftAnimating(false);
          setLeftCollapsed(true);
        }
        return;
      }
      // Drag came back from the collapse zone — re-open the panel
      // mid-drag so the user can keep adjusting without releasing.
      if (leftCollapsedRef.current) {
        setLeftAnimating(false);
        setLeftCollapsed(false);
      }
      // Hard cap: the OPPOSING sidebar must always retain at least
      // RIGHT_MIN visible. Past this point the drag stops growing.
      const hardCap = Math.max(
        LEFT_MIN,
        windowWidth - STRIP_W - (rightCollapsedRef.current ? 0 : RIGHT_MIN),
      );
      const newLeft = Math.max(LEFT_MIN, Math.min(hardCap, requested));
      setLeftWidth(newLeft);
      // PUSH behaviour: once the editor is squeezed to 0, further
      // dragging pushes the right sidebar inward — never below
      // RIGHT_MIN. We do NOT push back when the user reverses the
      // drag; the right keeps its squeezed width until the user
      // grabs its own handle (matches Obsidian).
      if (!rightCollapsedRef.current) {
        const remainingForRight = windowWidth - STRIP_W - newLeft;
        if (rightWidthRef.current > remainingForRight) {
          setRightWidth(Math.max(RIGHT_MIN, remainingForRight));
        }
      }
    },
    [windowWidth],
  );
  const onRightDelta = useCallback(
    (d: number) => {
      // Right-side delta is inverted: moving the cursor RIGHT shrinks
      // the right sidebar, so subtract.
      const requested = rightStartRef.current - d;
      if (requested < RIGHT_COLLAPSE_AT) {
        if (!rightCollapsedRef.current) {
          setRightAnimating(false);
          setRightCollapsed(true);
        }
        return;
      }
      if (rightCollapsedRef.current) {
        setRightAnimating(false);
        setRightCollapsed(false);
      }
      const hardCap = Math.max(
        RIGHT_MIN,
        windowWidth - STRIP_W - (leftCollapsedRef.current ? 0 : LEFT_MIN),
      );
      const newRight = Math.max(RIGHT_MIN, Math.min(hardCap, requested));
      setRightWidth(newRight);
      if (!leftCollapsedRef.current) {
        const remainingForLeft = windowWidth - STRIP_W - newRight;
        if (leftWidthRef.current > remainingForLeft) {
          setLeftWidth(Math.max(LEFT_MIN, remainingForLeft));
        }
      }
    },
    [windowWidth],
  );

  // If the window shrinks (or the OTHER sidebar grows) and our
  // current width is now above the dynamic cap, ease back down to
  // the cap so the sidebars don't end up overlapping.
  useEffect(() => {
    if (leftWidth > leftMaxDynamic) setLeftWidth(leftMaxDynamic);
  }, [leftMaxDynamic, leftWidth]);
  useEffect(() => {
    if (rightWidth > rightMaxDynamic) setRightWidth(rightMaxDynamic);
  }, [rightMaxDynamic, rightWidth]);

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

  const backlinks = useMemo<BacklinkGroup[]>(() => {
    if (!activeFile) return [];
    return computeBacklinks(activeFile, vault);
  }, [activeFile, vault]);

  // Unlinked mentions: plain-text mentions of the active file's basename
  // in other notes that aren't yet `[[wikilinks]]`. Shown in a second
  // section under Backlinks in the right sidebar; the engine caps the
  // workload (max 50 files, 5 snippets each) so even huge vaults stay
  // responsive on the main thread.
  const unlinked = useMemo<MentionGroup[]>(() => {
    if (!activeFile) return [];
    return computeUnlinkedMentions(activeFile, vault);
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
      // Status pill shows TOTAL mention count, not file count. Matches
      // Obsidian's behaviour and the rs-stats strip in the sidebar.
      backlinks: countMentions(backlinks),
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

  // ---- Paper PDF auto-open ----------------------------------------------
  // PaperToolbar fires `lattice-open-paper-pdf` after a successful
  // compile.  We refresh the vault tree so the just-written
  // `<paper>/build/main.pdf` shows up in `flatVault`, then route
  // through `onOpenFileByPath` — which opens it as a real editor
  // tab using `PdfView`.  This is what turns "Compile PDF" from
  // "ok, the file is somewhere on disk" into a true preview.
  useEffect(() => {
    const handler = async (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { absPath?: string }
        | undefined;
      const absPath = detail?.absPath;
      if (!absPath) return;
      try {
        await useVaultStore.getState().refreshTree();
      } catch (err) {
        console.warn("lattice-open-paper-pdf: refreshTree failed:", err);
      }
      // vault.get is keyed by absolute path (see tauriApi.ts:147 —
      // `id: node.path`) so we can pass `absPath` straight through.
      const node = useVaultStore.getState().flatVault.get(absPath);
      if (node) {
        openFile(node);
      } else {
        console.warn(
          "lattice-open-paper-pdf: PDF not found in vault after refresh:",
          absPath,
        );
      }
    };
    window.addEventListener("lattice-open-paper-pdf", handler);
    return () => window.removeEventListener("lattice-open-paper-pdf", handler);
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
  // x = left edge of the handle, in pixels. Hidden while the sidebar
  // is mid-animation so the handle doesn't snap to the final position
  // before the column catches up.
  //
  // Both handles are expressed in the same units (pixels off the left
  // edge of the viewport). Previously the right handle used a CSS
  // calc() string while the left used a pure number — under fractional
  // device-pixel ratios those two strategies rounded differently, so
  // the two handles drifted by a sub-pixel and the splitter felt
  // misaligned. Now they share a single anchor: windowWidth.
  const leftHandleX =
    !leftCollapsed && !leftAnimating
      ? STRIP_W + leftWidth - 3 /* center the 6px zone on the edge */
      : null;
  const rightHandleX =
    !rightCollapsed && !rightAnimating
      ? windowWidth - rightWidth - 3
      : null;

  // ── Onboarding gate ────────────────────────────────────────────────────
  // Show the onboarding wizard on first run. Once the user completes it
  // (setting completedAt), shouldShowOnboarding returns false and the
  // main workspace renders normally. The check is reactive via zustand.
  const showOnboarding = useOnboardingStore(shouldShowOnboarding);

  if (showOnboarding) {
    return <OnboardingShell />;
  }

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
            onOpenNewPaper={openNewPaper}
            onOpenPublishWizard={openPublishWizard}
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
            activeFileName={
              activeFile ? activeFile.name.replace(/\.(md|markdown)$/i, "") : null
            }
            backlinks={backlinks}
            unlinked={unlinked}
            outgoing={outgoing}
            tags={tags}
            headings={headings}
            isMac={isMac}
            onOpenFile={(fileId) => {
              const f = vault.get(fileId);
              if (f) openFile(f);
            }}
            onOpenByName={(name) => {
              // Resolve a wikilink target name (no extension) to a vault
              // file by case-insensitive basename match. Mirrors the
              // logic in the `lattice-open-wikilink` handler so clicks
              // from the outgoing-links list behave like real wikilink
              // clicks in the editor.
              const target = name.toLowerCase();
              let found: FileNode | null = null;
              vault.forEach((node) => {
                if (found) return;
                if (node.kind === "folder") return;
                const base = node.name
                  .replace(/\.md$/i, "")
                  .replace(/\.canvas$/i, "");
                if (base.toLowerCase() === target) found = node;
              });
              if (found) openFile(found);
            }}
          />
        </div>
      </div>

      {/* ===== Floating status pill (bottom-right, always visible) ===== */}
      <StatusPill
        hasOpenFile={activeFile !== null}
        backlinks={metrics.backlinks}
        words={metrics.words}
        characters={metrics.characters}
        dirtyCount={dirtyCount}
        onClickSync={() => {
          // Clicking the status-pill sync indicator is the canonical
          // shortcut into the Changes view (VCS + BYOC). If the left
          // sidebar is collapsed, expand it first so the panel is
          // actually visible — otherwise the click would silently
          // switch a hidden view.
          if (leftCollapsed) setLeftCollapsed(false);
          setLeftView("changes");
        }}
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

      {/* ===== New Paper modal (Slice C) ===== */}
      <NewPaperModal
        open={newPaperOpen}
        vaultPath={vaultPath}
        vaultName={vaultName}
        onClose={closeNewPaper}
        onOpenPath={onOpenFileByPath}
        activeMarkdown={
          activeFile && activeFile.kind === "file"
            ? { name: activeFile.name, body: activeFile.content ?? "" }
            : null
        }
      />

      {/* ===== Publish wizard (Slice D) ===== */}
      <PublishWizard
        open={publishOpen}
        vaultPath={vaultPath}
        vaultName={vaultName}
        onClose={closePublishWizard}
      />
    </div>
  );
}
