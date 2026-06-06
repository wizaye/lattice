# Lattice — Implementation Plan v2

> **Companion docs**
> - [`impl.md`](impl.md) — original (phase-1 roadmap, still authoritative for what's built so far)
> - [`current-state.md`](current-state.md) — what is shipping vs that plan and why we diverged
> - **This doc (`impl-v2.md`)** — the v2 roadmap: calendar, journaling, plugins (BYOC + BYOM), CLI, default VCS, databases-from-scratch, academic/student bundle, onboarding, importers, and end-to-end encryption

Last updated: 2026-06-06

> [!NOTE]
> The E2E encryption section (§9) is the only one written from first-principles web research (Obsidian Sync security model, age/`rage` cryptosystem, Standard Notes account-vs-encryption-passphrase split, MS Graph documentation). Everything else is opinionated design that builds on what already ships in this repo.

---

## 0. North-star recap

> **One offline-first PKM that is delightful for students, trustworthy for enterprises, and hackable for senior engineers.**

Three personas drive every decision:

| Persona | Default workflow | Must-have batteries |
|---|---|---|
| **Student / normal user** | Notes + journaling + Google Calendar + canvas + PDF export | Onboarding wizard, IEEE/APA export, daily-notes plugin, Google Calendar sync |
| **Enterprise / M365** | Notes + Outlook/Teams meeting capture + secure vault | Entra-ID sign-in, Teams transcript ingest, E2E encryption, MDM-friendly settings |
| **OSS dev / senior engineer** | Same vault from CLI, BYOM AI in Ollama, BYOC sync to GitHub | `lattice` CLI (ratatui), BYOM, plugin API, Cal.com integration |

A feature ships only when *one* persona is fully unblocked by it.

---

## 1. Calendar — three integration tiers

All three tiers feed the **same internal calendar store** (one event model, one UI). Provider differences live in a thin adapter layer.

### 1.1 Unified internal model
- New module `src-tauri/src/calendar/mod.rs`.
- One Rust type:
  ```rust
  pub struct CalEvent {
      pub id: String,            // provider-prefixed: "ms:<id>", "google:<id>", "calcom:<id>"
      pub source: CalSource,     // Outlook | GoogleCalendar | AppleCalendar | CalCom | Local
      pub start: DateTime<Utc>,
      pub end: DateTime<Utc>,
      pub title: String,
      pub body_md: Option<String>,
      pub attendees: Vec<String>,
      pub meeting_url: Option<String>,
      pub teams_meeting_id: Option<String>, // populated for Outlook events that have Teams join info
      pub note_path: Option<PathBuf>,       // backlink: which vault file represents this event
      pub etag: Option<String>,
  }
  ```
- Local cache in `.lattice/calendar.db` (SQLite). Refreshed on app open + every N minutes. ETags / deltaLinks where the provider supports them so refresh is cheap.
- The frontend always reads from this cache through one zustand slice — providers are invisible to the UI.

### 1.2 Tier A: Outlook + Teams (M365 / enterprise)
**Scope:** Pull Outlook calendar events, expand Teams meetings, fetch transcripts + Copilot AI insights, generate meeting-note files.

| Concern | Choice |
|---|---|
| Auth | Entra ID (MSAL) — OAuth 2.0 authorization code + PKCE, system browser, loopback redirect, tokens in OS keychain |
| Scopes | `User.Read`, `Calendars.Read`, `OnlineMeetings.Read`, `OnlineMeetingTranscript.Read.All` |
| Endpoints | `GET /me/calendar/events` (event list) → for each Teams event, `GET /me/onlineMeetings?$filter=joinWebUrl eq '...'` (resolve meeting id) → `GET /me/onlineMeetings/{id}/transcripts` (list) → `GET .../transcripts/{tid}/metadataContent` (speaker-tagged JSON over `WEBVTT`) |
| AI insights | `GET /me/onlineMeetings/{id}/aiInsights` (beta) — pulls Copilot-generated summary, action items, mentions. Gated behind the user's Copilot for M365 license. Falls back to "transcript only" if 403. |

**Note generation:** Every accepted/owned event becomes (on-demand or auto) a markdown file at `<vault>/Meetings/YYYY-MM-DD HHmm <slug>.md`:

```markdown
---
type: meeting
source: outlook
event_id: AAMkAGI...
start: 2026-06-12T15:00:00Z
end: 2026-06-12T16:00:00Z
attendees: [alice@contoso.com, bob@contoso.com]
teams_meeting_id: MSo1N2Y5ZGFjYy...
---

# Sprint review — 12 Jun

> [!summary] Copilot summary
> <ai-generated summary or "Awaiting transcript">

## Action items
- [ ] [[Alice]] — ship onboarding wizard
- [ ] [[Bob]] — finalize encryption KDF params

## Transcript
<speaker-tagged transcript pulled from metadataContent>
```

**Why this format:** Markdown means the note works offline, lives in the user's vault, links into the graph view (action-item `[[Alice]]` becomes a real backlink), and survives even if Lattice is uninstalled.

**Enterprise specifics:**
- App registered as multi-tenant; tenant admins use `/adminconsent` to grant org-wide.
- Tenant settings push: read OPA-style policy JSON from `<vault>/.lattice/policy.json` (signed by IT). Restricts plugins, requires E2EE, forces certain note locations.
- Logging: all Graph calls behind a single `graph_client.rs` so we can add Microsoft Entra audit fields and respect `Retry-After`.

### 1.3 Tier B: Cal.com (OSS devs)
**Scope:** Read + write a developer's own Cal.com bookings; surface them in the calendar view; create event-type templates from the vault.

| Concern | Choice |
|---|---|
| Auth (default) | Personal API key — user pastes `cal_live_*` from Cal.com → Settings → Security into Lattice → Settings → Calendar → Cal.com. Stored in keychain. |
| Auth (verified-app upgrade) | Cal.com OAuth client once we publish to the App Store — same PKCE pattern as everything else. |
| Endpoints (v2) | `GET /bookings` (list, supports `status`, `take`, `skip`), `GET /event-types`, `POST /bookings` to schedule from the calendar UI. Rate limit: 120 rpm for API key auth — adequate for individual use. |
| Webhook | Optional: register a webhook to our local clipper-style receiver (§7) so new bookings instantly create a meeting note. |

**Why API key first:** Cal.com OAuth requires a verified-partner registration; an API key works in 30 seconds and is the right default for the self-hosted OSS user.

### 1.4 Tier C: Google Calendar + Apple Calendar (students / everyone else)

**Google Calendar:**
- OAuth 2.0 with PKCE (Google supports it for installed apps since 2022).
- Scope: `https://www.googleapis.com/auth/calendar.events.readonly` for read-only (default); upgrade scope when the user enables "create events from Lattice."
- Endpoints: `GET /calendar/v3/users/me/calendarList`, `GET /calendar/v3/calendars/{id}/events?syncToken=...` (incremental).
- Note: Google doesn't sign Chrome extensions for desktop OAuth — we ship the **client ID** in the binary (it's not a secret for installed apps; PKCE is the secret) and use the system browser with a loopback redirect.

