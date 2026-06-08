# Publishing — Slice D implementation plan (Obsidian-Publish-style, Quartz-powered, BYOC-host)

> **Scope.** This is the implementation plan for the **publishing layer** — turn the user's vault (or a subset of it) into a public website, the same way Obsidian Publish does, but with the user owning the host. Two paths:
>
> 1. **GitHub Pages** — reuses the BYOC GitHub OAuth token already in the keychain; pushes the static build to the **same backup repo** the vault is already syncing through, on a separate orphan branch (`publish`). Zero new credentials, one extra OAuth scope (`pages`).
> 2. **External provider** — Cloudflare Pages, Netlify, or Vercel. Each gets its own OAuth / API-token paste flow, modelled exactly on the BYOC adapter shape (`PublishHost` trait mirrors `SyncProvider`).
>
> The build itself is **Quartz** (the well-maintained Node SSG used by hundreds of public digital gardens) so we get every Obsidian-Publish-equivalent feature for free: backlinks, graph view, Wikilinks, KaTeX, syntax highlighting, callouts, dark mode.
>
> **Cherry on top:** a **local browser preview** of the *published site* (not the desktop app in a browser) — a one-shot Tauri sidecar HTTP server on `127.0.0.1:<random>` serves the freshly-built `public/` folder; we open the user's default browser to it. So the user sees the exact site visitors will see, before clicking Deploy.
>
> This expands on [`docs/impl-v2.md`](impl-v2.md) §5.5 (Publishing pipeline) and is the concrete checklist for "Slice D" of the v2 roadmap.

---

## 1. Hard product rules

1. **Lattice has no publishing server.** Same rule as BYOC — every upload goes directly from the user's machine to GitHub / Cloudflare / Netlify / Vercel. Lattice is never on the network path for site content.
2. **Lattice never sees a host token.** All four host providers' tokens live in the OS keychain (via `keyring-rs`) keyed by `(vault_id, host_id)`. The token is loaded into memory only for the duration of an upload, then dropped.
3. **The user owns the destination repo / project.** We don't create accounts on the user's behalf and we don't proxy a "publish.lattice.dev" subdomain. If they don't have a GitHub repo / Cloudflare project / Netlify site, we walk them through creating one in the one-time setup wizard — but it's their project on their account.
4. **The user's notes never leave the vault folder.** The publish build reads from `<vault>/`, writes the static site to `<vault>/.lattice/publish/build/`, and uploads from there. No copy-to-tempdir, no AppData spillage.
5. **Exclusions are explicit and honored.** The defaults exclude `.lattice/`, `*.private.md`, files with frontmatter `publish: false`, and any path under a folder named `private/` or `drafts/`. The user can extend the list. **Frontmatter `publish: true` is also required for any file not under a `published/` root folder.** Default-public vs default-private is a setup choice; default-private is the safe default.
6. **Quartz version pinning.** **Quartz v5** is the target shipped version (released 2026-05-24; see <https://quartz.jzhao.xyz/>). We pin to `@jackyzha0/quartz@^5` and document the supported range in `publish.toml [quartz].version_range`. **No v4 back-compat shipped in slice D** — v5 is new enough that early adopters won't have v4 vaults to migrate, and shipping two config emitters doubles surface area. If the v5 minor release stream introduces a breaking change to `quartz.config.ts`, we gate `config_gen` on the resolved binary version (the gating logic still belongs in `config_gen.rs` even though it has one path today).
7. **Node is detected, not bundled — v22+ required.** Strategy B from `impl-v2.md` §5.5: at first publish, we probe for `node` (must satisfy `>= v22.0.0`) and `npm` (must satisfy `>= v10.9.2`) on PATH — these are Quartz v5's hard requirements per the v5 install docs. If either is missing or too old, surface a download CTA pointing at `https://nodejs.org/en/download` with a one-line note about the version floor. Mirrors the existing `git` precedent (we also don't ship git).

This shapes everything below.

---

## 2. Where we are today

- BYOC (slice B) is shipped — GitHub adapter uses Device Code Flow + per-vault keychain entries; tokens live under DPAPI on Windows / `keyring-rs` on mac+linux. **We reuse this GitHub token verbatim** for the GitHub Pages publish path. The Drive / OneDrive / Dropbox sync adapters are *not* used for publishing — those are sync targets, not webhost.
- `reqwest`, `tokio`, `keyring`, `oauth2` are all already in `src-tauri/Cargo.toml`. `tauri-plugin-opener` is wired and used by VCS for "open commit on GitHub". `tauri-plugin-fs` is registered. `tauri-plugin-shell` is **NOT** yet a dependency — we add it in this slice (we need it to spawn `npx quartz build`).
- `ChangesPanel.tsx` is the canonical place the user already sees VCS state + BYOC capsule rows. The Publish CTA lands as a third section there ("Publish") with the same row/state pattern as the BYOC providers.
- `StatusPill.tsx` is the bottom-bar status surface; the BYOC capsule already lives there. Publish gets a sibling capsule (the "earth" icon from §5.5).
- The editor's frontmatter parser (used by `lib/indexer.ts` for the graph view) already reads YAML frontmatter — we extend it to read `publish: true|false` without a new parser.
- `OnboardingShell.tsx` exists; the publishing wizard mounts as a **dialog-style modal**, not a new onboarding step. (Onboarding is for first-time vault setup; publishing is a per-vault-after-it-exists action.)

What does **NOT** exist yet:

- Any `src-tauri/src/publish/` module.
- Any Node detection / Quartz install / Quartz config emission.
- Any Pages / Cloudflare / Netlify / Vercel adapter.
- Any local preview HTTP server.
- Any `.lattice/publish.toml` schema or `.lattice/publish/` build folder.
- Any "Publish" CTA, wizard, or settings panel.

Slice D is the work to make all of that real.

---

## 3. Tractability snapshot (host free-tier ceilings)

Mirrors §3 of `byoc-plan.md`.

