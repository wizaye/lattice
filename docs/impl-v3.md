# Lattice — Implementation Plan v3

> **Companion docs (read first, in order)**
> - [`impl.md`](impl.md) — original Phase-1 roadmap. Still authoritative for "what core shell looks like."
> - [`current-state.md`](current-state.md) — what actually shipped vs `impl.md` and why we diverged.
> - [`impl-v2.md`](impl-v2.md) — calendar, journaling, plugins, BYOC, BYOM, CLI, default VCS, databases, academic bundle, onboarding, importers, E2EE. **Still authoritative for every feature it covers.**
> - [`byoc-plan.md`](byoc-plan.md), [`paper-export-plan.md`](paper-export-plan.md), [`publishing-plan.md`](publishing-plan.md), [`onboarding-journey.md`](onboarding-journey.md) — slice-specific design docs.
> - **This doc (`impl-v3.md`)** — the v3 plan: the architectural foundations and competitive-parity work that has to happen *underneath* every v2 slice before any of them ship at the quality bar set by ZenNotes / Obsidian / Logseq.

Last updated: 2026-06-10

---

## 0. Why v3 exists

`impl-v2.md` is correct about *what to build*. It is silent about *what shape the codebase has to be in for those features to ship without rewrites*. v3 fixes that silence.

The trigger was a side-by-side audit of [`zennotes/`](../../zennotes/README.md), which sits in the same workspace. ZenNotes is open-source, written by a small team, and already does:

- A proper vault layer with `inbox / quick / archive / trash / attachements / Daily Notes / .zennotes/` lifecycle, mtime+size metadata cache, sidecar comments, symlink-safe path joins, and 30+ domain-aware operations — vs Lattice's 12 generic FS verbs in [`src-tauri/src/commands.rs`](../src-tauri/src/commands.rs).
- A `ZenBridge` interface in `packages/bridge-contract/src/bridge.ts` that lets **one React app** drive desktop (Electron preload), browser (`fetch` against a Go server), **and the desktop shell itself talking to a remote ZenNotes server** — vs Lattice's components calling Tauri `invoke` directly. (Five deployment modes, not four — see §6.3.)
- A Go HTTP server in `apps/server/`, a `FROM scratch` Docker image, bearer-token + cookie session auth, rate limiters, **bootstrap auth token auto-generated on first `make up` and stored at `./data/auth-token`**, default port-bind to `127.0.0.1`, container runs as host UID/GID with read-only root + dropped Linux caps + `no-new-privileges` — vs Lattice being 100% desktop-only with no server, no PWA, no Docker.
- A 30+ command `zen` CLI (bundled via `ELECTRON_RUN_AS_NODE=1`) that the user installs from **Settings → CLI** (not from the installer); a 30+ tool stdio **MCP server** with one-click install/uninstall flows for **Claude Code, Claude Desktop, and Codex**; a **Raycast extension** that installs locally on macOS from the same Settings panel (no Raycast Store review); a `zennotes://` URI scheme; an **auto-updater**; **signed/notarized macOS builds**; AUR `zennotes-bin` PKGBUILD with FUSE-free AppImage extraction; and default-on **vim mode** with a configurable which-key overlay — vs Lattice having none of those.
- **At-rest encryption** as a real shipped feature (per `zennotes/docs/how-to/at-rest-encryption.md`), not a roadmap item — vs Lattice having E2EE deferred entirely to v4.
- A **pluggable text-search backend** with auto-detection of `ripgrep` and `fzf` plus user-overridable binary paths — vs Lattice's single-engine substring search.
- A documented **window/pane/tab model**: edit / preview / split modes, **pinned reference panes**, **detached note windows** (desktop), workspace layout restore on app open — vs Lattice having tabs only.
- **Diataxis docs structure** (`tutorials/` / `how-to/` / `reference/` / `explanation/`) — vs Lattice's flat `docs/` folder.
- Obsidian-vault-level fidelity: `[[Note]]`, `[[Note|alias]]`, `[[Note#heading]]`, `![[image.png]]` embeds resolved vault-wide, `> [!note]` callouts, YAML frontmatter as a compact properties widget, heading fold widgets, `primaryNotesLocation: root` mode for flat vaults, an explicit "drop your Obsidian vault in" path — vs Lattice supporting roughly the wikilink + alias subset and nothing else.

What ZenNotes *does not* have, and what Lattice already does or has planned, is the moat:

- Git-native VCS ([`src-tauri/src/git.rs`](../src-tauri/src/git.rs), ~1.2k LOC, real and shipping).
- JSON Canvas 1.0 read/write ([`src/components/canvas/CanvasView.tsx`](../src/components/canvas/CanvasView.tsx), ~2.6k LOC).
- Force-graph view with focus mode and reseed animation.
- A real academic-paper scaffolder ([`src-tauri/src/paper/`](../src-tauri/src/paper)) and Quartz publishing scaffold ([`src-tauri/src/publish/`](../src-tauri/src/publish)).
- BYOC-only sync philosophy (no Lattice server, tokens in OS keychain) — see [`byoc-plan.md`](byoc-plan.md).
- A v2 plan that already covers calendar (Outlook/Cal.com/Google), journaling, plugins, E2EE, databases — see [`impl-v2.md`](impl-v2.md).

**v3's north star:** keep every Lattice-unique slice in `impl-v2.md` intact, but rebuild the foundation underneath them so they can actually ship. Concretely:

1. Convert the repo to a monorepo with a `LatticeBridge` contract.
2. Replace the generic FS layer with a real vault crate that mirrors ZenNotes' verb surface, plus a `notify`-based file watcher and an mtime-debounced metadata cache.
3. Make Obsidian-vault compatibility a tier-1 promise (not a side effect).
4. Ship a Rust HTTP server + `FROM scratch` Docker image + browser PWA mode — three deploy targets from one binary.
5. Wire MCP first-class (the bootcamp is literally named `Camp_AIR_MCP_BOOTCAMP`).
6. Close the editor-extension gap (vim mode, command palette, slash commands, live preview, callouts, frontmatter widget, heading fold).
7. Ship Linux packaging (AUR, AppImage, Flatpak, deb/rpm) on day one of v3.
8. Build the `lattice` CLI that `impl-v2.md` §6 specifies, against the new vault crate.
9. Make the activity strip ([`src/components/layout/ActivityStrip.tsx`](../src/components/layout/ActivityStrip.tsx) lines 13–27) honest — five of its six entries say "(Coming soon)" today; v3 wires four of them.

Each of those is broken out below. The recommended **sequencing** is in §13.

---

## 1. What v3 explicitly does NOT change

To prevent scope drift, v3 takes the following from `impl-v2.md` and `byoc-plan.md`/`paper-export-plan.md`/`publishing-plan.md` **verbatim**:

| Area | Source of truth | v3 contribution |
|---|---|---|
| Calendar (Outlook/Teams, Cal.com, Google, Apple) | `impl-v2.md` §1 | None. v3 just makes sure §1's `src-tauri/src/calendar/` lives behind the bridge so it works in web mode later. |
| Journaling / daily notes | `impl-v2.md` §2 | v3 adds the daily-notes config slot to the vault settings file in §3. |
| Default VCS | `impl-v2.md` §4 | None — already shipping. v3 adds an MCP tool for it (§7). |
| Plugin system (WASM components) | `impl-v2.md` §5 | None for v3; deferred to v4. v3 only ships the bundled adapters (BYOC, BYOM, daily-notes) as in-tree crates. |
| BYOC (GitHub / Drive / OneDrive / Dropbox / WebDAV) | `byoc-plan.md` + `impl-v2.md` §5.2 | v3 implements GitHub adapter end-to-end (§9) and unblocks the rest. |
| BYOM (Ollama/OpenAI/Anthropic/Azure/HF) | `impl-v2.md` §5.3 | v3 adds the model-detection probe to onboarding step 7. |
| Databases | `impl-v2.md` §7 | None. Deferred to v4. |
| Paper export (Typst + Tectonic + BYOF) | `paper-export-plan.md` | None for v3; v3 only stops the `paper_compile` stub from blocking other UX. |
| Publishing (Quartz → GitHub Pages / Cloudflare / Netlify / Vercel) | `publishing-plan.md` | None for v3; same reason. |
| End-to-end encryption (`age` / `rage`) | `impl-v2.md` §9 | None for v3; deferred to v4 once BYOC ships. |
| Onboarding 9-step | `onboarding-journey.md` + `impl-v2.md` §10 | v3 makes steps 3 (vault, including "import existing Obsidian vault") and 7 (AI / Ollama probe) real. |

If a feature is listed above, do not rewrite it in v3; reference the source doc.

---

## 2. Repo reshape — monorepo + `LatticeBridge` contract

> **Why this is item one.** Every other v3 work-item depends on it. Today every React component in `src/components/**` reaches into [`src/lib/tauriApi.ts`](../src/lib/tauriApi.ts) and calls `invoke(...)`. The day we want a browser PWA mode (§5) or a remote-server mode, every component has to be rewritten. ZenNotes solved this on day one with `ZenBridge`; we are paying interest on the loan we did not take.

### 2.1 Target layout

```
lattice/                                  ← repo root, npm/bun workspace
├── package.json                          ← { "workspaces": ["packages/*", "apps/*"] }
├── tsconfig.base.json                    ← path aliases
├── turbo.json                            ← optional, parallel typecheck/test
│
├── apps/
│   ├── desktop/                          ← current Tauri shell, mostly unchanged
│   │   ├── src-tauri/                    ← moves from lattice/src-tauri/
│   │   ├── src/                          ← thin: bridge wiring + entry point
│   │   ├── index.html
│   │   └── vite.config.ts
│   │
│   ├── server/                           ← NEW — Rust HTTP/WebSocket server (§5)
│   │   ├── Cargo.toml
│   │   ├── src/main.rs                   ← axum + tower-cookies + axum-tungstenite
│   │   ├── src/api/                      ← route handlers
│   │   ├── src/auth/                     ← bearer + session + rate limit
│   │   ├── Dockerfile                    ← FROM scratch multi-stage
│   │   └── docker-compose.yml
│   │
│   └── web/                              ← NEW — browser PWA (§6)
│       ├── src/main.tsx                  ← imports @lattice/core, installs WebBridge or RemoteBridge
│       ├── public/manifest.webmanifest
│       ├── public/sw.ts                  ← service worker for offline
│       └── vite.config.ts
│
├── packages/
│   ├── lattice-bridge-contract/          ← NEW — the keystone
│   │   ├── src/bridge.ts                 ← interface LatticeBridge (§2.2)
│   │   ├── src/capabilities.ts           ← interface LatticeCapabilities
│   │   ├── src/ipc-types.ts              ← all DTOs (VaultInfo, NoteMeta, FolderEntry, …)
│   │   └── src/index.ts
│   │
│   ├── lattice-core/                     ← NEW — the React app, runtime-agnostic
│   │   ├── src/App.tsx                   ← moves from lattice/src/App.tsx
│   │   ├── src/components/               ← moves from lattice/src/components/
│   │   ├── src/state/                    ← moves from lattice/src/state/
│   │   ├── src/lib/                      ← moves from lattice/src/lib/ MINUS tauriApi.ts
│   │   ├── src/hooks/useBridge.ts        ← context-based bridge accessor
│   │   └── src/lib/bridge-mock.ts        ← in-memory bridge for vitest / Storybook
│   │
│   ├── lattice-bridge-tauri/             ← NEW — desktop bridge impl
│   │   └── src/index.ts                  ← class TauriBridge implements LatticeBridge { invoke(...) }
│   │
│   ├── lattice-bridge-web/               ← NEW — browser bridge impl (FS Access API + fetch)
│   │   ├── src/local.ts                  ← LocalWebBridge (File System Access API)
│   │   └── src/remote.ts                 ← RemoteBridge (fetch + WebSocket against apps/server)
│   │
│   └── lattice-vault-rs/                 ← NEW — Rust crate (§3); consumed by apps/desktop & apps/server
│       └── Cargo.toml
│
└── docs/                                 ← unchanged (this folder)
```

