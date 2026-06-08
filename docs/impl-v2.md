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

Three personas drive every decision — but **the feature set is universal**. Persona only changes *defaults* in the onboarding wizard; every user gets every feature.

| Persona | Default workflow | Persona-default batteries |
|---|---|---|
| **Student / normal user** | Notes + journaling + Google Calendar + canvas + paper scaffolding + PDF export | Onboarding wizard, IEEE/APA export, daily-notes plugin, Google Calendar sync, **paper scaffolder (§8.5)** |
| **Enterprise / M365** | Notes + Outlook/Teams meeting capture + secure vault | Entra-ID sign-in, Teams transcript ingest, E2E encryption ON, MDM-friendly settings |
| **OSS dev / senior engineer** | Same vault from CLI, BYOM AI in Ollama | `lattice` CLI (ratatui), BYOM, plugin API, Cal.com integration |

**Universal across all personas (no upsell, no plan gate):**
- **BYOC** — every user picks at least one sync provider during onboarding (GitHub for devs, Drive for students, OneDrive for enterprise — but any of them is available to anyone). BYOC is *the* sync model; there is no "Lattice Sync" SaaS to compete with it.
- **BYOM** — every user can attach an AI provider (local Ollama default; cloud keys optional).
- **E2E encryption** — available everywhere; opt-in for personal, opt-out for enterprise.
- **Default VCS** — every vault is version-controlled from day one.
- **Paper scaffolder, canvas, graph, importers, plugins** — all available to all personas.

A feature ships only when *one* persona is fully unblocked by it, but it is then exposed to *all* personas.

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
5. `byoc-icloud` — **descoped past v1** (see tractability table below); Windows/Linux greyed out with tooltip until then.
6. `byoc-webdav` — generic fallback for Nextcloud, ownCloud, self-hosted (basic auth + bearer token).

**Shared base crate** `byoc-core/` (Rust): trait `SyncProvider`, conflict UI helpers, retry/backoff, content-addressed upload/download. Adapters just implement the trait.

**Sync wire format:** each commit is `(commit-id.json, objects/<sha>...)` blobs. Provider is a dumb object store.

**E2EE layered on top:** see §9. The sync layer never sees plaintext when encryption is enabled.

#### 5.2.1 Per-provider tractability (researched 2026-06)
Free-tier API ceilings + auth friction shape the ship order inside §5.2. Summary: GitHub is the cleanest, the three cloud-drive APIs are free but force us to bolt on an incremental-sync workaround, iCloud is too expensive to justify for v1.

| Provider | Cost on the user side | Auth | Sync mechanism we have to build | Verdict |
|---|---|---|---|---|
| **GitHub** | Free (private repos unlimited) | OAuth Device Code or PAT | None — we shell out to system `git push/pull/fetch` (same binary VCS already uses, see [`lattice.md`](../memories/repo/lattice.md) VCS section). No HTTP rate limit on git protocol itself, only on REST metadata calls (5k/hr authed). | ✅ Ship first. Already 80% built — just needs the remote-add + push command. |
| **Google Drive** | Free 15 GB tier | OAuth 2.0 PKCE + system browser, loopback redirect | Drive API v3 has no native push notifications for app-folder scope. **Workaround:** poll `changes.list` with a stored `startPageToken` every N minutes + react to `fileWatcher` events (the API returns 1 row per change so quotas stay generous). | ⚠️ Ship after GitHub. Sync loop is ~150 LOC + a backoff scheduler. |
| **OneDrive** | Free 5 GB tier | MSAL (same PKCE pattern as Outlook in §1.2) | Graph `/me/drive/root/delta` returns a `@odata.nextLink` cursor we persist between sessions — closer to a real delta API than Drive's polling, but still client-driven, no webhooks at the consumer tier. | ⚠️ Same tractability as Drive. |
| **Dropbox** | Free 2 GB tier | OAuth 2.0 PKCE | `/2/files/list_folder/continue` with a persisted cursor — identical pattern to OneDrive delta. Dropbox also has long-poll endpoints we can layer on for near-real-time updates. | ⚠️ Same tractability as Drive/OneDrive. |
| **iCloud Drive** | Free 5 GB tier | CloudKit web auth token — but only issued to **signed apps** with an Apple Developer Program membership ($99/yr) and a registered iCloud container, **and** the sync container is only reachable from macOS (CloudKit JS in a webview works in theory but is permanently flaky outside Safari) | Native `NSFileCoordinator` + `NSMetadataQuery` watcher on a `~/Library/Mobile Documents/iCloud~com~lattice~app/` container, via a Swift sidecar bundled with the macOS build. Windows/Linux have no supported path. | ❌ **Descoped past v1.** Cost (Apple Dev account + signing + Swift sidecar + macOS-only support matrix) outweighs reach. Revisit when there's enterprise demand. |
| **WebDAV** | Free (self-hosted) | Basic auth + bearer token | `PROPFIND` + `If-Match` etags. No incremental API; we scan etags on push. | ✅ Cheapest fallback to ship — covers Nextcloud/ownCloud/Stackmount/Hetzner Storage Box. |