| Host | Free-tier ceiling | Upload primitive | Auth | Why it's a first-party adapter |
|---|---|---|---|---|
| **GitHub Pages** | 100 GB bandwidth/mo, 10 build min/mo (we build locally, so we use 0); 1 GB site size | `git push` to `publish` orphan branch + GraphQL `enablePagesSite` mutation | **Reuses BYOC GitHub token** (Device Code Flow + `repo` scope; we add `pages` scope on first publish) | The only host that lets the user use their existing BYOC repo as the publish target. Zero new credentials path. |
| **Cloudflare Pages** | Unlimited bandwidth, unlimited sites, 500 builds/mo (we build locally → no builds count against us), 25 MB single-asset cap | Direct Upload API (`POST /accounts/:id/pages/projects/:name/deployments`, multipart) | **API token paste** — we open `https://dash.cloudflare.com/profile/api-tokens` with the right template URL pre-filled (`Edit Cloudflare Pages` template); user clicks Create → copies → pastes into Lattice. No OAuth (Cloudflare's OAuth is for partner integrations only). | Best free tier; most lattice users on consumer plans hit zero costs. |
| **Netlify** | 100 GB bandwidth/mo, 300 build min/mo (local builds = 0 used) | `POST /api/v1/sites/:id/deploys` (deploy by tar of `dist/` + per-file SHA1 manifest) | PKCE OAuth, system browser, loopback redirect (same shape as BYOC OAuth flows) | "Just works" UX — most one-click target. |
| **Vercel** | 100 GB bandwidth/mo (Hobby plan, "non-commercial use only" — surfaced as a banner in the picker) | `POST /v13/deployments` (deployment files API; pre-upload `POST /v2/files` per blob) | PKCE OAuth via Vercel's Integration flow, system browser, loopback redirect | Strong for users who already have Vercel projects. |

Cloudflare Pages is **recommended default** in the picker (best free tier, no commercial-use restriction); GitHub Pages is **recommended for BYOC-GitHub users** (zero new credentials).

---

## 4. Crate / module layout

One new module tree under `src-tauri/`, mirroring the BYOC `sync/` shape.

```text
src-tauri/src/
├── git.rs              # existing
├── sync/               # existing (BYOC slice)
├── paper/              # existing if slice C lands first; else later
├── commands.rs         # existing
├── lib.rs              # MODIFIED — register publish_* invoke handlers
└── publish/            # NEW
    ├── mod.rs          # PublishHost trait, IPC commands, publish.toml load/save
    ├── toml.rs         # .lattice/publish.toml schema + .lattice/publish/state.json
    ├── node_probe.rs   # detect `node` / `npm` / `npx` on PATH; report missing
    ├── quartz.rs       # npm i + npx quartz create + npx quartz plugin install --from-config
    │                   # + npx quartz build, streaming stdout to UI
    ├── config_gen.rs   # emit .lattice/publish/quartz/quartz.config.ts from publish.toml
    ├── exclude.rs      # decide which vault files are copied into content/ before build
    ├── preview.rs      # one-shot 127.0.0.1:<random> static-file server (axum or hyper-only)
    ├── host.rs         # PublishHost trait + DeployResult + DeployProgress
    ├── github_pages.rs # adapter — reuses sync::keychain entry "github" + adds "pages" scope
    ├── cloudflare.rs   # adapter — Direct Upload API
    ├── netlify.rs      # adapter — Deploy API, PKCE flow
    ├── vercel.rs       # adapter — Deployments API, PKCE flow
    └── templates/      # bundled scaffold dropped into .lattice/publish/quartz/
        ├── garden/     # default layout — graph + backlinks visible, casual tone
        ├── docs/       # docs.rs-style sidebar, search-first, no graph
        └── notebook/   # academic — math-heavy, footnotes, no transitive backlinks
```

Frontend mirror under `src/`:

```text
src/
├── lib/
│   └── publish.ts                 # NEW — IPC wrappers (mirrors lib/byoc.ts)
├── state/
│   └── publishStore.ts            # NEW — Zustand; per-vault publish state
└── components/
    ├── publish/
    │   ├── PublishWizard.tsx      # NEW — one-time setup wizard (host pick → auth → first publish)
    │   ├── PublishWizard.css
    │   ├── PublishPanel.tsx       # NEW — settings panel; mounted under Settings → Publish
    │   ├── PublishPanel.css
    │   ├── PublishStatusPill.tsx  # NEW — earth icon capsule for the StatusPill row
    │   └── PublishPreviewBanner.tsx # NEW — yellow banner shown when a preview server is live
    └── layout/
        ├── ChangesPanel.tsx       # MODIFIED — add Publish section below the BYOC providers
        └── StatusPill.tsx         # MODIFIED — render PublishStatusPill when publish.toml exists
```

### New Rust dependencies

Add to `src-tauri/Cargo.toml`:

```toml
# Spawn `node` / `npm` / `npx` from Rust + the Tectonic sidecar (slice C, harmless to share).
tauri-plugin-shell = "2"

# Local static-file preview server. We could use axum but it pulls hyper transitively;
# easier and lighter to use `tiny_http` for the one-shot preview.
tiny_http = "0.12"

# MIME sniffing for the preview server's Content-Type.
mime_guess = "2"

# Glob matching for [exclude].patterns (handles `**/*.private.md`-style).
globset = "0.4"

# Tarball creation for Netlify's Deploy API.
tar = "0.4"
flate2 = "1"

# Already-present: reqwest, tokio, keyring, oauth2, blake3, rand, url, jsonwebtoken.
```

Add to `src-tauri/capabilities/default.json`:

```jsonc
{
  "permissions": [
    // existing entries...
    "shell:default",
    {
      "identifier": "shell:allow-execute",
      "allow": [
        // node / npm / npx — system-installed; we don't pin the absolute path
        // because it varies (volta / nvm / chocolatey / brew). The user's PATH
        // is the source of truth, validated by node_probe.rs at config time.
        { "name": "node", "cmd": "node", "args": true, "sidecar": false },
        { "name": "npm",  "cmd": "npm",  "args": true, "sidecar": false },
        { "name": "npx",  "cmd": "npx",  "args": true, "sidecar": false }
      ]
    }
  ]
}
```

Frontend deps: none new. The wizard reuses the existing modal primitives (matching `SettingsModal.tsx` / `ManageVaultsModal.tsx`).

---

## 5. The `PublishHost` trait

Shape-for-shape parallel to `SyncProvider` in `src-tauri/src/sync/mod.rs`. The orchestration layer (`publish/mod.rs`) is host-agnostic; adapters know how to do five things.

```rust
// src-tauri/src/publish/host.rs
#[async_trait::async_trait]
pub trait PublishHost: Send + Sync {
    /// Stable enum value used in IPC + keychain account names.
    fn id(&self) -> HostId;

    /// Human label for the UI ("GitHub Pages", "Cloudflare Pages", "Netlify", "Vercel").
    fn display_name(&self) -> &'static str;

    /// Phase 1 of the auth flow:
    ///  - GitHub Pages: reuse existing BYOC token, request `pages` scope upgrade if missing.
    ///  - Cloudflare:   open the dashboard URL with a template ID; return a "paste token" handle.
    ///  - Netlify/Vercel: PKCE flow — same shape as sync::oauth::start_pkce.
    async fn auth_start(&self, app: &AppHandle, vault_id: &str) -> Result<AuthSession, PublishError>;

    /// Phase 2 — complete the auth (PKCE redirect lands, OR user pastes the token).
    /// Writes credentials to the keychain. Idempotent — re-auth replaces the prior entry.
    async fn auth_complete(&self, session: AuthSession, code_or_token: String) -> Result<HostAccount, PublishError>;

    /// Probe: do we have a working token AND a destination project for this vault?
    /// Cheap — keychain probe + one cached metadata GET.
    async fn status(&self, vault_id: &str) -> Result<HostStatus, PublishError>;

    /// Upload the directory at `built_site_path` to the host. Idempotent — each adapter
    /// dedupes server-side (Cloudflare via file SHA, Netlify via file SHA1 manifest,
    /// Vercel via blob SHA1, GitHub Pages via `git push` with normal pack dedup).
    /// Streams progress (current_file, bytes_uploaded, total_bytes) via Tauri events.
    async fn deploy(&self, vault_id: &str, built_site_path: &Path, progress: ProgressSink) -> Result<DeployResult, PublishError>;

    /// Disconnect — wipe tokens for this (host, vault) pair from the keychain.
    /// Does NOT delete the deployed site (the user owns it on the host side).
    async fn disconnect(&self, vault_id: &str) -> Result<(), PublishError>;
}

#[derive(Copy, Clone, Eq, PartialEq, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HostId {
    GithubPages,
    Cloudflare,
    Netlify,
    Vercel,
}

#[derive(Debug, serde::Serialize)]
pub struct DeployResult {
    pub live_url: String,        // e.g. "https://my-vault.pages.dev"
    pub provider_dashboard: String, // host's site-management URL — for "Manage on Cloudflare" button
    pub deploy_id: String,        // host-specific id for log lookup
    pub deployed_at: String,      // ISO-8601 UTC
    pub bytes_uploaded: u64,
    pub files_uploaded: u32,
    pub files_skipped: u32,       // dedup hits
}
```

---

## 6. Auth flows per host

### 6.1 GitHub Pages (reuses BYOC token)

This is the **happy path** the user's request explicitly calls out: "BYOC credentials will be used to publish to pages — same backup repo used for syncing will be managed".

```text
User clicks "Set up Publishing" in the wizard, picks "GitHub Pages".
  │
  ├─ publish::github_pages::auth_start checks sync::keychain for an existing
  │  "github" token for this vault.
  │
  ├─ If found:
  │   - Probe the token's current scopes via GET /user (the X-OAuth-Scopes header).
  │   - If scopes include `repo` AND (`pages` OR `public_repo` is enough for public repos):
  │      → Return immediately as "ready", no new browser dance.
  │   - If scopes are missing `pages`:
  │      → Open https://github.com/settings/connections/applications/<our_client_id>
  │        in the system browser via tauri-plugin-opener.
  │      → Show a banner in the wizard: "Click 'Pages' on the permissions page, then click Continue here."
  │      → On Continue: re-probe scopes; loop until pages-present or user cancels.
  │
  ├─ If NOT found (user has BYOC on Drive but not GitHub):
  │   - Fall through to the standard BYOC Device Code Flow (sync::github::device_code_flow)
  │     with `repo,pages` scope. Tokens written to keychain under the same
  │     ("byoc", vault_id, "github") slot that the sync adapter uses.
  │     The sync adapter benefits — connecting Pages also enables Drive-style sync.
  │
  └─ Phase 2: list the user's repos (GET /user/repos), default-pick the repo
     that BYOC is already syncing into (we read it from sync-manifest.github.json's
     [remote].repo field). User can override to "create a new repo" — we POST
     /user/repos with `private=true` and the BYOC adapter starts syncing into it
     on the next push.
```

**Branch model:** the publish target is an **orphan branch named `publish`** on the same repo (no overlap with `main`'s vault content). We force-push the build output to `publish` on every deploy. The orphan branch never touches the vault history; users who clone the repo to inspect their data ignore `publish` (it's the rendered output, not their source).

**GitHub Pages enablement:** first deploy POSTs `https://api.github.com/repos/:owner/:repo/pages` with `{ source: { branch: "publish", path: "/" } }`. Subsequent deploys are pure `git push`. The live URL is `https://<owner>.github.io/<repo>/` (or custom domain if configured under `[host.custom_domain]` in `publish.toml`).

### 6.2 Cloudflare Pages (token paste)

```text
User picks "Cloudflare Pages".
  │
  ├─ Wizard explains in one paragraph: "Cloudflare wants an API token, not OAuth.
  │  We'll open the right page for you with the template pre-filled — paste the
  │  result here."
  │
  ├─ Click [Open Cloudflare dashboard]:
  │   - tauri-plugin-opener opens
  │     https://dash.cloudflare.com/profile/api-tokens
  │     ?permissionGroupKeys=[{"key":"pages_edit","type":"account"}]
  │     &name=Lattice%20Publish%20-%20<vault-name>
  │   - User clicks "Continue to summary" → "Create token" → "Copy".
  │
  ├─ Back in the wizard:
  │   - Paste field (with eye-toggle to mask).
  │   - "Verify" button → GET /accounts/<id>/pages/projects with the token.
  │     If 200: list user's projects + show "Create new project" option.
  │   - User picks "create new" → we POST /accounts/<id>/pages/projects with
  │     name="<slug>-lattice".
  │
  └─ Token written to keychain under ("publish", vault_id, "cloudflare").
     Stored alongside the account_id (needed for every subsequent API call).
```

### 6.3 Netlify (PKCE OAuth)

Standard PKCE shape — copy-paste from `sync::oauth::start_pkce`:

```text
Click "Connect Netlify" → spawn loopback server on 127.0.0.1:<random>
  → open https://app.netlify.com/authorize
       ?client_id=<lattice_netlify_client_id>
       &response_type=code
       &redirect_uri=http://127.0.0.1:<port>/callback
       &state=<nonce>
       &code_challenge=<S256>
       &code_challenge_method=S256
  → user approves
  → loopback receives ?code=… → exchange for token at POST /oauth/token
  → list user's sites (GET /api/v1/sites) → pick one OR "create new site"
     (POST /api/v1/sites with name="<slug>-lattice")
  → token + site_id to keychain under ("publish", vault_id, "netlify").
```

### 6.4 Vercel (PKCE OAuth via Integration)

Same PKCE shape as Netlify, but Vercel uses the Integration flow:

```text
Click "Connect Vercel" → open
  https://vercel.com/integrations/<lattice_integration_slug>/new
  ?slug=lattice&team_slug=<optional>
  → user approves → redirect to 127.0.0.1:<port>/callback
  → exchange code at POST https://api.vercel.com/v2/oauth/access_token
  → list projects (GET /v9/projects) → pick OR create
     (POST /v10/projects with name="<slug>-lattice", framework=null)
  → token + project_id + team_id (if any) to keychain under
     ("publish", vault_id, "vercel").
```

All four flows reuse the **same loopback server primitive** as BYOC's `sync::oauth::loopback`. (Cloudflare's flow doesn't need a redirect listener — the user pastes — but the wizard component shape is identical.)

---

## 7. `publish.toml` schema (per-vault config)

Lives at `<vault>/.lattice/publish.toml`. Single source of truth for everything the build + deploy pipeline needs to know.

```toml
[meta]
schema  = 1                          # bump on breaking changes
created = "2026-06-10T12:42:00Z"

[host]
id       = "github-pages"            # "github-pages" | "cloudflare" | "netlify" | "vercel"
slug     = "my-digital-garden"       # site name on the host
project_id = "8a3f…"                 # host-side stable id (Cloudflare/Netlify/Vercel)
repo     = "owner/repo"              # GitHub only — reused from BYOC sync-manifest if matched
branch   = "publish"                 # GitHub only — orphan branch we force-push to
custom_domain = ""                   # optional: "garden.example.com" — sets CNAME on deploy
live_url = "https://owner.github.io/repo/" # last-known good URL; refreshed on every deploy

[quartz]
version       = "5"                  # locked to v5 in slice D
version_range = "^5"                 # npm semver range pinned in the bundled package.json
plugins       = []                   # custom community plugins (out of scope for v1; reserved)
template  = "garden"                 # "garden" | "docs" | "notebook"
theme     = { dark = true, accent = "#5a8fd6", font_family = "Inter" }
features  = { graph = true, backlinks = true, search = true, math = true, syntax = true, rss = true }
analytics = { provider = "none", id = "" } # "none" | "plausible" | "umami" | "ga4"

[content]
# What's published. Two complementary opt-in mechanisms:
#  1) Frontmatter: any file with `publish: true` is included.
#  2) Folder: every file inside paths listed in `include_folders` is included
#     UNLESS individually marked `publish: false`.
include_folders = ["published/", "blog/"]
require_frontmatter_true = false      # if true, include_folders is ignored — every file must opt-in

[exclude]
# Glob patterns evaluated relative to vault root. Lower priority than `[content]`.
patterns = [
  ".lattice/**",
  ".git/**",
  "private/**",
  "drafts/**",
  "**/*.private.md",
  "**/.DS_Store",
  "**/Thumbs.db",
]