**Tooling notes:**
- Workspace package manager stays Bun (per `current-state.md` §3.6). `bun install` understands `workspaces` natively.
- Cargo workspace at repo root for `apps/desktop/src-tauri`, `apps/server`, and `packages/lattice-vault-rs`. New `Cargo.toml` at root with `[workspace] members = [...]`.
- Vite project per app (`apps/desktop`, `apps/web`) that share `packages/lattice-core` via TS path alias.

### 2.2 The `LatticeBridge` interface

`packages/lattice-bridge-contract/src/bridge.ts`:

```ts
export interface LatticeCapabilities {
  supportsNativeMenus: boolean;            // desktop only
  supportsFloatingWindows: boolean;        // desktop only
  supportsSystemFilePicker: boolean;       // desktop + Chromium FS Access API
  supportsRemoteWorkspace: boolean;        // web + desktop (against server)
  supportsCli: boolean;                    // desktop only (bundles `lattice` binary)
  supportsMcpServer: boolean;              // desktop only (sidecar)
  supportsBYOCKeychain: boolean;           // desktop only; web uses session storage
  supportsCanvas: boolean;                 // true everywhere
  supportsPdfViewer: boolean;              // true on desktop + Chromium web
}

export interface LatticeBridge {
  getCapabilities(): LatticeCapabilities;
  getAppInfo(): LatticeAppInfo;

  // Vault lifecycle
  pickVault(): Promise<VaultInfo | null>;
  openVault(root: string): Promise<VaultInfo>;
  closeVault(): Promise<void>;
  listLocalVaults(): Promise<LocalVaultEntry[]>;
  getVaultSettings(): Promise<VaultSettings>;
  setVaultSettings(next: VaultSettings): Promise<VaultSettings>;

  // Notes — 30+ methods mirroring lattice-vault-rs verbs (§3.3)
  listNotes(): Promise<NoteMeta[]>;
  readNote(rel: string): Promise<NoteContent>;
  writeNote(rel: string, body: string): Promise<NoteMeta>;
  createNote(folder: NoteFolder, title?: string, subpath?: string): Promise<NoteMeta>;
  renameNote(rel: string, nextTitle: string): Promise<NoteMeta>;
  moveNote(rel: string, target: NoteFolder, subpath: string): Promise<NoteMeta>;
  duplicateNote(rel: string): Promise<NoteMeta>;
  deleteNote(rel: string): Promise<void>;
  moveToTrash(rel: string): Promise<NoteMeta>;
  restoreFromTrash(rel: string): Promise<NoteMeta>;
  emptyTrash(): Promise<void>;
  archiveNote(rel: string): Promise<NoteMeta>;
  unarchiveNote(rel: string): Promise<NoteMeta>;

  // Folders / assets / comments / tasks / search …
  listFolders(): Promise<FolderEntry[]>;
  createFolder(folder: NoteFolder, subpath: string): Promise<void>;
  // … etc (full list in §3.3)

  // Watcher
  onVaultChange(cb: (e: VaultChangeEvent) => void): () => void;

  // VCS (already real — just routed through bridge)
  vcsStatus(): Promise<VcsStatus>;
  vcsCommit(message: string): Promise<string>;
  vcsLog(limit: number): Promise<CommitInfo[]>;
  // …

  // BYOC
  byocList(): Promise<ByocProvider[]>;
  byocConnect(provider: ByocProviderId): Promise<ByocSession>;
  byocSync(): Promise<ByocSyncReport>;

  // Paper / Publish (delegate to v2 slices; just routed)
  paperCreate(req: NewPaperRequest): Promise<NewPaperResult>;
  // …

  // Window control (desktop only — capability-gated)
  windowMinimize?(): void;
  windowToggleMaximize?(): void;
  windowClose?(): void;
  openNoteWindow?(rel: string): Promise<void>;
}
```

**Capability gating rule:** every component that calls a method only present on desktop guards it with `if (bridge.getCapabilities().supportsFloatingWindows) { … }`. The interface is union-typed; the implementations declare which capabilities they advertise.

### 2.3 Migration cookbook

The migration is mechanical, not creative. Per-file:

1. Replace `import { invoke } from '@tauri-apps/api/core'` with `import { useBridge } from '../hooks/useBridge'`.
2. Replace each `invoke('foo_bar', { … })` call with `bridge.fooBar({ … })`.
3. Where a feature is desktop-only (multi-window, native menus), wrap with the capability check.

Estimated touch-list: ~40 files (mostly under `src/components/layout/`, `src/components/editor/`, `src/state/`, plus `src/App.tsx`). Effort: 2–3 engineer-days once `LatticeBridge` is defined. **Do not start §3+ before §2 lands** — otherwise every new feature has to be migrated twice.

---

## 3. Real vault layer — `lattice-vault-rs`

> **Why this is item two.** Backlinks UI is stubbed because the backend re-walks disk on every call. Activity strip says "All files / Calendar / Kanban (Coming soon)" because there's no vault model. Onboarding step 3 is a `<Stub>` because there's no "import Obsidian vault" verb. Every one of those gates on a real vault crate.

### 3.1 Where the model comes from

The model in this section is the Rust translation of `zennotes/apps/server/internal/vault/{vault.go, types.go, parse.go, safepath.go, demo.go}` — augmented with Lattice-specific concerns (git VCS coexistence, JSON Canvas, paper roots).

### 3.2 On-disk layout

```
<vault root>/
├── inbox/                     ← active notes (primary if `primaryNotesLocation = inbox`)
├── quick/                     ← Quick Capture surface
├── archive/                   ← cold storage; still indexed, hidden from main lists
├── trash/                     ← soft-delete; restore + empty-trash gestures
├── attachements/              ← images, audio, video, pdf (ZenNotes-compatible spelling)
├── Daily Notes/               ← optional; configurable via VaultSettings.dailyNotes.dir
└── .lattice/
    ├── vault.json             ← VaultSettings (primaryNotesLocation, dailyNotes, folderLabels, folderIcons, …)
    ├── meta-cache-v1.json     ← { path → { mtimeMs, size, meta: NoteMeta } }; debounced persist 1s
    ├── comments/
    │   └── <posix path>.comments.json
    ├── templates/             ← user-defined templates (frontmatter + body)
    ├── git/                   ← existing --separate-git-dir target; unchanged
    ├── sync/                  ← BYOC manifest, cursors, conflict state (per byoc-plan.md)
    ├── paper.toml             ← per-vault paper defaults (per paper-export-plan.md)
    └── publish.toml           ← per-vault publish defaults (per publishing-plan.md)
```

**Compatibility notes:**
- Legacy attachment dirs `_assets/` and `assets/` are recognized read-only and surfaced under the same "Attachments" UI bucket, matching ZenNotes' behaviour. Writes go to `attachements/`.
- When the vault root contains top-level `.md` files or non-reserved folders, `primaryNotesLocation` auto-infers `root` ("Obsidian-style flat vault"). This is the rule from `zennotes/docs/reference/vault-and-folder-model.md`.
- **System-folder display labels are user-customizable** without changing internal ids. `inbox` can show as "Notes" in one user's UI and "Inbox" in another's; both vaults remain on-disk identical. Stored in `vault.json` as `folderLabels: { inbox: "…", quick: "…", archive: "…", trash: "…" }`. This matches ZenNotes' Settings → Vault behaviour and keeps the no-lock-in rule (§4.5) intact — the folder *name on disk* never changes.

### 3.3 Verb surface

`packages/lattice-vault-rs/src/lib.rs` exposes one struct `Vault` with this method set (each method is also a `#[tauri::command]` re-exported from `apps/desktop/src-tauri/src/vault_cmds.rs`):

```
list_notes()                              ⇒ Vec<NoteMeta>
list_folders()                            ⇒ Vec<FolderEntry>
list_assets()                             ⇒ Vec<AssetMeta>
read_note(rel)                            ⇒ NoteContent
write_note(rel, body)                     ⇒ NoteMeta
create_note(folder, title?, subpath?)     ⇒ NoteMeta
rename_note(rel, next_title)              ⇒ NoteMeta
delete_note(rel)                          ⇒ ()
move_to_trash(rel)                        ⇒ NoteMeta
restore_from_trash(rel)                   ⇒ NoteMeta
empty_trash()                             ⇒ ()
archive_note(rel)                         ⇒ NoteMeta
unarchive_note(rel)                       ⇒ NoteMeta
duplicate_note(rel)                       ⇒ NoteMeta
move_note(rel, target, subpath)           ⇒ NoteMeta
create_folder(folder, subpath)            ⇒ ()
rename_folder(folder, old, new)           ⇒ String
delete_folder(folder, subpath)            ⇒ ()
duplicate_folder(folder, subpath)         ⇒ String
scan_tasks()                              ⇒ Vec<Task>
scan_tasks_for_path(rel)                  ⇒ Vec<Task>
toggle_task(rel, task_id)                 ⇒ Task                ← MCP needs it; CLI needs it
search_text(query, backend?)              ⇒ Vec<TextSearchMatch> ← backend ∈ {Builtin, Ripgrep, Fzf, Auto}
search_capabilities()                     ⇒ SearchCapabilities   ← which backends are available on this host
import_asset(note_path, filename, bytes)  ⇒ ImportedAsset
get_settings()                            ⇒ VaultSettings
set_settings(next)                        ⇒ VaultSettings
read_note_comments(rel)                   ⇒ Vec<NoteComment>
write_note_comments(rel, comments)        ⇒ Vec<NoteComment>
generate_demo_tour()                      ⇒ DemoTourResult
remove_demo_tour()                        ⇒ DemoTourResult
```

Plus Lattice-specific:

```
get_backlinks(rel)                        ⇒ BacklinksResult       ← already real; promoted into crate
get_vault_graph()                         ⇒ VaultGraph            ← already real; promoted into crate
import_obsidian_vault(src_root, opts)     ⇒ ImportReport          ← NEW (§4.3)
```

### 3.4 Safe path joining

`packages/lattice-vault-rs/src/safe_path.rs`:

```rust
pub fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, SafePathError> {
    // 1. Lexical clean. Reject any component equal to ".."
    // 2. For each *existing* component, canonicalise (follows symlinks)
    //    and require the canonical path stay inside root's canonical form.
    // 3. Non-existing components are allowed (create-file case).
}
```

This is a direct port of `zennotes/apps/server/internal/vault/safepath.go`. Without it, a renderer-supplied path can read `C:\Windows\System32\config\sam` today. With the web server (§5) that becomes a CVE on day one.

