// Shared types for the editor split-tree, tabs, and vault.

/**
 * A node in the mock vault.
 *
 * `kind`:
 *  - `"folder"`: contains `children`, no `content`.
 *  - `"file"`:   markdown file. `content` holds the raw `.md` body.
 *  - `"canvas"`: JSON Canvas file. `content` holds the serialized
 *                `.canvas` JSON (see {@link state/canvas}). Treated
 *                like a regular openable file everywhere except the
 *                metrics/backlinks code (which is markdown-only).
 *
 * Anything that needs to know "is this an openable leaf?" should
 * check `kind !== "folder"` rather than `kind === "file"` so canvas
 * files don't get filtered out.
 */
export type FileNode = {
  id: string;
  name: string;
  kind: "file" | "folder" | "canvas";
  children?: FileNode[];
  /** Raw file body. Markdown for `"file"`, JSON for `"canvas"`. */
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