[transform]
# Wiki-link resolution policy:
# "drop"       - render as plain text if target not in published set
# "footnote"   - render text + footnote with link to lattice.app (NOT recommended)
# "ghost"      - render greyed-out, no link
wiki_unresolved = "ghost"

# Frontmatter fields exposed on the page (others stay private).
expose_frontmatter = ["title", "date", "tags", "description", "cover"]

# Strip these frontmatter fields before publish (private metadata).
strip_frontmatter = ["zotero_key", "private_note", "ai_summary"]

[preview]
# Local browser preview server config (the "cherry on top").
auto_open = true                     # open default browser on Preview click
bind      = "127.0.0.1"              # never 0.0.0.0 — host-local only
ttl_secs  = 1800                     # server auto-stops after 30 min of no requests

[deploy]
# Behavior knobs.
push_on_vcs_commit = false           # if true, every git commit triggers a publish
                                      # (we surface this as a checkbox in the wizard;
                                      #  default off so the user is never surprised)
require_preview_before_first_deploy = true  # first deploy MUST be preceded by a Preview run

[state]
last_deploy_at    = "2026-06-10T13:00:00Z"
last_deploy_id    = "abc123"
last_deploy_files = 247
last_deploy_bytes = 8_412_300
last_build_at     = "2026-06-10T12:59:48Z"
last_build_ms     = 9_842
```

Defaults come from `src-tauri/src/publish/templates/<template>/publish.defaults.toml` so each Quartz template sets its own sensible knobs.

---

## 8. IPC surface (registered in `src-tauri/src/lib.rs`)

Mirrors the BYOC + paper naming convention. All paths validated via `vault_dir()` first. All `publish_*` commands reject the mock vault sentinel at the TS layer (same guard as `byoc_*`).

| IPC command | Purpose | Returns |
|---|---|---|
| `publish_probe()` | Run `node_probe::probe()` — return `{ node: "v22.11.0", npm: "10.9.2", npx: true, ok: true }` or `{ missing: ["node"], ok: false }` or `{ node: "v20.10.0", npm: "10.2.3", npx: true, ok: false, reason: "node < v22 (Quartz v5 requires ≥ v22.0.0)" }`. Used by the wizard's first step. | `ProbeReport` |
| `publish_list_hosts()` | Static list of `[GithubPages, Cloudflare, Netlify, Vercel]` + per-host capabilities (e.g. `supports_custom_domain`, `requires_paste`). | `Vec<HostInfo>` |
| `publish_list_templates()` | Enumerate `src-tauri/src/publish/templates/` — `[garden, docs, notebook]`. | `Vec<TemplateInfo>` |
| `publish_init(vault, host_id, template_id)` | Scaffold `.lattice/publish.toml` + `.lattice/publish/quartz/` + `npm install`. Streams progress (`publish://progress`). One-shot per vault — re-running asks for confirm. | `()` |
| `publish_auth_start(vault, host_id)` | Begin auth (PKCE / paste / scope upgrade). Returns either a `RedirectStarted{}` or `PasteRequired{ dashboard_url }`. | `AuthStartResult` |
| `publish_auth_complete(vault, host_id, code_or_token)` | Complete auth. Lists candidate projects/repos/sites in the host account; returns them so the wizard can show the picker. | `Vec<HostProject>` |
| `publish_auth_pick(vault, host_id, project_id_or_new_name)` | Persist the user's chosen target into `publish.toml [host]`. If `new_name`, the adapter creates a new project on the host. | `()` |
| `publish_status(vault)` | Read `publish.toml` + run `host.status(...)` for the configured host. Cached for 30 s. | `PublishStatus` |
| `publish_build(vault)` | Run the build pipeline: `exclude::filter → copy to .lattice/publish/quartz/content/ → config_gen::write → npx quartz build`. Streams progress (`publish://progress`). | `PathBuf` (path to `.lattice/publish/build/`) |
| `publish_preview(vault)` | `publish_build` if needed → start `preview::server(...)` on `127.0.0.1:<random>` → return `{ url, port, token }`. If `auto_open = true`, also opens the system browser via `tauri-plugin-opener`. | `PreviewSession` |
| `publish_preview_stop(vault)` | Stop the running preview server. Idempotent. | `()` |
| `publish_deploy(vault)` | `publish_build` if no fresh build → `host.deploy(...)`. Streams progress (`publish://progress`). | `DeployResult` |
| `publish_disconnect(vault, host_id)` | Wipe host tokens from the keychain; reset `publish.toml [host]` to empty. Does NOT delete the deployed site. | `()` |
| `publish_open_dashboard(vault)` | Open the host's site-management URL (GitHub repo settings → Pages, Cloudflare project page, etc.). | `()` |
| `publish_open_live(vault)` | Open `publish.toml [host].live_url` in the system browser. | `()` |