### 3.5 File watcher

`packages/lattice-vault-rs/src/watcher.rs` wraps `notify = "8"`:

- Debounce window: 120 ms (same as ZenNotes' fsnotify settling).
- Coalesces add/change/remove into a `VaultChangeEvent { kind, rel, scope }` where `scope` is one of `""` (note), `"vault-settings"`, `"comments"`, `"asset"`.
- Pushes through a `tokio::sync::broadcast::channel` so multiple subscribers (Tauri IPC, MCP, WebSocket clients) all see the same stream.

This is what backlinks, graph view, file tree, status bar word count, and the Changes panel all need today — they currently re-poll because there's nothing to listen to.

### 3.6 Metadata cache

`packages/lattice-vault-rs/src/meta_cache.rs`:

```rust
pub struct MetaCache {
    inner: DashMap<String, MetaCacheEntry>,
}
pub struct MetaCacheEntry { pub mtime_ms: i64, pub size: u64, pub meta: NoteMeta }
```

- Invalidated by `WriteNote`, renames, deletes, folder ops, and watcher events.
- Persisted to `.lattice/meta-cache-v1.json` 1 s after `list_notes` (debounced).
- Rebuilt lazily on cache miss; `list_notes` runs reads concurrently with `tokio::task::JoinSet`.

### 3.7 Parse helpers (single-source-of-truth for wikilinks/embeds/tags)

`packages/lattice-vault-rs/src/parse.rs` is the canonical parser; the existing JS extractors in [`src/lib/backlinks.ts`](../src/lib/backlinks.ts) become a thin re-export of WASM bindings (or are dropped — the bridge returns parsed results).

```rust
static WIKILINK_RE: Lazy<Regex>   = Lazy::new(|| Regex::new(r"(!?)\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]").unwrap());
static EMBED_RE: Lazy<Regex>      = Lazy::new(|| Regex::new(r"!\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]").unwrap());
static TAG_RE: Lazy<Regex>        = Lazy::new(|| Regex::new(r"(?:^|\s)#([A-Za-z][\w\-/]*)").unwrap());
static FRONTMATTER_RE: Lazy<Regex>= Lazy::new(|| Regex::new(r"(?s)\A---\n(.*?)\n---\n?").unwrap());
static TASK_LINE_RE: Lazy<Regex>  = Lazy::new(|| Regex::new(r"^\s*-\s+\[(.)\]\s+(.*)$").unwrap());
static INLINE_DUE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"due:(\S+)").unwrap());
static INLINE_PRI_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"!(high|med|medium|low|h|m|l)").unwrap());
```

All extractors must skip fenced code blocks. The Rust version reuses [`current-state.md`](current-state.md) §2.8's fenced-block skip logic.

### 3.8 Concurrency model

- `Vault` itself holds a `RwLock<VaultInner>` so reads parallelise.
- Long-running scans (`scan_tasks`, `search_text`) run on `tokio::task::spawn_blocking` so they don't stall the Tauri event loop.
- The watcher and the cache communicate via channels; never share mutexes.

---

## 4. Obsidian compatibility as a tier-1 promise

> **Marketing line we want to be able to say:** *"Drop your Obsidian vault in Lattice. Every keystroke you already know works. You gain a real graph, a real canvas, git history, paper export, BYOC sync, and a CLI. No subscription."*

We can almost say it. The gap is short and concrete.

### 4.1 Compat truth table

| Obsidian feature | Today in Lattice | v3 target | Implementation pointer |
|---|---|---|---|
| `[[Note]]` wikilinks | ✅ | ✅ | already in [`commands.rs`](../src-tauri/src/commands.rs) — promoted to `lattice-vault-rs/src/parse.rs` |
| `[[Note\|alias]]` | ✅ | ✅ | same |
| `[[Note#heading]]` anchors | ❌ resolve only on alias | ✅ resolve + scroll-to-heading on open | `lattice-core/src/lib/wikilink-resolve.ts`, see ZenNotes `apps/desktop/src/main/vault.ts` `resolveLinkToPath` |
| `![[image.png]]` embeds | ❌ | ✅ rendered inline (preview + live-preview) | `lattice-core/src/components/editor/extensions/cm-embeds.ts` (port of `packages/app-core/src/lib/cm-live-preview.ts` `STANDALONE_OBSIDIAN_EMBED_RE`) |
| `#tag` hierarchical | ❌ | ✅ tag pane + completion + click-to-filter | `lattice-vault-rs/src/parse.rs::extract_tags` + new `TagPane.tsx` |
| Callouts `> [!note]` `> [!tip]` `> [!warning]` | ❌ | ✅ preview + live-preview | new `cm-callouts.ts` + CSS (`zennotes/packages/app-core/src/styles/index.css` line 2690 is the visual reference) |
| YAML frontmatter | ❌ rendered raw | ✅ compact "properties" widget | `cm-frontmatter.ts` (port from ZenNotes) |
| Heading fold (caret in gutter) | ❌ | ✅ | `cm-heading-fold.ts` (port from ZenNotes) |
| Daily Notes folder | ❌ | ✅ creates today's note; binds to calendar (`impl-v2.md` §1.5) | uses §3.2 `Daily Notes/` + `vault.json.dailyNotes` |
| `primaryNotesLocation: root` (flat vault) | ❌ | ✅ inferred from existing top-level `.md` | §3.2 |
| Open existing Obsidian vault | ❌ | ✅ explicit splash entry + step-3 "Import Obsidian vault" | §4.3 |
| Plugins / Dataview / Templater / Excalidraw | ❌ | ❌ (out of scope) | Lattice plugin system (`impl-v2.md` §5) is the long-term answer; **not in v3** |

### 4.2 Editor extension stack (concrete files)

All under `packages/lattice-core/src/components/editor/extensions/`:

```
cm-wikilinks.ts            ← already partially in CodeMirrorEditor.tsx; extract into proper extension
cm-embeds.ts               ← NEW: render ![[image.png]] / ![[note]] as widgets
cm-callouts.ts             ← NEW: render > [!note] / [!tip] / [!warning] blocks
cm-frontmatter.ts          ← NEW: fold YAML frontmatter into a properties widget
cm-heading-fold.ts         ← NEW: gutter carets to fold sections
cm-slash-commands.ts       ← NEW: type "/" to open insertion menu
cm-live-preview.ts         ← NEW: Obsidian-style WYSIWYG — hide markdown syntax on inactive lines
cm-template-variables.ts   ← NEW: {{title}} / {{date}} / {{date:YYYY-MM-DD}} / {{cursor}}
cm-vim.ts                  ← NEW: wires @replit/codemirror-vim conditionally (§6.1)
cm-which-key.ts            ← NEW: overlay shown on leader key (§6.2)
```

Each is sized at "a focused PR per extension." All are direct ports of ZenNotes' `packages/app-core/src/lib/cm-*.ts` adjusted for our naming and the Lattice theme tokens already in [`src/App.css`](../src/App.css).

### 4.3 The "Import Obsidian vault" verb

`lattice-vault-rs/src/import/obsidian.rs`:

```rust
pub struct ObsidianImportOptions {
    pub source_root: PathBuf,
    pub mode: ObsidianImportMode,  // CopyInPlace | CopyToNewVault | OpenAsIs
    pub respect_dot_obsidian: bool, // false in v3 (we don't read plugin configs yet)
}
pub fn import_obsidian_vault(opts: ObsidianImportOptions) -> Result<ImportReport, ImportError> {
    // 1. Detect: presence of `.obsidian/` directory ⇒ Obsidian vault
    // 2. Scan: count notes, attachments, infer flat vs nested
    // 3. If OpenAsIs: just set `primaryNotesLocation: root` and open
    // 4. If CopyToNewVault: copy notes and `.obsidian/` (preserved but unused) into new root
    // 5. Build initial meta cache + persist
}
```

Wired into:
- Splash detection ([`src/components/onboarding/steps/Step0Splash.tsx`](../src/components/onboarding/steps/Step0Splash.tsx)) — already detects Obsidian; just needs the action.
- Onboarding step 3 (Vault) — replaces today's `<Stub>` in [`StubSteps.tsx`](../src/components/onboarding/steps/StubSteps.tsx).
- "Manage Vaults" modal ([`src/components/modals/ManageVaultsModal.tsx`](../src/components/modals/ManageVaultsModal.tsx)) — adds "Import from Obsidian" alongside "Open" / "Create".

### 4.4 What we still won't do (and that's fine)

We will not read `.obsidian/workspace`, `.obsidian/hotkeys.json`, `.obsidian/plugins/*` in v3. The vault itself is portable; the user re-binds their workflow inside Lattice. Saying this loudly in onboarding sets the right expectation.

### 4.5 Bidirectional compat — the no-lock-in guarantee

> **Hard product rule.** A vault written by Lattice opens cleanly in Obsidian, with zero conversion, forever. If a v3+ change would break this, the change does not ship.

The whole space leans one-way. Obsidian → Lattice is something everyone advertises (ZenNotes, Logseq, Silverbullet, Foam, …). **Lattice → anywhere else** is something almost no one offers. ZenNotes itself, despite being the most Obsidian-faithful PKM in the comparison set, is a leaky one-way door: the notes are `.md` so they technically open in Obsidian, but the four lifecycle folders (`inbox/`, `quick/`, `archive/`, `trash/`) and the `.zennotes/comments/*.json` sidecars are opaque to anyone outside ZenNotes — meaning a user who walks away from ZenNotes walks away from their lifecycle history too.

Lattice does not have to inherit that defect. The on-disk layout in §3.2 was chosen with reverse-compat in mind, and the editor-extension list in §4.2 is deliberately constrained to syntax Obsidian already speaks. Codified, the guarantees are:

| # | Guarantee | What it means concretely |
|---|---|---|
| 1 | **Every note is plain CommonMark + GFM**, never a proprietary serialisation. | Open `inbox/foo.md` in `cat`, in `vim`, in Obsidian, in VSCode — you see the same text. No JSON-in-disguise, no binary blobs, no XML. |
| 2 | **Wikilinks are Obsidian-shaped.** | `[[Note]]`, `[[Note\|alias]]`, `[[Note#heading]]`, `![[embed]]`, `[[Note^block-ref]]`. Lattice does not invent new bracket syntax. |
| 3 | **Frontmatter is standard YAML with Obsidian's reserved keys honoured.** | `tags:`, `aliases:`, `cssclasses:`, `publish:` mean the same thing in both apps. Lattice-specific metadata lives under a single `lattice:` namespace key so Obsidian ignores it. |
| 4 | **Callouts use Obsidian's exact syntax.** | `> [!note]`, `> [!tip]`, `> [!warning]`, `> [!quote]-`. No `:::lattice-note:::` containers, ever. |
| 5 | **Tags are inline `#tag` and YAML `tags:`** — nothing else. | A vault tagged in Lattice is a vault tagged in Obsidian. |
| 6 | **Canvas files are JSON Canvas 1.0** (already shipping). | `.canvas` files Lattice writes load unchanged in Obsidian Canvas — and vice versa. JSON Canvas is an open standard precisely so this works. |
| 7 | **Attachments live in `attachements/`** (the Obsidian-default `_assets/` and `assets/` paths are also read). Embeds use `![[image.png]]` or `![alt](path.png)`. | An asset added in Lattice resolves in Obsidian and the other way round. |
| 8 | **Lifecycle folders are plain folders**, not virtual views. `inbox/`, `quick/`, `archive/`, `trash/`, `Daily Notes/` are just directories you can `mv` between. | If a user opens the same vault in Obsidian, they see four extra folders. That's it — no broken links, no missing notes. Lattice's lifecycle UX layer is opt-in; the bytes don't care. |
| 9 | **`primaryNotesLocation: root` mode** (§3.2) drops the lifecycle folders entirely. | If a user wants their Lattice vault to look pixel-identical to an Obsidian vault on disk, they choose this mode at vault-create time. Lattice still works; Obsidian still works; both see the same flat layout. |
| 10 | **All Lattice-private state lives under `.lattice/`**, which is a hidden directory. | Obsidian ignores hidden directories. Settings, meta cache, comments, git separate-dir, BYOC manifest, paper config — none of it leaks into the user-visible tree. Deleting `.lattice/` loses Lattice-specific state but does not damage a single note. |
| 11 | **VCS uses `--separate-git-dir=.lattice/git`** (already shipping). | No `.git/` clutter at vault root; Obsidian sees no git noise. |
| 12 | **Code-fence extensions degrade gracefully.** Anything Lattice renders specially (`mermaid`, `dataview`-equivalents, plugin-defined blocks) must still be a valid GFM fenced code block. | Worst case in Obsidian: the user sees the source. Never a parse error, never lost content. |
| 13 | **No proprietary file extensions.** Only `.md`, `.canvas` (JSON Canvas), `.json` (sidecars under `.lattice/`), and standard media (`.png`, `.jpg`, `.pdf`, `.mp4`, …). | The vault as a folder of files is meaningful to every tool that understands those formats. |
| 14 | **Comments are sidecars under `.lattice/comments/`**, not inline HTML. | Obsidian doesn't see them — but the notes are unmodified. (Tradeoff: cross-app comment portability is sacrificed for in-Lattice cleanliness. Acceptable; comments are an annotation tier, not content.) |

This list is the bidirectional-compat checklist. The CI suite that gates v3+ releases runs a fixture vault through three round-trips — `lattice-write → obsidian-read → lattice-read → diff` — and fails the build on any byte-level drift in `.md`, `.canvas`, or attachment content.

**Why it matters strategically.** Obsidian's moat is "your notes are yours, in plain markdown, locally." Lattice's moat is the same — plus *"and you can go back to Obsidian on a whim."* That symmetry is genuinely uncomfortable for every closed-vault competitor (Notion, Logseq-when-using-the-DB-backend, Roam, Bear, …) and *also* uncomfortable for Obsidian itself, because Obsidian's flat vault doesn't natively give the user the inbox/quick/archive/trash lifecycle a real PKM workflow needs. Lattice adds the lifecycle without taxing the user's freedom to leave.

**The onboarding copy that uses this.** Step 3 (Vault) shows three radio options:

- *"Use Lattice's lifecycle folders (`inbox / quick / archive / trash / Daily Notes`). Best for active PKM. Vault still opens in Obsidian — the lifecycle folders just show as folders."*
- *"Mirror an Obsidian vault exactly — flat layout, all notes at root. Best if you regularly switch between Lattice and Obsidian."*
- *"Import my existing Obsidian vault as-is. Same as above, but copies your current notes in."*

Both modes ship in v3.

---

## 5. Rust HTTP server + Docker self-hosting

> **Why:** four deployment modes (desktop / local PWA / self-hosted home server / hosted SaaS) from one binary is the architectural pattern that gets Lattice taken seriously on Hacker News, r/selfhosted, Arch Wiki, and corporate IT shortlists in one stroke. ZenNotes already has it. Obsidian charges $8/mo for less. This is the largest single asymmetric move available to us.

### 5.1 Crate + framework choices

| Concern | Choice | Why |
|---|---|---|
| HTTP framework | `axum = "0.7"` | Tokio-native, tower middleware, the de-facto choice for this shape of app |
| WebSocket | `axum::extract::ws` | Built-in |
| Session cookies | `tower-cookies = "0.10"` + `argon2 = "0.5"` | Stdlib-shaped, no surprises |
| Static asset embed | `rust-embed = "8"` | Embed `apps/web/dist/**` into the binary |
| Rate limit | `tower_governor = "0.4"` | Per-route policies |
| TLS hint | "use a reverse proxy" (Caddy in docs) | Same call ZenNotes makes — keeps the binary small and the TLS story standard |
| Logging | `tracing` + `tracing-subscriber` | Async-aware, structured |

### 5.2 Configuration

Env-var-first, file fallback (`/data/server.json`):

```
LATTICE_VAULT_PATH               hard-locks server to this path; disables in-app vault switching
LATTICE_DEFAULT_VAULT_PATH       default starting vault when no saved selection exists
LATTICE_BROWSE_ROOTS             CSV whitelist for the directory picker (CVE prevention)
LATTICE_ALLOW_UNSCOPED_BROWSE    escape hatch — removes browse-root enforcement (off by default)
LATTICE_ALLOWED_ORIGINS          CORS allowlist (strict by default)
LATTICE_BIND                     default 127.0.0.1:7878  ← bind-localhost-by-default; user opts in to public
LATTICE_BASE_PATH                default /  (reverse-proxy sub-path support)
LATTICE_AUTH_TOKEN[_FILE]        bearer token (single-tenant mode)
LATTICE_ALLOW_INSECURE_NOAUTH    escape hatch — disables auth requirement (off by default)
LATTICE_MAX_ASSET_BYTES          default 50 MiB
LATTICE_MAX_NOTE_BYTES           default 10 MiB
LATTICE_BEHIND_TLS               trust X-Forwarded-Proto when behind a proxy
LATTICE_TRUSTED_PROXIES          CIDR list of proxies whose X-Forwarded-* we trust
LATTICE_VAULT_FILE_MODE          default 0o600
LATTICE_VAULT_DIR_MODE           default 0o700
LATTICE_CONFIG_PATH              default /data/server.json
```

This is the ZenNotes `Config` struct from `apps/server/internal/config/config.go`, transliterated. Same defaults, same posture.

**First-run UX (`make up` equivalent):**
- The server generates a random bearer token on first start and writes it to `/data/auth-token` (mode `0600`). The user opens the browser, pastes the token once, and the server upgrades to an `HttpOnly` session cookie.
- No auth token ever travels in URLs or local-storage. Tokens-in-querystring is an anti-pattern we copy from ZenNotes specifically *not* to do.
- `Makefile` `up / down / restart / logs / status / open / rebuild / nuke / clean` targets ship in the repo root, same shape as ZenNotes'. New users on macOS/Linux do `make up && make open`.

**Version-skew detection:** the server exposes `GET /api/version` returning `{ apiSchema: "v1", buildSha, semver }`. The web/desktop client checks at startup and renders a clear "your client is newer than the server — please update the server" banner instead of opaque 404s on new routes.

### 5.3 Route surface

Public:

```
GET  /api/healthz
GET  /api/version
GET  /api/capabilities      ← server-side LatticeCapabilities
GET  /api/platform
POST /api/session/login
GET  /api/session
POST /api/session/logout
```

Authenticated (bearer or session cookie):

```
GET  /vault
GET  /vault/settings        POST /vault/settings
POST /vault/select
GET  /fs/browse             ← respects LATTICE_BROWSE_ROOTS

GET  /notes                 GET  /notes/read
POST /notes/write           POST /notes/create
POST /notes/rename          POST /notes/delete
POST /notes/trash           POST /notes/restore   POST /notes/empty-trash
POST /notes/archive         POST /notes/unarchive
POST /notes/duplicate       POST /notes/move

GET  /folders               POST /folders/create  POST /folders/rename
POST /folders/delete        POST /folders/duplicate

GET  /assets                GET  /assets/exists   GET  /assets/raw
POST /assets/upload

GET  /comments/read         POST /comments/write

GET  /search/text           GET  /search/capabilities

GET  /tasks                 GET  /tasks/for

POST /demo/generate         POST /demo/remove

GET  /watch                 ← WebSocket: server pushes VaultChangeEvent
```

All routes are thin wrappers over `packages/lattice-vault-rs` — the same crate the desktop app uses. **No duplicated business logic.**

### 5.4 Security defaults

- `loginLimiter`: 10 attempts / 10 min. `wsRejectLimiter`: 20 / 1 min.
- CORS strict-by-default; user opts in to specific origins via `LATTICE_ALLOWED_ORIGINS`.
- Origin logging deduped via `Mutex<HashSet>` so logs don't fill.
- File mode `0o600`, dir mode `0o700` — private-by-default. Configurable for shared-NAS use.
- Subtle string comparison for bearer tokens (`subtle = "2"`).
- `safe_join` enforced on every vault path the user supplies (§3.4).

### 5.5 Docker image

`apps/server/Dockerfile`:

```dockerfile
# Stage 1: build web bundle
FROM oven/bun:1-alpine AS web
WORKDIR /w
COPY . .
RUN bun install --frozen-lockfile && bun run --filter @lattice/web build

# Stage 2: build server
FROM rust:1-alpine AS server
WORKDIR /s
RUN apk add --no-cache musl-dev
COPY . .
COPY --from=web /w/apps/web/dist ./apps/web/dist
RUN cargo build --release --bin lattice-server --target $(uname -m)-unknown-linux-musl

# Stage 3: scratch runtime
FROM scratch
COPY --from=server /s/target/*-unknown-linux-musl/release/lattice-server /lattice-server
USER 65532:65532
ENV LATTICE_BIND=0.0.0.0:7878
ENV LATTICE_DEFAULT_VAULT_PATH=/workspace
ENV LATTICE_BROWSE_ROOTS=/workspace
ENV LATTICE_CONFIG_PATH=/data/server.json
EXPOSE 7878
VOLUME ["/workspace","/data"]
ENTRYPOINT ["/lattice-server"]
```

`apps/server/docker-compose.yml`:

```yaml
services:
  lattice:
    image: ghcr.io/lattice/lattice-server:latest
    ports: ["7878:7878"]
    volumes:
      - ./vault:/workspace
      - ./data:/data
    read_only: true
    tmpfs: ["/tmp"]
    security_opt: ["no-new-privileges:true"]
    cap_drop: ["ALL"]
    environment:
      LATTICE_AUTH_TOKEN_FILE: /data/token
```

This is the ZenNotes hardening profile, copied. There is no reason to invent a weaker one.

### 5.6 What it does *not* do

- No multi-tenant mode in v3 (deferred — same staging that `impl-v2.md` §5.5 takes for publishing).
- No built-in TLS termination; docs recommend Caddy.
- No federated identity; bearer token + session cookie only.

---

## 6. Browser PWA mode (`apps/web`)

The same React bundle as `apps/desktop`, served either by `apps/server` (mode A) or by any static host pointing at `apps/web/dist` (mode B — pure browser, no backend, File System Access API).

### 6.1 Two bridge implementations

`packages/lattice-bridge-web/src/local.ts` — **mode B (PWA)**:
- Uses `window.showDirectoryPicker()` to obtain a `FileSystemDirectoryHandle`.
- Wraps it in a `LocalWebBridge` that implements `LatticeBridge`.
- Persists the handle via IndexedDB so re-opens skip the picker.
- Service worker (`apps/web/public/sw.ts`) caches the app shell; works fully offline.
- Capability flags: `supportsCanvas: true`, `supportsPdfViewer: true`, `supportsBYOCKeychain: false` (uses `sessionStorage` instead).

`packages/lattice-bridge-web/src/remote.ts` — **mode A (against server)**:
- `RemoteBridge` reads `import.meta.env.VITE_LATTICE_SERVER_URL` (or same origin).
- Each method maps to a `fetch` against the route surface in §5.3.
- Vault change events arrive over `WebSocket` `/watch`.
- BYOC tokens stored server-side, so capability `supportsBYOCKeychain` is `false` but capability `supportsRemoteWorkspace` is `true`.

### 6.2 Constraints we accept

- Mode B is Chromium-only (File System Access API). Firefox + Safari users get mode A.
- Mobile browsers get a read-only fallback bundle ("view your vault on phone" not "edit your vault on phone"). Editing on mobile waits for Tauri 2 mobile (§G of the competitive doc; tracked as a v4 item, not v3).

### 6.3 Five deployment modes (not four)

| Mode | Shell | Bridge | Vault location | Auth | Typical user |
|---|---|---|---|---|---|
| **A — Desktop, local** | Tauri (apps/desktop) | `TauriBridge` (direct Rust IPC) | machine-local FS | OS user | every Obsidian/Notion refugee |
| **B — Browser PWA, local** | Vite SW (apps/web) | `LocalWebBridge` (File System Access API) | machine-local FS via browser handle | OS user | Chromebook users; "try without installing" |
| **C — Browser PWA, remote** | Vite SW (apps/web) | `RemoteBridge` (fetch + WS) | server-side FS | bearer → session cookie | self-hosters; r/selfhosted |
| **D — Multi-user remote** | Vite SW (apps/web) | `RemoteBridge` | per-user server-side | per-user session | small teams (post-v3) |
| **E — Desktop, remote vault** | Tauri (apps/desktop) | `TauriBridge` *wrapping* `RemoteBridge` for vault ops, keeping native windows/CLI/MCP local | server-side FS | bearer → session | road-warrior; thick client against home server |

Mode **E** is the mode ZenNotes calls "Connect Desktop to a Remote ZenNotes Server" — and the one a single-user-multi-machine user actually wants. v3 ships it because the bridge contract makes it a 3-day addition: the desktop shell composes a `RemoteBridge` for vault verbs while keeping `TauriBridge` for native menus, floating windows, system tray, OS keychain, the `lattice` CLI sidecar, and the local MCP server. Capability flags (§2.2) tell components which is which.

### 6.4 PWA assets

`apps/web/public/manifest.webmanifest`, icons in `apps/web/public/icons/`, splash screens for iOS. `vite-plugin-pwa = "0.20"` does most of the work.

---

## 7. MCP — first-class, default-on

> The bootcamp is named `Camp_AIR_MCP_BOOTCAMP`. We do not have an MCP server. ZenNotes has 30+ MCP tools. This has to change in v3.

### 7.1 Crate

`apps/desktop/src-tauri/src/mcp/`:

```
mod.rs                ← register Tauri commands for "start/stop/status" + sidecar invoker
server.rs             ← stdio MCP server using `rmcp = "0.1"`
tools.rs              ← 30+ #[mcp_tool] handlers, each a thin call into lattice-vault-rs
instructions.rs       ← system instruction string (note-writing pedagogy)
client_config.rs      ← writers for Claude Desktop / Claude Code / Cursor / Zed config
```

### 7.2 Tools (mirror ZenNotes 1:1)

```
vault_info               list_notes               list_folders              list_assets
read_note                write_note               create_note               rename_note
move_note                trash_note               restore_note              archive_note
unarchive_note           delete_note              duplicate_note            append_to_note
prepend_to_note          replace_in_note          insert_at_line
create_folder            rename_folder            delete_folder             duplicate_folder
search_text              backlinks                read_primary_notes_location
list_tasks               scan_all_tasks           toggle_task               empty_trash
vcs_status               vcs_commit               vcs_log                   ← Lattice-specific bonus
get_vault_graph                                                              ← Lattice-specific bonus
```

The Lattice-specific bonuses (`vcs_*`, `get_vault_graph`) are the differentiator vs ZenNotes' MCP. An AI agent driving Lattice can read its own commit history and the vault link graph — neither of which ZenNotes can offer.

### 7.3 Invocation

Two modes:

1. **Sidecar** — `lattice mcp` (the `lattice` CLI subcommand from §8) runs as a stdio MCP process spawned by Claude Desktop / Claude Code / Cursor / Codex / Zed. Standard MCP plumbing.
2. **Embedded** — same `server.rs` module instantiated inside the running Tauri app and exposed via Tauri IPC for in-app "agent" UX. Same tools, no process boundary.

### 7.4 Settings → AI/MCP — one-click install/uninstall per client

Match ZenNotes' UX exactly: a Settings panel that, for each supported client, shows:

- whether Lattice's MCP entry is currently installed in that client's config file,
- a one-click install/uninstall toggle,
- the exact runtime command the client will use to launch the server,
- an editable text area for the server's default system instructions (the note-writing pedagogy in `instructions.rs`).

Supported clients (config file path detection per OS):

| Client | macOS | Windows | Linux |
|---|---|---|---|
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` | `%APPDATA%/Claude/claude_desktop_config.json` | `~/.config/Claude/claude_desktop_config.json` |
| Claude Code | `~/.config/claude-code/mcp_servers.json` | `%APPDATA%/claude-code/mcp_servers.json` | `~/.config/claude-code/mcp_servers.json` |
| Codex | `~/.codex/mcp.json` | `%USERPROFILE%/.codex/mcp.json` | `~/.codex/mcp.json` |
| Cursor | `~/.cursor/mcp.json` | `%USERPROFILE%/.cursor/mcp.json` | `~/.cursor/mcp.json` |
| Zed | `~/.config/zed/settings.json` (under `context_servers`) | `%APPDATA%/Zed/settings.json` | `~/.config/zed/settings.json` |

### 7.5 Onboarding hook

Step 7 (AI) — already in [`StubSteps.tsx`](../src/components/onboarding/steps/StubSteps.tsx) — gets a real implementation:

1. Detect Ollama at `http://localhost:11434/api/tags`.
2. Offer to write the MCP server config into the detected clients from the §7.4 table.
3. Show a "test" button that pings the server with a `vault_info` call.

---

## 8. CLI — `lattice`

`impl-v2.md` §6 specifies the CLI surface; v3 actually ships it because the vault crate from §3 makes it cheap.

`apps/cli/Cargo.toml` (new):

```toml
[package]
name = "lattice"
[dependencies]
clap = { version = "4", features = ["derive"] }
ratatui = "0.27"
crossterm = "0.27"
lattice-vault = { path = "../../packages/lattice-vault-rs" }
```

### 8.1 Subcommand surface (matches ZenNotes' `zen`)

```
lattice init [<path>]                       create a vault at path (or cwd)
lattice list [--folder F] [--tag #t] [--json]
lattice read <rel>
lattice create [--folder F] [--title T] [--subpath S] [--body B]
lattice write <rel> [--stdin]
lattice append <rel> [--stdin]
lattice prepend <rel> [--stdin]
lattice rename <rel> <new-title>
lattice move <rel> <folder> [--subpath S]
lattice archive <rel>     lattice unarchive <rel>
lattice trash <rel>       lattice restore <rel>
lattice delete <rel> [--confirm]
lattice duplicate <rel>

lattice search <query> [--limit N] [--json]
lattice backlinks <title> [--json]

lattice folder list|create|rename|delete
lattice tag list|find <#tag>
lattice task list|toggle <task-id>

lattice vault info|list
lattice capture [--title T] [--body B]      quick-capture into quick/
lattice open <path>                          open an arbitrary md file in the desktop app
lattice daily [today|YYYY-MM-DD]             create/open daily note

lattice sync now                             trigger BYOC sync if configured
lattice graph                                emit graph JSON

lattice mcp                                  start stdio MCP server (§7)

lattice tui                                  ratatui dashboard (§8.2)
```

### 8.2 ratatui dashboard

`apps/cli/src/tui/` — same widgets as `impl-v2.md` §6.3: vault picker, file tree, note preview, tasks pane, git status, sync status. Power users will live here.

### 8.3 Install from the GUI (Settings → CLI)

The desktop app bundles the `lattice` binary as a Tauri sidecar resource and offers a one-click **Install** in Settings → CLI that symlinks it into `PATH`:

| OS | Install target | Mechanism |
|---|---|---|
| macOS | `/usr/local/bin/lattice` (or `~/.local/bin/lattice` if `/usr/local/bin` is not writable) | symlink; one-time `sudo` prompt if needed |
| Linux | `~/.local/bin/lattice` (PATH-added per `XDG_BIN_HOME`) | symlink |
| Windows | `%LOCALAPPDATA%/Programs/lattice/lattice.exe` + adds to user PATH | copy + `setx PATH` |

Uninstall reverses the same steps. This is the ZenNotes "Settings → CLI install" flow — the friction of "download a separate CLI" is a real adoption killer.

### 8.4 Raycast extension (macOS, install from Settings)

Same Settings → CLI panel offers, on macOS only, a **Install Raycast extension** button that places the extension files under `~/.config/raycast/extensions/lattice/` and registers them locally — bypassing the Raycast Store review cycle exactly as ZenNotes does. Commands: `Search Notes`, `Open Note`, `Open in Floating Window`, `Archive`, `Trash`, `Reveal in Finder`, `Copy Path`, `Copy Wikilink`. All commands call the `lattice` CLI; URI scheme `lattice://open/...` brings the main app forward.

---

## 9. BYOC — ship GitHub end-to-end

`byoc-plan.md` is the source of truth for the design. v3 just makes the first provider real so the rest follow.

### 9.1 What v3 implements

- `packages/lattice-vault-rs` exposes a `Snapshot` API (content-addressed blobs + meta JSON) — same wire format as `byoc-plan.md`.
- `apps/desktop/src-tauri/src/sync/oauth.rs` — PKCE generator + loopback redirect server on `127.0.0.1:<random>`. Real, not stubbed.
- `apps/desktop/src-tauri/src/sync/keychain.rs` — `keyring = "3"` wrapper for token storage.
- `apps/desktop/src-tauri/src/sync/github.rs` — Device Code Flow + `git push/pull` against a user-chosen private repo. Done end-to-end.
- `src/components/layout/ChangesPanel.tsx` row at [line 913](../src/components/layout/ChangesPanel.tsx) for `github` becomes `ready: true`. The other providers stay as `<PlaceholderByocRow />` until v3.1.

### 9.2 What v3 doesn't ship

Google Drive, OneDrive, Dropbox, WebDAV — same skeletons as today, deferred. The point of v3 is to prove the bridge end-to-end on the easiest provider; the other adapters then follow the proven shape.

---

## 10. Packaging, signing, updater, deep links — day one

### 10.1 Linux packaging

| Format | File | Tool |
|---|---|---|
| AUR `lattice-bin` | `packaging/aur/PKGBUILD` | direct port of `zennotes/packaging/aur/PKGBUILD` (FUSE-free AppImage extract pattern) |
| AppImage | `tauri.conf.json` `targets: ["appimage", …]` | `cargo-packager` |
| Flatpak | `packaging/flatpak/dev.lattice.Lattice.yaml` | `flatpak-builder` |
| `.deb` / `.rpm` / `.pacman` | `tauri.conf.json` targets | `cargo-packager` |
| `.desktop` entry + hicolor icons | `packaging/linux/lattice.desktop`, `packaging/linux/icons/` | manual |

The AUR PKGBUILD's main subtlety (also in ZenNotes' file) is **`chmod -R a+rX` after `cp -a`** — the extracted squashfs root is often `0700`, which silently breaks `Exec=` lookups. Steal the comment along with the code.

