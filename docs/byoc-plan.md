# BYOC — Slice B implementation plan

> **Scope.** This is the implementation plan for the **BYOC (Bring-Your-Own-Cloud) sync layer** that turns the existing local VCS into a sync system the user controls end-to-end. Four first-party adapters: **GitHub, Google Drive, OneDrive, Dropbox**. (iCloud is descoped past v1 — see [§13](#13-descoped---icloud).)
>
> This file expands on [`docs/impl-v2.md`](impl-v2.md) §5.2 (BYOC) and [`docs/current-state.md`](current-state.md) §5 (sync plugin), and is the concrete checklist for "Slice B" of the v2 roadmap.

---

## 1. Hard product rule

**Lattice has no server. Lattice has no website that holds credentials. Lattice never sees a user password or token, ever.**

Concretely, this means:

- There is **no `auth.lattice.dev` redirect URI**, no Lattice-hosted OAuth proxy, no "sign in to Lattice with Google" backend.
- Every OAuth flow is a **public-client PKCE flow** that runs entirely inside the desktop app. The provider redirects to `http://127.0.0.1:<random-port>/oauth-callback`, which is served by a one-shot listener inside the Tauri process for the ~30 seconds the user is consenting in their browser.
- Tokens (access + refresh) are written to the **OS keychain only**, via [`keyring-rs`](https://crates.io/crates/keyring) — Windows Credential Manager, macOS Keychain, libsecret on Linux. Never to a file, never to a log, never serialized to the Zustand store.
- The user's vault data flows **directly** from their machine to their cloud provider's API. Lattice is not on the network path.
- The OAuth client IDs themselves are baked into the app binary. They are **public** identifiers (the same way `gh` ships its public client ID); the PKCE code verifier is what makes the flow safe, and the verifier never leaves the user's machine.

This shapes every decision below.

---

## 2. Where we are today

Slice A (local VCS) is shipped. Concretely:

- `src-tauri/src/git.rs` is a ~1k LOC shell around the user's system `git` binary (subprocess + `--separate-git-dir=.lattice/git`). All status / log / branch / commit / diff IPC commands exist and are wired into `src-tauri/src/lib.rs`.
- `src/state/vcsStore.ts` holds the live VCS state (status, history, branches, graph). All actions exist.
- `src/components/layout/ChangesPanel.tsx` renders working changes, history (with `<GitGraph>` DAG), branches, and a **placeholder Sync section** with four disabled `BYOC_PROVIDERS` rows (`github`, `gdrive`, `onedrive`, `dropbox`, all `ready: false`).
- `tauri-plugin-opener` is already a dependency — we'll use it to launch the system browser for OAuth.

What does **not** exist yet:

- Any `src-tauri/src/sync/` module.
- Any keychain integration (`keyring-rs` is not in `Cargo.toml`).
- Any HTTP client (`reqwest` is not in `Cargo.toml`).
- Any loopback redirect server.
- Any frontend wiring for the Sync section beyond the cosmetic row list.

Slice B is the work to make that placeholder real.

---

## 3. Tractability snapshot (free-tier ceilings)

Copied from `impl-v2.md` §5.2.1 for reference at the top of this doc:

| Provider   | Free-tier write/req ceiling                       | Delta-sync primitive                                  | OAuth flow                              | Notes |
|------------|----------------------------------------------------|--------------------------------------------------------|------------------------------------------|-------|
| GitHub     | Git protocol — no HTTP rate-limit on push/fetch; 5 000 REST/hr/user for metadata | `git fetch` + `git push` over HTTPS                    | Device Code **or** PKCE                  | Cheapest by far. Reuses the system `git` binary; tokens stored in the OS keychain *or* handed to `git` via `credential.helper`. |
| Google Drive | 1 000 req/100s/user (Drive v3); ~10 k files/day soft cap on `changes.list` | `changes.list` + persisted `startPageToken`            | PKCE + system browser + loopback         | App-folder scope (`spaces=appDataFolder`) — invisible to the user's normal Drive UI; can't accidentally delete by reorganising. |
| OneDrive   | ~12 000 req/min/user (Graph throttling guidance)  | `/me/drive/root/delta` + persisted `@odata.nextLink`   | PKCE + system browser + loopback         | App-root (`/me/drive/special/approot`) — same isolation story as Drive's `appDataFolder`. |
| Dropbox    | Soft per-user QPS; hard 350 GB/day upload per app | `/2/files/list_folder/continue` + persisted cursor, plus long-poll | PKCE + system browser + loopback         | App-folder app type (`/Apps/Lattice/<vault>`) — narrowest possible scope. |

All four are sustainably free for a single user's notes vault. The cost model has Lattice paying **zero** for sync; the user pays nothing extra (each provider's free tier covers a single-user vault by a wide margin).

---

## 4. Crate / module layout

We add **one** new module tree under the existing `src-tauri/` crate — no new workspace crates yet (kept small per the existing convention in [`docs/current-state.md`](current-state.md) §5.1).

```text
src-tauri/src/
├── git.rs              # existing (slice A)
├── commands.rs         # existing
├── lib.rs              # existing — register new invoke handlers here
└── sync/               # NEW
    ├── mod.rs          # SyncProvider trait + ProviderId enum + IPC commands
    ├── oauth.rs        # PKCE generator, loopback redirect server, browser launcher
    ├── keychain.rs     # keyring-rs wrapper: per-(provider, vault) tokens
    ├── manifest.rs     # .lattice/sync-manifest.json — local mirror of remote state
    ├── client.rs       # shared reqwest client with retry/backoff + rate-limit helpers
    ├── github.rs       # GitHub adapter — reuses system `git` for blob transfer
    ├── gdrive.rs       # Drive v3 adapter, spaces=appDataFolder
    ├── onedrive.rs     # Microsoft Graph adapter, /me/drive/special/approot
    └── dropbox.rs      # Dropbox API v2 adapter, /Apps/Lattice
```

Frontend mirror under `src/`:

```text
src/
├── lib/
│   └── byoc.ts         # NEW — IPC wrappers (mirrors `lib/vcs.ts` shape)
├── state/
│   └── byocStore.ts    # NEW — Zustand store; per-(vault, provider) sync state
└── components/layout/
    └── ChangesPanel.tsx  # MODIFIED — replace the disabled BYOC_PROVIDERS rows
                          #            with live Connect / Sync / Disconnect UI
```

### New Rust dependencies

Add to `src-tauri/Cargo.toml`:

```toml
# OS keychain — Windows Cred Mgr / macOS Keychain / libsecret Linux.
# Tokens NEVER touch disk in plaintext.
keyring = "3"

# HTTP client for the four cloud APIs.  `rustls-tls` keeps the TLS
# story uniform across platforms (no OpenSSL dep on Linux).
reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls", "stream", "multipart"] }

# Local async runtime for the loopback redirect server + concurrent uploads.
# `tokio` is already pulled in transitively by Tauri 2 but we add a top-level
# entry so the deps section documents the explicit features we use.
tokio = { version = "1", features = ["rt-multi-thread", "macros", "net", "io-util", "sync", "time"] }

# PKCE — code verifier generation + S256 challenge.  Tiny.
oauth2 = "5"

# JSON Web Tokens (for Microsoft Graph - Microsoft returns an id_token alongside
# the access token; we use the `sub` claim as a stable account id).
jsonwebtoken = "9"

# BLAKE3 for content-addressed dedup in the manifest.
blake3 = "1"

# URL-encoded form bodies (Dropbox + GitHub Device Code).
url = "2"

# Random port + state nonce.
rand = "0.8"
```

Frontend deps: **none new**. The Tauri IPC wrappers are plain `invoke` calls.

---

## 5. The `SyncProvider` trait

The whole point of the trait is that the **scheduler is provider-agnostic**. Adapters know how to do four things; everything else (debounce, retry, progress UI, conflict surfacing) lives in `sync/mod.rs`.

```rust
// src-tauri/src/sync/mod.rs
#[async_trait::async_trait]
pub trait SyncProvider: Send + Sync {
    /// Stable enum value used in IPC + keychain account names.
    fn id(&self) -> ProviderId;

    /// Human label for the UI ("GitHub", "Google Drive", "OneDrive", "Dropbox").
    fn display_name(&self) -> &'static str;

    /// Phase 1 of the OAuth flow — pops the system browser, returns a
    /// pending handle the IPC layer can poll / cancel.
    async fn auth_start(&self, app: &AppHandle, vault_id: &str) -> Result<AuthSession, SyncError>;

    /// Phase 2 — called by the loopback server when the redirect lands;
    /// exchanges the code for tokens and stashes them in the keychain.
    async fn auth_complete(&self, session: AuthSession, code: String, state: String) -> Result<AccountInfo, SyncError>;

    /// Wipe tokens from the keychain. Idempotent.
    async fn disconnect(&self, vault_id: &str) -> Result<(), SyncError>;

    /// Has this (provider, vault) pair been connected? Cheap — just a
    /// keychain probe; does NOT validate the token is still good.
    async fn is_connected(&self, vault_id: &str) -> Result<bool, SyncError>;

    /// Upload the local commits + objects that the remote doesn't have yet.
    /// Idempotent; the manifest dedupes by BLAKE3.
    async fn push(&self, vault_path: &Path, progress: ProgressSink) -> Result<PushResult, SyncError>;

    /// Pull any remote commits / objects the local manifest doesn't know about.
    /// Surface conflicts via `PullResult.conflicts`.
    async fn pull(&self, vault_path: &Path, progress: ProgressSink) -> Result<PullResult, SyncError>;
}
```

`ProviderId` is the registration key (matches the `id` field in `BYOC_PROVIDERS` in `ChangesPanel.tsx`):

```rust
#[derive(Copy, Clone, Eq, PartialEq, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderId {
    Github,
    Gdrive,
    Onedrive,
    Dropbox,
}
```

`AuthSession` carries the PKCE verifier + state nonce + a `oneshot::Sender<Code>` the loopback server uses to deliver the authorization code back to the awaiting `auth_complete`.

---

## 6. OAuth — the no-server PKCE pattern

### 6.1 What the user actually sees

Same five-step ritual for **every** provider. There is no Lattice login page anywhere in this flow — Lattice only ever asks the provider, and the provider only ever asks the user.

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Screen 1 — IN LATTICE                                                        │
│ Sync panel shows: [ Connect Google Drive ]                                   │
│ User clicks it.                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ Screen 2 — DEFAULT BROWSER OPENS                                             │
│ URL: https://accounts.google.com/o/oauth2/v2/auth?...                        │
│ Google's own page, served by Google. Lattice cannot read or modify it.       │
│                                                                              │
│ Lattice meanwhile is showing a small "Waiting for browser…" card with a      │
│ Cancel button. No spinner timeout for 5 minutes.                             │
└──────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ Screen 3 — ACCOUNT PICKER (Google's UI)                                      │
│ "Choose an account to continue to Lattice"                                   │
│   ◯ alice@gmail.com                                                          │
│   ◯ alice@work.example.com                                                   │
│   ◯ Use another account                                                      │
└──────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ Screen 4 — CONSENT SCREEN (Google's UI, content driven by our scope string)  │
│ "Lattice wants to access your Google Account (alice@gmail.com)"              │
│                                                                              │
│   This will allow Lattice to:                                                │
│   ✓ See, create, and delete its own configuration data in your Google Drive │
│     (drive.appdata scope)                                                    │
│                                                                              │
│ [ Cancel ]                                                  [ Allow ]        │
└──────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ Screen 5 — REDIRECT TO LATTICE                                               │
│ Browser navigates to http://127.0.0.1:<random-port>/oauth-callback?code=...  │
│ Lattice's tiny loopback handler returns:                                     │
│   "Connected. You can close this tab and return to Lattice."                 │
│ Browser tab auto-closes (best-effort).                                       │
│                                                                              │
│ BACK IN LATTICE the Sync panel flips to:                                     │
│   ✓ Google Drive · alice@gmail.com · [ Disconnect ]                          │
│   [ Push now ]  [ Pull now ]                                                 │
└──────────────────────────────────────────────────────────────────────────────┘
```

Identical for **OneDrive** (Screen 3 + 4 are served by `login.microsoftonline.com` and say "Lattice wants to access Files.ReadWrite.AppFolder") and **Dropbox** (served by `dropbox.com/oauth2/authorize`, says "Lattice would like access to its own folder, Apps/Lattice").

**GitHub** has one cosmetic difference: after consent there's an extra one-time mini-step asking "create new private repo `lattice-vault-notes`" or "pick an existing repo" — this is a Lattice-side modal that appears after Screen 5, before the first push, because GitHub's wire format is git-native (see §7.1) and we need a remote URL to push to.

### 6.2 Scopes the consent screen will display

These are the **minimal** scopes per provider — they're what the user reads on Screen 4 of §6.1 and they're what we send as `scope=...` in the authorize URL.

| Provider     | Scope string sent                                | What the consent screen will say in plain English                          |
|--------------|--------------------------------------------------|-----------------------------------------------------------------------------|
| GitHub       | `repo` (private), `read:user`                    | "Full control of private repositories" + "Read user profile" — required because we push commits. |
| Google Drive | `https://www.googleapis.com/auth/drive.appdata`  | "See, create, and delete its own configuration data in your Google Drive." Invisible app-folder; cannot see user's normal Drive. |
| OneDrive     | `Files.ReadWrite.AppFolder offline_access User.Read` | "Have full access to your app folder" + "Sign you in and read your profile" + "Maintain access to data you have given it access to" (refresh token). |
| Dropbox      | `files.content.write files.content.read account_info.read` | "View and edit content inside your app folder" + "View your account info." App-folder app type means the folder shows up as `/Apps/Lattice` in the user's Dropbox. |

These strings live in `src-tauri/src/sync/clients.rs` next to the client IDs.

### 6.3 Engineering implementation

All four providers support PKCE. Here is the exact dance, verbatim from `oauth.rs`:

```text
1. User clicks "Connect GitHub" in ChangesPanel.
2. Frontend invokes byoc_auth_start({ provider: "github", vault_id: <hash of vault root> }).
3. Rust sync::oauth::start_pkce(provider, vault_id):
     a. Generate a 128-byte code verifier; SHA-256 it for the challenge.
     b. Bind a TCP listener on 127.0.0.1:0  (kernel picks free port).
     c. Build the provider's authorize URL with:
          response_type=code
          client_id=<baked-in public client id>
          redirect_uri=http://127.0.0.1:<port>/oauth-callback
          code_challenge=<challenge>
          code_challenge_method=S256
          state=<32-byte random nonce>
          scope=<provider-specific minimal scope>
     d. Use tauri-plugin-opener to launch that URL in the user's default browser.
     e. Await the loopback server delivering (code, state) on a oneshot channel.
        Timeout: 5 minutes.  Cancel: user closes the panel / clicks Cancel.
4. User authenticates IN THEIR BROWSER, against the provider's own page.
   Lattice never sees the password.
5. Provider redirects browser -> 127.0.0.1:<port>/oauth-callback?code=...&state=...
6. Loopback handler:
     a. Validate state == nonce; reject otherwise.
     b. Return a tiny HTML page that says "Connected. You can close this tab."
        and triggers window.close() (best-effort).
     c. Send (code, state) on the oneshot channel.  Shut down listener.
7. byoc_auth_complete():
     a. POST to provider's token endpoint with grant_type=authorization_code,
        code, code_verifier, client_id, redirect_uri.
     b. Receive access_token + refresh_token.
     c. keychain::store(provider_id, vault_id, TokenSet { access, refresh, expires_at }).
8. Return AccountInfo { display_name, account_email } to the frontend.
   StatusPill flips to "Connected ✓".
```

**Refresh.** Each adapter wraps every API call in a `with_token(...)` helper that:
1. Reads the `TokenSet` from the keychain.
2. If `expires_at` is within 60 s, runs the provider's refresh-token grant first.
3. Writes the new `TokenSet` back to the keychain.
4. Calls the underlying request closure with the fresh access token.

A 401 from the API short-circuits to a single re-fetch attempt before bubbling.

**Client IDs.** Registered manually per-provider:

| Provider   | Client type    | Registration URL |
|------------|----------------|------------------|
| GitHub     | OAuth App      | https://github.com/settings/applications/new (callback `http://127.0.0.1`) |
| Google     | Desktop app    | https://console.cloud.google.com/apis/credentials (OAuth client ID → "Desktop app") |
| Microsoft  | Native client  | Entra → App registrations → New → Public client / native (mobile & desktop) — redirect `http://localhost` |
| Dropbox    | Scoped app     | https://www.dropbox.com/developers/apps — "App folder" type |

These IDs live in `src-tauri/src/sync/clients.rs` as constants:

```rust
pub const GITHUB_CLIENT_ID:   &str = env!("LATTICE_GITHUB_CLIENT_ID",   "set at build time");
pub const GOOGLE_CLIENT_ID:   &str = env!("LATTICE_GOOGLE_CLIENT_ID",   "set at build time");
pub const MS_CLIENT_ID:       &str = env!("LATTICE_MS_CLIENT_ID",       "set at build time");
pub const DROPBOX_APP_KEY:    &str = env!("LATTICE_DROPBOX_APP_KEY",    "set at build time");
```

`build.rs` reads these from env vars at compile time, defaulting to placeholder values for dev builds (which trip a runtime error on Connect, with a clear "set `LATTICE_GITHUB_CLIENT_ID` in your env to enable this adapter" message). The CI release pipeline injects the production values. **No client secret is ever embedded** — PKCE removes that requirement, which is the whole reason this fits the "no server" model.

---

## 7. Wire format — what we actually upload

Two design paths, chosen per-provider:

### 7.1 GitHub — native git protocol

GitHub is the only provider where it's worth exploiting that we already have the user's `git` binary. We do **not** reinvent push/pull over the REST API.

```text
Connect:
  1. User picks "Sync to existing repo" or "Create new private repo".
  2. (Create-new) call POST /user/repos with `private: true, auto_init: false`.
  3. Rust runs:
       git -C <vault> remote add lattice https://oauth2:<TOKEN>@github.com/<owner>/<repo>.git
     The token lives ONLY in the in-memory remote URL we feed to git via stdin
     for each push (we never write it to .git/config).  Pattern:
       git -C <vault> -c credential.helper='!f() { echo username=oauth2; echo password=<TOKEN>; }; f' push lattice main
  4. Initial push.

Subsequent syncs:
  push: git -C <vault> push lattice <branch>
  pull: git -C <vault> fetch lattice && git -C <vault> merge --ff-only lattice/<branch>
        (non-ff falls into the conflict UI below)
```

Why this is better than a blob-store overlay for GitHub specifically:
- Zero new wire-format code.
- Users can browse / clone the vault from `github.com` without a Lattice install.
- It "just works" with `git lfs`, signed commits, hooks, etc.
- It reuses the binary semantic fidelity story from slice A (`docs/current-state.md` §5.1).

### 7.2 Drive / OneDrive / Dropbox — blob store overlay

For the three "dumb blob storage" providers we mirror the local `.lattice/git/` layout into a provider-side app folder. The structure is intentionally a strict subset of git's on-disk format so we could one day cross-pollinate to GitHub via this same format.

Remote layout (identical across Drive / OneDrive / Dropbox):

```text
<app-folder-root>/
├── manifest.json         # { schema: 1, head: <sha>, branches: { main: <sha>, ... } }
├── refs/
│   └── heads/<branch>    # text file: 40-char commit sha
├── objects/
│   ├── ab/cdef...        # zlib-compressed blob, BLAKE3-addressed
│   └── ...
└── packs/                # optional v2 — bundle small objects to fight per-file overhead
```

Local manifest at `<vault>/.lattice/sync-manifest.json` (per provider):

```json
{
  "schema": 1,
  "provider": "gdrive",
  "remote_head": "ab12cd...",
  "local_head": "ab12cd...",
  "uploaded_objects": ["ab12cd...", "ef34gh...", "..."],
  "last_sync_at": 1731000000,
  "last_delta_cursor": "<provider-specific opaque cursor>"
}
```

`uploaded_objects` is a Bloom-filter-friendly list of BLAKE3 hashes we've pushed; on push we compute the set of objects reachable from `HEAD` locally, subtract `uploaded_objects`, and only upload the diff. Deletes are out of scope for v1 (the remote acts append-only); we'll garbage-collect in a later slice.

### 7.3 Conflict resolution

Per [`current-state.md`](current-state.md) §5.5, kept identical:

- Markdown: three-way merge with `<<<<<<<` / `=======` / `>>>>>>>` markers, user resolves in the editor.
- Binary (images, PDFs, `.canvas`): keep-local / keep-remote / keep-both modal.
- The Changes panel grows a "Conflicts" section above History when `PullResult.conflicts` is non-empty.

---

## 8. Per-provider delta sync

| Provider   | Endpoint                                          | Cursor we persist                  | Notes |
|------------|----------------------------------------------------|------------------------------------|-------|
| Google Drive | `GET drive/v3/changes?pageToken=<startPageToken>&spaces=appDataFolder` | `startPageToken` from `changes/getStartPageToken` | First call: get a `startPageToken`. Each poll: `changes.list` until `newStartPageToken` is returned. |
| OneDrive   | `GET /me/drive/special/approot/delta`             | `@odata.nextLink` / `@odata.deltaLink` | Same delta-link pattern as Outlook / Teams. Walk pages until `@odata.deltaLink` is set; persist that for next poll. |
| Dropbox    | `POST /2/files/list_folder` then `/continue`      | `cursor` returned by the previous response | Optional `/list_folder/longpoll` for 30-second long-poll between syncs. |
| GitHub     | n/a — `git fetch` is the delta                    | local `refs/remotes/lattice/<branch>` sha | Branch tip moves; comparing to `refs/heads/<branch>` gives ahead / behind. |

Sync scheduler (in `sync/mod.rs`):

- Debounced auto-sync: 30 s after the last `vcs_commit` event (configurable in Settings).
- Manual: "Sync now" button in ChangesPanel.
- Background: every N minutes per vault (default 5; user-configurable). One ticker per (vault, provider) pair.

---

## 9. IPC surface

These are the **only** new commands. Each is a thin Rust function in `sync/mod.rs` that dispatches to the matching `dyn SyncProvider`.

```rust
#[tauri::command] async fn byoc_list_providers() -> Vec<ProviderInfo>
#[tauri::command] async fn byoc_status(vault_path: String, provider: ProviderId) -> ProviderStatus
#[tauri::command] async fn byoc_auth_start(app: AppHandle, vault_path: String, provider: ProviderId) -> AuthHandle
#[tauri::command] async fn byoc_auth_cancel(handle: AuthHandle) -> ()
#[tauri::command] async fn byoc_disconnect(vault_path: String, provider: ProviderId) -> ()
#[tauri::command] async fn byoc_push(vault_path: String, provider: ProviderId) -> PushResult
#[tauri::command] async fn byoc_pull(vault_path: String, provider: ProviderId) -> PullResult
#[tauri::command] async fn byoc_sync_now(vault_path: String, provider: ProviderId) -> SyncResult  // push + pull
```

Frontend wrappers in `src/lib/byoc.ts` mirror these 1:1, following the shape of `src/lib/vcs.ts`.

Progress events are emitted via Tauri's `app.emit("byoc://progress", BYOCProgress { provider, vault_id, stage, current, total })`. The frontend subscribes once in `byocStore.ts` and routes to the per-(vault, provider) row.

---

## 10. Frontend integration

Targeted edits, not a rewrite:

### `src/components/layout/ChangesPanel.tsx`

- Replace the cosmetic `BYOC_PROVIDERS` array (lines ~1385-1397) with a live read from `byocStore`:
  ```ts
  const providers = useBYOCStore((s) => s.providers); // { github, gdrive, onedrive, dropbox }
  ```
- For each provider row:
  - Status pill: `Disconnected` / `Connecting…` / `Connected ✓` / `Syncing…` / `Conflict` / `Error`.
  - Action button derived from status: `Connect` → `Sync now` (+ `…` menu with Disconnect).
  - Last-sync timestamp + ahead/behind counts (GitHub only, since the other three are blob-store).

### `src/state/byocStore.ts` (new)

Per-vault, per-provider state:

```ts
interface ProviderState {
  connected: boolean;
  accountLabel: string | null;
  status: "idle" | "syncing" | "conflict" | "error";
  lastSyncAt: number | null;
  lastError: string | null;
  progress: { stage: string; current: number; total: number } | null;
}

interface BYOCState {
  byVault: Record<string, Record<ProviderId, ProviderState>>;
  refresh: (vaultPath: string) => Promise<void>;
  connect: (vaultPath: string, provider: ProviderId) => Promise<void>;
  disconnect: (vaultPath: string, provider: ProviderId) => Promise<void>;
  syncNow: (vaultPath: string, provider: ProviderId) => Promise<void>;
}
```

The store subscribes once to the `byoc://progress` Tauri event and merges incoming updates into `byVault[vaultPath][provider].progress`.

### Onboarding wizard (`src/components/onboarding/`)

Already wired to ask the user to pick a provider — currently no-ops. Flip the `Continue` button on the sync step to call `connect(vaultPath, selectedProvider)`. Skip remains skip.

---

## 11. Security checklist (OWASP-relevant)

| Risk                          | Mitigation                                                                                  |
|-------------------------------|---------------------------------------------------------------------------------------------|
| Token theft from disk         | Tokens live in OS keychain. Never written to a file, log, or the Zustand store. Cleared on `disconnect`. |
| Token leak via console.log    | `TokenSet` derives a deliberately useless `Debug` impl that prints `TokenSet { … }`. Rust `tracing` filters scrub the `authorization` header. |
| OAuth CSRF                    | `state` is a 32-byte CSPRNG nonce; mismatch on callback aborts the flow with no token exchange. |
| Loopback hijack               | Listener binds to `127.0.0.1` only (never `0.0.0.0`). Ephemeral port. Single-use: shuts down after first request. |
| Refresh-token replay          | We rotate refresh tokens when the provider supports it (Microsoft does; Google + Dropbox return the same; GitHub doesn't refresh — we re-auth on expiry). |
| MITM on the OAuth redirect    | The redirect URL is `http://127.0.0.1`; there is no network hop. PKCE binds the code to the verifier so even local interception is moot. |
| Vault path injection in keychain account name | We hash the absolute vault path to BLAKE3 → 16-byte hex prefix; that's the keychain "account" field. Provider id is the "service" field. |
| Prompt injection from remote notes | Out of scope for sync — that's an editor/LLM concern. The sync layer treats every byte as opaque. |
| Exfiltration of unrelated user files | App-folder scopes everywhere. Dropbox = `/Apps/Lattice`, Drive = `appDataFolder`, OneDrive = `/me/drive/special/approot`. GitHub = the one private repo the user picks. |
| Re-auth required after token revocation | A 401 from any provider clears the keychain entry for that (vault, provider) and surfaces a "Reconnect" CTA in ChangesPanel — never silently retries with a known-bad token. |

---

## 12. Step-by-step shipping order

Each row is a discrete PR-sized chunk. Land in order; later rows depend on earlier ones.

| # | Slice                                              | Touches                                                              | Notes |
|---|----------------------------------------------------|----------------------------------------------------------------------|-------|
| 1 | Skeleton: `sync/` module tree + `SyncProvider` trait, no adapters | `src-tauri/src/sync/mod.rs`, `lib.rs`                                | Compiles; trait + types only. |
| 2 | `oauth.rs` — PKCE generator + loopback redirect server | `src-tauri/src/sync/oauth.rs`, `Cargo.toml` (oauth2, tokio, rand)    | Unit-tested with a mock authorize URL pointing at a local fixture server. |
| 3 | `keychain.rs` — keyring-rs wrapper                 | `src-tauri/src/sync/keychain.rs`, `Cargo.toml` (keyring)             | Idempotent store/load/delete. |
| 4 | **GitHub adapter** — auth + connect + initial push via system `git` | `src-tauri/src/sync/github.rs`, frontend wiring (Connect button)     | First end-to-end flow. Validates the OAuth + keychain plumbing. |
| 5 | `manifest.rs` + `objects/` upload helper           | `src-tauri/src/sync/manifest.rs`, `client.rs`                        | Used by the next three adapters. |
| 6 | **Drive adapter** (read + write)                   | `src-tauri/src/sync/gdrive.rs`                                       | First blob-store provider. |
| 7 | **OneDrive adapter**                               | `src-tauri/src/sync/onedrive.rs`                                     | Reuses 5; differs only in HTTP shapes + delta cursor. |
| 8 | **Dropbox adapter**                                | `src-tauri/src/sync/dropbox.rs`                                      | Same. |
| 9 | Conflict UI — three-way markers for markdown, modal for binary | `src/components/editor/`, `src/components/layout/ChangesPanel.tsx`   | Per `current-state.md` §5.5. |
| 10 | Scheduler — debounced auto-sync + background ticker | `src/state/byocStore.ts`                                             | One ticker per (vault, provider). |
| 11 | Settings UI — sync section in `SettingsModal.tsx`  | `src/components/modals/SettingsModal.tsx`                            | Replaces the current placeholder row. |
| 12 | Onboarding step — flip the no-op Continue button   | `src/components/onboarding/steps/`                                   | Picks default provider per onboarding-journey.md. |

**Definition of done for slice B:** all four providers can `Connect`, `Sync now`, and `Disconnect` from `ChangesPanel`; auto-sync fires 30 s after every commit; conflicts surface in the conflict UI; tokens never appear in any log, file, or store snapshot.

---

## 13. Descoped — iCloud

iCloud sits behind a $99/yr Apple Developer Program membership, requires a notarised macOS app signed by that developer ID, and forces every CloudKit call through the macOS-only CloudKit framework (or the web-services JSON API, which still requires the same paid membership). Wrapping that for Lattice would mean:

- Joining the Apple Developer Program. Yearly cost.
- Building a Swift sidecar (CloudKit isn't exposed via the C API).
- Code-signing + notarising the Tauri macOS build (currently unsigned dev builds).
- Hiding the option on Windows / Linux entirely.

For v1 we register `byoc-icloud` in the picker as **greyed out with a tooltip** explaining the macOS-only status, and revisit once we have a signed macOS release pipeline.

---

## 14. Open questions for product

These do not block slice B implementation but should be resolved before user-facing copy is finalised:

1. **Default provider per onboarding bucket?** `docs/onboarding-journey.md` already proposes GitHub-for-devs, Drive-for-students, OneDrive-for-enterprise. Confirm.
2. **GitHub "create new repo" UX** — do we prompt for repo name, default to `lattice-vault-<random>`, or scrape the vault folder name? My vote: default to vault folder name + slugify.
3. **Sync frequency default** — 5 min background sync or commit-triggered only? I'd ship "commit-triggered only" on by default; 5 min ticker opt-in. Fewer surprise API calls.
4. **Multi-provider per vault** — allowed? E.g. GitHub + Drive on the same vault. Technically the manifest is per-provider so it works, but the conflict story doubles. Recommend v1 = "one provider per vault" with a "Switch provider" action that wipes the manifest.

---

## 15. Pointers

- Trait + scheduler shape: this doc §5.
- Local VCS that everything sits on: [`docs/current-state.md`](current-state.md) §5.1, `src-tauri/src/git.rs`.
- Tractability + free-tier math: [`docs/impl-v2.md`](impl-v2.md) §5.2.1 (this doc §3 is the same table).
- Conflict UI v1: [`docs/current-state.md`](current-state.md) §5.5.
- Cosmetic Sync section to replace: `src/components/layout/ChangesPanel.tsx` `BYOC_PROVIDERS` array.