Tauri events emitted on the `publish://progress` channel:

```ts
type PublishProgress =
  | { stage: "filter";   files_scanned: number; files_included: number }
  | { stage: "copy";     files_copied: number; total_files: number }
  | { stage: "build";    quartz_line: string }   // raw stdout line from `npx quartz build`
  | { stage: "preview";  url: string }
  | { stage: "deploy";   files_uploaded: number; total_files: number; bytes_uploaded: number; total_bytes: number }
  | { stage: "done";     deploy: DeployResult }
  | { stage: "error";    code: string; message: string };
```

---

## 9. Build pipeline (`publish::quartz`)

End-to-end, with paths anchored at vault root.

```text
publish_build(vault)
  │
  ├── 1. Filter:
  │      exclude::filter(vault_root, publish.toml [content] + [exclude])
  │      → returns Vec<PathBuf> of vault-relative paths to include.
  │      Honors:
  │       - include_folders (folder opt-in)
  │       - require_frontmatter_true (file-level opt-in)
  │       - exclude.patterns (globset)
  │       - frontmatter `publish: false` override
  │      Plus a hard safety filter: never include any path under .lattice/, .git/,
  │      or any path whose canonical form escapes vault_root.
  │
  ├── 2. Copy:
  │      For each included file:
  │        - Read source.
  │        - Apply transform::strip_frontmatter (drop private fields).
  │        - Apply transform::wiki_unresolved (rewrite [[Target]] per policy).
  │        - Apply transform::inject_published_urls — if a [[Target]] points to a
  │          note that ALSO has `publish: true`, rewrite the link as a Quartz-style
  │          relative link. This is the cross-feature integration with slice C
  │          (paper export): paper bibliographies use this same lookup so a paper's
  │          \href{} target matches the published URL.
  │        - Write to .lattice/publish/quartz/content/<vault-relative-path>.
  │      Asset files (PNG, SVG, PDF) are copied byte-for-byte (no transform).
  │
  ├── 3. Scaffold (first-build only):
  │      Quartz v5 expects the project to be initialised by `npx quartz create`
  │      (it copies the chosen template + writes the initial quartz.config.ts).
  │      We invoke it NON-INTERACTIVELY by piping the answers it would prompt for
  │      (template = empty -- we provide our own config; base URL = publish.toml
  │      [host].live_url or a placeholder; content source = symlink to ./content/).
  │      If .lattice/publish/quartz/quartz.config.ts already exists, skip.
  │
  ├── 4. Config emit:
  │      config_gen::write(publish.toml → .lattice/publish/quartz/quartz.config.ts)
  │      Templated from the chosen Lattice template's `quartz.config.template.ts`,
  │      substituting:
  │        - {{ TITLE }} (vault display name)
  │        - {{ BASE_URL }} (publish.toml [host].live_url)
  │        - {{ THEME }}, {{ ACCENT }}, {{ FONT_FAMILY }}
  │        - {{ ENABLE_GRAPH }}, {{ ENABLE_BACKLINKS }}, etc.
  │      Always overwrites — publish.toml is the source of truth, not the Quartz
  │      config. config_gen is version-gated (Quartz minor bumps emit slightly
  │      different config shapes); today gating is a no-op (only v5.x supported).
  │
  ├── 5. Install (first-build only OR package-lock.json hash changed):
  │      a. `npm install --no-audit --no-fund` against the bundled Lattice
  │         package.json (pins quartz@^5 + a curated allow-list of plugins).
  │      b. `npx quartz plugin install --from-config` (NEW in v5 — plugins are
  │         now resolved from quartz.config.ts at install time, not bundled).
  │      Stream stdout to publish://progress {stage:"build"}.
  │
  ├── 6. Build:
  │      Spawn `npx quartz build --output ../build/`
  │      (CWD = .lattice/publish/quartz/).
  │      Stream stdout/stderr to publish://progress.
  │      On non-zero exit: bubble up a PublishError with the last 30 lines of stderr.
  │      Recovery hint surfaced for the common "plugins fail on fresh clone":
  │      auto-retry once with `npx quartz plugin install --latest` (Quartz v5
  │      troubleshooting docs recommend this).
  │
  └── 7. Done:
         Verify .lattice/publish/build/index.html exists.
         Update [state] in publish.toml.
         Return PathBuf to .lattice/publish/build/.
```

