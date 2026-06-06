# Lattice — Implementation Plan (Final)

## Goal

Build a high‑performance, 100% open‑source, local‑first PKM workspace that bridges **Obsidian** (data ownership, graph, markdown) and **Notion** (databases, collaboration, polish). Ships natively on **macOS & Windows** via Tauri 2.0 and as a static web app on Vercel.

---

## Finalized Technology Stack

| Layer | Component | Technology | Role |
|---|---|---|---|
| Runtime & Shell | Host Environment | **Tauri 2.0** (Rust) | Native window management, IPC, multi-threaded system tasks |
| Frontend UI | Core Framework | **React 19 + TypeScript + Vite** | High-performance component rendering |
| State Mgmt | UI State | **Zustand** | Lightweight global store with slice subscriptions |
| Styling | UI Design | **TailwindCSS + shadcn/ui** | Premium glassmorphism dark-mode UI |
| Editor | Engine Core | **CodeMirror 6** | Markdown buffer, extension-driven block abstractions, DOM optimization |
| Canvas | Spatial Engine | **Excalidraw Core** | Open-source infinite whiteboard for mind mapping |
| Graph View | High-Speed Render | **Sigma.js + Graphology** | WebGL-driven rendering supporting 50K+ nodes |
| Graph Compute | Network Analytics | **petgraph** (Rust) | Memory-efficient community detection, Dijkstra, co-citations |
| Storage (Native) | File System & Index | **Rust std::fs + rusqlite + notify** | File tree watching, read-cache index |
| Storage (Web) | Sandboxed DB | **sqlite3-wasm + OPFS** | Synchronous file access in Web Workers |
| Collaboration | CRDT | **Automerge** (Rust + WASM) | Rust-native conflict-free merging; sync via BYOC cloud as binary diffs |
| CLI | Dev Terminal Tools | **clap + ratatui + indicatif** | Beautiful terminal dashboards, progress bars, colored output |
| Export | Document Assembly | **Typst** (WASM) | Client-side PDF rendering with academic templates |

> [!NOTE]
> **Why Automerge, not Yjs?**
>
> Automerge is **written in Rust**. It compiles directly into the same `crates/core` binary alongside petgraph, rusqlite, and the YAML parser — one language, one binary, one WASM bundle. Its sync protocol produces transport-agnostic binary diffs that can be stored as files and pushed to GitHub/Drive/Dropbox alongside Markdown files. **Zero WebSockets, zero WebRTC, zero signaling servers.** The BYOC cloud sync *is* the collaboration transport layer.

---

## Phased Technical Roadmap

### Phase 1: Core Architecture, Editor & Monorepo

**Goal:** A working Tauri app with a functional CodeMirror 6 Markdown editor that reads/writes local files.

#### 1.1 Monorepo Scaffold
- Initialize Tauri 2.0 project (React + TypeScript template).
- Create shared Rust crate at `crates/core/` with `wasm-bindgen` support.
- Add `automerge` as a dependency in `crates/core/Cargo.toml`.
- Configure `pnpm-workspace.yaml` for the frontend workspace.
- Configure Vite to bundle the WASM output for web builds.

#### 1.2 CodeMirror 6 Editor
- Install all required CodeMirror packages:
  - `@codemirror/state`, `@codemirror/view`, `@codemirror/commands`
  - `@codemirror/lang-markdown`, `@codemirror/language-data`
  - `@codemirror/language`, `@codemirror/autocomplete`
- Build `MarkdownEditor` component with:
  - Syntax highlighting for Markdown + fenced code blocks.
  - Vim/Emacs key bindings (optional, togglable).
  - YAML frontmatter parsing and inline preview.
  - Logseq-style outliner mode (bullet block folding).
  - Bidirectional `[[wikilink]]` detection and navigation.
- Theme the editor with a custom dark theme matching the app's glassmorphism palette.

#### 1.3 File System Layer (Native)
- Implement Tauri IPC commands in Rust:
  - `read_file`, `write_file`, `list_directory`, `watch_directory`.
- Use the `notify` crate for real-time file system watching.
- Build a React file-tree sidebar that renders the vault folder hierarchy.

#### 1.4 File System Layer (Web)
- Scaffold the OPFS abstraction layer in a Web Worker.
- Stub the same file API interface so the React UI works identically on both native and web.

#### Phase 1 Deliverable
> A Tauri desktop app opens a local folder as a "vault." The user can browse files in a sidebar, open Markdown files in a CodeMirror 6 editor, edit them, and save changes back to disk. The editor supports syntax highlighting, wikilinks, and YAML frontmatter.

---

### Phase 2: Local-First Storage, Bases & Automerge CRDT

**Goal:** Obsidian-style "Bases" (YAML-backed databases) and Automerge conflict-free document merging.

