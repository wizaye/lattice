# Lattice — Gap Summary TODO

> Source of truth: [`docs/impl-v2.md`](../impl-v2.md), [`docs/impl-v3.md`](../impl-v3.md), [`docs/byoc-plan.md`](../byoc-plan.md), [`docs/paper-export-plan.md`](../paper-export-plan.md), [`docs/publishing-plan.md`](../publishing-plan.md), [`docs/onboarding-journey.md`](../onboarding-journey.md).
>
> Convention: `[x]` = shipped in repo today (verified by code search), `[~]` = partial / stub, `[ ]` = not started. Each row links to the spec section that defines "done."
>
> Last refreshed: 2026-06-10 — after the calendar + journaling + activity-strip-relocation drop.

---

## 0. Recently shipped (this session)

These are the pieces that landed in the last few turns. Listed first so they don't get lost in the v3 sea of unticked boxes.

- [x] **Calendar Rust module** — [`src-tauri/src/calendar/mod.rs`](../../src-tauri/src/calendar/mod.rs) with `CalEvent`, `CalSource::Local`, JSON store at `<vault>/.lattice/calendar/local-events.json`, `chrono = 0.4` wired into `Cargo.toml`. (impl-v2 §1.1, local-only slice)
- [x] **Journal Rust module** — [`src-tauri/src/journal/mod.rs`](../../src-tauri/src/journal/mod.rs) with `open_today`, `journals/YYYY-MM-DD.md`, streak counter persisted at `<vault>/.lattice/journal.json`. (impl-v2 §2.1 + §2.4)
- [x] **TS API wrappers** — `calendarApi.ts` + `journalApi.ts` under [`src/lib/`](../../src/lib/).
- [x] **Zustand stores** — [`calendarStore.ts`](../../src/state/calendarStore.ts) + [`journalStore.ts`](../../src/state/journalStore.ts).
- [x] **`CalendarPanel`** — Day/Week/Month + Today rail with streak badge + journal CTA + agenda. [`src/components/calendar/CalendarPanel.tsx`](../../src/components/calendar/CalendarPanel.tsx). (impl-v2 §1.5)
- [x] **`EventDialog`** — create / edit / delete local events with date+time native inputs, ESC to close, delete only for `source === "local"`. [`src/components/calendar/EventDialog.tsx`](../../src/components/calendar/EventDialog.tsx).
- [x] **`Ctrl+Shift+D`** opens today's journal — wired in [`App.tsx`](../../src/App.tsx) keyboard `useEffect`, refreshes the file tree, and opens the file in the active tab. (impl-v2 §2.4)
- [x] **Activity strip relocation** — Calendar + Source-Control (Changes) icons moved from the LeftSidebar header into the always-visible [`LeftActivityStrip`](../../src/components/layout/ActivityStrip.tsx); VS Code pattern (click inactive → switch + expand; click active → collapse). LeftSidebar header now only carries Files / Search / Bookmarks.

---

## 1. Calendar (impl-v2 §1)

### 1.1 Unified model
- [x] `CalEvent` Rust struct with `id`, `source`, `start`, `end`, `title`, `body_md`, `attendees`, `meeting_url`, `teams_meeting_id`, `note_path`, `etag`. (Local source only today.)
- [x] Frontend reads through one zustand slice ([`calendarStore.ts`](../../src/state/calendarStore.ts)).
- [ ] Local cache moved from JSON file → **SQLite at `.lattice/calendar.db`** (spec target; deferred — JSON is fine for local-only tier).
- [ ] ETag / deltaLink plumbing for cheap incremental refresh (only relevant once a remote provider lands).

### 1.2 Tier A — Outlook + Teams (M365)
- [ ] Entra ID (MSAL) PKCE auth + system browser + loopback redirect + keychain.
- [ ] `User.Read`, `Calendars.Read`, `OnlineMeetings.Read`, `OnlineMeetingTranscript.Read.All` scopes.
- [ ] Graph endpoints: `/me/calendar/events` → `/me/onlineMeetings` → transcripts → `/aiInsights`.
- [ ] Meeting-note generator: `<vault>/Meetings/YYYY-MM-DD HHmm <slug>.md` with frontmatter + Copilot summary + action items + transcript.
- [ ] Multi-tenant app registration; OPA-style `policy.json` reader.
- [ ] `graph_client.rs` shared client with Entra audit fields + `Retry-After` respect.