`exclude::filter` and `copy` together never write outside `.lattice/publish/quartz/content/`. The Quartz process can only read from `.lattice/publish/quartz/` (we set a fixed `--directory .` and pass `--output ../build/` explicitly so the produced site never escapes the publish sandbox).

---

## 10. Local browser preview — the cherry on top

`publish::preview::server` is a one-shot `tiny_http` server. Lives entirely inside the Tauri process; no daemon, no port allocation if the user never clicks Preview.

```rust
// pseudocode
pub async fn start(build_path: &Path, cfg: &PreviewCfg) -> Result<PreviewSession, PublishError> {
    let bind = cfg.bind.parse::<IpAddr>()?;
    if !bind.is_loopback() { return Err(PublishError::NonLoopbackBind); } // hard guard
    let port = pick_free_port(bind)?;                  // 0..65535, OS-assigned
    let token = random_token_32();
    let server = tiny_http::Server::http((bind, port))?;
    // Spawn a tokio task per request.
    let handle = tokio::spawn(serve_loop(server, build_path.to_owned(), token.clone(), cfg.ttl_secs));
    Ok(PreviewSession {
        url: format!("http://{}:{}/?t={}", bind, port, token),
        port, token, started_at: now(), handle,
    })
}
```

Behaviour:

- **Loopback-only bind.** Hard-rejected if `[preview].bind != "127.0.0.1"`. We never bind to `0.0.0.0` even on the user's request — they can run `npx quartz build --serve` directly in the project folder if they need LAN-visible (Quartz v5's built-in dev server).
- **Token gate.** Every request must carry `?t=<token>` (or `X-Preview-Token` header). Lost on the first request to `index.html`? No — we sniff `?t=` and write a short-lived cookie before redirecting to clean URLs, so the rest of the SPA works without query-string spam.
- **Static-file only.** The server reads from `<build>/` and replies with the file's bytes + `mime_guess` Content-Type. Path traversal blocked: any `..` segment fails canonicalisation against the build root.
- **Auto-stop.** Server stops when:
  1. `publish_preview_stop` is called explicitly.
  2. `ttl_secs` elapses with no new requests (default 30 min).
  3. The vault closes / app quits (Tauri's `on_window_event` listener wires this).
  4. A new `publish_build` is triggered (the new preview supersedes the old).
- **What the user sees in the system browser:** their default browser navigates to `http://127.0.0.1:<port>/?t=<token>`, lands on the Quartz-rendered `index.html`. The site renders **exactly** like it will after deploy — same Quartz CSS, same graph view, same Wikilinks, same dark mode. Only difference: assets are served from localhost, not the eventual host.

A persistent **PreviewPreviewBanner** at the top of the editor area shows "Preview running on `127.0.0.1:54231` — [Open] [Stop]" while the server is live, so the user never forgets they have one running. Same banner used for the Overleaf-zip server in slice C (one component, two consumers).

---

## 11. VCS-triggered publish — the "guided one-time setup"

This is the user's verbatim ask: "triggers via vcs guide him to one time setup of all that". The flow:

```text
First commit after vault open
  │
  ├─ If .lattice/publish.toml does NOT exist:
  │   ChangesPanel surfaces a soft CTA below the "Commit" button:
  │     "📡 Publish this vault?  → [Set up Publishing]"
  │   Click → opens PublishWizard.
  │
  ├─ If publish.toml exists AND [deploy].push_on_vcs_commit = true:
  │   After every successful `vcs_commit_all`, fire publish_build → publish_deploy.
  │   Surfaced as a small spinner on the commit row + a toast on completion.
  │
  └─ If publish.toml exists AND [deploy].push_on_vcs_commit = false (default):
      After every successful commit, show a one-line toast:
        "Committed — vault has unpublished changes. [Preview] [Deploy]"
      Toast is dismissable; reappears on the next commit.
```

The wizard itself is **5 steps**, no skipping mid-flow:

| Step | Title | What happens |
|---|---|---|
| 1 | "Check your machine" | Calls `publish_probe`. If `node` missing OR `node < v22` OR `npm < v10.9.2`, show the nodejs.org download CTA + the version floor + "Recheck" button. No advancing until probe passes. |
| 2 | "Pick a host" | 4 cards (GitHub Pages / Cloudflare / Netlify / Vercel). Smart pre-selection: if a BYOC GitHub token exists, GitHub Pages is the recommended card with a "Reuses your existing credentials" badge. |
| 3 | "Sign in" | Host-specific auth flow (§6). Loopback / paste / scope-upgrade. |
| 4 | "Pick a destination" | Lists the user's repos / projects / sites; default-picked: the one BYOC is syncing into (GitHub) or "Create new <slug>-lattice". |
| 5 | "Pick a layout & confirm" | Garden / Docs / Notebook radio + custom-domain field (optional) + "Push on every commit?" checkbox (default off) + "Preview first?" checkbox (default ON — enforces `require_preview_before_first_deploy`). |
| → | "Deploy" | First publish runs `publish_build → publish_preview` (opens browser) → user clicks the Deploy button on the wizard's success screen → `publish_deploy` runs → wizard closes with the live URL displayed. |

Wizard state is held in memory only; if the user cancels, no partial `publish.toml` is written. (Same pattern as the BYOC connection wizard.)

---

## 12. Frontend integration details

### `ChangesPanel.tsx` (modified)

Add a third section below "Branches":

```text
┌─ Publish ────────────────────────────────────────────────────────┐
│  Not yet configured.                                             │
│  Publish this vault as a public site you fully own.              │
│                                                                  │
│  [📡 Set up Publishing]                                          │
└──────────────────────────────────────────────────────────────────┘
```

After setup:

```text
┌─ Publish ────────────────────────────────────────────────────────┐
│  GitHub Pages → garden.example.com                       Ready  │
│  Last deploy:  2 minutes ago • 247 files • 8.2 MB               │
│                                                                  │
│  [Preview]  [Deploy now]  [Open live]  [Settings]               │
└──────────────────────────────────────────────────────────────────┘
```

### `StatusPill.tsx` (modified)

A new earth capsule, sibling to the cloud-sync capsule:

```text
[ 🌍 garden.example.com • 2m ago ]
```

Click → opens `PublishPanel` (Settings → Publish). Hover → tooltip with deploy stats.

### `SettingsModal.tsx` (modified)

Add a "Publish" tab between "Sync" (BYOC) and "Plugins". `PublishPanel` rendered there shows:

- Current host + project + live URL + last-deploy stats.
- Layout picker (with "Apply" — requires a rebuild).
- Exclusion rules editor (textarea, one glob per line; live-validated by `globset`).
- Frontmatter strip/expose lists.
- Toggle: `push_on_vcs_commit`.
- Toggle: `require_preview_before_first_deploy`.
- Custom domain field.
- [Disconnect host] (red button, asks for confirm; preserves the deployed site on the host side).

### `EditorArea.tsx` (modified)

When the active file has `publish: true` in frontmatter OR is inside an `include_folders` path, show a small "🌍 Published" badge next to the breadcrumb. Click → opens the file's expected published URL (uses `publish.toml [host].live_url` + the slug rule from Quartz's `transformers/frontmatter.ts`). If the file hasn't been deployed yet, the badge shows "🌍 Pending deploy" (greyed).

