# Lattice — Current State (Living Doc)

> Companion to [impl.md](impl.md). That file is the **original** roadmap. This file is what is **actually shipping**, where we diverged, and why. Update it whenever a decision in `impl.md` is revised.

Last updated: 2026-06-06

---

## 1. TL;DR

| Area | impl.md goal | Reality today | Status |
|---|---|---|---|
| Shell | Tauri 2.0 | Tauri 2 + WebView2 on Windows, native window controls | ✅ Shipping |
| UI framework | React 19 + TS + Vite | Same, Bun runtime instead of pnpm | ✅ Shipping |
| State | Zustand | Same, two slices (`vaultStore`, `editorStore`) | ✅ Shipping |
| Styling | Tailwind + shadcn/ui | Hand-rolled CSS + CSS custom-property design tokens | 🔁 Switched (see §3.1) |
| Editor | CodeMirror 6 | CodeMirror 6 + custom dark/light themes, wikilink decoration, reading mode | ✅ Shipping |
| Canvas | Excalidraw Core | Custom Canvas2D/DOM engine reading JSON Canvas 1.0 | 🔁 Switched (see §3.2) |
| Graph | Sigma.js + Graphology + petgraph WASM | `force-graph` (vanilla) + Rust `get_vault_graph` | 🔁 Switched (see §3.3) |
| Indexer | SQLite + `notify` | In-memory Rust regex walk per command | 🔁 Deferred (see §3.4) |
| CRDT merge | Automerge | Not integrated | ⏸️ Deferred (see §3.5) |
| Bases (YAML DBs) | Table / Kanban / Gallery | Not started | ⏸️ Deferred |
| Backlinks | Linked + Unlinked w/ snippets | Rust backend done; **frontend still uses stub** | 🚧 In-progress (next milestone) |
| BYOC sync | OAuth PKCE per provider | Not started — planned as the first first-party plugin | ⏸️ Planned next (see §5) |
| Web clipper | Not in impl.md | Brave/Chrome MV3 extension → app receiver | ⏸️ Planned next (see §6) |
| MS Teams ingest | OAuth + Graph API | Not started | ⏸️ Deferred |
| Iroh P2P | iroh-blobs | Not started | ⏸️ Deferred |
| CLI | clap + ratatui + indicatif | Not started | ⏸️ Deferred |
| Typst PDF | WASM Typst | Not started | ⏸️ Deferred |

Legend: ✅ shipping · 🔁 changed from plan · 🚧 actively in-progress · ⏸️ on the backlog

---

## 2. What is actually built

### 2.1 Shell, chrome, window
- Custom Win11-style title bar (`src/components/layout/TopBar.tsx`) with stock hairline glyphs and draggable region; macOS hides the chrome and uses native traffic lights.
- Floating window-controls cluster (z-index 100) so it sits over either the right sidebar or the editor depending on collapse state.

### 2.2 Workspace layout
- Three columns: left activity strip + left sidebar, editor area, right sidebar. Each side resizable with full-height drag handles (`src/hooks/useDragResize.ts`).
- Left sidebar views: **Files**, **Search**, **Bookmarks**, plus header buttons (vault picker, new note, settings).
- Right sidebar views: **Backlinks**, **Outgoing links**, **Tags**, **Saved**, **Outline**.
- Bottom-right floating status pill (`src/components/layout/StatusPill.tsx`): backlinks count, word count, character count, edit-mode toggle, sync indicator (currently always red — "no sync configured").

### 2.3 Editor area
- Split tree (`src/state/splitTree.ts`) supports arbitrary horizontal/vertical splits, tab drag-drop between leaves, drop-edge previews.
- Tabs: per-tab `viewMode: "source" | "preview"`. Dirty tabs gate the close animation so the "Save / Don't save" dialog appears before the slide-out plays.
- Per-doctype "more" menus (`DocMoreMenu` for markdown, `GraphMoreMenu` for the graph tab; canvas tab uses its own toolbar).
- CodeMirror 6 (`src/components/editor/CodeMirrorEditor.tsx`):
  - Two custom themes synced to the `<html data-theme>` attribute.
  - `MatchDecorator` for `[[wikilink]]` highlight and `lattice-open-wikilink` CustomEvent dispatch.
  - Recreated only on `[filePath, isDark]` — content updates through a separate effect, gated so external syncs don't overwrite an in-progress edit.
