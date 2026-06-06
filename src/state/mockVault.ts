import type { FileNode } from "./types";

// A small starter canvas so the user has something to look at the
// moment they click `Project Map.canvas` in the file tree. The shape
// is the JSON Canvas 1.0 format (https://jsoncanvas.org/spec/1.0/)
// serialized as a string — exactly how Obsidian writes `.canvas` files
// to disk, so this content round-trips between editors.
const SAMPLE_CANVAS = JSON.stringify(
  {
    nodes: [
      {
        id: "n-1",
        type: "text",
        x: -260,
        y: -160,
        width: 240,
        height: 90,
        text: "# Project Map\n\nDouble-click anywhere to add a card.",
        color: "6",
      },
      {
        id: "n-2",
        type: "text",
        x: 80,
        y: -180,
        width: 220,
        height: 80,
        text: "**Ideas**\n- shipping flow\n- onboarding",
      },
      {
        id: "n-3",
        type: "text",
        x: 80,
        y: -40,
        width: 220,
        height: 80,
        text: "**Open questions**\nWhere do canvases live?",
        color: "3",
      },
      {
        id: "n-4",
        type: "text",
        x: 80,
        y: 100,
        width: 220,
        height: 80,
        text: "**Done**\n- sidebar polish",
        color: "4",
      },
    ],
    edges: [
      { id: "e-1", fromNode: "n-1", fromSide: "right", toNode: "n-2", toSide: "left", toEnd: "arrow" },
      { id: "e-2", fromNode: "n-1", fromSide: "right", toNode: "n-3", toSide: "left", toEnd: "arrow" },
      { id: "e-3", fromNode: "n-1", fromSide: "right", toNode: "n-4", toSide: "left", toEnd: "arrow" },
    ],
  },
  null,
  "\t",
);

export const VAULT_NAME = "StressVault";

/**
 * The sentinel "file id" for the GraphView virtual tab. EditorArea
 * checks `activeTab.fileId === GRAPH_TAB_FILE_ID` to decide whether
 * to render GraphView instead of a markdown / canvas editor.
 *
 * Kept in sync with the literal used in EditorArea.tsx and App.tsx —
 * if you change one, change them all. (We keep the literal in those
 * files for readability instead of importing this constant
 * everywhere.)
 */
export const GRAPH_TAB_FILE_ID = "__graph__";

// ── Synthetic stress vault ─────────────────────────────────────────
// Five topical folders, twelve notes each (60 total), with each note
// linking to its three folder-mates and the first note of each folder
// linking to the next folder's hub. This produces a graph with five
// tight clusters connected by sparse "ambassador" edges — much more
// interesting than a handful of demo notes, and it surfaces force-
// graph bugs (sizing, focus, drag, wand re-grow) that only manifest
// on larger networks.
const TOPICS = ["ai", "arch", "web", "devops", "design"] as const;
const NOTES_PER_TOPIC = 12;

function buildStressNotes(): { tree: FileNode[]; nodes: FileNode[] } {
  const folders: FileNode[] = [];
  const allNotes: FileNode[] = [];
  TOPICS.forEach((topic, ti) => {
    const children: FileNode[] = [];
    for (let i = 0; i < NOTES_PER_TOPIC; i++) {
      const name = `${topic}-note-${i + 1}`;
      // 3 intra-cluster wikilinks: next, +2, +3 (mod 12). Gives every
      // node in-cluster degree ≥ 3 so the cluster stays connected.
      const links: string[] = [];
      for (let k = 1; k <= 3; k++) {
        const j = (i + k) % NOTES_PER_TOPIC;
        links.push(`[[${topic}-note-${j + 1}]]`);
      }
      // Inter-cluster ambassador: first note of each folder also
      // links to the first note of the next folder, so the five
      // clusters form a loop in the graph.
      if (i === 0) {
        const next = TOPICS[(ti + 1) % TOPICS.length];
        links.push(`[[${next}-note-1]]`);
      }
      const content = `# ${name}\n\nRelated: ${links.join(" \u00b7 ")}\n`;
      children.push({
        id: `mk-${name}`,
        name: `${name}.md`,
        kind: "file",
        content,
      });
    }
    folders.push({
      id: `mk-folder-${topic}`,
      name: topic,
      kind: "folder",
      children,
    });
    allNotes.push(...children);
  });
  return { tree: folders, nodes: allNotes };
}

const { tree: STRESS_TREE } = buildStressNotes();

export const initialVault: FileNode[] = [
  // Hard-coded graph entry pinned at the top of the file tree. It is
  // NOT a real file — clicking it routes to the GraphView virtual tab
  // (see `openFile` in App.tsx, which special-cases `kind === "graph"`).
  // Living in the vault means the user has a visible, clickable entry
  // point for the force-directed graph without needing the activity-
  // strip button. The id matches the GraphView tab's `fileId` so the
  // FileTree's "is the active tab this node?" highlight works.
  {
    id: GRAPH_TAB_FILE_ID,
    name: "Graph View",
    kind: "graph",
  },
  // The synthetic 60-note network — five folders of twelve notes each,
  // wired via [[wikilinks]] to produce a multi-cluster graph that
  // exercises every interaction (drag-focus, click-focus, wand re-
  // grow, zoom/pan). The starter canvas remains available so the
  // canvas editor still has something to open.
  ...STRESS_TREE,
  {
    id: "file-project-map-canvas",
    name: "Project Map.canvas",
    kind: "canvas",
    content: SAMPLE_CANVAS,
  },
];

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
