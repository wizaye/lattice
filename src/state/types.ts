// Shared types for the editor split-tree, tabs, and vault.

export type FileNode = {
  id: string;
  name: string;
  kind: "file" | "folder";
  children?: FileNode[];
  /** Raw markdown content (mock) — only meaningful for files. */
  content?: string;
};

export type Tab = {
  id: string;
  /** id of the file in the vault, or null for an empty "New tab". */
  fileId: string | null;
  title: string;
};

/**
 * A node in the editor split-tree.
 *  - "leaf" holds a list of tabs (a pane).
 *  - "split" composes two children either horizontally or vertically.
 */
export type SplitTree =
  | {
      kind: "leaf";
      id: string;
      tabs: Tab[];
      activeTabId: string;
    }
  | {
      kind: "split";
      id: string;
      direction: "horizontal" | "vertical";
      /** Fraction of the first child's size in [0.05, 0.95]. */
      ratio: number;
      a: SplitTree;
      b: SplitTree;
    };

export type DropEdge = "left" | "right" | "top" | "bottom" | "center";