- Reading mode (`MarkdownPreview.tsx`) via `markdown-it@14`; same wikilink dispatch path as the source editor.

### 2.4 Canvas
- Custom `CanvasView.tsx` renders text/shape/draw/group nodes and edges per the [JSON Canvas 1.0 spec](https://jsoncanvas.org/spec/1.0/). Files saved as `.canvas` work in Obsidian and vice versa.
- Native non-passive `wheel` listener (React 19's passive `onWheel` can't `preventDefault`).

### 2.5 Graph view
- `GraphView.tsx` (chrome + data) + `GraphCanvas.tsx` (isolated `force-graph` instance). Split was necessary so outer HMR / state changes don't tear down the d3 simulation.
- Data source:
  - Real vault → Rust `get_vault_graph` (regex walk).
  - Mock vault (`vaultPath === "__mock__"`) → in-memory regex over `flatVault`.
- Focus mode: two-pass composite blur via `onRenderFramePre` (off-screen canvas → single `ctx.filter = "blur(3px)"` drawImage) gives the Obsidian "soft cloud" look that per-shape `ctx.filter` can't.
- Wand button reseeds layout with `growLayout()` BFS animation; gear button opens a settings panel (Filters / Groups / Display / Forces).
- WebView2 quirk fix: `touch-action: none` + `overscroll-behavior: contain` on the canvas + host — without this Chromium swallows trackpad gestures before JS sees them.

### 2.6 File tree
- Full CRUD on disk through Tauri commands: `create_file`, `create_folder`, `rename_entry`, `delete_file`, `delete_folder`.
- Drag-drop: drop on a folder moves into it; drop on a file moves into that file's parent.
- Drag ghost positioned at `transform: translateX(-9999px)` (not negative `top`) so WebView2's snapshot doesn't fail back to the not-allowed cursor.

### 2.7 Mock vault & dev hooks
- Default vault is the synthetic `StressVault` (60 notes, 5 topic clusters, ambassador edges) so the graph and editor are populated even before a real folder is picked.
- `window.__lattice`, `window.__latticeGraphInst`, `window.__latticeApplySelection` exposed in DEV for Playwright/devtools work.

### 2.8 Backend (Rust)
Commands wired in [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs):

| Command | Purpose | Wired to UI? |
|---|---|---|
| `read_file`, `write_file` | I/O | ✅ |
| `list_directory` | Vault tree | ✅ |
| `create_file`, `create_folder` | New entries | ✅ |
| `rename_entry` | Rename + move | ✅ |
| `delete_file`, `delete_folder` | Delete | ✅ |
| `open_new_window` | New window action | ✅ |
| `get_vault_graph` | Build link graph | ✅ |
| `get_backlinks` | Linked + Unlinked + snippets | **❌ Not yet — see §4** |

---

## 3. Decision deltas vs `impl.md`

### 3.1 Styling — dropped Tailwind + shadcn/ui
**Plan:** Tailwind + shadcn/ui for "premium glassmorphism dark-mode UI."
**Reality:** Hand-rolled CSS modules + a CSS custom-property design system in [App.css](../src/App.css). Themes toggle via `<html data-theme="dark|light">`.
**Why we switched:**
1. Obsidian's aesthetic is information-dense, not glassmorphic — Tailwind's utility-first model fights against tight, custom rows of pill-shaped icons.
2. shadcn/ui copies Radix components into your codebase; we'd be modifying every primitive anyway, so we lose the upgrade benefit.
3. Our floating popup tokens (`--bg-menu`), syntax-highlighting tokens (`--syn-*`), canvas color resolver (`--canvas-*`), and graph-overlay tokens were easier to define once and reference from CodeMirror, force-graph, the canvas engine, and CSS — Tailwind classes don't reach into those non-DOM layers.
4. Build cost: a flat CSS + Vite pipeline keeps `bun run build` at ~1.1s. Tailwind's JIT + PostCSS would 2-3× that on cold builds.

### 3.2 Canvas — dropped Excalidraw Core
**Plan:** Excalidraw Core for infinite whiteboard.
**Reality:** Custom Canvas2D/DOM engine in [`src/components/canvas/CanvasView.tsx`](../src/components/canvas/CanvasView.tsx) that reads and writes the JSON Canvas 1.0 format directly.
**Why we switched:**
1. Excalidraw bundles its own React app and a sketch-style stroke engine — it's ~5 MB gzipped and has its own opinionated UI shell that we'd have to wrap or hide.
2. Excalidraw doesn't natively read Obsidian's `.canvas` files; we'd need a translation layer in both directions, which is most of the work anyway.
3. Scope alignment: we need rectangles, text cards, arrows, and freehand strokes — not a full diagramming app. The custom engine is ~1 file and matches the JSON Canvas spec exactly.

### 3.3 Graph view — switched to vanilla `force-graph`
**Plan:** Sigma.js + Graphology (WebGL, 50K nodes) + petgraph (Rust) for analytics.
**Reality:** `force-graph` (Vasco Asturiano, vanilla JS, Canvas2D).
**Why we switched:**
1. Sigma.js had React 19 peer-dep installation friction and the React wrapper (`@react-sigma/core`) hadn't caught up. The vanilla `force-graph` package mounts via a `div` ref and is React-version-agnostic.
2. Out-of-the-box gestures: pan, zoom, hover, drag, label LOD all work without writing a single d3 listener. Sigma needed bespoke listeners for each.
3. Performance budget: realistic Obsidian vaults are 1-5K notes. `force-graph` (Canvas2D) renders that range at 60fps with focus blur enabled. Sigma's WebGL advantage only matters past ~20K nodes — a milestone we'll cross later, not at MVP.
4. petgraph (community detection, Dijkstra, Jaccard) is **still on the roadmap** but isn't built. We deferred it because the user-facing graph UI (focus, blur, search, drag-to-pin) had to ship first; analytics get layered on once we have a Rust→WASM toolchain integrated.

### 3.4 Indexer — deferred SQLite + `notify`
**Plan:** Per-vault SQLite index of YAML frontmatter, watched by `notify`, queried by Bases views.
**Reality:** Both `get_vault_graph` and `get_backlinks` re-walk the vault per call.
**Why we switched:**
1. <10K-note vaults cold-walk in well under 100 ms on an SSD. We have no perf complaints at this size.
2. Bases (the consumer that actually needs the index) hasn't shipped yet, so we'd be optimizing for a feature without a UI.
3. Adding `notify` requires a Tauri capability + a long-lived watcher thread + IPC events — that's a real surface area we'd rather add at the same time as Bases so we only handle invalidation in one place.

**When to revisit:** As soon as we start the Bases work, OR as soon as a real-world vault crosses ~10K notes and a graph fetch exceeds 250 ms.

### 3.5 Automerge CRDT — deferred
**Plan:** Every save is an Automerge commit stored as `.crdt` next to the `.md`; cloud sync transports binary diffs.
**Reality:** Plain file overwrites; no merge layer.
**Why we switched:**
1. The BYOC sync milestone (§5) is the first place that benefits from CRDT. We'll integrate Automerge at the same time we ship sync, not before — otherwise we'd be writing `.crdt` files that nothing reads.
2. We're going to start with a **VCS-style commit log** (see §5.1), which is closer to git than to a CRDT. A commit log handles "I edited offline, you edited online" the same way git does — three-way merge with conflict markers. CRDT becomes a follow-up when we want real-time co-editing.

### 3.6 Lockfile / package manager — using Bun
- impl.md says pnpm; we use Bun (`bunfig.toml` with `backend = "copyfile"` to work around OneDrive corrupting hardlinks).

---

## 4. Backlinks — the immediate next milestone

The Rust backend is done. The frontend is the gap.

### What exists
- [`src-tauri/src/commands.rs`](../src-tauri/src/commands.rs) — `get_backlinks(vault_path, active_file_path)` walks the vault, returns `{linked: [], unlinked: []}` where each entry is `{source_path, source_name, snippet, line_number}`. Skips fenced code, ignores the active file itself, lowercases for unlinked matching, deduplicates linked vs unlinked on the same line.
- [`src/lib/tauriApi.ts`](../src/lib/tauriApi.ts) — `getBacklinks(vaultPath, activeFilePath)` wrapper + `BacklinksResult` / `BacklinkSnippet` types.
- [`src/components/layout/RightSidebar.tsx`](../src/components/layout/RightSidebar.tsx) — has a "Linked mentions" list and an "Unlinked mentions" section header, but only renders `fileName` (no snippet, no line number, no body) and is wired to the **in-memory** `collectBacklinks` in `App.tsx` (file-name match only).

### What's missing (concrete TODO)
1. **Wire the real backend**: in `App.tsx`, when `vaultPath !== "__mock__"`, call `getBacklinks(vaultPath, activeFile.id)` on `activeFile` change, debounced ~150 ms. Cache results keyed by `(vaultPath, activeFilePath)` so panel switches feel instant.
2. **Fallback for the mock vault**: extend `collectBacklinks` in `App.tsx` to also extract snippets + line numbers + unlinked mentions from `flatVault` so the dev experience matches the real-vault one. Same `{linked, unlinked}` shape.
3. **Render snippets**: in `RightSidebar.tsx`, replace the bullet list with a two-pane layout per Obsidian:
   - Group by source file (header = `source_name`, count).
   - Under each: list of snippets, each showing the trimmed line with the matched term highlighted, and a line-number prefix.
   - Click a snippet → resolve `source_path` to `fileId` via `flatVault`, dispatch `openFile`, scroll to line via a new `lattice-jump-to-line` CustomEvent the editor listens for.
4. **Empty / loading states**: spinner while the IPC is in flight, "No backlinks found" + "No unlinked mentions" when both arrays are empty.
5. **Counts**: update the status pill `backlinks` count to read from the new result (linked-only, matching Obsidian's behaviour).
6. **Collapsible sections**: native `<details>` so the user can hide the noisy unlinked-mentions list.

### Estimated touch list
- `src/App.tsx` — new `useEffect` for IPC fetch + cache, extend the mock-vault collector.
- `src/components/layout/RightSidebar.tsx` — render two grouped sections with snippets, click-to-open.
- `src/components/layout/RightSidebar.css` — section header / snippet / highlight styles.
- `src/components/editor/CodeMirrorEditor.tsx` — listen for `lattice-jump-to-line` and `view.dispatch({selection: EditorSelection.cursor(line.from), scrollIntoView: true})`.

---

## 5. BYOC sync plugin — the next major feature

> Goal: zero-account, zero-credential-sharing sync. The user authenticates **once** against their own provider (GitHub, Google Drive, OneDrive, Dropbox, iCloud); tokens stay in the OS keychain on their machine; Lattice never sees a username/password.

### 5.1 Local-VCS layer (the "git-style change graph")
This sits **under** any sync provider — it's the source of truth even offline.

- New crate-local module `src-tauri/src/vcs.rs` (no new top-level crate yet — keep the surface small).
- Storage: a `.lattice/` folder at the vault root, ignored by sync as `.lattice/local/`:
  - `commits.db` (SQLite) — append-only log: `(commit_id, parent_id, author, timestamp, message, ref)`.
  - `objects/<sha>` — content-addressed blob store (BLAKE3 of file body).
  - `refs/heads/main` — current HEAD pointer.
- Triggers:
  - Every `write_file` call wraps in a "stage" — on debounce (say 30 s of idle), auto-commit with message `Auto: <filename>` (configurable to manual-only).
  - Manual "Commit changes" command in the sidebar with a message box.
- Rust commands:
  - `vcs_status(vault_path)` → `{staged: [], modified: [], untracked: []}`.
  - `vcs_commit(vault_path, message)` → `{commit_id}`.
  - `vcs_log(vault_path, limit)` → `[{id, parent, msg, ts, files_changed}]`.
  - `vcs_diff(vault_path, commit_id, file_path)` → unified diff string.
  - `vcs_revert(vault_path, commit_id, file_path)` → restore that file's content from that commit.
- **Why not real libgit2?** Two reasons: (a) we want one binary format we control end-to-end so the BYOC providers all see the same shape, and (b) git's working-directory semantics fight with a vault that's already a folder of `.md` files the user edits directly. We borrow the *model* (DAG of commits, content-addressed blobs) without inheriting the index/staging-area complexity.

### 5.2 Frontend: Changes panel
- New left-sidebar view `LeftView = "files" | "search" | "bookmarks" | "changes"`.
- Renders the commit DAG as a vertical lane (one column for the active branch; sync provider branches as additional lanes once §5.3 lands).
- Each commit row: hash prefix, message, file-count badge, timestamp. Click → diff viewer (re-use `MarkdownPreview` or a CodeMirror in read-only `unified-diff` mode).
- "Uncommitted changes" pseudo-row at the top with a "Commit" button.

### 5.3 Provider adapters (the actual BYOC)
Each provider is a Rust module under `src-tauri/src/sync/`:

```text
sync/
  mod.rs          # SyncProvider trait
  github.rs       # commits + objects pushed as files in a private repo
  gdrive.rs       # same, in an app-folder via Drive v3
  onedrive.rs     # Microsoft Graph v1.0 /me/drive/special/approot
  dropbox.rs      # /Apps/Lattice/<vault> via Dropbox API v2
  icloud.rs       # CloudKit on macOS, deferred on Windows
```

Trait shape:
```rust
trait SyncProvider {
    async fn auth_start(&self, app: &AppHandle) -> Result<AuthUrl>;
    async fn auth_complete(&self, code: &str) -> Result<AccessToken>;
    async fn push_objects(&self, blobs: &[Blob]) -> Result<()>;
    async fn fetch_refs(&self) -> Result<Vec<RemoteRef>>;
    async fn fetch_objects(&self, ids: &[BlobId]) -> Result<Vec<Blob>>;
}
```

#### Auth — no credential sharing
- **OAuth 2.0 PKCE** for every provider that supports it (GitHub, Google, Microsoft, Dropbox).
- App opens the provider's authorize URL in the user's **system browser** via Tauri's `opener` plugin (already a dependency) — the user types their password into Google's own page, never into Lattice.
- The redirect lands on a one-shot loopback HTTP listener inside the app (`http://127.0.0.1:<random-port>/oauth-callback`) — same pattern as `gh auth login` and `gcloud auth login`.
- Tokens stored in OS keychain via [`keyring-rs`](https://crates.io/crates/keyring) (Windows Credential Manager, macOS Keychain, libsecret on Linux). **Never touch disk in plaintext.** Never sent anywhere outside the user's machine + the provider.
- For providers without PKCE (iCloud — Apple uses CloudKit JS web auth tokens), the macOS build uses the native CloudKit framework via a Swift sidecar; the Windows build hides the option.

#### Wire format
- Sync as a series of opaque blobs + a small metadata JSON per commit. The provider's storage is **dumb object storage**; all repo intelligence lives client-side.
- For GitHub specifically, we *could* use real git over the REST API — but that locks us into git's wire format. Sticking to "blobs in a folder named `objects/`, a JSON file at `refs/main.json`" works identically across all five providers.

### 5.4 Settings UI
- Settings → Sync section (`SettingsModal.tsx` already has the row, currently shows an "Obsidian Sync" placeholder — replace).
- Provider picker with status badges (connected ✓ / not connected). Connect/disconnect buttons trigger the OAuth flow.
- "Sync now" + "Auto-sync every N minutes" toggle. Mirrors the StatusPill sync-indicator state (red when no provider; green when synced; spinning when in flight; amber when conflict).

### 5.5 Conflict handling (v1)
- Three-way merge **for markdown only** using `diff3`-style markers inline (`<<<<<<<` / `=======` / `>>>>>>>`). User opens the file and resolves manually. Good enough for v1.
- Binary files (images, PDFs, `.canvas`): keep-local / keep-remote / keep-both modal.
- Automerge (per impl.md §2.3) is a v2 upgrade path — same `.crdt` sidecar idea, just layered on later once the BYOC sync pipeline is proven.

---

## 6. Web Clipper (browser extension)

> Goal: highlight content on any web page → click "Save to Lattice" → a Markdown note appears in the active vault's `Inbox/`.

### 6.1 Architecture
```text
Browser (Chrome / Brave / Edge) MV3 extension
   │
   │ 1. Content script extracts main content (Mozilla Readability)
   │ 2. Converts HTML → Markdown (Turndown)
   │ 3. Background worker calls fetch("http://127.0.0.1:<port>/clip", {body})
   ▼
Lattice (Tauri) — clipper-receiver Rust module
   │ 1. Localhost HTTP server bound to 127.0.0.1 only (never 0.0.0.0)
   │ 2. CORS allow-list = chrome-extension://<our-id>, moz-extension://...
   │ 3. Validates one-time pairing token from the extension settings
   │ 4. Writes <vault>/Inbox/<YYYY-MM-DD>-<slug>.md with frontmatter
   ▼
Vault file watcher picks up the new file, sidebar refreshes, optionally opens the new note
```

### 6.2 Extension repo layout (new sibling repo `lattice-clipper/`)
```text
manifest.json          # MV3, host_permissions: <all_urls>, optional permission for activeTab
src/
  background.ts        # MV3 service worker — receives extension messages, POSTs to localhost
  content.ts           # Injected on user click — runs Readability + Turndown
  popup/
    Popup.tsx          # Title preview, tag input, "Save to Lattice" button
    Pair.tsx           # First-run: paste pairing token from the desktop app
  options/
    Options.tsx        # Vault destination subfolder, "open after save" toggle, default tags
icons/
```

Dependencies (pinned, MIT/Apache):
- `@mozilla/readability` — main-content extraction.
- `turndown` + `turndown-plugin-gfm` — HTML → Markdown.
- Optional: `dompurify` if we ever inline rendered HTML elsewhere.

### 6.3 Pairing — no accounts, no cloud round-trip
- Desktop app generates a random 256-bit token on first clipper enable, displays a QR + base32 string in **Settings → Web clipper**.
- User pastes the token into the extension's first-run Pair screen.
- Extension stores it in `chrome.storage.local`; every request includes it in `Authorization: Bearer <token>`.
- Receiver compares constant-time. Token rotation: "regenerate token" button in settings invalidates the old one immediately.

### 6.4 Receiver — Tauri-side
- New Rust module `src-tauri/src/clipper.rs` using `axum` (or `tiny_http` if we want to stay zero-dep) bound to `127.0.0.1:<picked port>` only.
- One endpoint: `POST /clip`. Body:
  ```json
  { "url": "...", "title": "...", "markdown": "...", "tags": ["..."], "html": "<optional>" }
  ```
- Writes:
  ```markdown
  ---
  source: "https://..."
  clipped: 2026-06-06T12:34:56Z
  tags: [web, ...]
  ---
  # <title>
  
  <markdown body>
  ```
- Path: `<active vault>/Inbox/<YYYY-MM-DD>-<slug>.md` (created on demand).
- Errors → JSON `{ok: false, reason}`; success → `{ok: true, path}` for the extension to show a toast.

### 6.5 Security checklist
- Bind to `127.0.0.1` only — never `0.0.0.0`. Confirm no IPv6 wildcard.
- CORS allow-list of extension origins; reject everything else.
- Bearer token required on every request, constant-time compare.
- Rate limit: max 10 clips per minute per token.
- Content-length cap: refuse bodies > 5 MB.
- Settings → Web clipper has a master kill-switch that stops the receiver.

---

## 7. Other gaps worth tracking

Beyond backlinks, BYOC, and the clipper, these are the next-tier items pulled from `impl.md` that aren't started:

1. **Bases (YAML databases)** — Table / Kanban / Gallery views over `.base` files. Largest single piece of unstarted UI. Requires the SQLite indexer (§3.4).
2. **Command palette** (`Ctrl+P`) — Most-requested missing power-user feature. Driven off the same data we already have (vault flat map + a static action list).
3. **Quick switcher** (`Ctrl+O`) — Same data source, narrower scope; easy companion ship to the command palette.
4. **Search view** — Left sidebar already has a Search tab placeholder. Backend just needs a tokenized full-text walk; can re-use the regex pattern from `get_backlinks`.
5. **Tags panel → graph filter** — Clicking a tag in the right sidebar should subset the graph view. Trivial once both stores are talking.
6. **Outline view click-to-jump** — The headings list already renders; clicks aren't wired. Needs the same `lattice-jump-to-line` event the backlinks click-through will introduce.
7. **Daily notes / templates / file recovery** — In `CORE_PLUGIN_SECTIONS` in the settings modal as visible rows with empty bodies. Ship as a single "Productivity pack" once backlinks + BYOC are done.
8. **MS Teams transcript ingest** — impl.md Phase 4. Not started, blocked on nothing technical, just priority.
9. **Iroh P2P transfer** — impl.md Phase 5.2. Genuinely a v2 feature; BYOC covers the "sync between my devices" story for most users.
10. **CLI tool** — impl.md Phase 5.3. Ship once we have a stable `vcs_*` + `sync_*` command surface to call from Rust.
11. **Typst PDF export** — impl.md Phase 5.4. Niche but desirable for the student persona.
12. **Real Automerge integration** — see §3.5. Plug in once BYOC v1 has shipped and we want real-time co-editing.

---

## 8. Recommended next-step order

1. **Backlinks render (§4)** — finish the work the Rust side already supports; this is the cheapest, highest-visibility win and the one referenced in `impl.md` §3 "Detailed Plan for Graph View & Backlinking."
2. **Command palette + Quick switcher** — low effort, unlocks every other feature's discoverability and gives BYOC and the clipper real entry points.
3. **Local VCS layer (§5.1) + Changes panel (§5.2)** — ship the offline half of BYOC first; even with no remote, the commit log + revert + diff is a valuable "page history" feature on its own.
4. **First BYOC provider — GitHub (§5.3 GitHub adapter only)** — single provider end-to-end (PKCE, keychain, push/pull, conflict UI) before fanning out to the other four. GitHub is easiest because its OAuth + REST API is the best-documented.
5. **Web Clipper (§6)** — independent of everything above; can be developed in parallel by a second contributor. Ship the desktop receiver first so the extension has something to talk to during local testing.
6. **Remaining BYOC providers (Drive, OneDrive, Dropbox, iCloud)** — each one is mostly a new file in `src-tauri/src/sync/` plus a settings-modal row, once the trait is stable.
7. **Bases + SQLite indexer (§3.4)** — start the bigger lift once the BYOC milestone is stable.

Everything from §7 §8 onward (Automerge, Iroh, CLI, Typst, Teams) is a v2 conversation.
