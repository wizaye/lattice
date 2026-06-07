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
  // ── Demo: KaTeX math rendering in reading mode ─────────────────────
  // Showcases inline (`$E=mc^2$`) and display (`$$ ... $$`) syntax,
  // including a few tricky constructs (matrices, integrals, aligned
  // environments) so visual regressions in KaTeX upgrades are easy
  // to spot. Pure markdown — no special tab handling needed.
  {
    id: "file-math-demo",
    name: "Math Demo.md",
    kind: "file",
    content: `# Math Demo

Inline math: Einstein's famous $E = mc^2$, the Euler identity $e^{i\\pi} + 1 = 0$, and a quick fraction $\\tfrac{1}{2}$.

## Display

A Gaussian integral:

$$
\\int_{-\\infty}^{\\infty} e^{-x^{2}}\\,dx = \\sqrt{\\pi}
$$

A simple matrix:

$$
\\begin{bmatrix}
  a & b \\\\
  c & d
\\end{bmatrix}
\\cdot
\\begin{bmatrix} x \\\\ y \\end{bmatrix}
=
\\begin{bmatrix} ax + by \\\\ cx + dy \\end{bmatrix}
$$

Aligned equations:

$$
\\begin{aligned}
  (a+b)^2 &= a^2 + 2ab + b^2 \\\\
  (a-b)^2 &= a^2 - 2ab + b^2
\\end{aligned}
$$

Hover this link with Ctrl held: [[Slides Demo]] — the popover renders math too.
`,
  },
  // ── Demo: Reveal.js slides view ────────────────────────────────────
  // Demonstrates horizontal slides (`---` on its own line), vertical
  // sub-slides (`--`), code blocks (which must NOT trigger slide
  // splits even when they contain `---`), and KaTeX inside slides.
  // To see this, open the note then use the doc-header's More menu
  // (⋯) → Slides view.
  {
    id: "file-slides-demo",
    name: "Slides Demo.md",
    kind: "file",
    content: `# Welcome

Slides view powered by **Reveal.js**.

Open the **⋯** menu in the doc header and pick *Slides view*.

---

## How it works

- \`---\` on its own line  →  new horizontal slide
- \`--\` on its own line  →  vertical sub-slide
- Code fences are safe — \`---\` inside a fence does NOT split

---

## Vertical example

Press ↓ to step down into nested slides.

--

### Sub-slide A

This is a vertical sub-slide. ↑/↓ to navigate.

--

### Sub-slide B

Another sub-slide.

---

## Math works too

Inline: $E = mc^2$.

Display:

$$
\\int_0^{\\infty} e^{-x^{2}}\\,dx = \\frac{\\sqrt{\\pi}}{2}
$$

---

## Code blocks

\`\`\`ts
// The triple-dash below would NOT be treated as a slide break
// because we track fence state line-by-line.
const banner = "---";
\`\`\`

---

## That's it

Press **F** for fullscreen, **?** for keyboard shortcuts.
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