**AUR pitch on the package page:** *"Installs cleanly without `libfuse2`."* The number of Arch users this single sentence converts is non-trivial.

### 10.2 macOS + Windows signing

Match ZenNotes' release workflow. GitHub Actions secrets:

- `MACOS_CERTIFICATE_P12`, `MACOS_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` — hardened runtime + notarization (required; CI fails the tagged release if missing).
- `WINDOWS_CERTIFICATE_P12`, `WINDOWS_CERTIFICATE_PASSWORD` — optional code signing.

Unsigned tagged releases are a release-management bug; CI must enforce.

### 10.3 Auto-updater

Tauri's built-in updater plugin pointed at `https://releases.lattice.dev/<channel>/manifest.json`. Channels: `stable`, `beta`. Signed update manifests via `tauri signer` (Ed25519). User toggles auto-update in Settings → Updates with channel selector and "check now" button. This matches the ZenNotes "download once, app auto-updates" pitch — the alternative (every release is a re-download) costs us retention.

### 10.4 `lattice://` deep-link routes

Registered via `apps/desktop/src-tauri/tauri.conf.json` `bundle.protocols`. Route table:

| URI | Action |
|---|---|
| `lattice://open/<rel-path>` | open note in main window |
| `lattice://open-window/<rel-path>` | open note in detached floating window (§11.5) |
| `lattice://search?q=<query>` | open Search palette pre-populated |
| `lattice://daily` | open today's daily note |
| `lattice://capture?body=<text>` | append to today's Quick Capture |
| `lattice://vault/<vault-id>` | switch to a registered vault |
| `lattice://mcp/connect/<client>` | re-run MCP install for a client (used by error-recovery UI) |

