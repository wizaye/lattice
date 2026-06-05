import { create } from "zustand";
import { readFile, writeFile } from "../lib/tauriApi";

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

    const content = await readFile(path);
    set((state) => ({
      fileContents: { ...state.fileContents, [path]: content },
    }));
    return content;
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