**Implications for the ship order** (reflected in §13):
- Step 5 ("BYOC plugin host + first adapter") = GitHub only.
- Step 17 ("Remaining BYOC providers") fans out Drive/OneDrive/Dropbox/WebDAV in parallel since they all reuse the same delta-cursor scheduler.
- iCloud is **not** on the v1 queue; documented here so we don't re-litigate it.

**Granular sync hooks (shared across all delta-based providers):**
- Maintain `.lattice/sync-manifest.json` per provider — `{path, blake3_hash, last_known_remote_etag, last_pushed_at}`. SQLite if it grows past 10k rows.
- Hook into the editor auto-save event already wired through `useEditorStore` — debounce 3s of idle, then push only the changed objects (BLAKE3 deduped against the manifest) through the provider's delta API. Big-bang full-vault uploads only happen on first connect.
- Receive side runs the same delta cursor on a 60s timer (configurable); applies incoming objects through the VCS layer as a synthetic remote-side commit (`Sync from <provider> @ <ts>`) — keeps the commit graph honest and gives conflict UI something to point at.

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

### 5.5 Publishing pipeline — Obsidian-Publish replacement (Quartz SSG + free hosting)

> Goal: one-click "Publish" button that turns the active vault (or a sub-folder of it) into a live, themed, interactive static site at a free `*.pages.dev` / `*.vercel.app` / `*.github.io` URL — without the user ever touching a terminal, paying for Obsidian Publish ($8/mo), or running a build server.