### `lib/publish.ts` (new)

Thin `invoke<T>(...)` wrappers. One file. ~200 LOC.

### `state/publishStore.ts` (new)

Zustand. Per-vault publish state:

```ts
type PublishVaultState = {
  configured: boolean;
  status?: PublishStatus;
  buildState: "idle" | "building" | "built" | "error";
  buildProgress?: { stage: string; line?: string };
  preview?: { url: string; port: number; token: string };
  deployState: "idle" | "deploying" | "deployed" | "error";
  deployProgress?: { filesUploaded: number; totalFiles: number; bytesUploaded: number; totalBytes: number };
  lastDeploy?: DeployResult;
  lastError?: string;
};
```

Subscribes once to `publish://progress` via `listen<…>()` (HMR-safe via `import.meta.hot.dispose`, same pattern as `byocStore.ts`). All actions are no-op for the mock vault sentinel.

---

## 13. Cross-feature integration

- **BYOC (slice B):** GitHub Pages reuses the BYOC GitHub token. The publish branch lives on the same repo BYOC syncs into — when the user does `byoc push`, the `publish` branch is silently filtered out (BYOC syncs `main` only; we add `publish` to the implicit exclude list in `sync::github::push`). User sees both their vault and their published site backed up to one repo, exactly what they asked for.
- **VCS (slice A):** every published page carries a tiny `<meta>` tag with the source commit SHA (read from `vcs_status`'s `commit` field at build time). Makes "view source" inspectable: viewers can see exactly which commit produced this page.
- **Paper export (slice C):** when a paper has been published (its containing folder is in `[content].include_folders`), the cross-feature link injection from slice C's md→TeX writer reads `publish.toml [host].live_url + slug` and emits `\href{...}` to the public URL. Inverse direction: a paper's bibliography that cites a published note gets a working hyperlink in the printed PDF.
- **AI / BYOM (later):** "Summarize this note for the homepage" (auto-fills the frontmatter `description` field) and "Generate alt-text for figures before publishing" are bolt-ons under `[ai_assist]` in `publish.toml`. Off by default.

---

## 14. Phased ship order (Slice D — within itself)

> Slice D lands as **§13 step 18** in the global queue (already so in `impl-v2.md`). Inside the slice we ship in this order so each step is independently testable:

1. **D1 — Node v22 probe + Quartz v5 scaffold + plugin install + build to disk.** Smallest end-to-end: `publish_init → publish_build → build/ folder appears`. No host adapters, no preview, no UI. Validates the node/npm version detection + `npx quartz create` non-interactive flow + `npx quartz plugin install --from-config` + the build spawn pipeline. Tested via CLI / `cargo test`.
2. **D2 — Preview server + `PublishPreviewBanner`.** Adds `publish_preview` + the loopback server + browser auto-open. The cherry on top, shipped second because it's independently valuable: even with no host configured, the user can preview their vault as a site.
3. **D3 — GitHub Pages adapter.** The happy-path host. End-to-end: `wizard → reuse BYOC GitHub token → pick repo → first deploy → live URL`. This is the first slice that puts a Lattice vault on the internet.
4. **D4 — `ChangesPanel` integration + commit-trigger toast.** Wires the VCS surface in. After this step, every commit invites the user to deploy.
5. **D5 — Cloudflare Pages adapter.** Token-paste flow. Second host; validates the non-OAuth adapter shape.
6. **D6 — Netlify adapter.** Full PKCE shape. Third host; validates the OAuth flow reuse.
7. **D7 — Vercel adapter.** Integration flow. Fourth host; validates the Integration variant of PKCE.
8. **D8 — Settings panel + custom domain support.** Surfaces all the knobs in `PublishPanel`. Adds CNAME emission on deploy for GitHub Pages + CF Pages.
9. **D9 — `push_on_vcs_commit` automatic mode.** Last because it changes a sharp default; ship with telemetry showing how many users enable it.
10. **D10 — Quartz v5 minor-version drift hardening.** Because v5 is the only supported major, `config_gen` only needs one shape today — but v5 is moving fast and minor bumps can change plugin APIs. Add: (a) a `package-lock.json` hash recorded in `publish.toml [state]` so we re-run install on drift, (b) a startup banner when the resolved `quartz --version` doesn't match `[quartz].version_range`, (c) a Settings-panel "Upgrade Quartz" button that wipes `node_modules/` and re-installs. Frees the user to ride the v5 minor train without breaking their published site silently.

Each step is mergeable on its own; each step adds value visible to a real user.

---

## 15. Security checklist (OWASP-relevant)

| Concern | Mitigation |
|---|---|
| **Loopback preview server exposing vault to LAN/internet** | `bind` field is checked against `IpAddr::is_loopback()` in `preview::start`; non-loopback values rejected at runtime with a typed error. Hardcoded `bind = "127.0.0.1"` in the default `publish.toml`. The `0.0.0.0` value is unreachable from the wizard. |
| **Preview server serving arbitrary file paths** | The HTTP handler canonicalises every requested path against `<build_path>` (with `std::fs::canonicalize`); any path that escapes the build root → 403. No symlink following (the canonicalised path is checked for `starts_with(build_path)` AFTER symlink resolution). |
| **Stale preview server leaking site after deploy/disconnect** | TTL auto-stop (30 min default). Triggered also on app quit, vault close, and new `publish_build`. The `PreviewSession` handle is held by `publishStore`; the store's `dispose()` (HMR safe) calls `publish_preview_stop`. |
| **Tokens in process memory dumps** | Tokens are zeroed on drop via `secrecy::Secret<String>` in adapter code. They're loaded from the keychain only at the moment of upload and dropped before the IPC handler returns. |
| **Token leakage in publish logs** | The `publish://progress` event's `quartz_line` and `deploy` payloads are filtered through a redaction layer that masks Bearer tokens, API keys, and the BYOC GitHub token specifically (we hold its prefix in memory for fast SHA-256 compare). |
| **Malicious vault file content compiling unsafe HTML** | Quartz's default transformer chain sanitises raw HTML via `rehype-sanitize`; we do NOT pass `--allow-unsafe-html`. Documented as `[transform].allow_unsafe_html = false` (a future opt-in). |
| **Path traversal in `[exclude].patterns`** | Patterns are evaluated by `globset` against vault-relative paths only; no pattern can match outside the vault. Absolute paths in patterns are rejected by a pre-pass. |
| **Cloudflare API-token over-scoping** | The dashboard URL we open pre-fills the **Edit Cloudflare Pages** template scoped to `Account:Pages` only — the user can't accidentally paste an Account:All token without doing manual extra work. We verify the scope on Verify by inspecting the token's permissions list. |
| **Deploying a vault with secret files** | Deploy is gated by `require_preview_before_first_deploy` — the user MUST have run a preview and clicked through it before the first deploy goes through. The preview pane prominently labels any file that looks secret-shaped (`.env*`, files containing strings matching `(api[_-]?key|password|secret|token)[\\s:=]+`); deploy is soft-blocked with a confirmation when such files are about to ship. |
| **GitHub Pages force-push wiping user history on `publish` branch** | We never touch any branch other than `publish`. The branch is created orphan if absent; never created on `main`. Force-push is scoped via `refs/heads/publish:refs/heads/publish` explicitly. |
| **Wikilinks linking to private notes from a published page** | `transform::wiki_unresolved = "ghost"` default — unresolved links render as greyed text with no `<a>` element. A `wiki_unresolved = "footnote"` policy that emits a `lattice.app/...` link is documented as DEPRECATED in the schema (kept for back-compat). |
| **Quartz arbitrary-code execution** (theme plugin loading) | We never set `npm` install arguments from `publish.toml`; the install command is hardcoded `npm install --no-audit --no-fund` against a Lattice-curated `package.json`. User-supplied Quartz plugins are explicitly out of scope for v1. |

---

## 16. What is NOT in slice D

- **Real-time updates to the live site without redeploy** (websocket / polling).
- **Subdirectory deployments** (`lattice.com/garden/` style on shared hosts).
- **Auth-gated published sites** (members-only digital gardens). All published content is fully public; if the user wants private, they don't publish.
- **Multi-language i18n.** Quartz supports it; we don't surface the knob in v1.
- **Image optimization / CDN integration beyond what Quartz does out of the box.**
- **Comment / reaction systems** (Giscus, Utterances). Documented as a "drop this script in `[quartz].extraHead`" recipe; not first-party.
- **Lattice-hosted publishing** ("just publish to lattice.app/u/<name>"). Explicitly off the table — see hard rule 1.
- **Custom Quartz themes / plugins.** v1 ships the three bundled templates. Custom themes lands with the plugin marketplace (`impl-v2.md` §5.4).

---

## 17. Verification gates

Each slice-D step lands only when:

- `cargo check --lib` clean.
- `cargo test -p lattice-publish` green (new tests: `exclude::filter` 20 fixtures, `config_gen` snapshot tests per template, `preview::server` loopback-bind + path-traversal smoke).
- `bun run build` clean.
- Manual smoke test: open `examples/vaults/garden-sample/` in a dev build, run `Publish → Set up Publishing → GitHub Pages → first deploy`, see the site live at `https://<test-account>.github.io/garden-sample/` within 2 min on a normal connection.
- Preview smoke: hit Preview → confirm browser opens → confirm hard rule 1 by `curl http://<lan-ip>:<port>` from a second machine → MUST connection-refuse.
- BYOC interop: with BYOC sync active on the same repo, run `git pull` from CLI → confirm `publish` branch is present, vault is unaffected, `byoc pull` correctly skips `publish`.

---

## 18. Frozen contracts (don't change without migration)

- `publish.toml` schema version is in `[meta].schema = 1`. Bump on breaking changes; provide migration in `publish/toml.rs`.
- Branch name `publish` for GitHub Pages is a public-facing contract — users will rely on it for backup tooling.
- `publish://progress` event schema (§8) is the frontend contract.
- Loopback bind `127.0.0.1` is a non-negotiable; even if the user requests `0.0.0.0` we reject.
- Keychain account naming: `("publish", vault_id, host_id_kebab)`. Adding a new host requires picking a new id; renaming an existing id requires a keychain migration step in `publish/keychain.rs`.

---

## 19. Open questions

1. **Quartz v5 timing.** ✅ **Resolved 2026-06-08:** Quartz v5.0.0 shipped 2026-05-24. We target v5 directly from D1 (no v4 back-compat). D10 is now "minor-version drift hardening" instead of an upgrade switch.
2. **Default `wiki_unresolved` policy.** "ghost" (greyed text, no link) vs "drop" (plain text). Recommendation: ghost — visually distinct so the user notices and either publishes the target or rewords the link. Confirm.
3. **Default `push_on_vcs_commit`.** Off by default (recommended — surprise-deploy is a sharp edge). Confirm.
4. **Default `require_preview_before_first_deploy`.** On by default (recommended — first deploy is the right time to slow down). Confirm.
5. **Cloudflare token paste UX.** We could try a polling-style "open the dashboard, we'll detect when you've created a token" via the Cloudflare API's `GET /user/tokens/verify` … but that's flaky because the token has to be entered into our app to verify. Recommendation: keep the paste flow — it's clearer. Confirm.
6. **Should `publish.toml` live in `.lattice/` or at the vault root?** Recommendation: `.lattice/publish.toml` — consistent with how `paper.toml` and `sync-manifest.*.json` are scoped to `.lattice/`. Confirm.
7. **Detect-vs-bundle Node.** Strategy B (detect on PATH; CTA to nodejs.org if missing). Mirrors `git` precedent. Bundling Node would add 50 MB to the installer and complicate signing/notarization. Confirm.

---

## 20. Companion docs

- [`docs/impl-v2.md`](impl-v2.md) §5.5 — what we want (high-level)
- [`docs/byoc-plan.md`](byoc-plan.md) — slice-B template; trait shape + OAuth patterns + keychain naming reused verbatim
- [`docs/paper-export-plan.md`](paper-export-plan.md) — slice-C plan; cross-references for the `[[wikilink]]` → published-URL injection rule
- [`docs/current-state.md`](current-state.md) — shipped surface today
- [`/memories/repo/lattice.md`](../memories/repo/lattice.md) — repo-scoped facts (VCS / BYOC / editor / preview)
- [Quartz docs](https://quartz.jzhao.xyz/) — v5 build pipeline, config shape, plugin install flow, troubleshooting (external)
