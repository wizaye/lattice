import { create } from "zustand";
import type { FileNode } from "./types";
import { listDirectory, toFrontendTree, isTauri } from "../lib/tauriApi";

/** Flatten the vault tree for fast id-based lookup. */
function flattenVault(nodes: FileNode[]): Map<string, FileNode> {
  const out = new Map<string, FileNode>();
  const walk = (n: FileNode) => {
    out.set(n.id, n);
    n.children?.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}

interface VaultState {
  /** Absolute path to the currently open vault folder, or null. */
  vaultPath: string | null;
  /** Display name derived from the last path segment. */
  vaultName: string;
  /** The file tree for the sidebar. */
  fileTree: FileNode[];
  /** Flat id→node map for fast lookups. */
  flatVault: Map<string, FileNode>;

  // ── Actions ──
  /** Open a vault by absolute path: reads the directory and populates the tree. */
  openVault: (path: string) => Promise<void>;
  /** Re-read the current vault from disk. */
  refreshTree: () => Promise<void>;
  /** Manually set the file tree (for local mutations). */
  setFileTree: (nodes: FileNode[]) => void;
  /** Update a single file node's content in the flat vault (in-memory only). */
  updateFileContent: (fileId: string, content: string) => void;
}

export const useVaultStore = create<VaultState>((set, get) => ({
  vaultPath: null,
  vaultName: "",
  fileTree: [],
  flatVault: new Map(),

  openVault: async (path: string) => {
    try {
      if (isTauri()) {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("open_vault", { path });
      }
      const backendNodes = await listDirectory(path);
      const tree = toFrontendTree(backendNodes);
      const name = path.split(/[/\\]/).filter(Boolean).pop() ?? "Vault";
      set({
        vaultPath: path,
        vaultName: name,
        fileTree: tree,
        flatVault: flattenVault(tree),
      });
    } catch (err) {
      console.error("Failed to open vault:", err);
    }
  },

  refreshTree: async () => {
    const { vaultPath } = get();
    if (!vaultPath) return;
    try {
      const backendNodes = await listDirectory(vaultPath);
      const tree = toFrontendTree(backendNodes);
      set({
        fileTree: tree,
        flatVault: flattenVault(tree),
      });
      // ── VCS auto-refresh ─────────────────────────────────────────
      // refreshTree is called after create / rename / delete ops, so
      // it's the right place to nudge the VCS panel for tree-shape
      // changes (saves go through editorStore.saveFile separately).
      // Lazy dynamic import to avoid a circular module-load between
      // vaultStore → vcsStore → (anything that imports vaultStore at
      // top level). The debounce in vcsStore swallows the double
      // refresh that happens right after vault-open (App.tsx also
      // kicks one off when vaultPath changes).
      if (vaultPath) {
        const { useVcsStore } = await import("./vcsStore");
        void useVcsStore.getState().refresh(vaultPath);
      }
    } catch (err) {
      console.error("Failed to refresh tree:", err);
    }
  },

  setFileTree: (nodes: FileNode[]) => {
    set({
      fileTree: nodes,
      flatVault: flattenVault(nodes),
    });
  },

  updateFileContent: (fileId: string, content: string) => {
    // Performance fix: instead of walking the full fileTree and rebuilding
    // flatVault on every keystroke (O(n) per character), mutate only the
    // flat map entry and skip the recursive tree walk entirely.
    //
    // The file tree in the sidebar never shows content — it only needs
    // name / kind / children.  The only consumer of node.content is
    // `loadFile` via editorStore (which has its own content cache), and
    // the in-memory fallback in GraphView (which reads from flatVault).
    // Both read from `flatVault`, so updating that map is sufficient.
    //
    // We do NOT update fileTree here: the tree is rebuilt from disk on
    // the next refreshTree() call (create/rename/delete operations).
    const { flatVault } = get();
    const existing = flatVault.get(fileId);
    if (!existing || existing.kind === "folder") return;
    const updated = new Map(flatVault);
    updated.set(fileId, { ...existing, content });
    set({ flatVault: updated });
  },
}));