This is **not** a sync feature (that's §5.2) and **not** another cloud account (we reuse the BYOC OAuth pattern). It's a separate compile-and-publish pipeline that runs locally and uploads HTML to free CDN tiers. Conceptually it sits beside BYOC under the plugin host because (a) the hosting providers authenticate the same way and (b) advanced users will want to swap the compiler.

#### 5.5.1 Three layers
1. **Editor (already shipped)** — vault is a folder of `.md` + `.canvas` + `.pdf`. Wikilinks, frontmatter, embeds all work.
2. **Compiler** — bundled headless [Quartz v5](https://github.com/jackyzha0/quartz) (released 2026-05-24; see <https://quartz.jzhao.xyz/>) running in a child Node process. Requires Node v22+ and npm v10.9.2+. Quartz already implements wikilink resolution, backlinks, interactive graph view, page popover previews, full-text search, and Obsidian-compatibility — re-implementing any of that in our own pipeline would be wasted work. We just embed it. v5 splits scaffold (`npx quartz create`) from plugin install (`npx quartz plugin install --from-config`); both run during `publish_init`. See [`docs/publishing-plan.md`](publishing-plan.md) for the full build pipeline.
3. **Hosting adapter** — uploads the compiled `public/` directory to the user's choice of GitHub Pages / Cloudflare Pages / Vercel via REST. Tokens stored in the OS keychain (same `keyring-rs` slot we already use for BYOC).

```text
  vault/*.md  ──►  [ Quartz child process ]  ──►  public/*.html
                            │                              │
                            │                              ▼
                            │                  [ Hosting adapter ]
                            ▼                              │
                  .lattice/publish.log                     ▼
                                              user.pages.dev / .vercel.app / .github.io
```

#### 5.5.2 Bundling Quartz inside the Tauri app
- Quartz is TypeScript/Node and depends on `npm` to install transitive deps. We can't ship a stripped CPython-style "frozen" Node runtime cheaply, so the choice is:
  - **A. Bundle a portable Node + a pre-installed `quartz` tree inside `src-tauri/resources/quartz/`** (~80 MB unpacked, ~25 MB compressed). Pros: zero-network first run. Cons: app installer grows; Quartz upgrades require a Lattice release.
  - **B. Ship without Node, detect `node` on PATH during onboarding, run `npx quartz ...` on demand.** Pros: tiny installer. Cons: dependency on user installing Node (some students won't have it).
  - **Decision:** ship **B** for v1 with a one-time prompt + auto-install link to `nodejs.org`, **A** as a paid/enterprise SKU later. Lines up with the "VCS requires git" precedent (see [`lattice.md`](../memories/repo/lattice.md) VCS section) where we surface a download link instead of a generic error.
- Child-process invocation lives in `src-tauri/src/publish.rs`:
  ```rust
  fn build_quartz(vault: &Path, out: &Path, layout: Layout) -> Result<BuildReport> {
      // 1. Materialise a temp .quartz/ config dir derived from layout + user settings
      // 2. Spawn: npx quartz build --directory <vault> --output <out>
      // 3. Stream stdout/stderr back to the frontend via Tauri event for the progress UI
  }
  ```
- IPC commands:
  - `publish_preview(vault_path, layout)` → builds into `.lattice/publish-preview/` and returns the local URL we serve via a Tauri sidecar HTTP server. User can hit "Open preview" before uploading anywhere.
  - `publish_deploy(vault_path, layout, host)` → builds + uploads + returns the live URL.
  - `publish_status(vault_path)` → last build/upload metadata for the Settings → Publish panel.

#### 5.5.3 Three layouts (user-selectable in the Publish settings panel)
The user noted Quartz "gives us docs, notebook layouts" — we expose three:

| Layout | Quartz config preset | Persona fit | What changes |
|---|---|---|---|
| **Garden** (default) | `quartz.config.ts` with `Component.Graph` enabled, full backlinks sidebar, table-of-contents per page | Students, researchers | The classic Quartz look — interactive graph, page popovers, dense backlink panel. Best for a personal wiki. |
| **Docs** | `Component.Explorer` (collapsible tree), `Component.TableOfContents`, graph disabled, breadcrumb header | Engineers writing OSS docs | Reads like Docusaurus / VitePress. Folder structure is the navigation; graph view is hidden because docs sites don't need it. |
| **Notebook** | `Component.RecentNotes(limit=20)` on home, chronological index, `Component.Tags` cloud, slides export via the existing reveal.js pipeline | Daily-note / journaling users | Front page is reverse-chronological feed of recent notes. Pairs with §2 Journaling. |

Under the hood all three are the same Quartz install with a different generated `quartz.config.ts` — we never fork Quartz. Custom CSS overrides land in `.lattice/publish/theme.css` so users can tweak without losing upgrades.

#### 5.5.4 Hosting adapters (free tiers only, all 100% headless)

| Host | Free tier ceiling | API | Auth |
|---|---|---|---|
| **GitHub Pages** | Unlimited public, 1 GB / site | Push a generated repo via the existing `git` integration + commit a `.github/workflows/deploy.yml` workflow Quartz already provides | Reuses the BYOC-GitHub OAuth token from §5.2 — no new auth. |
| **Cloudflare Pages** | 500 builds/mo, unlimited bandwidth, unlimited sites | [Direct Upload API](https://developers.cloudflare.com/pages/platform/direct-upload/) — `POST /accounts/{id}/pages/projects/{name}/deployments` with a multipart form of the built files. No GitHub required. | OAuth — Cloudflare API token paste during onboarding (no PKCE app yet). |
| **Vercel** | 100 GB-hr serverless, unlimited static | `POST /v13/deployments` with a JSON manifest of `{file, sha, size}` entries + companion blob uploads | OAuth via [Vercel Integration](https://vercel.com/docs/rest-api#oauth) (PKCE) or pasted token. |

All three are implemented behind a `PublishHost` trait that mirrors `SyncProvider` in shape — easy code review, easy parallel work.

```rust
#[async_trait]
trait PublishHost {
    async fn auth_start(&self, app: &AppHandle) -> Result<AuthUrl>;
    async fn auth_complete(&self, code: &str) -> Result<HostToken>;
    async fn deploy(&self, dir: &Path, project: &str) -> Result<DeploymentInfo>; // returns URL + log
    async fn list_deployments(&self, project: &str) -> Result<Vec<DeploymentInfo>>;
}
```

#### 5.5.5 UX (Settings → Publish + status pill)
- New settings section "Publish" with: layout picker (3 cards), host picker (3 cards, badge per ready/connected), preview button, publish button, last-deployment URL + status.
- StatusPill grows a small earth/cloud icon when a Publish target is connected; click navigates straight to the Publish settings — same pattern as the BYOC sync pill.
- Per-vault config in `.lattice/publish.toml` so multiple vaults can publish independently:
  ```toml
  layout = "garden"
  host = "cloudflare"
  project = "my-notes"
  exclude = ["private/**", "Inbox/**"]
  last_deploy_url = "https://my-notes.pages.dev"
  last_deploy_at = "2026-06-07T11:42:00Z"
  ```

#### 5.5.6 What we explicitly do NOT do
- **No central Lattice publish server.** Compile is local, upload goes provider-direct, the user owns the project on the host. No middleman, no SLA on us.
- **No real-time republish.** Each Publish click is a full Quartz rebuild + redeploy. Incremental builds are a v2 idea (Quartz supports them but caches add complexity not worth shipping in v1).
- **No custom domains in v1.** Users get `*.pages.dev` / `*.vercel.app` / `*.github.io` only. Domain attachment is a one-line config in the host's dashboard the user can do themselves.
- **Quartz v5 is locked in.** Quartz v5.0.0 shipped 2026-05-24; we target v5 from day one. **No v4 back-compat.** Minor-version drift inside v5.x is handled by the version-gating logic in `config_gen` (see [`docs/publishing-plan.md`](publishing-plan.md) §9 step 4 + D10).

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

### 8.5 Paper scaffolder — `Cmd+P → New Paper`

This is **the** student feature. One command spins up an entire opinionated paper project that compiles end-to-end on first try, with sane defaults a thesis advisor would approve of.

#### 8.5.1 Goal — beat the field

| Tool | What they do well | What we do better |
|---|---|---|
| **Overleaf** | Polished cloud LaTeX, real-time co-edit, every journal template | Offline-first; native graph view + PKM context for literature review; integrated Zotero/BibTeX without a paid tier; Typst speed (~50× faster builds); your notes + your paper live in the same vault |
| **Notion / Confluence** | Easy editing, structured DB | Real publication-ready output (camera-ready PDF), citation graphs, math typesetting, no vendor lock-in (plain markdown + plain BibTeX on disk) |
| **Obsidian** | Vault + plugins | First-class paper structure (no "figure out which 4 community plugins to chain"); built-in compile pipeline; canvas→TikZ/SVG without a separate Excalidraw export dance |
| **Typst web app / studio** | Typst syntax, fast | Markdown-native (you write `# Heading` not `= Heading`); integrated with notes/graph/calendar; works offline with full template library bundled |
| **Authorea, Manubot** | Markdown-to-paper | Local-first, no GitHub Actions dependency, full GUI, includes the whole research workflow not just typesetting |

#### 8.5.2 Folder scaffold (what gets created)

User runs **Command Palette → `New Paper…`** → picks a template (IEEE Conf / IEEE Journal / Springer LNCS / ACM / APA / Thesis / Lab Report / Blank) → picks title + author(s) + parent folder. We then create:

```text
<Parent>/My Paper Title/
├── paper.typ                  ← compile entry (or paper.tex for Tectonic templates)
├── README.md                  ← "how to use this folder" — author-facing
├── title.md                   ← title, authors, affiliations, keywords (frontmatter)
├── abstract.md                ← single ~250-word paragraph
├── sections/
│   ├── 01-introduction.md
│   ├── 02-related-work.md
│   ├── 03-method.md
│   ├── 04-results.md
│   ├── 05-discussion.md
│   └── 06-conclusion.md
├── figures/
│   ├── README.md              ← naming convention reminder
│   └── _.gitkeep
├── tables/
│   └── _.gitkeep
├── bibliography.bib           ← BibTeX (also accepts .yaml CSL-JSON)
├── citations.md               ← human-readable index of every cited work (auto-maintained)
├── notes.md                   ← scratchpad / reviewer comments (excluded from build)
├── .lattice/
│   ├── paper.toml             ← template id, build config, target venue
│   └── checklist.md           ← submission checklist (auto-checked when possible)
└── build/                     ← .gitignored output: paper.pdf + diff.pdf
```

Every file is pre-populated with **real, working content** (not lorem ipsum) — placeholder headings, illustrative `\cite{example2024}` usage, a stub figure include, a stub table. The user can compile it the moment it's created and get a 6-page PDF that looks like a real paper.

#### 8.5.3 `paper.typ` (compile entry point)

For Typst templates the root file imports everything in order, applies the template, and resolves bibliography:

```typst
#import "@templates/ieee-conf:0.4.0": ieee-conf, affiliation
#import "sections/_loader.typ": load-section

#show: ieee-conf.with(
  title: include "title.md",
  authors: include "_authors.typ",
  abstract: include "abstract.md",
  index-terms: ("PKM", "local-first", "E2EE"),
  bibliography: bibliography("bibliography.bib", style: "ieee"),
)

#load-section("01-introduction.md")
#load-section("02-related-work.md")
#load-section("03-method.md")
#load-section("04-results.md")
#load-section("05-discussion.md")
#load-section("06-conclusion.md")
```

`load-section` is a tiny helper we ship in every template that runs each `.md` through our markdown→Typst converter (handles `[@key]` citations, `[[wikilinks]]` to other notes in the vault, math, code, figures). **The author never has to write Typst syntax** — every section file is plain markdown.

#### 8.5.4 Build pipeline

- **Compile button** in the editor toolbar when any file inside a `.lattice/paper.toml` folder is active.
- One click → background `typst compile paper.typ build/paper.pdf` (or Tectonic for `.tex`).
- Inline PDF preview panel (right split, optional auto-show on first compile).
- **Live preview** mode: re-compile on save with debounced 250 ms. Typst is fast enough that this feels instant on a 20-page paper.
- Errors surface inline in the offending markdown file as red squiggles with the Typst/LaTeX error message.
- Output: `build/paper.pdf` + `build/paper.tagged.pdf` (PDF/A-1a for journals that require it) + `build/diff.pdf` (visual diff vs the last commit — see §8.5.7).

#### 8.5.5 Citation management

- **Zotero integration:** auto-discover `~/Zotero/storage/` (or user-set path) → watch `Better BibTeX` exports → live-merge into `bibliography.bib` on change.
- **Inline picker:** type `[@` in any section file → fuzzy autocomplete drops down from `bibliography.bib`. Selecting an entry inserts `[@smith2024]` and adds the work to `citations.md`.
- **Hover preview:** hover any `[@key]` in source mode → popup shows full reference + abstract + first 200 chars of any notes in the vault tagged with that citation key.
- **DOI import:** paste a DOI → fetches CSL-JSON from crossref.org → appends BibTeX entry → done.
- **Cite-while-you-read:** when reading a PDF in the vault, the right rail offers "Cite this in active paper" — adds the BibTeX entry and inserts `[@…]` at the cursor in the paper.

#### 8.5.6 Figure & table management

- Drag any image into the editor → auto-saved into `figures/` with a kebab-case name → inserts a labeled figure block: `![Pipeline overview](figures/pipeline-overview.png){#fig:pipeline}`.
- Drag a `.canvas` file → exports the canvas as PDF (vector) AND PNG @ 2× into `figures/` → inserts the labeled block. Canvas remains live-editable — re-compile re-exports automatically.
- Drag a `.lattice-db` table view → exports as a `\begin{table}` / `#table` block.
- **`Cmd+R F`** → "Refer to figure…" — fuzzy picker of every labeled figure/table/equation, inserts `Fig.~\ref{fig:pipeline}` (or `@fig:pipeline` in Typst).

#### 8.5.7 Version diff for papers (the killer feature reviewers love)

- Every commit (§4) carries a per-file diff. For papers we additionally generate a **visual PDF diff** using `latexdiff`/equivalent: text additions in blue, deletions struck-through in red.
- One click in the Changes panel: "Generate diff vs commit X" → outputs `build/diff.pdf`.
- Submission workflow: tag a commit `submitted-v1`. After reviews, generate diff vs that tag → upload alongside the resubmission. Journals love this.

#### 8.5.8 Submission checklist

`.lattice/checklist.md` is template-specific and auto-checked where possible:

```markdown
- [x] All authors listed with ORCID iDs (3/3 ORCIDs found in title.md)
- [x] Abstract under 250 words (currently 217)
- [x] All figures have captions
- [ ] All figures have alt-text (2 of 5 missing — see fig-results.png, fig-arch.png)
- [x] All cited works present in bibliography.bib (0 missing)
- [ ] Page count under conference limit (currently 9, limit is 8)
- [x] No \todo or TODO markers in body text
- [ ] Anonymous submission: author names removed (IEEE TPDS double-blind)
```

Auto-checks run on every compile; manual checks have a button to mark them done.

#### 8.5.9 Collaboration story

- Vaults already sync via BYOC (§5.2). A paper folder is just a sub-tree, so **send your co-author the folder via OneDrive/Drive share + a BibTeX file** and they edit alongside you using their own Lattice install.
- Conflicts on `bibliography.bib` and `sections/*.md` use the standard 3-way merge from §4.5.
- **Track-changes mode** (later): per-author colored decorations sourced from the VCS blame; one-click accept/reject in the gutter.
- **For Overleaf-style live co-editing:** v3 feature behind Automerge — not in v2 scope, but the data model already supports it (CRDT per-section, see [`impl.md`](impl.md) phase-2.3).

#### 8.5.10 Templates package (`@templates/...`)

Shipped in `crates/templates/` and copied into the vault as Typst packages at first use:
- `ieee-conf` (IEEEtran conference)
- `ieee-journal` (IEEEtran transactions)
- `springer-lncs` / `springer-svjour3`
- `acm-sigconf`
- `apa-7` (papers + theses)
- `thesis-generic` (parameterizable for most universities — chapters/abstract/declaration/etc.)
- `lab-report` (cs/eng undergraduate)
- `cv-resume` (because the same engine should do the CV you submit *with* the paper)
- `posters-a0` (conference posters)
- `slides-beamer-like` (Polylux-based Typst slides)

Community templates land via the same plugin marketplace (§5.4) — drop a `.typ` package, declare it in `manifest.toml`, ship.

#### 8.5.11 "Resume an existing paper"

- **Import from Overleaf:** paste a Overleaf project zip → we detect the main `.tex` file → split into `sections/` if multi-file already, otherwise leave as-is → wrap in a Lattice paper folder. Native compile continues via Tectonic.
- **Import from arXiv source:** `lattice paper import-arxiv 2403.12345` → downloads source bundle → scaffolds.
- **Import a published PDF for replication/extension:** drop the PDF → "Create paper from this" → auto-extracts title, authors, abstract, BibTeX entry into a new paper folder where you write your response/extension.

#### 8.5.12 AI assist (gated behind BYOM, opt-in per scope)

- "Suggest related work for §2" — runs vault search + arXiv search + Semantic Scholar API, drops candidate citations into a side panel.
- "Tighten this paragraph" — selection → BYOM call → diff suggestion (accept/reject like Copilot inline).
- "Translate Methods section to plain English (cover letter / press release)" — drafts a `cover-letter.md` companion file.
- All AI features OFF by default for academic preset because journals' AI-use disclosure rules are still evolving. Author has to enable per-paper.

#### 8.5.13 BYOF — Bring Your Own Format (conference-supplied LaTeX bundles)

> **The student-killer extension to §8.5.10.** Real conferences don't ship to our 10 built-in templates; they ship a `.zip` with `IEEEtran.cls`, `bare_conf.tex`, `IEEEbib.bst`, sometimes a 12-page "Submission instructions" PDF. The student must produce a PDF that looks **exactly** like that bundle expects — wrong class, wrong margins, wrong font, desk-reject. The student should never have to abandon Lattice + markdown and re-learn LaTeX just because the conference is a snowflake.
>
> BYOF = "drop the conference zip in, keep writing markdown, get the conference-exact PDF out."

##### What "BYOF" means concretely

1. Student gets `ieee-tpds-2026.zip` (or `acm-chi-2026.zip`, or a journal-supplied `.tex` template) from the conference's call-for-papers page.
2. Drag-drops it onto Lattice → `Paper → Import format bundle…`
3. Lattice extracts it to `<vault>/.lattice/byof-templates/<id>/`, parses the main `.tex` for structure (class + class options + bibliography style + section skeleton + author/title commands + figure/table macro signatures + special package requirements), and writes a `byof.toml` adapter that maps **the student's markdown sections** (`sections/01-intro.md`, `sections/02-related.md`, …) into the right LaTeX placeholders.
4. From this point on the student keeps writing pure markdown in `sections/*.md`. Build (`Cmd+B`) compiles via bundled **Tectonic** using the imported `.cls/.sty/.bst` files. Output PDF is byte-pattern indistinguishable from what `pdflatex bare_conf.tex` would produce against the conference template.
5. Submit-day: `Paper → Export → Conference bundle` zips up the rendered `.tex` (markdown re-converted via pandoc-equivalent) + the conference's `.cls`/`.bst` + the bibliography + figures, ready to upload to HotCRP / EasyChair / CMT.

##### What the importer actually parses

- **Class file (`.cls`):** name + options (e.g. `\documentclass[conference,a4paper,10pt]{IEEEtran}`) → recorded verbatim in `byof.toml [class]`.
- **Style files (`.sty`):** every `\usepackage{...}` from the sample document is recorded → preserved on every build (no silent drops).
- **Bibliography style (`.bst`):** captured from `\bibliographystyle{...}` → routed to `biber`/`bibtex` automatically based on file presence.
- **Section skeleton:** parse the sample `.tex` between `\begin{document}` and `\end{document}` for `\section{…}`, `\subsection{…}`, `\IEEEPARstart{…}`, custom macros (`\IEEEauthorblockN`, `\acmauthor`, etc.). Build a placeholder map: `intro` → `\section{Introduction}`, `methods` → `\section{Methods}`, etc.
- **Custom macros:** detect non-standard commands (e.g. `\threeauthors`, `\ChairOfTheConference`) → either auto-fill from `paper.toml [authors]` if the signature matches, or surface a "this template requires `\foo{}` — fill in here" panel in the editor.
- **Required packages / missing fonts:** Tectonic auto-downloads from TeX Live mirror; anything that can't be auto-resolved (proprietary fonts, e.g. `MinionPro`) is flagged **up front**, not at build time. The pre-flight check is what saves the student from a 3 a.m. deadline panic.

##### The `byof.toml` adapter (generated, hand-editable)

```toml
[meta]
id         = "ieee-tpds-2026"
imported   = "2026-01-12T11:02:00Z"
source_zip = "ieee-tpds-2026.zip"

[class]
file    = "IEEEtran.cls"
name    = "IEEEtran"
options = ["conference", "a4paper", "10pt"]

[bibliography]
style = "IEEEtran"
file  = "IEEEbib.bst"
backend = "bibtex"      # or "biber"

[packages]
required = ["graphicx", "amsmath", "amssymb", "cite", "url"]
optional = ["microtype"]

[macros]
title   = "\\title{{{ title }}}"
authors = "\\IEEEauthorblockN{{{ name }}}\n\\IEEEauthorblockA{{{ affiliation }}}"

[sections]
# Markdown filename in sections/  →  LaTeX heading command + level
"01-introduction.md"     = { command = "\\section",    title = "Introduction" }
"02-related-work.md"     = { command = "\\section",    title = "Related Work" }
"03-methods.md"          = { command = "\\section",    title = "Methods" }
"04-results.md"          = { command = "\\section",    title = "Results" }
"05-discussion.md"       = { command = "\\section",    title = "Discussion" }
"06-conclusion.md"       = { command = "\\section",    title = "Conclusion" }

[figure_macro]
single   = "\\begin{figure}[t]\n\\includegraphics[width=\\linewidth]{{{ path }}}\n\\caption{{{ caption }}}\n\\label{{{ label }}}\n\\end{figure}"
twocol   = "\\begin{figure*}[t]\n... \n\\end{figure*}"

[preflight]
missing_fonts   = []     # populated by the importer; non-empty blocks build
missing_packages = []
warnings = [
  "Template uses \\IEEEPARstart in the intro — first paragraph will be auto-rewrapped."
]
```

##### Build pipeline (BYOF mode)

```
sections/*.md  →  pandoc-ast (or in-house md→tex via comrak + custom writer)
                  →  apply [macros] + [sections] substitutions from byof.toml
                  →  emit  build/main.tex
                  +  symlink imported .cls/.sty/.bst into build/
                  →  tectonic build/main.tex
                  →  build/main.pdf
```

Same Tectonic build pipeline as §8.5.4 — we just swap `.typ` for `.tex` and the template files come from `.lattice/byof-templates/<id>/` instead of `@templates/`.

##### UX surface

- `Paper → New Paper → Import conference template…` is a peer of the 10 built-in templates from §8.5.10. After import, the conference appears in the template picker like any other.
- `Paper → Validate against template` runs the preflight check from `[preflight]` whenever the user opens the paper — it catches missing-package issues before the build does.
- The right sidebar shows a **"Format: IEEE TPDS 2026"** chip; clicking it opens `byof.toml` for hand-edits.
- Status pill turns yellow if `[preflight]` has unresolved warnings.

##### Edge cases we explicitly cover

| Case | Behavior |
|---|---|
| Template ships only a PDF "instructions" file (no `.tex`) | Importer says *"Need a `.tex` skeleton — please drop one in too, or paste the page-formatting commands."* No silent guess. |
| Template uses proprietary fonts (MinionPro, Charter Pro) | Preflight flag; we offer "substitute with closest free font (TeX Gyre Termes)" with a one-click toggle. PDF will visually differ — we warn loudly. |
| Multi-author template with N-author macro (`\authorblockN`) | We populate from `paper.toml [authors]` array; if the macro arity doesn't match, we open the macro panel and let the user map by hand once — the mapping persists. |
| Template requires a non-LaTeX tool (e.g. `bibexport`, `gnuplot`) | Recorded in `[preflight].external_tools`; we shell out via the same sandbox as §5.1 plugins, with a "you'll be prompted to allow X" confirmation on first build. |
| Conference changes the template mid-cycle | `Paper → Re-import template` swaps the bundle; `byof.toml` is regenerated and the user's hand-edits are preserved via a 3-way merge against the previous `byof.toml`. |
| User writes `\latex{...}` inline (escape hatch) | Markdown→TeX pass-through respects raw-LaTeX fences (` ```latex ` and `$...$`); we never round-trip these through pandoc's smart-quote rewriter. |

##### BYOF for non-LaTeX formats (forward-looking)

Same adapter shape works for any "conference ships their format" case:

- **Word `.docx` templates** (CHI/UIST late-breaking, many medical journals): convert markdown → `.docx` via pandoc using the conference template as `--reference-doc`. Same `byof.toml`, different `[backend]`.
- **Springer LNCS official package**: identical to LaTeX BYOF, special-cased only because Springer ships a `.zip` with two skeleton files.
- **ACM Submission System Word template**: pandoc reference-doc path.

The principle is the same: **the user keeps writing markdown; the format adapter handles everything else.**

##### Why this belongs in v1 (and not behind §8.5.10)

- Built-in templates (§8.5.10) cover the 10 most common cases but conferences are a long tail of weird snowflakes; without BYOF the student has to leave Lattice for Overleaf the moment they submit to anything non-standard.
- The whole "academic killer" pitch from §8.5.1 collapses if "but you have to use one of our 10 templates" is the asterisk. BYOF makes the pitch unconditional.
- Implementation is largely **reuse** — Tectonic + comrak + pandoc are already in the §8.5.4 build pipeline; BYOF is mostly the `.tex` parser + the adapter writer + a UX panel for the preflight warnings.

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

> **Onboarding is universal** — every user, on every platform, sees the same 9-step flow on first launch. It is not gated by persona, not behind a paywall, and not optional in v1. Persona pick (Step 2) only changes *defaults*; every feature stays available to every user afterward.
>
> **Full design lives in its own doc:** [`onboarding-journey.md`](onboarding-journey.md) — 11 sections covering principles, per-step UX, state schema, IPC contract, React component layout, accessibility checklist, telemetry events, edge cases, open questions, and an engineer-sized build sequence.

Quick recap (the long version is in the dedicated doc):

| # | Step | Skippable? | Purpose |
|---|---|---|---|
| 0 | Splash + EULA | No (legal) | Boot + auto-detect existing Obsidian/Logseq vaults + local Ollama |
| 1 | Welcome | Yes (one-click *"Skip all"* → 45-second path) | Honest data-handling promise |
| 2 | Persona | Yes (defaults to Student) | Sets defaults only; never gates features |
| 3 | Vault | No (need *some* vault) | Create / Open / Import |
| 4 | Theme + density | Yes | Live preview, zero stakes |
| 5 | Sync (BYOC) | Yes | OAuth in system browser; non-blocking |
| 6 | Encryption (E2EE) | Yes | Default Off for Student/Dev, On for Enterprise; recovery passphrase forced |
| 7 | AI (BYOM) | Yes | Local Ollama auto-detect or BYOK; privacy matrix locked to strictest preset |
| 8 | Calendar + extras | Yes | Daily journal, calendar, CLI, web clipper, telemetry (always-default-off) |
| 9 | Tour + "You're ready" | — | `Welcome.md` + status-bar background jobs (initial push, imports) |

Re-runnable any time from *Settings → Help → Re-run onboarding* without destroying data. Headless / MDM install bypasses the UI by reading prefill JSON written by the installer. Wizard always completes offline (steps that need the network degrade gracefully). See [`onboarding-journey.md`](onboarding-journey.md) for the full state schema, IPC commands, accessibility checklist, telemetry payloads, edge cases, and per-step build sequence.

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

> **Reorder rationale (this revision):** VCS is foundational — every sync/encryption/web-clipper path writes to a vault that must already be version-controlled. The **web clipper** has been promoted from step 16 to step 4 because (a) it is independent enough to be developed in parallel by a different track, (b) it produces immediate visible value for every persona, and (c) BYOC is much easier to dogfood once we have a steady stream of clipped notes flowing in. **BYOC** sits right after web clipper for that reason: it's the natural "now I want this on my other devices" payoff. **Onboarding** stays at step 3 so the introductions for steps 4+ all hang off the wizard. **BYOF** (§8.5.13) is grouped with the paper scaffolder since both share the same Tectonic build pipeline.

> **🎯 Current POC focus (post-BYOC):** BYOC (step 5) is shipped and in testing. The next two POCs being actively planned are **Paper export + BYOF (step 10)** and **Publishing pipeline (step 18)** — see the dedicated slice plans [`docs/paper-export-plan.md`](paper-export-plan.md) and [`docs/publishing-plan.md`](publishing-plan.md). They are deliberately *not* being renumbered in the queue (the dependency order still holds — Publishing reuses the BYOC GitHub token, Paper export needs no upstream features), but the two slice plans are the authoritative breakdown of work for the immediate POC track. Steps 6–9 and 11–17 continue in parallel where they don't block step 10 or step 18.

1. **Backlinks v2 — engine + sidebar stats panel (§ done this session, see `src/lib/backlinks.ts`).** ✅ Shipped: alias/anchor-aware engine, grouped snippets with line numbers + highlight, mentions/files/unlinked stats strip, unlinked-mention detector. Status pill now reports total mention count.
2. **Default VCS layer + Changes panel (§4).** Foundation for both BYOC and AI commit messages. Nothing else on this list assumes a known-good vault history until this lands.
3. **Onboarding wizard + Welcome.md (§10, [`onboarding-journey.md`](onboarding-journey.md)).** Every feature shipped after this point gets introduced through the wizard, so it has to come before BYOC/E2EE/calendar etc.
4. **Web clipper (browser extension + IPC handshake, [`current-state.md`](current-state.md#6-web-clipper-browser-extension) §6).** Promoted: independent track, immediate-value, fills the vault with content that step 5+ then syncs. Can be built in parallel from step 2 onward.
5. **BYOC plugin host + first adapter (GitHub) (§5.1, §5.2).** Once the vault is version-controlled (step 2) and is filling up with clips (step 4), users want it on their other devices. Establishes the plugin contract.
6. **E2EE phase 1 (§9.1–9.4, §9.9 step 1).** Lands with BYOC so privacy-conscious users adopt sync from day one.
7. **Importers — Obsidian + Logseq (§11.1, §11.2).** Cheapest, highest-value imports for the persona we already attract; intentionally after BYOC so an imported vault syncs out of the box.
8. **Calendar tier C (Google Calendar) + Journaling (§1.4, §2).** Largest user-base, most-requested feature for the Student persona.
9. **BYOM + Ollama default + privacy matrix (§5.3).** Unlocks AI commit messages (§4.2) and the agentic features in §5.3.
10. **Paper scaffolder + BYOF + Typst compile pipeline (§8.5, §8.5.13, §8.1).** Headline differentiator vs Overleaf/Notion/Obsidian; BYOF lands together so the very first paper a student writes can target any conference, not just our 10 built-in templates. **→ Slice plan: [`docs/paper-export-plan.md`](paper-export-plan.md).**
11. **Canvas extras phase 1 (§3.1 items 1-5).** Closes the gap to Excalidraw without a dependency.
12. **Databases v1 — Table + Kanban + embedded-row mode (§7).** Big effort, big payoff.
13. **Calendar tier A (Outlook + Teams) + Meeting note generation (§1.2).** Enterprise tier opens up.
14. **Importers — Notion + Siyuan (§11.3, §11.4).** Now that we have databases, Notion import is finally lossless.
15. **CLI — `lattice` ratatui (§6).** Senior-engineer love letter; can be developed in parallel from step 5 onward.
16. **Academic bundle polish — citation graph, lab-notebook template, AI assist (§8.3, §8.4, §8.5.12) + Stats for nerds (§12).** Builds on the §8.5 scaffolder shipped in step 10.
17. **Remaining BYOC providers (Drive, OneDrive, Dropbox, WebDAV) (§5.2.1).** Each one is a new file once the trait stabilizes; all four share the delta-cursor scheduler so they fan out in parallel. **iCloud is intentionally NOT on the v1 queue** (Apple Dev account + macOS-only signing makes the cost-to-reach ratio untenable; see §5.2.1).
18. **Publishing pipeline — Quartz SSG + GitHub Pages / Cloudflare Pages / Netlify / Vercel + local browser preview (§5.5).** The Obsidian-Publish replacement. Lands after Drive/OneDrive/Dropbox ship because (a) the BYOC-GitHub OAuth token from step 5 is reused by the GitHub Pages adapter (same backup repo used for sync hosts the `publish` orphan branch), and (b) advanced users on the other clouds expect a publish target by then. The compile pipeline + 3 layouts (Garden/Docs/Notebook) + the local-preview server all ship together — splitting them by layout would re-trigger Quartz config churn three times. **→ Slice plan: [`docs/publishing-plan.md`](publishing-plan.md).**
19. **Calendar tier B (Cal.com) + Apple Calendar.** Long tail.
20. **Canvas extras phase 2 (§3.1 items 6-10) + research-paper exports (§3.2, §8.1–8.2).**
21. **E2EE phases 2-5 (§9.9 steps 2-5).**
22. **Community plugin marketplace (§5.4).**

Anything past step 22 is "v3" — Iroh P2P, MS Teams AI insights deep integration, real-time Automerge collaboration, full agentic AI flows, custom-domain support for the publish pipeline.

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