#### 2.1 Rust YAML Parser & SQLite Index
- Build an incremental YAML frontmatter parser in `crates/core/src/parser.rs`.
- On vault open, scan all `.md` files and index their frontmatter properties into a local SQLite database (via `rusqlite` on native, `sqlite3-wasm` + OPFS on web).
- Use the `notify` crate to incrementally update the index when files change.

#### 2.2 Bases Views (React Components)
- **Table View:** Editable data grid. Editing a cell writes the updated value back to the source `.md` file's YAML frontmatter.
- **Kanban View:** Columns grouped by a single-value property (e.g., `status: todo | doing | done`). Dragging a card updates the property.
- **Gallery/Card View:** Renders image attachments found in frontmatter or inline.
- **`.base` File Format:** A YAML config file specifying filters, sort rules, visible columns, and the active view type.

#### 2.3 Automerge Integration
- Each document's edit history is tracked as an `automerge::AutoCommit` document in Rust.
- On every save, the Automerge document is serialized to a `.crdt` binary file stored alongside the `.md` file in the vault (e.g., `.Lattice/crdt/my-note.crdt`).
- Bind Automerge to the CodeMirror 6 editor via `@automerge/automerge-codemirror` on the frontend.
- When BYOC sync pulls changes, load both the local and remote `.crdt` files, call `automerge::merge()`, and the document resolves automatically — **no conflict dialogs needed for text**.

#### 2.4 Vercel Deployment Config
- Add `vercel.json` with `Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Opener-Policy: same-origin` headers for `SharedArrayBuffer` support.

#### Phase 2 Deliverable
> The user can create `.base` files that query their vault's YAML properties and display results as Tables, Kanbans, or Galleries. Every document edit is tracked by Automerge; syncing through any cloud provider merges changes automatically without conflicts.

---

### Phase 3: Graph Analytics & Infinite Canvas

**Goal:** "Stats for Nerds" graph analytics and a student-focused infinite canvas.

#### 3.1 Petgraph Integration (Rust)
- Build the note graph in `crates/core/src/graph.rs` using `petgraph`:
  - Nodes = notes (file paths).
  - Edges = `[[wikilinks]]`, tags, and shared YAML properties.
- Implement algorithms:
  - **Similarity:** Jaccard index over shared backlinks/tags.
  - **Co-Citations:** Find note clusters frequently referenced together.
  - **Community Detection:** Louvain or label propagation clustering.
  - **Shortest Path:** Dijkstra's algorithm for link prediction.
- Compile to WASM for browser execution.

#### 3.2 Sigma.js + Graphology Graph View
- Initialize a `Graphology` graph instance from the Rust-computed adjacency data.
- Render with `Sigma.js` using WebGL for GPU-accelerated visualization.
- Implement:
  - Node coloring by community/cluster.
  - Hover tooltips with note titles and link counts.
  - Click-to-navigate to the note in the editor.
  - Zoom-dependent label rendering.
  - Search/filter overlay to highlight specific nodes.

#### 3.3 Excalidraw Canvas
- Integrate `@excalidraw/excalidraw` (MIT license) for infinite whiteboard.
- Allow users to embed note references onto the canvas as linked cards.
- Persist canvas state as `.excalidraw` JSON files inside the vault.

#### Phase 3 Deliverable
> The user can open a graph view that renders their entire vault as an interactive WebGL graph. They can inspect analytics (communities, co-citations). Students can use the infinite canvas to visually arrange research notes.

### Detailed Plan for Graph View & Backlinking (Option 2 & Full Backlinks)

#### 1. Graph Engine Migration (`force-graph`)
- **Dependencies:** Remove raw `d3`. Install `force-graph` (the vanilla JS version by Vasco Asturiano to avoid React 19 peer dependency issues) to achieve out-of-the-box highly optimized Canvas WebGL rendering with built-in zoom, pan, hover, and drag.
- **Component Update:** Rewrite `GraphView.tsx` to instantiate `ForceGraph()` attached to a `div` ref. Map `VaultGraphData` to the required `{ nodes, links }` format. Configure `nodeCanvasObject` to render labels only at high zoom levels for performance.

#### 2. Advanced Backlinks Backend (Rust)
- **New Command:** Create `get_backlinks(vault_path, active_file_path)` in `src-tauri/src/commands.rs`.
- **Logic:** 
  - Read all `.md` files in the vault.
  - **Linked Mentions:** Search for `[[ActiveFileName]]` or `[[Folder/ActiveFileName]]`.
  - **Unlinked Mentions:** Search for the raw text `ActiveFileName` (ignoring case) not enclosed in `[[]]`.
  - **Context:** Extract the surrounding text (or the line) where the mention occurred to show a snippet.
- **Output:** Return a JSON payload grouping mentions into `linked` and `unlinked`, including the `source_path`, `snippet`, and `line_number`.