The Raycast extension (§8.4) and the `lattice` CLI (`lattice open`) both call into this route table — single source of truth for "how does the outside world bring up a note in Lattice."

---

## 10.5 Window / pane / tab model — explicit

Lattice today has tabs. ZenNotes ships **edit / preview / split / pinned-reference / detached-window** as five distinct affordances; that's the bar.

| Affordance | Today in Lattice | v3 target | Where it lives |
|---|---|---|---|
| Tabs | ✅ | ✅ | already |
| Edit mode | ✅ | ✅ | already |
| Preview mode | partial (markdown-it render exists) | ✅ first-class toggle | `Editor.tsx` + `PreviewPane.tsx` |
| Split mode (edit + preview side-by-side) | ❌ | ✅ | new `SplitEditor.tsx`; respects synchronized scroll |
| Pinned reference pane | ❌ | ✅ | a tab can be "pinned" — stays in place while other tabs cycle; useful for keeping a reference note visible while editing |
| Detached note window | ❌ (Tauri supports `WebviewWindow::new`) | ✅ desktop-only | `bridge.openNoteWindow(rel)`; capability-gated `supportsFloatingWindows` |
| Workspace layout restore | ❌ (no persistence today) | ✅ | persist `{ openTabs, activeTab, pinnedTabs, splitMode, sidebarWidth, rightSidebarOpen }` to `.lattice/workspace.json` on change (debounced 500ms), restore on app open |
| Sidebar multi-select | ❌ (single-select today) | ✅ | Cmd/Ctrl-click toggles; Shift-click ranges; context menu actions: open-in-tabs, move, archive, trash, restore, delete, copy-path, drag-to-folder |