**Apple Calendar:**
- **macOS:** Native EventKit via a small Swift sidecar (`lattice-eventkit-helper`). Requests calendar permission via the system prompt. Read-only in v1.
- **Windows + Linux:** CalDAV. Apple's iCloud CalDAV endpoint requires an app-specific password from appleid.apple.com — paste it in Settings → Calendar → Apple Calendar (stored in keychain).
- Library: [`minicaldav-rs`](https://crates.io/crates/minicaldav) or similar — small enough to vendor.

### 1.5 Calendar UI
- New left-sidebar view: `LeftView = ... | "calendar"`.
- Three sub-views: **Day**, **Week**, **Month**. Standard grid; events colored by source.
- Click an event → opens the linked note (creates one on demand using the §1.2 template).
- Right-rail panel inside the calendar: "Today" — events + journal entry for the day.
- "+ New event" → if Cal.com or Outlook is connected, prompts which calendar to write back to.

---

## 2. Journaling — Logseq-style daily notes

### 2.1 Storage
- Folder `<vault>/journals/` (created on first use).
- One file per day: `YYYY-MM-DD.md`. Matches Logseq exactly so cross-tool imports/exports just work.
- Optional weekly/monthly rollups: `2026-W23.md`, `2026-06.md` (config in Settings → Daily notes).

### 2.2 First-class outliner mode
Logseq's killer feature is the outliner — every line is a bullet block with foldable children. We expose it as a CodeMirror **mode toggle** on a per-file basis (frontmatter `outliner: true` or path-prefix rule for `journals/`):

- Each top-level `- ` line is a "block." Tab/Shift-Tab indent/outdent. Enter splits, keeps depth.
- Folding glyph on hover.
- `((block-ref))` syntax for transclusion (Logseq parity) — rendered in reading mode as embedded blocks.
- Block IDs are stable: a hidden HTML comment `<!-- id: <uuid> -->` is appended on first reference, so links survive reflow.

### 2.3 Calendar integration
- Calendar view's "Today" panel embeds the active day's journal entry inline. Editing it in either place updates the same file.
- Long-press / right-click a day cell → "Create journal entry."
- Default new-day template configurable (`<vault>/.lattice/templates/journal.md`).

### 2.4 Daily notes plugin slot
- Built as the first **first-party plugin** (see §5) so the same loader can host community work later. The plugin owns:
  - Folder path + filename format.
  - Template body.
  - "Open today's note" command (`Ctrl+Shift+D`).
  - Status-pill streak indicator.

---

## 3. Canvas — additional tools

The current canvas (`src/components/canvas/CanvasView.tsx`) reads/writes JSON Canvas 1.0 with text/shape/draw/group nodes + edges. Round out the toolset to match Excalidraw-class apps without bringing in Excalidraw itself.

### 3.1 New tools (priority order)
1. **Sticky notes** — text node with colored background, larger default font. (Trivial: extends `CanvasTextNode`.)
2. **Image node** — drag a file from the vault or system into the canvas; embed by relative path. Spec-compliant `file` node type.
3. **Embedded note card** — drop a markdown file → renders its title + first 200 chars; click opens it in a new tab.
4. **Arrow style polish** — head/tail markers, dashed/dotted, label-on-edge.
5. **Layers panel** — z-order management with named layers.
6. **Snap to grid + smart guides** — already have grid dots; add 8px snap and live alignment lines.
7. **Frames** — named bounded regions for export.
8. **Mini-map** in the corner (re-uses the canvas renderer at low LOD).
9. **Multi-select transform handle** — group resize/rotate.
10. **Connector routing** — orthogonal/curved options for edges between two boxes.

### 3.2 Research-paper export (academic bundle hook)
- "Export frame as SVG" — outputs a clean SVG (no transform clutter) sized to the frame.
- "Export frame as TikZ" — for LaTeX users; emits the same shapes as TikZ nodes/arrows. Best-effort for free-strokes (converts to `\draw [smooth] coordinates {...}`).
- "Export frame as PNG @ 2×" — for Word/Google Docs.

These three actions live behind the `frame.context_menu` so they only appear when a frame is selected — keeping the canvas chrome quiet for casual users.

---

## 4. Default VCS — every vault is version-controlled

Already sketched in [`current-state.md`](current-state.md#51-local-vcs-layer-the-git-style-change-graph). This section adds the **intelligent commit message** and **tree-of-changes UX** the user asked about.

### 4.1 Commit cadence
- **Auto-commit** every 60 s of idle (configurable: off / 30 s / 1 m / 5 m / manual-only).
- **Snapshot on save** — fast in-memory checkpoint; promoted to a real commit at the next idle window. This means even an immediate crash recovery has a per-save snapshot to revert to.
- **Manual commit** in the Changes panel with a message box.

### 4.2 Intelligent commit messages
Normal users don't know what to write. We generate one for them.

**Local heuristic (always on, zero deps):**
- 1 file changed, ≤ 20 lines: `Edit <filename>: <first added heading or first 60 chars of the diff>`
- 1 file created: `Create <filename>`
- 1 file deleted: `Delete <filename>`
- 1 file renamed: `Rename <old> → <new>`
- N files in same folder: `Edit N files in <folder>`
- Mixed: `Edit <topfile>, <topfile2> and N other files`

**BYOM-powered (opt-in, see §6):**
- If a BYOM provider is configured AND the user opted in for commit assist, send the diff stat + the first 2 KB of each hunk to the model with prompt:
  > "Summarize this vault change set in one imperative sentence ≤ 60 characters. Output only the sentence."
- Local Ollama (default) keeps it private; cloud providers gated by an explicit per-session toggle.

### 4.3 Changes panel — visual git
- Left sidebar `LeftView = ... | "changes"`.
- Three sub-panes:
  1. **Working changes** — modified files since last commit, with diff preview on click and per-file revert.
  2. **Commit graph** — vertical lane of commits (one column for the current branch; provider branches stacked as lanes when BYOC is set up). Each node: hash, message, file count, timestamp. Click → full diff of that commit. Right-click → revert that commit, branch from here.
  3. **Branches** — explicit branches (one for each sync provider + named "drafts"). Drag-drop merge: drop a branch onto another → 3-way merge with conflict markers in the affected files.

### 4.4 Storage
- `.lattice/objects/<sha256>` — content-addressed blobs (BLAKE3 was tempting but SHA-256 is in Rust std + matches what every git tool understands).
- `.lattice/commits.db` (SQLite): `(id, parent, author, ts, message, ai_generated)`.
- `.lattice/refs/<branch>` — text file with the head commit id.
- `.lattice/HEAD` — symbolic ref pointer.

### 4.5 Rust commands
| Command | Purpose |
|---|---|
| `vcs_status` | `{staged: [], modified: [], untracked: []}` |
| `vcs_commit(message?)` | If `message` is `None`, generate one. Returns new commit id. |
| `vcs_log(limit, branch?)` | DAG slice for the graph view. |
| `vcs_diff(commit_id, file?)` | Unified diff. |
| `vcs_revert_file(commit_id, file)` | Restore one file from one commit. |
| `vcs_branch(name, from?)` | Create a branch. |
| `vcs_merge(from, into)` | 3-way merge with conflict markers. |
| `vcs_blame(file, line?)` | Per-line provenance (commit + ts). |

---

## 5. Plugin system — BYOC (default batteries) + BYOM + community

### 5.1 Plugin host architecture
- Plugins are **WASM components** (WASI Preview 2) loaded by the Rust shell. Why WASM:
  - **Sandboxed** by default — no fs/network access unless the manifest declares the capability.
  - **Language-agnostic** — community can write in Rust, AssemblyScript, JS via QuickJS, Python via componentized CPython.
  - **Fast** — Wasmtime + AOT compilation; cold-start is ms-scale.
- Each plugin ships:
  - `manifest.toml` (id, name, version, capabilities, ui-slots).
  - `plugin.wasm` (the component).
  - `assets/` (icons, css, sample data).
- Manifest example:
  ```toml
  id = "lattice-byoc-github"
  name = "BYOC — GitHub"
  version = "0.1.0"
  capabilities = ["vault.read", "vault.write", "net.https(github.com,api.github.com)", "keychain"]
  ui_slots = ["settings.section", "sidebar.changes.lane", "command.palette"]
  ```
- Host API exposed to plugins via WIT interfaces under `crates/lattice-plugin-api/`:
  - `lattice:vault/read`, `lattice:vault/write`
  - `lattice:vcs/log`, `lattice:vcs/push-objects`
  - `lattice:ui/register-settings-section`, `lattice:ui/register-command`
  - `lattice:net/https-request` (gated)
  - `lattice:keychain/get|set` (gated)
  - `lattice:ai/inference` (BYOM router — see §6.4)

### 5.2 BYOC (default batteries — bundled, can be disabled)
The plugin bundle ships in-tree at `crates/plugins-builtin/byoc-*` and is enabled by default. From the user's POV, "Sync" works out of the box; under the hood it's the same plugin contract a community provider would use.

**Adapters (ship with v1):**
1. `byoc-github` — repo-as-storage, OAuth Device Code (works in CLI too).
2. `byoc-gdrive` — Drive app-folder, PKCE + system browser.
3. `byoc-onedrive` — Graph `/me/drive/special/approot`, MSAL.
4. `byoc-dropbox` — `/Apps/Lattice/<vault>`, PKCE.
5. `byoc-icloud` — macOS only in v1; Windows/Linux greyed out with tooltip.
6. `byoc-webdav` — generic fallback for Nextcloud, ownCloud, self-hosted (basic auth + bearer token).

**Shared base crate** `byoc-core/` (Rust): trait `SyncProvider`, conflict UI helpers, retry/backoff, content-addressed upload/download. Adapters just implement the trait.

**Sync wire format:** each commit is `(commit-id.json, objects/<sha>...)` blobs. Provider is a dumb object store.

**E2EE layered on top:** see §9. The sync layer never sees plaintext when encryption is enabled.

### 5.3 BYOM (Bring Your Own Model)
Same plugin contract, different host-API surface. Models are first-class providers.

**Providers (ship with v1):**
1. `byom-ollama` — local Ollama daemon at `http://localhost:11434`. Auto-discovers installed models. **Default for new users** because zero-cost, zero-network.
2. `byom-openai-compatible` — generic OpenAI-format HTTP backend. Covers OpenAI, Groq, Together, Fireworks, LM Studio, vLLM, llama.cpp server, OpenRouter. Configurable base URL + API key.
3. `byom-anthropic` — direct Claude Messages API.
4. `byom-google-gemini` — direct Gemini API.
5. `byom-azure-openai` — Entra-ID or key auth; needed for the enterprise tier.

**Capabilities a model plugin declares:**
- `chat` — multi-turn completion.
- `embed` — vector embeddings (for the upcoming semantic search).
- `tool-use` — function-calling support (drives agent features).
- `vision` — image input (canvas analysis, screenshot-to-note).

**Context injection (the "deep integration"):**
The BYOM router exposes a `lattice:ai/context` API that lets plugins request:
- Active note text + frontmatter
- Open tabs' titles + first N lines
- Selected text only
- The user's last K backlinks-or-mentions for the active note
- Recent N journal entries
- A vector-search result over the vault (if `embed` capability is available)

Plugins compose these into prompts; the router ensures no chunk is sent to a provider the user hasn't whitelisted for that scope.

**Privacy controls (mandatory UI):**
- Settings → AI shows a matrix: rows = providers, columns = data scopes (`note`, `selection`, `vault search`, `entire file`).
- Each cell is allow/ask/deny. Default for any cloud provider is **ask**; default for local Ollama is **allow** for everything.
- Sent-payloads log: every cloud request shows up in Settings → AI → Activity with a "View payload" button.

### 5.4 Community plugins (later)
- Discovery: `lattice.md/plugins` (static site backed by a GitHub repo of submitted manifests + signed `plugin.wasm` releases).
- Sigsum (the same supply-chain proof system age uses) for release attestations.
- Settings → Community plugins → browse / install / update / disable.
- Quarantine on first run: capability prompt before granting net/keychain.

---

## 6. CLI — `lattice` (ratatui)

For senior engineers who want to live in the terminal.

### 6.1 Crate layout
```text
crates/
  lattice-core/        # existing — shared vault/vcs/sync types
  lattice-cli/         # NEW — binary "lattice"
  lattice-plugin-api/  # WIT defs shared with desktop
```

`lattice-cli` depends on `lattice-core` so it speaks the exact same vault/vcs format as the desktop app — open a vault from CLI, edit from desktop, no migration.

### 6.2 Commands (sub-commands via `clap`)
| Command | Purpose |
|---|---|
| `lattice init <path>` | Initialize a vault (`.lattice/` skeleton + sample journal). |
| `lattice open [path]` | Launch the ratatui dashboard. |
| `lattice new [--journal\|--meeting] <title>` | Create a note (templates honored). |
| `lattice search <query>` | Full-text + tag search; pipes results. |
| `lattice graph` | ASCII graph stats: nodes, edges, top hubs, communities. |
| `lattice log` | `git log`-style commit history. |
| `lattice diff [commit] [file]` | Unified diff. |
| `lattice commit -m <msg>` | Manual commit (omit `-m` for AI-generated). |
| `lattice sync [provider]` | Push/pull through configured BYOC adapters. |
| `lattice export <file> --as pdf\|tikz\|html` | Hooks the same exporters the desktop uses. |
| `lattice ai <prompt>` | One-shot BYOM call with active vault as context. |
| `lattice plugin {list,install,disable}` | Plugin management. |
| `lattice serve` | Headless WebDAV server so other devices on LAN can edit the vault. |

### 6.3 ratatui dashboard layout
Three-pane TUI mirroring the desktop:
- Left: file tree + activity icons (Files, Search, Graph, Changes, Calendar).
- Center: editor (Helix-style modal editing — `hx` library) or graph (ASCII force layout).
- Right: backlinks / outline.
- Bottom: status line (vault, branch, dirty count, AI provider, sync status).

Designed to feel like `helix` and `lazygit` had a kid — opinionated, modal, fast. Mouse-optional.

### 6.4 Performance bar
- Cold-start: < 50 ms to the dashboard on a 10 k-note vault.
- Search: < 100 ms across 100 k notes via the same SQLite FTS5 index that powers the desktop.
- All Rust — no JS in the CLI binary.

---

## 7. Databases — design plan (from scratch)

A first-class table/kanban/gallery layer over the vault, comparable to Notion databases but file-backed and SQL-queryable.

### 7.1 File format — `.lattice-db`
- Pure JSON for human-edit-ability + git diff friendliness.
- One `.lattice-db` per database. Lives anywhere in the vault.

```json
{
  "id": "01HXYZ...",
  "name": "Research Papers",
  "schema": [
    {"name": "title", "type": "text", "required": true},
    {"name": "authors", "type": "multi-relation", "target": "people.lattice-db"},
    {"name": "year", "type": "number", "min": 1900},
    {"name": "topics", "type": "multi-tag"},
    {"name": "read", "type": "checkbox"},
    {"name": "rating", "type": "number", "min": 1, "max": 5},
    {"name": "notes", "type": "rich-ref", "target": "Papers/", "create_on_blank": true}
  ],
  "views": [
    {"id": "all", "kind": "table", "sort": [{"field": "year", "dir": "desc"}]},
    {"id": "kanban-by-status", "kind": "kanban", "group_by": "read"},
    {"id": "gallery", "kind": "gallery", "cover_field": "preview_image"}
  ]
}
```

### 7.2 Row storage — two modes
**Mode A: "embedded rows"** (small DBs, ≤ 500 rows).
- Rows stored inline in the `.lattice-db` JSON.
- Git-diff friendly, zero-setup.

**Mode B: "note-backed rows"** (large DBs, every row is a note).
- Each row is a markdown file under a configured folder (e.g. `Papers/<title>.md`).
- Frontmatter holds the structured fields; the markdown body is the long-form notes.
- The `.lattice-db` file only stores schema + views; rows are discovered by scanning the folder.
- **This mode IS Obsidian Bases** — interop is automatic.

User picks the mode when creating the DB. Switching is reversible (we provide an import/export between the two).

### 7.3 Query layer
- Backed by SQLite (the same `.lattice/index.db` that backs search). Frontmatter properties are indexed on file save.
- Views query that index — no per-render full vault walk.
- Optional: expose a SQL panel in the database UI for power users (read-only by default; writes go through the standard frontmatter write path).

### 7.4 Views (v1)
1. **Table** — Notion-style editable grid. Inline cell editors per type.
2. **Kanban** — group by a single-value field (`select`, `checkbox`, `relation`).
3. **Gallery** — card grid with a cover image field.
4. **Calendar** — group by a date field; reuses the calendar widget from §1.
5. **Timeline** — Gantt-ish; group by date + duration fields.
6. **List** — minimal one-row-per-line for outline-style DBs.

### 7.5 Relations
- `relation` and `multi-relation` field types point at other `.lattice-db` files or folders.
- Rendered as chips; click chip → opens the target row's note.
- Back-relations auto-computed (no need to declare both directions).

### 7.6 Why not SQL-first
Could store everything in SQLite from the start. We don't because:
- Vault portability — JSON travels through any sync provider.
- Diff/merge — DBs play nicely with the default VCS (§4) when rows are real text.
- Trust — users can hand-edit a `.lattice-db` if Lattice itself is unavailable.

SQLite is the index, never the source of truth.

---

## 8. Student / academic bundle

A single "Academic" preset enabled at onboarding for the `Student` persona. Bundles plugins that lecturers and grad students actually use.

### 8.1 IEEE / Springer / APA out-of-the-box (LaTeX backend)
- **Approach:** Markdown → Pandoc-flavored extensions → Typst OR Tectonic LaTeX → PDF.
- **Why Typst as default:** single-binary, no TeX Live, no fonts.conf, builds offline in < 1 s. Ship `typst.wasm` bundled with the app, ~5 MB.
- **Why ship Tectonic too:** for users who *need* a specific publisher template that exists only as a `.cls`. Tectonic downloads packages on demand from CTAN; we vendor a frozen mirror for offline use.
- **Templates shipped:**
  - IEEE Conference (Typst).
  - IEEE Journal (Typst).
  - Springer LNCS (Typst).
  - ACM (Typst).
  - APA 7 (Typst).
  - The "publishers we couldn't reimplement" set ships as `.cls` packs for Tectonic.
- Export dialog: pick template → pick author/affiliation block → render → preview PDF inline.
- Citation handling: Pandoc-style `[@key]` + `references.bib`. BibTeX file auto-imports from Zotero if installed (read `~/Zotero/storage/...`).

### 8.2 Canvas → diagram export for papers
Already mentioned in §3.2 — frame exports as SVG, TikZ, or PNG @ 2×. Adds a one-click "Insert into LaTeX/Typst draft at cursor" if the active editor is a `.tex`/`.typ` file.

### 8.3 PKM graph as research tool
The graph view already exists. Academic-specific add-ons:
- **Citation graph overlay** — when notes have `cites: [@key1, @key2]` frontmatter, draw those as a second edge color.
- **Concept clustering** — petgraph community detection (now on the roadmap; powers "Stats for Nerds" too).
- **Timeline mode** — replace the force layout with one X-axis = `date:` frontmatter; visualizes how an idea evolved.

### 8.4 Journaling
Same as §2 — the academic preset just enables it by default and adds a "Lab notebook" template (date, hypothesis, method, observations, next steps).

---

## 9. End-to-end encryption (researched)

> Goal: optional E2EE for the entire vault so that even when sync goes through GitHub / Drive / OneDrive / Dropbox / iCloud, the provider sees only ciphertext. Compatible with self-recovery (no Lattice-held escrow) and with multi-device + multi-recipient (shared vaults).

### 9.1 What other apps do (web research)
- **Obsidian Sync** has a separate **encryption password** distinct from the account password. End-to-end encrypted on the client. Without the encryption password Obsidian cannot recover the vault. Account password authenticates against Obsidian's servers; encryption password derives the local key.
- **Standard Notes** uses the same split: **account password** authenticates with the server; a derived **encryption key** (PBKDF2 → AES-GCM v003, Argon2id → XChaCha20-Poly1305 v004) is computed entirely client-side and never sent. They publish their cryptographic specification and have undergone third-party audits.
- **age / rage** (FiloSottile) — modern file encryption: X25519 recipients (per-device public keys) + scrypt for passphrase mode + ChaCha20-Poly1305 payload encryption + post-quantum hybrid (ML-KEM 768 + X25519) since v1.3. Per-file format with header listing recipients, so multiple keys can decrypt the same file independently.
- **Cryptomator** (open-source cloud encryption) — per-file AES-GCM with separate filename encryption; vault key wrapped by a scrypt-derived key from the passphrase.

### 9.2 Design for Lattice
Take the best ideas from each:
- **Two-password separation** (Obsidian/Standard Notes): account password (only if you opt into a hosted account, e.g. for Web Clipper pairing relays) vs encryption passphrase (never leaves the device).
- **Per-recipient X25519 keys** (age): each *device* gets a long-term X25519 keypair generated at first run, stored encrypted-at-rest by the OS keychain. The vault key is wrapped to every authorized device's public key, so revoking a device just re-wraps without re-encrypting payloads.
- **Per-file encryption** (Cryptomator): every vault file is encrypted independently so partial sync/incremental updates don't require re-encrypting the world.
- **Filename encryption optional** (Cryptomator) — toggle in Settings. Default off (folder structure visible to the sync provider for easier debugging); enterprise preset forces it on.
- **Post-quantum hybrid** — adopt age's `mlkem768x25519` recipient type. Adds ~2 KB per file header; negligible.

### 9.3 Cryptographic primitives (locked down)
| Concern | Choice | Rationale |
|---|---|---|
| Passphrase → key | **Argon2id** (m=64 MiB, t=3, p=1) | Standard Notes v004 + libsodium default; resistant to GPU/ASIC; tunable. |
| Symmetric AEAD | **XChaCha20-Poly1305** | 24-byte nonce → safe for random nonces; constant-time on all CPUs; matches age. |
| Key wrap | **X25519** (with PQ hybrid `mlkem768x25519` opt-in) | Future-proof; same construction as age so we can re-use audited code. |
| Hashing / KDF tree | **BLAKE3** (for content-addressed object IDs in §4 storage) | Already content-addressed; consistent throughout the codebase. |
| Filename encryption | XChaCha20 (CTR-like via BLAKE3 KDF subkey) + Base32 encode | Match Cryptomator; deterministic so renames work without a manifest. |
| Library | [`age` Rust crate](https://github.com/str4d/rage) for file format + recipients; [`argon2`](https://crates.io/crates/argon2) for passphrase KDF; [`chacha20poly1305`](https://crates.io/crates/chacha20poly1305) for ad-hoc AEAD; [`x25519-dalek`](https://crates.io/crates/x25519-dalek) for raw key wrap when not using the age format | All RustCrypto / audited / pure-Rust → cross-compiles to WASM for the web build later. |

### 9.4 Key hierarchy
```
                ┌──────────────────────────────┐
                │  User passphrase (memorized) │
                └──────────────┬───────────────┘
                               │ Argon2id
                               ▼
                  ┌──────────────────────────┐
                  │  Master passphrase key   │  (32 bytes, never persisted)
                  └──────────────┬───────────┘
                                 │ wraps
                                 ▼
                ┌────────────────────────────────┐
                │  Device long-term X25519 sk    │  (per device, in OS keychain)
                └──────────────┬─────────────────┘
                               │ recipient of
                               ▼
                  ┌───────────────────────────┐
                  │  Per-vault content key K  │  (32 bytes, random)
                  └──────────────┬────────────┘
                                 │ derive (HKDF-BLAKE3)
                  ┌──────────────┼──────────────┐
                  ▼              ▼              ▼
              K_files       K_names        K_index
            (AEAD body) (filename CTR)  (FTS5 token blinding)
```

- Adding a new device: user enters the passphrase on the new device → derives master key → fetches the wrapped K from any sync provider → unwraps → re-wraps to the new device pubkey → uploads. No re-encryption of files.
- Removing a device: drop the wrapped-K entry for that device + rotate K (re-encrypt files lazily; mark old ciphertexts as "stale").

### 9.5 Recovery
Two recovery paths, user picks at setup:
1. **Recovery passphrase (default).** A second Argon2id-derived key generated alongside the main one, stored only in the user's head / paper. Used when the main passphrase is forgotten.
2. **Sharded recovery (enterprise add-on).** Shamir secret sharing (3-of-5) over the wrapped vault key; shares can be held by trusted colleagues or a corporate escrow service. We never see them.

**Zero escrow on Lattice's side.** Forgetting both your passphrase and your recovery passphrase means the data is lost. This is explicit, repeated in the setup UI, and tested by requiring the user to enter the recovery passphrase before completing setup.

### 9.6 What the sync provider sees
With filename encryption ON:
```
<remote>/
   refs/main.json.age              # encrypted ref
   commits.db.age                  # encrypted SQLite
   objects/
     2hf...kf3              # opaque blob (XChaCha20-Poly1305 ciphertext)
     8qz...m21              # opaque blob
     ...
```
With filename encryption OFF (default for non-enterprise):
```
<remote>/
   .lattice/
     refs/main.json
     commits.db
     objects/
       <sha256>.age          # body encrypted; structure visible
```

### 9.7 Plaintext-on-disk caveat
Notes are stored on the user's own machine **as plain `.md` files** because that's the whole point of the local-first promise — you can open them in any editor. E2EE applies to data **in flight** and **at rest on the sync provider**, not to the local working copy. We document this prominently; for full-disk threat models the user is expected to enable OS disk encryption (BitLocker / FileVault / LUKS).

For users who *want* encrypted-at-rest local storage (e.g. shared computers), a "vault lock" mode encrypts the working copy with the same K when the app is closed and decrypts to RAM-only / `/tmp` on unlock. This is v2 of the E2EE plugin.

### 9.8 Threat model
We protect against:
- Sync provider compromise / employee snooping / subpoena.
- Network MITM (PKCE + TLS + provider's own E2EE-of-transport).
- Lost device (device key rotation revokes future access; cannot retroactively unread already-synced files).

We do not protect against:
- Local malware on an unlocked device.
- Memory-scraping rootkits.
- The user voluntarily sharing their passphrase or installing a malicious plugin (plugin sandbox helps — §5.1 — but `vault.read` capability is still trusted).

### 9.9 Rollout plan
1. **Phase 1:** Ship E2EE as a BYOC plugin option behind a `Settings → Sync → Encryption` panel. Off by default for free users; on by default for the enterprise preset.
2. **Phase 2:** Add multi-device key management UI (list devices, revoke, re-key vault).
3. **Phase 3:** Filename encryption + at-rest local encryption.
4. **Phase 4:** Shared encrypted vaults (multi-user with per-recipient key wrap).
5. **Phase 5:** Post-quantum hybrid keys promoted to default.

---

## 10. Onboarding journey

### 10.1 Installer (Windows + macOS)
- **Windows:** WiX-built MSI. Per-user install (no admin needed), auto-update via [Velopack](https://github.com/velopack/velopack). Optional silent install args (`/quiet VAULT_PATH=...`) for MDM.
- **macOS:** signed + notarized DMG. Drag-to-Applications. Auto-update via Sparkle. Universal binary (x86_64 + arm64).
- **Linux** (later): AppImage + Flatpak + DEB/RPM via `cargo-packager`.

Installer collects nothing beyond accepting the EULA + picking install path.

### 10.2 First-boot wizard
Six steps, skippable at any point ("I'll set this up later").

1. **Welcome + persona pick.** Three cards: *Student / Personal · OSS Developer · Enterprise / M365*. Picks default presets (templates, enabled plugins, sync defaults).
2. **Vault choice.** *Open existing folder* · *Create new vault* · *Import from another tool* (→ §11).
3. **Theme + density.** Dark / Light / System; Comfortable / Compact / Cozy spacing.
4. **Sync.** Connect a BYOC provider now, or skip. Persona presets recommend one (Student → Drive, Dev → GitHub, Enterprise → OneDrive).
5. **Encryption.** *Off* (default for Student) · *On with passphrase* (default for Enterprise). If On, walk through passphrase entry → recovery passphrase entry → forced confirm.
6. **AI assistant.** Pick a BYOM provider or skip. Defaults to Ollama if detected locally. Otherwise *Skip — I'll set this up later*.

Final screen: "You're ready" + a one-line cheatsheet (`Ctrl+P` palette, `Ctrl+O` quick switcher) + a "Take the tour" button that opens an in-app guide note.

### 10.3 In-app guide note
- New file `Welcome.md` in the vault root (`<vault>/Welcome.md`).
- Real markdown with embedded screenshots; the user can edit/delete it freely.
- Section anchors: Editor, Graph, Backlinks, Canvas, Sync, Plugins, AI.

### 10.4 Telemetry
- **Off by default.** A single boolean in Settings → General → "Send anonymous usage data."
- If on: counts of feature uses (no content, no paths, no IPs) batched daily to a self-hosted Plausible instance.
- Crash reports: explicit per-crash prompt; never auto-sent.

---

## 11. Importers (built-in tier; can also be plugins)

All importers map source content → vault structure + `.lattice/` metadata. None mutate the source.

### 11.1 Obsidian
- Identity import: just point at the existing Obsidian vault folder. No conversion needed (we share the markdown + wikilink + JSON Canvas formats).
- Convert `.obsidian/workspace.json` → our split-tree (best-effort).
- Convert `.obsidian/plugins/*` → "these plugins were enabled; here are our equivalents" report.

### 11.2 Logseq
- Markdown engine + journals folder already match (§2). Block IDs (`id::`) preserved as our `<!-- id: ... -->` comments.
- Convert `pages/` and `journals/` flat layout into our suggested vault layout (or keep as-is).
- Properties (`tag::`, `alias::`) translated to YAML frontmatter.

### 11.3 Notion
- Source: Notion's official Markdown + CSV export (`.zip`).
- Conversion:
  - Pages → `.md` files preserving folder hierarchy.
  - Databases → `.lattice-db` files (§7) — **the headline feature of this importer.** Each CSV row becomes either an embedded row (Mode A) or a note (Mode B, with body taken from the page export).
  - Relations preserved by file-id mapping table built during the first pass.
  - Files / images → moved into `<vault>/_attachments/` and links rewritten.
  - Mentions (`@User`) → `[[User]]` wikilinks (with a People DB auto-created).

### 11.4 Siyuan
- Source: SiYuan's `.sy.zip` block-tree export OR the `data/` folder directly.
- Conversion:
  - Each `.sy` block-tree (JSON) → markdown via block-walker (headings, lists, code, embeds, references).
  - Asset folder (`assets/`) → `<vault>/_attachments/`.
  - Block references → wikilinks with anchor (`[[<doc>#<heading>]]` when possible, `((blockid))` outliner transclusion otherwise).
- Caveat: SiYuan's deep block-level features (table queries, SQL) become Lattice databases (§7) where they map cleanly, and Markdown comments noting the original semantic where they don't.

### 11.5 Importer execution
- Triggered from onboarding wizard OR `Settings → Import`.
- Long-running; runs in a Tauri command spawn with progress events streamed to a modal showing current file + ETA.
- Dry-run mode: writes a `import-preview.md` report instead of touching the vault.

---

## 12. Stats for nerds (petgraph — moved here from impl.md)

petgraph analytics is officially an **opt-in panel**, not part of the default graph UI. Keeps the main graph fast and the analytics deep.

- New panel `Graph → Stats for nerds` (gear → toggle).
- Algorithms:
  - **Communities (Louvain)** — color overlay on the existing render.
  - **Betweenness centrality** — top 20 list with rank pills.
  - **Shortest path between two notes** — pick two nodes; path highlighted.
  - **Co-citation map** — which notes are frequently linked from the same source.
  - **Tag co-occurrence matrix** — heatmap.
- Implementation: `petgraph` in `crates/lattice-core/src/analytics.rs`, compiled to native + WASM. Frontend just consumes pre-computed results.

---

## 13. Sequencing — recommended ship order

This is the v2 build queue, built **on top of** the work already finished + the v1 next steps captured in [`current-state.md`](current-state.md#8-recommended-next-step-order).

1. **Backlinks render (v1 carry-over).** Already half-done; finish the frontend first.
2. **Default VCS layer + Changes panel (§4).** Foundation for both BYOC and AI commit messages.
3. **Onboarding wizard + Welcome.md (§10).** Anything we ship after this point benefits from being introduced in the wizard.
4. **Importers — Obsidian + Logseq (§11.1, §11.2).** Cheapest, highest-value imports for the persona we already attract.
5. **BYOC plugin host + first adapter (GitHub) (§5.1, §5.2).** Establishes the plugin contract.
6. **E2EE phase 1 (§9.1–9.4, §9.9 step 1).** Has to land with BYOC so privacy-conscious users adopt sync.
7. **Calendar tier C (Google Calendar) + Journaling (§1.4, §2).** Largest user-base, most-requested feature for the Student persona.
8. **BYOM + Ollama default + privacy matrix (§5.3).** Unlocks AI commit messages (§4.2) and the agentic features in §5.3.
9. **Canvas extras phase 1 (§3.1 items 1-5).** Closes the gap to Excalidraw without a dependency.
10. **Databases v1 — Table + Kanban + embedded-row mode (§7).** Big effort, big payoff.
11. **Calendar tier A (Outlook + Teams) + Meeting note generation (§1.2).** Enterprise tier opens up.
12. **Importers — Notion + Siyuan (§11.3, §11.4).** Now that we have databases, Notion import is finally lossless.
13. **CLI — `lattice` ratatui (§6).** Senior-engineer love letter; can be developed in parallel from step 5 onward.
14. **Academic bundle (§8) + Stats for nerds (§12).** Polish for the Student persona; sets us apart from "Obsidian but newer."
15. **Web clipper (already in [`current-state.md`](current-state.md#6-web-clipper-browser-extension) §6).** Independent track, fold into shipping whenever it's ready.
16. **Remaining BYOC providers (Drive, OneDrive, Dropbox, iCloud, WebDAV).** Each one is a new file once the trait stabilizes.
17. **Calendar tier B (Cal.com) + Apple Calendar.** Long tail.
18. **Canvas extras phase 2 (§3.1 items 6-10) + research-paper exports (§3.2, §8.1–8.2).**
19. **E2EE phases 2-5 (§9.9 steps 2-5).**
20. **Community plugin marketplace (§5.4).**

Anything past step 20 is "v3" — Iroh P2P, MS Teams AI insights deep integration, real-time Automerge collaboration, full agentic AI flows.

---

## Appendix A — Open questions to resolve before starting

1. **Plugin host language for v1.** WASM components (WIT) is the long-term right answer, but tooling is still maturing. We could ship a v1 with a much simpler **Deno-style sandboxed JS runtime** (QuickJS in-process) and migrate to WASM components in v2. → Decide before §5 work starts.
2. **Encryption default for "Personal" preset.** Off (today's UX) vs on with passphrase. Standard Notes makes it on; Obsidian Sync makes it on. Going on-by-default raises a real "I forgot my password" cliff for casual users. Suggested compromise: prompt loudly during onboarding but default to off, with a settings-screen badge until enabled.
3. **Telemetry vendor.** Self-hosted Plausible vs nothing. Anything cloud-hosted is hard to justify given the privacy stance. Suggest: nothing in v1, revisit when we have funded infra.
4. **License.** Original `impl.md` says "100% open source." Choose: AGPLv3 (matches PKM community norms, hostile to closed-source forks) vs MIT (broadest adoption). Suggest: AGPLv3 for the app, MIT for `lattice-plugin-api` so plugin authors can ship any license.
5. **Funding model.** Implicit through this doc but never spelled out — enterprise tier (E2EE, Entra ID, Teams ingest, policy.json) is the natural paid SKU; everything else is free + open. Confirm.

---

## Appendix B — Glossary

- **BYOC** — Bring Your Own Cloud. User authenticates against their own GitHub / Drive / OneDrive / Dropbox / iCloud account; Lattice never sees credentials.
- **BYOM** — Bring Your Own Model. User configures Ollama / OpenAI / Claude / Gemini / etc; Lattice routes inference through them under a per-scope privacy matrix.
- **E2EE** — End-to-end encryption. The sync provider sees only ciphertext.
- **PKM** — Personal Knowledge Management. The category Obsidian, Logseq, Roam, Notion all sit in.
- **WIT** — WebAssembly Interface Type — the IDL for WASM components.
- **Argon2id, XChaCha20-Poly1305, X25519, BLAKE3** — see §9.3 for primitive choices.
