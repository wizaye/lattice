import type { FileNode } from "./types";

/**
 * The sentinel "file id" for the GraphView virtual tab. EditorArea
 * checks `activeTab.fileId === GRAPH_TAB_FILE_ID` to decide whether
 * to render GraphView instead of a markdown / canvas editor.
 */
export const GRAPH_TAB_FILE_ID = "__graph__";

/**
 * The sentinel "file id" for the KanbanView virtual tab. EditorArea
 * checks `activeTab.fileId === KANBAN_TAB_FILE_ID` to render the
 * full-pane Kanban board instead of a text editor.
 */
export const KANBAN_TAB_FILE_ID = "__kanban__";

/** Flatten the vault for fast id-based lookup. */
export function flattenVault(nodes: FileNode[]): Map<string, FileNode> {
  const out = new Map<string, FileNode>();
  const walk = (n: FileNode) => {
    out.set(n.id, n);
    n.children?.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}