---

## 11. Honest activity strip + onboarding

[`src/components/layout/ActivityStrip.tsx`](../src/components/layout/ActivityStrip.tsx) lines 13–27 today:

```ts
{ Icon: IcGraph,    title: "Graph view",                onClick: onOpenGraph },
{ Icon: IcGrid,     title: "Canvas (Coming soon)",      onClick: undefined },
{ Icon: IcCalendar, title: "Calendar (Coming soon)",    onClick: undefined },
{ Icon: IcFiles,    title: "All files (Coming soon)",   onClick: undefined },
{ Icon: IcTerminal, title: "Terminal (Coming soon)",    onClick: undefined },
{ Icon: IcKanban,   title: "Kanban (Coming soon)",      onClick: undefined },
```

v3 wires four of them:

| Icon | v3 target | Backing work |
|---|---|---|
| Canvas | open the existing `CanvasView` for the current vault | already real; just unhide |
| Calendar | open `CalendarPanel` per `impl-v2.md` §1.5 | depends on calendar module landing |
| All files | flat list of all `.md` + assets with virtual scrolling | depends on §3 + a `VirtualList.tsx` port from `zennotes/packages/app-core/src/lib/virtual-list.ts` |
| Kanban | tasks board from `scan_tasks()` | depends on §3.3 `scan_tasks` |
| Terminal | **deferred to v4** (Tauri sidecar + xterm.js) | — |

Onboarding: steps 3 (vault, including "import Obsidian") and 7 (AI / MCP / Ollama) become real per §4.3 + §7.4. Steps 4, 5, 6, 8 stay as `<Stub>` until their slices land — but the stub copy is updated to point at the right milestone instead of "coming soon."

---

## 11.5 Pluggable search backends

`lattice-vault-rs` exposes one `search_text(query, backend)` verb where `backend` ∈ `{ Auto, Builtin, Ripgrep, Fzf }`. The default is `Auto`, which probes for `rg` and `fzf` on `PATH` at vault open and picks the fastest available (ripgrep > builtin > fzf for whole-vault text; fzf for filename-fuzzy).

| Backend | When chosen | Implementation |
|---|---|---|
| `Builtin` | always available; default if no external bins | naive concurrent `walkdir` + `regex` with fenced-code-block skip |
| `Ripgrep` | preferred for whole-vault text | shell-out via `tokio::process::Command`; parse `--json` |
| `Fzf` | filename fuzzy ("jump to file") | shell-out; pipe `list_notes()` paths in |

Settings → Search exposes `searchBackend: Auto | Builtin | Ripgrep | Fzf` plus optional custom binary paths (`ripgrepPath`, `fzfPath`) for users with non-standard installs. This is ZenNotes' Settings → Search behaviour copied verbatim because (a) ripgrep is genuinely 5–20× faster than naïve walks on big vaults and (b) the auto-detect-with-override pattern is what power users expect.

---

## 11.6 Render parity — beyond KaTeX

Lattice today renders KaTeX (math) in preview via `markdown-it-texmath`. ZenNotes also ships Mermaid, TikZ, JSXGraph, function-plot, callouts, footnotes, and inline embeds. v3 closes this gap because preview-quality is what a user *demonstrates to colleagues*; missing renderers are the single most-visible quality gap.

| Renderer | Lib | v3 wave | Notes |
|---|---|---|---|
| KaTeX | `markdown-it-texmath` + `katex` | shipped | already |
| Mermaid | `mermaid` (lazy-loaded; ~600 KB) | W2 | gate on `~~~mermaid` fence; cache rendered SVG by content-hash |
| Callouts | hand-rolled markdown-it plugin | W2 | aligned to Obsidian syntax (§4.5 rule 4) |
| Footnotes | `markdown-it-footnote` | W2 | trivial |
| Inline embeds `![[…]]` | hand-rolled (§4.2 `cm-embeds.ts` + a preview plugin) | W2 | the visible win |
| TikZ | `node-tikzjax` or web-tikzjax | W4 | heavy; lazy; opt-in setting |
| JSXGraph | `jsxgraph` | W4 | small; opt-in |
| function-plot | `function-plot` (d3) | W4 | small; opt-in |
| Audio / Video / SVG / PDF inline | native `<audio>`, `<video>`, `<img>`, existing `pdfjs-dist` viewer | W2 | open inside Lattice tab instead of handing off to OS |

---

## 12. Backlinks UI — finally wire it

[`current-state.md`](current-state.md) §4 lists the concrete TODO. v3 closes it on the back of §3:

1. `RightSidebar.tsx` calls `bridge.getBacklinks(activeFile)` on `activeFile` change, debounced 150 ms.
2. Renders "Linked mentions" and "Unlinked mentions" sections, grouped by source file, with snippet + line number per occurrence.
3. Click snippet → editor navigates and `EditorView.scrollIntoView` on the matching line.
4. Cache results by `(vaultPath, activeFilePath)` in a small `Map`.

This is a 1-day task once §3 is in. The reason it has lingered is that the in-memory `collectBacklinks` mock in [`src/lib/backlinks.ts`](../src/lib/backlinks.ts) was the only available data source and produced filename-only results.

---

## 13. Sequencing — recommended ship order

| Wave | Items | Why this order |
|---|---|---|
| **W1 — Foundation** | §2 monorepo + `LatticeBridge`; §3 `lattice-vault-rs` (verbs, safe_join, watcher, meta cache); §12 backlinks UI wired against new vault | Everything else compounds on these. Backlinks ships as a smoke test that the new vault works end-to-end. |
| **W2 — Editor parity** | §4 Obsidian compat truth-table (heading fold, frontmatter widget, callouts, `![[embeds]]`, `[[Note#heading]]`, tag pane, `primaryNotesLocation: root`, import Obsidian vault); §4.2 slash commands; §11.6 render parity (Mermaid + callouts + footnotes + embeds); §10.5 split mode + pinned reference pane + workspace layout restore + sidebar multi-select; §11 activity-strip honesty (Canvas/All files/Kanban) | This is the user-visible quality bar shift. The vault crate is invisible until the editor uses it. |
| **W3 — Power user** | §4.2 vim mode + which-key + command palette + slash + live preview; §8 `lattice` CLI (incl. §8.3 install-from-Settings); §7 MCP server (sidecar + embedded); §7.4 one-click install/uninstall for Claude Desktop / Claude Code / Codex / Cursor / Zed; §8.4 Raycast extension on macOS; §11.5 pluggable search backend (ripgrep / fzf auto-detect); §13.5 Settings inventory shipped in full | Lifts Lattice into the "serious tool" tier; closes the largest gap vs ZenNotes. |
| **W4 — Self-host + web** | §5 Rust HTTP server + Docker (bootstrap auth token + 127.0.0.1 bind + version-skew detection); §6.1–6.4 PWA mode (local + remote bridge + mode-E desktop-as-remote-client); §10 Linux packaging + macOS/Windows signing + auto-updater + `lattice://` deep-link route table | This is the marketing moat. Until this lands, Lattice is "another desktop notes app." After it lands, Lattice is "the open-source self-hosted Obsidian-compatible PKM, with git + canvas + paper export." |
| **W5 — BYOC GitHub** | §9 OAuth + keychain + GitHub adapter + Changes panel real row | Closes the sync gap vs Obsidian Sync's $8/mo. |
| **W6 — Hand-off to v4** | Plugins (impl-v2 §5), Databases (impl-v2 §7), E2EE (impl-v2 §9), remaining BYOC providers, mobile (Tauri 2 mobile), Terminal panel | These are all enabled by W1–W5; promoted from "stub" to "spec" status. |

