import { create } from "zustand";
import { readFile, writeFile } from "../lib/tauriApi";
import { useVaultStore } from "./vaultStore";
import { useVcsStore } from "./vcsStore";

interface EditorState {
  /** Map of file path → loaded content. */
  fileContents: Record<string, string>;
  /** Set of paths that have unsaved changes. */
  dirtyFiles: Set<string>;

  // ── Actions ──
  /** Load a file's content — returns cached if available, otherwise reads from disk. */
  loadFile: (path: string) => Promise<string>;
  /** Update in-memory content for a file. */
  setFileContent: (path: string, content: string) => void;
  /** Save a file to disk and mark it clean. */
  saveFile: (path: string) => Promise<void>;
  /** Mark a file as having unsaved changes. */
  markDirty: (path: string) => void;
  /** Mark a file as saved / clean. */
  markClean: (path: string) => void;
  /** Get cached content for a file, or undefined if not loaded. */
  getContent: (path: string) => string | undefined;
  /** Check if a file has unsaved changes. */
  isDirty: (path: string) => boolean;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  fileContents: {},
  dirtyFiles: new Set(),

  loadFile: async (path: string) => {
    const cached = get().fileContents[path];
    if (cached !== undefined) return cached;

    // In browser mode (no Tauri), readFile returns "". Fall back to the
    // vault store's in-memory content (set by mock vault injection or
    // updateFileContent) before falling through to the empty string.
    const diskContent = await readFile(path);
    if (diskContent !== "") {
      set((state) => ({
        fileContents: { ...state.fileContents, [path]: diskContent },
      }));
      return diskContent;
    }

    // Vault store fallback (in-memory / mock content)
    const { useVaultStore } = await import("./vaultStore");
    const node = useVaultStore.getState().flatVault.get(path);
    const vaultContent = (node?.kind === "file" || node?.kind === "canvas") ? (node.content ?? "") : "";
    set((state) => ({
      fileContents: { ...state.fileContents, [path]: vaultContent },
    }));
    return vaultContent;
  },

  setFileContent: (path, content) =>
    set((state) => ({
      fileContents: { ...state.fileContents, [path]: content },
    })),

  saveFile: async (path: string) => {
    const content = get().fileContents[path];
    if (content === undefined) return;
    try {
      await writeFile(path, content);
      const next = new Set(get().dirtyFiles);
      next.delete(path);
      set({ dirtyFiles: next });
      // ── VCS auto-refresh ───────────────────────────────────────────
      // Every successful disk-write nudges the VCS panel so the
      // working-changes list reflects reality without the user having
      // to click Refresh.  We read the vault path lazily (via
      // getState()) instead of subscribing — the editor store has no
      // business re-rendering on vault changes.  The VCS store
      // debounces (~250ms), so a flurry of saves coalesces into one
      // git status walk.  Skip when no vault is open or when we're on
      // the mock-vault sentinel (no real filesystem to scan).
      const vaultPath = useVaultStore.getState().vaultPath;
      if (vaultPath) {
        void useVcsStore.getState().refresh(vaultPath);
      }
      window.dispatchEvent(new CustomEvent("lattice-tasks-changed"));
    } catch (err) {
      console.error("Failed to save file:", err);
    }
  },

  markDirty: (path) =>
    set((state) => {
      const next = new Set(state.dirtyFiles);
      next.add(path);
      return { dirtyFiles: next };
    }),

  markClean: (path) =>
    set((state) => {
      const next = new Set(state.dirtyFiles);
      next.delete(path);
      return { dirtyFiles: next };
    }),

  getContent: (path) => get().fileContents[path],

  isDirty: (path) => get().dirtyFiles.has(path),
}));