### 1.3 Tier B — Cal.com
- [ ] API-key auth (Settings → Calendar → Cal.com), keychain storage.
- [ ] OAuth upgrade once published to Cal.com App Store.
- [ ] v2 endpoints: `GET /bookings`, `GET /event-types`, `POST /bookings`.
- [ ] Optional webhook → instant meeting-note creation.

### 1.4 Tier C — Google + Apple
- [ ] Google PKCE OAuth; `calendar.events.readonly` (upgrade for write).
- [ ] Google `calendarList` + incremental `events?syncToken`.
- [ ] Apple Calendar — macOS EventKit Swift sidecar (`lattice-eventkit-helper`).
- [ ] Apple Calendar — Windows / Linux CalDAV with app-specific password.

### 1.5 Calendar UI
- [x] New `LeftView = ... | "calendar"` route.
- [x] Day / Week / Month sub-views; events coloured by source.
- [x] Click event → opens linked note (when `note_path` present).
- [x] "Today" right-rail with events + journal CTA + agenda.
- [x] "+ New event" creates a `Local` event (no write-back to Outlook / Cal.com / Google yet).

---

## 2. Journaling (impl-v2 §2)

### 2.1 Storage
- [x] `<vault>/journals/` created on first use.
- [x] `YYYY-MM-DD.md` per day (Logseq-compatible).
- [ ] Optional weekly / monthly rollup files (`2026-W23.md`, `2026-06.md`).

### 2.2 First-class outliner mode
- [ ] CodeMirror outliner mode toggle (frontmatter `outliner: true` or path-prefix rule for `journals/`).
- [ ] Tab / Shift-Tab indent-outdent on `- ` block lines.
- [ ] Block fold glyph.
- [ ] `((block-ref))` transclusion rendering.
- [ ] Stable block IDs via hidden HTML comments.

### 2.3 Calendar ↔ Journal integration
- [x] Today panel embeds the day's journal CTA inline (open / create).
- [ ] Long-press / right-click a day cell → "Create journal entry."
- [x] Default new-day template (`<vault>/.lattice/templates/journal.md`) — falls back to a built-in template if missing.

### 2.4 Daily-notes plugin slot
- [x] `Ctrl+Shift+D` opens today's note.
- [x] Status-pill / sidebar streak indicator.
- [ ] Promote to a first-party **plugin** once the plugin loader lands (impl-v2 §5 — deferred to v4 per impl-v3 §1).

---

## 3. Canvas — additional tools (impl-v2 §3)

- [x] JSON Canvas 1.0 read/write (`CanvasView.tsx`).
- [ ] New tools (priority order): connector auto-routing, multi-select group, sticky template, paper-section ↔ canvas-card binding.
- [ ] Research-paper export hook (impl-v2 §3.2 + paper-export-plan).

---

## 4. Default VCS (impl-v2 §4)

- [x] Git-native VCS (`src-tauri/src/git.rs`, ~1.2k LOC).
- [x] `--separate-git-dir=.lattice/git` (no `.git/` clutter at vault root).
- [x] Changes panel with refresh + status surface ([`ChangesPanel.tsx`](../../src/components/layout/ChangesPanel.tsx)).
- [ ] Intelligent commit messages (BYOM-backed; impl-v2 §4.2).
- [ ] Auto-commit cadence config (impl-v2 §4.1).

---

## 5. Plugins / BYOC / BYOM (impl-v2 §5)

- [ ] **Plugin loader** (WASM Preview 2) — deferred to v4 (impl-v3 §1).
- [ ] **BYOC GitHub adapter** end-to-end (PKCE OAuth + keychain + push/pull + Changes panel rows) — impl-v3 §9 / W5.
- [ ] BYOC Drive / OneDrive / Dropbox / WebDAV — after GitHub lands.
- [ ] **BYOM** (Ollama / OpenAI / Anthropic / Azure / HF) — Ollama probe in onboarding step 7.