Each wave is sized to be shippable as a real release (`0.2.0` for W1, `0.3.0` for W2, …). Nothing in v3 is "infinite scope" — every item has a clear file list and a precedent in either our existing code or ZenNotes'.

---

## 13.5 Settings inventory — what Settings → … must contain

ZenNotes' settings surface is long and well-organised. Shipping a half-baked Settings UI in v3 leaves the impression of a half-baked product, so we encode the full target inventory here:

**Settings → Appearance**
- Theme family (e.g. Lattice / Solarized / Tokyo Night / High Contrast)
- Mode: Light / Dark / Auto (follow OS)
- Interface font (sans)
- Editor / text font (serif or sans)
- Monospace font (code blocks)
- Editor font size
- Editor line height
- Editor max width
- Preview max width
- Content alignment (left / centered)

**Settings → Editor**
- Line numbers (off / on)
- Vim mode (off / on)
- Vim leader hint overlay behavior (always / on-pause / never)
- Live preview behaviour (off / on)
- Heading fold gutter (off / on)
- Slash commands (off / on)
- Keymap overrides

**Settings → Vault**
- Primary notes location: `inbox` / `root` (Obsidian-style)
- System folder display labels (rename UI labels for inbox/quick/archive/trash without touching disk)
- Daily notes: enabled, directory, title format
- Auto-open today's note on app open

**Settings → Search** (§11.5)
- Backend: Auto / Builtin / Ripgrep / Fzf
- Custom ripgrep binary path
- Custom fzf binary path

**Settings → Sync / BYOC** (`byoc-plan.md`)
- Connected providers
- Cadence
- Conflict policy

**Settings → AI / MCP** (§7.4)
- One toggle per client (Claude Desktop / Claude Code / Codex / Cursor / Zed)
- BYOM provider list (Ollama / OpenAI / Anthropic / Azure / HF) — see `impl-v2.md` §5.3
- MCP server system instruction editor

**Settings → CLI** (§8.3/§8.4)
- Install / uninstall `lattice` CLI button
- macOS-only: install / uninstall Raycast extension button

**Settings → Updates** (§10.3)
- Channel: Stable / Beta
- Auto-update toggle
- Check now button
- Current version + build SHA

**Settings → Security** (§5.4 + at-rest encryption when it lands)
- Lock app on idle (N minutes)
- At-rest vault encryption (off / on, with passphrase) — *deferred to v4 per Appendix B, but the toggle shell ships in v3 disabled so the layout doesn't shift later*

**Settings → Advanced**
- Vault file mode / dir mode override
- Logs folder reveal
- Reset window layout
- Reset onboarding

---

## 14. Risks and how we plan around them

| Risk | Mitigation |
|---|---|
| Monorepo migration breaks `bun run tauri dev` | Branch off `v3/monorepo`; keep `main` shippable until W1 is green. CI runs `bun run build` on both the old and new layouts during the transition week. |
| Rust HTTP server bloats binary | `cargo build --release --bin lattice-server` with `strip = true` + `lto = true` + `panic = "abort"` keeps the scratch image under ~10 MB. Measure before W4. |
| File System Access API limits (Chromium-only, no Firefox/Safari) | Documented up front; Firefox/Safari users default to mode A (server). |
| MCP sidecar spawn UX on macOS Gatekeeper | Codesign the `lattice` binary that gets shipped; document the one-time `xattr -d com.apple.quarantine` for self-built versions. |
| AUR FUSE-free extraction pattern surprises | Port the `chmod -R a+rX` workaround and the `chrome-sandbox` setuid handling **with the comments intact**. Don't trust future-us to remember why. |
| `notify` crate has known platform quirks | Test on macOS APFS, Windows ReFS, Linux ext4 + btrfs in CI. Fall back to polling at 2 s if a watcher init fails. |
| Onboarding "import Obsidian vault" misleads users into expecting plugin parity | Step copy explicitly says: *"We import your notes and attachments. We do not run Dataview, Templater, or Excalidraw plugins yet — that's planned for v4."* |
| BYOC OAuth flow Apple/Google policy review for redirect-loopback | Use the documented loopback IP redirect pattern (`http://127.0.0.1:<port>/callback`) which is the explicitly-supported "native app" flow per RFC 8252. |

---

## 15. What "done with v3" looks like

A new user sees this in one session:

1. Downloads `Lattice-0.3.0-linux-x86_64.AppImage` from GitHub Releases — or `yay -S lattice-bin`, or `docker compose up`, or visits `https://demo.lattice.dev` in Chrome.
2. Splash detects their existing Obsidian vault and offers to open it as-is.
3. Vault opens. Their wikilinks work. Their callouts render. Their frontmatter is a properties widget. Their `![[image.png]]` embeds show inline.
4. They press `Space` (vim leader) — which-key overlay shows commands. They open the command palette with `Ctrl+K`. They type `/` and the slash menu appears.
5. They open the activity strip's **Canvas**, **Kanban**, and **All files** views and they work — not "(Coming soon)" anymore.
6. They open Claude Desktop. Lattice's MCP server is already configured; they ask Claude to "summarise my notes about Project X" and it works.
7. They open the right sidebar — **Linked mentions** and **Unlinked mentions** are populated, with snippets and line numbers, click-to-jump.
8. They open Settings → BYOC → GitHub. PKCE flow runs in their browser. Repo is private. First commit pushes. Subsequent saves diff and commit.
9. They open `lattice tui` in their terminal. They navigate notes with `hjkl`. They mark a task done with `x`.
10. They open `https://lattice.example.com` on their phone (mode A against their own home-server). Notes load read-only. Editing on mobile waits for v4.

If steps 1–10 all work for an existing Obsidian user — that's v3 shipped.

---

## Appendix A — File-to-port checklist

Direct ports from ZenNotes (license-compatible, MIT). Each is a focused PR.

| ZenNotes file | Lattice destination | Adjustments needed |
|---|---|---|
| `apps/server/internal/vault/safepath.go` | `packages/lattice-vault-rs/src/safe_path.rs` | Go → Rust translation; use `std::fs::canonicalize`; preserve error variants |
| `apps/server/internal/vault/vault.go` | `packages/lattice-vault-rs/src/vault.rs` | Same; use `tokio::sync::RwLock`, `DashMap` |
| `apps/server/internal/vault/parse.go` | `packages/lattice-vault-rs/src/parse.rs` | Use `regex` + `once_cell::Lazy` |
| `apps/server/internal/vault/demo.go` + `demo-tour.json` | `packages/lattice-vault-rs/src/demo.rs` + `demo-tour.json` | Replace ZenNotes branding with Lattice |
| `apps/server/internal/watcher/watcher.go` | `packages/lattice-vault-rs/src/watcher.rs` | Use `notify = "8"`; same 120 ms debounce |
| `apps/server/internal/httpserver/server.go` | `apps/server/src/api/mod.rs` (axum) | Translate `chi` → `axum::Router` |
| `apps/server/internal/config/config.go` | `apps/server/src/config.rs` | Same env vars, `LATTICE_*` prefix |
| `Dockerfile` | `apps/server/Dockerfile` | Replace Go stage with `rust:1-alpine` + musl |
| `docker-compose.yml` | `apps/server/docker-compose.yml` | Direct copy with image name change |
| `packaging/aur/PKGBUILD` | `packaging/aur/PKGBUILD` | Direct port; rename `zennotes` → `lattice`; same FUSE-free pattern |
| `packages/bridge-contract/src/bridge.ts` | `packages/lattice-bridge-contract/src/bridge.ts` | Direct port; rename types; drop Electron-specific methods; add capability flags for Tauri |
| `packages/app-core/src/lib/cm-live-preview.ts` | `packages/lattice-core/src/components/editor/extensions/cm-live-preview.ts` | TS → TS; adjust to our theme tokens |
| `packages/app-core/src/lib/cm-heading-fold.ts` | same dir, same name | minor |
| `packages/app-core/src/lib/cm-frontmatter.ts` | same dir, same name | minor |
| `packages/app-core/src/lib/cm-slash-commands.ts` | same dir, same name | minor |
| `packages/app-core/src/lib/cm-wikilinks.ts` | same dir, same name | extract from existing inline impl in `CodeMirrorEditor.tsx` |
| `packages/app-core/src/lib/virtual-list.ts` | `packages/lattice-core/src/lib/virtual-list.ts` | direct |
| `packages/app-core/src/lib/fuzzy-score.ts` | `packages/lattice-core/src/lib/fuzzy-score.ts` | direct — needed for command palette ranking |
| `packages/app-core/src/lib/tab-scroll-memory.ts` | `packages/lattice-core/src/lib/tab-scroll-memory.ts` | direct |
| `packages/app-core/src/components/{CommandPalette,BufferPalette,OutlinePalette,SearchPalette,TemplatePalette}.tsx` | `packages/lattice-core/src/components/palettes/` | adjust to our Zustand store names |
| `packages/app-core/src/components/WhichKeyOverlay.tsx` | same | direct |
| `packages/app-core/src/components/CalendarPanel.tsx` | `packages/lattice-core/src/components/calendar/CalendarPanel.tsx` | keep, then re-wire to `impl-v2.md` §1 cal store |
| `apps/desktop/src/mcp/{server.ts, vault-ops.ts, instructions.ts}` | `apps/desktop/src-tauri/src/mcp/{server.rs, tools.rs, instructions.rs}` | TS → Rust; use `rmcp` |
| `apps/desktop/src/cli/index.ts` (command structure only) | `apps/cli/src/main.rs` | TS structure → `clap` derive |

Every row above is "verbatim if license-compatible, otherwise pattern-borrowed." ZenNotes is MIT; Lattice can ingest verbatim provided LICENSE / NOTICE attribution is preserved in the new files.

---

## Appendix B — What we explicitly de-scope from v3

- **CRDT live collaboration.** Stays as `impl.md` Phase 2 / `impl-v2.md` open question. v3 ships single-writer-per-vault with last-write-wins on BYOC conflicts (per `byoc-plan.md`).
- **Mobile (Tauri 2 mobile).** Read-only web mode on mobile is the v3 answer; native mobile editor is v4.
- **Plugins (WASM Preview 2).** Stays as `impl-v2.md` §5. The bundled BYOC/BYOM/daily-notes "plugins" ship as in-tree crates in v3, then promote to dynamically-loaded plugins in v4.
- **Multi-tenant server.** v3 server is single-tenant only (bearer token or single session). Multi-tenant is v4.
- **Hosted SaaS.** Same — v3 is self-host only.
- **Terminal panel.** Activity-strip icon stays "(Coming soon)" until v4.
- **AI features beyond MCP.** No commit-message autogen, no embeddings, no semantic search. MCP is the surface; the user picks the model and the agent.
- **E2EE.** Deferred until BYOC is real — encryption with no sync is theatre. `impl-v2.md` §9 design is correct; v4 ships it.

