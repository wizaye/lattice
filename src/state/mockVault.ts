import type { FileNode } from "./types";

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