---

## 6. CLI + MCP (impl-v2 §6 / impl-v3 §7–§8)

- [ ] `lattice` CLI built against `lattice-vault-rs` (clap, ~30 verbs).
- [ ] Install / uninstall from **Settings → CLI** (no installer footprint).
- [ ] First-party **MCP server** (sidecar + embedded).
- [ ] One-click MCP install/uninstall for Claude Desktop / Claude Code / Codex / Cursor / Zed.
- [ ] `lattice://` deep-link scheme.
- [ ] macOS Raycast extension (installed from Settings).

---

## 7. Databases (impl-v2 §7)

- [ ] Deferred to v4 (impl-v3 Appendix B).

---

## 8. Academic bundle (impl-v2 §3.2 + paper-export-plan)

- [x] Paper scaffolder shipped (`src-tauri/src/paper/`).
- [ ] Typst + Tectonic + BYOF compile path.
- [ ] Canvas → paper-section binding.

---

## 9. Publishing (impl-v2 §8 + publishing-plan)

- [x] Quartz publishing scaffold (`src-tauri/src/publish/`).
- [ ] One-click deploy: GitHub Pages / Cloudflare / Netlify / Vercel.

---

## 10. Onboarding (impl-v2 §10 + onboarding-journey)

- [x] 9-step structure scaffolded ([`src/components/onboarding/`](../../src/components/onboarding/)).
- [x] Step 0 splash with Obsidian-vault detection.
- [ ] Step 3 — "Import existing Obsidian vault" verb (impl-v3 §4.3).
- [ ] Step 7 — Ollama / BYOM probe.
- [ ] Remaining stub steps in [`StubSteps.tsx`](../../src/components/onboarding/steps/StubSteps.tsx) — promote to real.

---

## 11. Importers (impl-v2 §11)

- [ ] Obsidian vault import (CopyInPlace / CopyToNewVault / OpenAsIs).
- [ ] Logseq import.
- [ ] Notion export ingest.

---

## 12. E2EE (impl-v2 §9)

- [ ] Deferred to v4 (impl-v3 Appendix B). Settings → Security row ships disabled in v3 so the layout doesn't shift later.

---

## 13. v3 foundation work (impl-v3 §2–§13)

### W1 — Foundation
- [ ] §2 Repo reshape — bun workspaces; `apps/desktop`, `apps/server`, `apps/web`, `packages/lattice-bridge-contract`, `lattice-core`, `lattice-bridge-tauri`, `lattice-bridge-web`, `lattice-vault-rs`.
- [ ] §2.2 `LatticeBridge` interface + `LatticeCapabilities` flags.
- [ ] §2.3 Migrate every `invoke(...)` call site to `bridge.fooBar(...)` (~40 files).
- [ ] §3 `lattice-vault-rs` crate — 30+ vault verbs (inbox / quick / archive / trash / Daily Notes / attachements lifecycle).
- [ ] §3.4 `safe_join` path traversal guard (port of ZenNotes `safepath.go`).
- [ ] §3.5 `notify`-based file watcher (120 ms debounce, `broadcast::channel` fan-out).
- [ ] §3.6 mtime+size meta cache (`.lattice/meta-cache-v1.json`, 1 s debounced persist).
- [ ] §3.7 Single-source-of-truth parser (`parse.rs` — wikilinks, embeds, tags, frontmatter, tasks).
- [ ] §12 Backlinks UI wired against new vault (linked + unlinked mentions, snippet + line number, click-to-jump).

### W2 — Editor parity (Obsidian compat tier 1)
- [ ] §4.1 `[[Note#heading]]` resolve + scroll-to-heading.
- [ ] §4.1 `![[image.png]]` and `![[note]]` embeds rendered inline.
- [ ] §4.1 `#tag` hierarchical — tag pane + completion + click-to-filter.
- [ ] §4.1 Callouts `> [!note]`, `> [!tip]`, `> [!warning]`.
- [ ] §4.1 YAML frontmatter compact properties widget.
- [ ] §4.1 Heading fold gutter.
- [ ] §4.1 `primaryNotesLocation: root` (flat-vault) auto-infer.
- [ ] §4.3 `import_obsidian_vault` verb (CopyInPlace / CopyToNewVault / OpenAsIs).
- [ ] §4.5 Bidirectional-compat CI fixture vault — round-trip diff test.
- [ ] §4.2 Slash commands (`cm-slash-commands.ts`).
- [ ] §4.2 Template variables (`cm-template-variables.ts`).
- [ ] §11.6 Mermaid + footnotes + embeds preview parity.

