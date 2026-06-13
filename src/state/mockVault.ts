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

// ── Demo content ──────────────────────────────────────────────────────────

export const DEMO_NOTE_ID = "__demo__";
export const DEMO_KANBAN_ID = "__kanban_demo__";

export const DEMO_NOTE_CONTENT = `# Welcome to Lattice

Your second brain — local-first, markdown-native. This note shows everything the editor can render.

## Text Formatting

Write in **bold**, *italic*, ~~strikethrough~~, or combine ***bold italic***. Inline \`code\` is monospace with a subtle highlight. You can [[wikilink]] to any note or link to [external URLs](https://obsidian.md).

## Code Block

\`\`\`typescript
interface Note {
  id: string;
  title: string;
  content: string;
  tags: string[];
}

function createNote(title: string): Note {
  return {
    id: crypto.randomUUID(),
    title,
    content: "",
    tags: [],
  };
}
\`\`\`

## Mermaid Diagram

\`\`\`mermaid
graph TD
  A[User opens note] --> B{Has content?}
  B -->|Yes| C[Render preview]
  B -->|No| D[Show empty state]
  C --> E[Display in pane]
  D --> E
  E --> F[User edits]
  F --> A
\`\`\`

## Blockquote

> The best tool is the one you actually use.
> A PKM system works when it captures your thoughts
> with as little friction as possible.

## Table

| Feature | Status | Notes |
|---------|--------|-------|
| Editor | ✅ Live | CodeMirror 6 |
| Preview | ✅ Live | markdown-it |
| Graph | ✅ Live | force-graph |
| Kanban | ✅ Live | Native markdown |
| Slides | ✅ Live | Reveal.js |
| Sync | 🔧 Beta | GitHub + Drive |

## Task List

- [x] Set up the editor
- [x] Add reading mode
- [/] Build Kanban board
- [ ] Publish first vault
- [ ] Add AI suggestions

## Nested Lists

1. Plan the note
   - Write outline
   - Add headings
   - Fill in content
2. Review and edit
   - Check links work
   - Fix formatting
3. Publish or sync

---

You can switch between **Source** and **Reading** mode using the book icon above. Try clicking the [[Welcome to Lattice|wikilink]] — it opens this same note.
`;

export const DEMO_KANBAN_CONTENT = `---
kanban-plugin: basic
---

## 📥 Backlog

- [ ] Implement full-text search across vault
- [ ] Add calendar heatmap for activity
- [ ] Dark/light theme auto-follow OS
- [ ] Command palette (Ctrl+P)

## 🔧 In Progress

- [ ] Fix CodeMirror formatting in all themes
- [ ] Add Mermaid diagram rendering
- [ ] Obsidian-style Kanban board

## 👀 Review

- [ ] Reading mode polish pass
- [ ] PDF export dialog

## ✅ Done

- [x] CodeMirror 6 editor setup
- [x] Force-directed graph view
- [x] GitHub BYOC sync
- [x] Reveal.js slides view
- [x] Split-pane editor

%% kanban:settings
\`\`\`
{"kanban-plugin":"basic"}
\`\`\`
%%
`;

export const DEMO_VAULT_NODES: FileNode[] = [
  {
    id: DEMO_NOTE_ID,
    name: "Welcome to Lattice.md",
    kind: "file",
    content: DEMO_NOTE_CONTENT,
  },
  {
    id: DEMO_KANBAN_ID,
    name: "Project Kanban.md",
    kind: "file",
    content: DEMO_KANBAN_CONTENT,
  },
  {
    id: "__mock__/trash",
    name: "trash",
    kind: "folder",
    children: [],
  },
];
