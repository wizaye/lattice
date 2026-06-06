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
 *  - `"graph"`:  virtual entry that opens the GraphView when clicked.
 *                Has no on-disk file — purely a sidebar shortcut to
 *                the force-directed wiki-link graph. `content` is
 *                ignored. Stored in the vault so the FileTree can
 *                render it like any other row.
 *
 * Anything that needs to know "is this an openable leaf?" should
 * check `kind !== "folder"` rather than `kind === "file"` so canvas
 * and graph entries don't get filtered out.
 */
export type FileNode = {
  id: string;
  name: string;
  kind: "file" | "folder" | "canvas" | "graph";
  children?: FileNode[];
  /** Raw file body. Markdown for `"file"`, JSON for `"canvas"`. */
  content?: string;
};

export type Tab = {
  id: string;
  /** id of the file in the vault, or null for an empty "New tab". */
  fileId: string | null;
  title: string;
  /**
   * Per-tab view mode for markdown files. `"source"` shows the
   * CodeMirror editor; `"preview"` (reading mode) shows the rendered
   * HTML via `MarkdownPreview`. Defaults to `"source"` when undefined
   * so existing serialized layouts keep working unchanged.
   */
  viewMode?: "source" | "preview";
  /**
   * When `true` the tab is pinned: the X button is replaced with a
   * pin icon, "Close all" / "Close others" skip it, and pinned tabs
   * sort to the left of unpinned ones. Mirrors Obsidian behaviour.
   * Undefined ≡ false so older serialized layouts keep working.
   */
  isPinned?: boolean;
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