### W3 — Power user
- [ ] §4.2 / §6.1 Vim mode (`cm-vim.ts`, `@replit/codemirror-vim`).
- [ ] §6.2 Which-key overlay on leader.
- [ ] §4.2 Command palette (port of ZenNotes `CommandPalette.tsx`).
- [ ] §4.2 Live preview (`cm-live-preview.ts`).
- [ ] §8 `lattice` CLI (clap; install from Settings → CLI).
- [ ] §7 MCP server (sidecar + embedded).
- [ ] §7.4 MCP one-click for Claude Desktop / Claude Code / Codex / Cursor / Zed.
- [ ] §8.4 Raycast extension (macOS).
- [ ] §11.5 Pluggable search backend (builtin / ripgrep / fzf auto-detect + custom paths).
- [ ] §13.5 Full Settings inventory (Appearance / Editor / Vault / Search / Sync / AI-MCP / CLI / Updates / Security-disabled / Advanced).

### W4 — Self-host + web
- [ ] §5 Rust HTTP server (`apps/server`, axum, tower-cookies, argon2, rust-embed, tower_governor).
- [ ] §5.2 Bootstrap auth token + 127.0.0.1 bind + version-skew detection.
- [ ] §5.4 / §5.5 Docker `FROM scratch` image: read-only root, `no-new-privileges`, dropped caps, host UID/GID.
- [ ] §6.1–6.4 PWA mode (LocalWebBridge File System Access API + RemoteBridge fetch/WebSocket).
- [ ] §6.3 Mode E — desktop shell talking to remote server.
- [ ] §10.1 Linux packaging (AUR `lattice-bin`, AppImage with FUSE-free `--appimage-extract-and-run`, `.deb`, `.pacman`).
- [ ] §10.2 macOS .dmg signed + notarized; Windows .exe (optionally signed).
- [ ] §10.3 Auto-updater.
- [ ] §10.4 `lattice://` deep-link route table.

### W5 — BYOC GitHub
- [ ] §9 PKCE OAuth + OS keychain.
- [ ] §9 GitHub adapter (clone / fetch / push / conflict surface).
- [ ] §9 Changes panel real BYOC row.

### W6 — Hand-off to v4
- [ ] Plugin loader (impl-v2 §5).
- [ ] Databases (impl-v2 §7).
- [ ] E2EE (impl-v2 §9).
- [ ] Remaining BYOC providers (Drive / OneDrive / Dropbox / WebDAV).
- [ ] Mobile (Tauri 2 mobile).
- [ ] Terminal panel.

---

## 14. Activity strip honesty (impl-v3 §11)

- [x] **Calendar** view wired (this session).
- [x] **Source Control / Changes** view wired (this session).
- [x] **Graph** action wired (existing).
- [ ] **All files** — promote from disabled placeholder.
- [ ] **Canvas (Grid icon)** — promote from disabled placeholder.
- [ ] **Kanban** — promote from disabled placeholder (after `scan_tasks` in `lattice-vault-rs`).
- [ ] **Terminal** — deferred to v4 (impl-v3 Appendix B).

---

## 15. Diataxis docs reorg (impl-v3 Appendix D row 58)

- [ ] Create `docs/tutorials/`, `docs/how-to/`, `docs/reference/`, `docs/explanation/`.
- [ ] Move existing how-to-style docs into `how-to/`; keep `impl*.md` at `docs/` root.
- [ ] Add `docs/todos/` (this folder) to the index.

---

*End of gap-summary.md. When an item ships, flip `[ ]` → `[x]` (or `[~]` for partial). Keep the spec links intact so reviewers can jump straight to the design.*
