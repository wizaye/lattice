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

export const VAULT_NAME = "Az-Cim";

export const initialVault: FileNode[] = [
  {
    id: "folder-clippings",
    name: "Clippings",
    kind: "folder",
    children: [
      {
        id: "file-clip-1",
        name: "Welcome to Lattice",
        kind: "file",
        content: `# Welcome to Lattice

A tiny **Obsidian-style** workspace built on Tauri + React.

- Drag files from the sidebar into the editor
- Drop a tab on the edge of a pane to split
- Resize the [[Oversubscriptions]] sidebars from either side
- Toggle the activity bar icons to collapse panels
- Open **Project Map.canvas** to try the new infinite canvas

Have a look at [[Rahul's 1 on 1]] for a sample note.`,
      },
    ],
  },
  {
    id: "file-oversubscriptions",
    name: "Oversubscriptions",
    kind: "file",
    content: `# Oversubscriptions

Notes on capacity planning and oversubscription strategy.

See also: [[Rahul's 1 on 1]]`,
  },
  {
    id: "file-rahul-1on1",
    name: "Rahul's 1 on 1",
    kind: "file",
    content: `# Rahul's 1 on 1

You can refer Oversubscriptions here - [[Oversubscriptions]]


RCM - external library which is no longer a part


[[DQos]]

[[ResourceCentralClient.cs]]
`,
  },
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