---

## Appendix C — Glossary additions

- **Bridge contract** — `LatticeBridge` interface in `packages/lattice-bridge-contract`. The single place that defines what the runtime exposes to React.
- **Bridge implementation** — `TauriBridge`, `LocalWebBridge`, `RemoteBridge`. Concrete classes selected at app startup by the host shell.
- **Capability flag** — `LatticeCapabilities` field. Lets a single component branch on runtime affordances without runtime checks for `window.__TAURI__`.
- **`primaryNotesLocation`** — `inbox` (the default lifecycle) or `root` (Obsidian-style flat vault). Setting in `.lattice/vault.json`.
- **Vault verb** — one of the ~30 methods on `Vault` in `lattice-vault-rs`. The unit of authorisation for plugins (later) and MCP tools (now).
- **Mode A / B / C / D** — server-on-host / browser-PWA-only / multi-user-server / hosted-SaaS, per `zennotes/docs/web-architecture.md` and applied here.

---

*End of v3 plan. The next doc to write — once W1 is in flight — is `docs/migration-monorepo.md` with the per-file PR sequence.*

---

## Appendix D — ZenNotes README parity audit (2026-06-10)

A line-by-line pass of [`zennotes/README.md`](../../zennotes/README.md) against this plan. Every feature ZenNotes advertises in its README is listed with its v3 disposition. Where the disposition is "deferred to v4" it is also added to Appendix B.

| # | ZenNotes README feature | v3 disposition | Section |
|---|---|---|---|
| 1 | macOS .dmg signed + notarized | ✅ ships in v3 | §10.2 |
| 2 | Windows .exe (optionally signed) | ✅ ships in v3 | §10.2 |
| 3 | AUR `*-bin` (no libfuse2) | ✅ ships in v3 | §10.1 |
| 4 | Native `.pacman` | ✅ ships in v3 | §10.1 |
| 5 | `.deb` for Debian/Ubuntu | ✅ ships in v3 | §10.1 |
| 6 | AppImage (with FUSE-free `--appimage-extract-and-run` doc) | ✅ ships in v3 | §10.1 |
| 7 | CLI installed from Settings → CLI | ✅ ships in v3 | §8.3 |
| 8 | Self-hosted web app + Go server | ✅ ships in v3 (Rust axum instead of Go) | §5 |
| 9 | Plain `.md` files on disk, no DB | ✅ already true; reinforced | §4.5 |
| 10 | Keyboard-first / Vim / leader / palette / pane motion / ex commands / help | ✅ ships in v3 (vim + which-key + palettes + slash) | §6 |
| 11 | Edit / Preview / Split / Pinned-reference / Detached-window | ✅ ships in v3 | §10.5 |
| 12 | First-party MCP server, install to compatible clients | ✅ ships in v3 (5 clients) | §7 |
| 13 | Notes, folders, lifecycle: create/rename/duplicate/move/archive/unarchive/trash/restore/reveal | ✅ ships in v3 | §3.3 |
| 14 | Watch the vault for external changes | ✅ ships in v3 | §3.5 |
| 15 | Reopen workspace layout (tabs + panes) | ✅ ships in v3 | §10.5 |
| 16 | Lifecycle areas: quick / archive / trash | ✅ ships in v3 | §3.2 |
| 17 | Main notes area: `inbox/` OR vault root (Obsidian-style) | ✅ ships in v3 | §3.2 + §4.5 |
| 18 | Customizable built-in folder labels (without changing internal ids) | ✅ ships in v3 | §3.2 (`folderLabels`) |
| 19 | Daily notes (optional, ISO-date titles, `Daily Notes/` default dir) | ✅ ships in v3 | §3.2 + §13.5 |
| 20 | CM6 editor: live preview, heading fold, outline jumps, line numbers, line-height, syntax highlighting | ✅ ships in v3 | §4.2 |
| 21 | Editor: wiki links, callouts, tables, footnotes, local embeds | ✅ ships in v3 | §4 + §11.6 |
| 22 | Vim block cursor and keyboard navigation | ✅ ships in v3 | §6.1 |
| 23 | Preview: GFM, KaTeX, **Mermaid, TikZ, JSXGraph, function-plot**, callouts, footnotes, wiki links, backlinks | ✅ ships in v3 (KaTeX/Mermaid/callouts/footnotes/embeds in W2; TikZ/JSXGraph/function-plot in W4) | §11.6 |
| 24 | Note search by title/path | ✅ ships in v3 | §11.5 |
| 25 | Vault-wide text search | ✅ ships in v3 | §11.5 |
| 26 | Tags view | ✅ ships in v3 | §4.2 (tag pane) |
| 27 | Tasks view | ✅ ships in v3 | §11 (Kanban from `scan_tasks`) |
| 28 | Archive / Trash / Quick views | ✅ ships in v3 | §3.3 |
| 29 | Built-in help/manual | ⏩ v4 (in-app help renderer) | Appendix B |
| 30 | **Pluggable search backend: builtin / ripgrep / fzf with auto-detection + custom paths** | ✅ ships in v3 | §11.5 |
| 31 | `zen` CLI: list/read/search/capture/edit/archive/trash/tasks/folders/MCP | ✅ ships in v3 (as `lattice`) | §8.1 |
| 32 | macOS Raycast extension, installed locally from Settings | ✅ ships in v3 | §8.4 |
| 33 | `zennotes://` deep links | ✅ ships in v3 (as `lattice://`) | §10.4 |
| 34 | Obsidian-friendly: primary notes at root, loose files surfaced, `![[image.png]]` resolves Obsidian-style | ✅ ships in v3 | §4 |
| 35 | Legacy `attachements/` and `_assets/` recognised | ✅ ships in v3 | §3.2 |
| 36 | Local assets in sidebar/list views | ✅ ships in v3 | §3.3 (`list_assets`) |
| 37 | Images / SVGs / videos / audio / PDFs / media open inside app tabs | ✅ ships in v3 | §11.6 |
| 38 | Desktop reveal-in-Finder / file-manager | ✅ ships in v3 | bridge verb `revealInFileManager(rel)` |
| 39 | Watcher includes non-Markdown file changes | ✅ ships in v3 | §3.5 |
| 40 | Sidebar multi-select (Cmd/Ctrl-click toggle, Shift-click range, drag-to-folder, batch context menu) | ✅ ships in v3 | §10.5 |
| 41 | Settings: theme families, light/dark/auto, fonts × 3, font-size, line-height, widths, alignment, keymap overrides, vim toggles, leader-hint, search backend, vault layout, daily notes, system-folder labels | ✅ ships in v3 (full inventory) | §13.5 |
| 42 | Native menus (desktop-only) | ✅ ships in v3 | capability-gated |
| 43 | App auto-updater | ✅ ships in v3 | §10.3 |
| 44 | Floating note windows (desktop-only) | ✅ ships in v3 | §10.5 |
| 45 | MCP install/uninstall flows for supported clients | ✅ ships in v3 — Claude Desktop, Claude Code, **Codex**, Cursor, Zed | §7.4 |
| 46 | Web/self-hosted: same shared UI, Go backend, vault picker, browser access | ✅ ships in v3 (Rust axum backend) | §5 + §6 |
| 47 | **Connect Desktop to Remote Server** (the 5th mode) | ✅ ships in v3 | §6.3 mode E |
| 48 | Monorepo layout | ✅ ships in v3 | §2 |
| 49 | Docker self-hosting (`make up / down / restart / logs / status / open / rebuild / nuke / clean`) | ✅ ships in v3 (`Makefile` mirrored) | §5 + §5.2 |
| 50 | Docker secure-by-default: 127.0.0.1 bind, bootstrap auth token, HttpOnly session cookie, local UID/GID, read-only root, `no-new-privileges`, dropped caps | ✅ ships in v3 | §5.2 + §5.4 + §5.5 |
| 51 | `*_VAULT_PATH` hard-lock mode | ✅ ships in v3 | §5.2 |
| 52 | `*_DEFAULT_VAULT_PATH`, `*_BROWSE_ROOTS`, `*_ALLOWED_ORIGINS`, `*_ALLOW_UNSCOPED_BROWSE`, `*_ALLOW_INSECURE_NOAUTH` | ✅ ships in v3 | §5.2 |
| 53 | Web client / server **version-skew detection** with clear error UI | ✅ ships in v3 | §5.2 |
| 54 | Web vault picker (server-side, scoped to allowed roots, sensible starts, macOS shortcuts) | ✅ ships in v3 | §5.3 (`/fs/browse`) |
| 55 | Tokens never in URLs / local-storage; HttpOnly session cookie | ✅ ships in v3 | §5.2 |
| 56 | Signed/notarized release pipeline enforced in CI | ✅ ships in v3 | §10.2 |
| 57 | **At-rest vault encryption** (docs/how-to/at-rest-encryption.md) | ⏩ v4 — but the Settings → Security row ships disabled in v3 so layout is stable | §13.5 + Appendix B |
| 58 | Diataxis docs structure (tutorials / how-to / reference / explanation) | ✅ ships in v3 (docs reorg PR alongside W1) | new — add `docs/tutorials/`, `docs/how-to/`, `docs/reference/`, `docs/explanation/`, keep `impl*.md` at root |
| 59 | Vim *leader-hint behavior* setting (always / on-pause / never) | ✅ ships in v3 | §13.5 |
| 60 | Light/dark/auto + theme families | ✅ ships in v3 | §13.5 |

**Net result:** of 60 README-surfaced features, **58 ship in v3** and **2 are explicitly deferred to v4** (in-app help manual, at-rest encryption — with the latter's Settings row shipped disabled so the UI doesn't shift later). No README feature is silently dropped.

**Things Lattice ships that ZenNotes' README does not** (the actual moat):

- Git-native VCS with Changes-panel UI (`git.rs` shipped; `byoc-plan.md` for the Pro-grade flow).
- JSON Canvas 1.0 read/write with selection / connect / arrange tools (shipped).
- Force-graph view with focus mode and reseed animation (shipped).
- Academic paper export (Typst + Tectonic + BYOF) per `paper-export-plan.md`.
- Quartz-based publishing to GitHub Pages / Cloudflare / Netlify / Vercel per `publishing-plan.md`.
- BYOC sync (GitHub / Drive / OneDrive / Dropbox / WebDAV) with zero Lattice server per `byoc-plan.md`.
- BYOM (Ollama / OpenAI / Anthropic / Azure / HF) per `impl-v2.md` §5.3.
- Calendar integration (Outlook+Teams / Cal.com / Google / Apple) per `impl-v2.md` §1.
- Bidirectional Obsidian compat as a hard product rule (§4.5) — ZenNotes is one-way (Obsidian → ZenNotes works; ZenNotes → Obsidian leaks lifecycle history).
- `vcs_*` and `get_vault_graph` MCP tools (§7.2 bonuses) — neither exists in ZenNotes.
- Calendar-aware daily notes (`impl-v2.md` §1.5 + §2.3) — ZenNotes has daily notes but no calendar coupling.

The README pass therefore *confirms* the v3 plan rather than expanding it materially; the only genuinely new architectural item it added was **mode E (desktop-as-remote-client) in §6.3**, which is a 3-day add on the back of the bridge contract.
