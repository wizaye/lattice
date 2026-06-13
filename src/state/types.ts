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
 *  - `"pdf"`:    binary PDF.  `content` is either a base64-encoded
 *                string (mock vault) or empty (real vault — `id` is
 *                the absolute path and `PdfView` reads bytes via the
 *                `read_file_bytes` Tauri command).  Routing in
 *                `EditorArea` short-circuits to `PdfView`; the
 *                CodeMirror text path would corrupt binary content.
 *  - `"graph"`:  virtual entry that opens the GraphView when clicked.
 *                Has no on-disk file — purely a sidebar shortcut to
 *                the force-directed wiki-link graph. `content` is
 *                ignored. Stored in the vault so the FileTree can
 *                render it like any other row.
 *
 * Anything that needs to know "is this an openable leaf?" should
 * check `kind !== "folder"` rather than `kind === "file"` so canvas,
 * pdf, and graph entries don't get filtered out.
 *
 * Anything that does markdown-specific work (backlinks, wikilink
 * scanning, metrics) MUST gate on `kind === "file"` so it never
 * accidentally walks a `.canvas` JSON blob or a base64 PDF.
 */
export type FileNode = {
  id: string;
  name: string;
  kind: "file" | "folder" | "canvas" | "pdf" | "graph";
  children?: FileNode[];
  /**
   * Raw file body.
   *  - markdown for `"file"`
   *  - JSON for `"canvas"`
   *  - base64 string for `"pdf"` (mock vault only; real PDFs are read
   *    on demand from disk by `PdfView` using the absolute path `id`).
   */
  content?: string;
};

export type Tab = {
  id: string;
  /** id of the file in the vault, or null for an empty "New tab". */
  fileId: string | null;
  title: string;
  /**
   * Per-tab view mode for markdown files.
   *  - `"source"`  → CodeMirror editor
   *  - `"preview"` → `MarkdownPreview` reading mode (markdown-it +
   *                  KaTeX via markdown-it-texmath)
   *  - `"slides"`  → `SlidesView` (Reveal.js) — treats `---` lines as
   *                  horizontal slide breaks and `--` as vertical
   *                  ones, exactly like Reveal's own markdown plugin.
   * Defaults to `"source"` when undefined so existing serialized
   * layouts keep working unchanged.
   */
  viewMode?: "source" | "preview" | "slides";
  /**
   * Pinned tabs survive "close others" / middle-click-close and show
   * a pin icon in place of the × button. Optional so older serialized
   * layouts (and freshly opened tabs) stay unpinned by default.
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