#### 3. Backlinks UI Overhaul
- **Component Update:** Update `Backlinks.tsx` to call `get_backlinks` instead of deriving links from the global graph.
- **UI Structure:** Create two collapsible sections:
  - **Linked mentions:** Showing the source file and the context snippet.
  - **Unlinked mentions:** Showing the source file and the context snippet.
- **Navigation:** Clicking a mention snippet navigates to the source file.

> [!IMPORTANT]
> **User Review Required:**
> Please review this plan! 
> 1. We will use the vanilla `force-graph` library as requested to get the buttery-smooth "Out-of-the-Box" masterpiece.
> 2. We will add a dedicated Rust command specifically to calculate both **Linked** and **Unlinked** mentions with context snippets (since calculating unlinked mentions globally for *all* files at once for the global graph would be too slow).
> Do you approve this approach?

---

### Phase 4: Microsoft Teams AI Integration

**Goal:** Automated meeting transcript ingestion and AI summary generation.

#### 4.1 OAuth 2.0 PKCE Flow
- Implement client-side Microsoft Entra ID authentication.
- Request scopes: `OnlineMeetings.Read`, `OnlineMeetingTranscript.Read.All`, `User.Read`, `Calendars.Read`.

#### 4.2 Graph API Client
- Fetch calendar events: `GET /me/calendar/events`.
- Fetch transcripts: `GET /me/onlineMeetings/{id}/transcripts/{id}/content`.
- Fetch AI insights: `GET /me/onlineMeetings/{id}/aiInsights`.

#### 4.3 Local Markdown Generation
- Parse Graph API JSON responses in Rust/WASM.
- Generate structured Markdown notes with:
  - YAML frontmatter (date, attendees, meeting title).
  - Conversation summary section.
  - Action items with `[[backlinks]]` to assignee notes.
- Write to vault via native FS or OPFS.

#### Phase 4 Deliverable
> A PM can authenticate their Microsoft account and automatically pull meeting transcripts and AI-generated summaries into their vault as structured Markdown notes.

---

### Phase 5: BYOC Sync, P2P Transfer & CLI

**Goal:** Cloud sync, peer-to-peer heavy file sharing, and a beautiful CLI.

#### 5.1 BYOC Cloud Sync
- Client-side OAuth PKCE flows for:
  - **GitHub:** Commit/push/pull `.md` files + `.crdt` Automerge binaries to a private repo via the GitHub REST API.
  - **Google Drive:** Folder sync via Drive API v3.
  - **iCloud:** CloudKit JS / native CloudKit framework.
  - **Dropbox:** Dropbox API v2 with chunked upload support.
- On sync pull, run `automerge::merge()` on local and remote `.crdt` files for automatic conflict resolution. For non-text files (images, PDFs), show a simple "keep local / keep remote / keep both" dialog.

#### 5.2 Iroh P2P Transfer
- Integrate `iroh-blobs` for direct peer-to-peer file sharing.
- QUIC protocol + BLAKE3 verified streaming.
- UDP hole-punching for NAT traversal.

#### 5.3 CLI Tool (`Lattice-cli`)
- Built with `clap` for argument parsing.
- `ratatui` for rich terminal UI dashboards (vault overview, graph stats).
- `indicatif` for beautiful progress bars during sync/export operations.
- Sub-commands:
  - `Lattice init` — Initialize a new vault.
  - `Lattice sync` — Push/pull to configured cloud provider.
  - `Lattice graph` — Print graph analytics to terminal.
  - `Lattice export` — Export notes to PDF via Typst.
  - `Lattice note add` — Create a new note from the terminal.

#### 5.4 Typst WASM Export
- Compile Typst to WASM for client-side PDF generation.
- Provide academic templates (IEEE, APA) for students.
- Render Markdown → Typst → PDF entirely offline.

#### Phase 5 Deliverable
> Users can sync their vault to GitHub/Google Drive/iCloud/Dropbox with automatic Automerge CRDT merging. Power users can manage their vault from a beautiful terminal CLI. Students can export notes as professionally formatted PDFs.

---

## Verification Plan

### Automated Tests
- `cargo test` — Rust parser, Automerge merge logic, graph algorithms, WASM bindings.
- `vitest` — React components (editor, bases views, graph panel).
- CI pipeline (GitHub Actions) building macOS + Windows artifacts.

### Manual Verification
- **Phase 1:** Open a vault, edit Markdown, verify file saves to disk.
- **Phase 2:** Create 10,000 dummy notes, verify Bases Table loads instantly. Edit same file from two synced locations, verify Automerge merges cleanly.
- **Phase 3:** Verify Sigma.js renders 50K nodes at 60fps.
- **Phase 4:** Authenticate MS account, pull a meeting transcript.
- **Phase 5:** Run `Lattice sync` and verify `.md` + `.crdt` files appear in GitHub repo.