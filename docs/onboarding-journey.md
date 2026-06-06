# Lattice — Onboarding Journey (v2)

> **Status:** Design doc. Cross-references [`impl-v2.md`](impl-v2.md) §10 (which is now a stub that points here) and [`current-state.md`](current-state.md).
>
> **Audience:** every Lattice user on first launch — Student, Enterprise, OSS Developer, anyone. Onboarding is the **single universal experience**; it is not gated, not optional in v1, and not customized per "tier."
>
> **North-star sentence:** *"From double-click to first useful note in under 90 seconds, with zero data leaving the machine unless the user explicitly chooses to send it."*

---

## 0. Principles

These are the non-negotiables every onboarding screen must satisfy.

1. **Universal.** Every user — regardless of persona — sees the same flow. Persona pick changes *defaults*, never *availability*.
2. **Skippable.** Every step (except Step 0 EULA + Step 1 vault choice) has *Skip — set this up later*. Skipping never deletes data and never breaks the next step.
3. **Resumable.** If the user quits mid-flow, the next launch resumes from the last completed step. State is persisted to `<config>/onboarding.json` (machine-local only, never synced).
4. **Reversible.** A "← Back" button is present on every screen except the final one. Choices written to disk are idempotent (re-running a step overwrites cleanly).
5. **Local-first.** No network call is made before the user explicitly opts into a feature that requires one (sync, AI, calendar). The first launch can complete with the network unplugged.
6. **Zero dark patterns.** No fake urgency, no "are you sure you want to skip security?" guilt prompts. The opt-out path is the same visual weight as the opt-in path.
7. **Accessible.** Full keyboard navigation (`Tab` / `Shift+Tab` / `Enter` / `Esc`), screen-reader labels on every control, high-contrast theme respected from system, minimum 14 pt body / 16 pt headings, focus rings always visible.
8. **Fast.** No step waits longer than 200 ms on any user input. Network calls (provider OAuth, Ollama detection, etc.) run in the background with a non-blocking spinner; the user can advance without waiting.
9. **Re-runnable.** *Settings → Help → Re-run onboarding* replays the full flow at any time without destroying existing data — every step shows the current value and the user just confirms or changes it.
10. **Honest.** Every screen that affects privacy says, in plain language, *exactly* what data leaves the machine and to whom.

---

## 1. Pre-flow — Installer (out of scope for the wizard, but adjacent)

| OS | Format | Auto-update | Admin needed? | Silent-install args (MDM) |
|---|---|---|---|---|
| Windows | WiX MSI | [Velopack](https://github.com/velopack/velopack) | No (per-user install) | `msiexec /i Lattice.msi /quiet VAULT_PATH=D:\Vault PERSONA=enterprise SYNC=onedrive E2EE=on` |
| macOS | Signed + notarized DMG (universal: arm64 + x86_64) | Sparkle | No (drag to Applications) | `installer -pkg Lattice.pkg -target /` + defaults write `md.lattice.app onboarding.persona enterprise` |
| Linux (later) | AppImage + Flatpak + DEB/RPM (cargo-packager) | Built-in update manifest | No | env vars `LATTICE_PERSONA`, `LATTICE_VAULT_PATH`, etc. |

The installer collects nothing beyond EULA acceptance + install path. No "would you like to send anonymous analytics?" checkbox at install time — that belongs in Step 7 of the wizard where the user has context.

**MDM hook:** if any of the silent-install args are present, the wizard auto-skips the corresponding steps on first launch and goes straight to step 8 (tour). This is the *only* way to bypass the wizard.

---

## 2. The journey at a glance (9 steps)

```
   ┌──────────────────────────────────────────────────────────────────────┐
   │                                                                      │
   │   0. Splash         1. Welcome        2. Persona       3. Vault      │
   │   (≈ 800 ms)      (1 screen)        (3 cards)      (3 cards)         │
   │                                                                      │
   │   4. Theme +        5. Sync           6. Encryption   7. AI          │
   │      density        (BYOC)            (E2EE)          (BYOM)         │
   │                                                                      │
   │   8. Calendar +     9. Tour →                                        │
   │      extras         "You're ready"                                   │
   │                                                                      │
   └──────────────────────────────────────────────────────────────────────┘

   Total time budget for a user who clicks "Skip" on optional steps: ≈ 45 s
   Total time for a user who configures every step:                  ≈ 4 min
```

Persistent footer on every screen: `← Back   ·   Step X of 9   ·   Skip   ·   Next →` (Skip becomes "Finish" on the last step).

---

## 3. Per-step specification

### Step 0 — Splash + EULA (≈ 800 ms + 1 click)

**Trigger:** first launch, or whenever `<config>/onboarding.json` is missing.

**UI:**
- Centered Lattice logo (256 px) + tagline "*Your second brain, on your terms.*"
- Brief loader while we (a) scan the local FS for existing PKM vaults (Obsidian `.obsidian/`, Logseq `logseq/`, Joplin sqlite, Siyuan workspace) and (b) detect a local Ollama install on `localhost:11434`.
- Single CTA: **`Continue`** (enabled as soon as the EULA is acknowledged via a single small checkbox that defaults *unchecked* — explicit consent only).
- Tiny link: "Read the EULA" → opens the bundled `LICENSE.md` in the system viewer.

**State written:** `eula_accepted_at` timestamp, detected-vault list cached in memory for Step 3.

**Skip:** not allowed (legal). But there is no "decline" trap — declining quits the app gracefully with no leftover files.

---

### Step 1 — Welcome (1 screen, optional 10 s read)

**Goal:** set expectations + tell the truth about data.

```
┌────────────────────────────────────────────────────────────────────────┐
│                                                                        │
│   Welcome to Lattice.                                                  │
│                                                                        │
│   • Your notes live in a plain folder on your disk.                    │
│   • Nothing is sent to us. Ever.                                       │
│   • Sync, AI, and calendar are opt-in and use accounts you already     │
│     own.                                                               │
│                                                                        │
│   The next 6 steps set up your defaults. You can skip any of them.     │
│                                                                        │
│                                              [ Skip all → ]  [ Next → ]│
└────────────────────────────────────────────────────────────────────────┘
```

`Skip all` jumps straight to Step 9 (tour) using the "Student / Personal" persona defaults and creates a default vault at `~/Documents/Lattice Vault`. This is the **45-second path**.

---

### Step 2 — Persona pick

**Goal:** pre-select sensible defaults for steps 3–8. **Not a permission gate.** Every feature is available to every persona afterward.

Three equally-weighted cards (no "Recommended" badge — that's a dark pattern):

| Card | Default vault location | Default sync provider | Default E2EE | Default AI | Default templates enabled |
|---|---|---|---|---|---|
| **Student / Personal** | `~/Documents/Lattice Vault` | Google Drive | Off (prompted in Step 6) | Local Ollama if detected, else Skip | Paper scaffolder, Daily notes, Reading list |
| **OSS Developer** | `~/lattice-vault` | GitHub (via `gh` CLI auth if present) | Off | Local Ollama default; OpenAI optional | Code-snippet template, Project log, ADR template |
| **Enterprise / M365** | `%USERPROFILE%\OneDrive - <Tenant>\Lattice Vault` | OneDrive (Entra-tenant aware) | **On** | Skip by default (BYOM with org-approved Azure OpenAI endpoint is a follow-up step) | Meeting notes, 1:1 template, OKR doc |

Below the cards, in muted text:
> *Choosing a persona only sets up defaults. You can change any of these in Settings at any time, and every feature is available in every persona.*

**State written:** `persona` ∈ `{student, dev, enterprise}`.

---

### Step 3 — Vault choice

**Goal:** point Lattice at a folder.

Three primary options:

1. **Create new vault** — pre-filled with the persona's default path; user can browse to change. Shows live preview of the folder name.
2. **Open existing folder** — system file picker. Validates that the folder exists, is writable, and is not inside another Lattice vault.
3. **Import from another tool** — listed only when Step 0's auto-detection found candidates. Shows each detected vault with: tool name + icon, path, note count, size. One-click import triggers the relevant adapter (see [`impl-v2.md`](impl-v2.md) §11). Import runs in the background; Step 4 onward proceeds in parallel.

**Edge cases handled inline:**
- Vault path already exists and is non-empty → "We found existing notes here. Open as-is, or pick another folder?"
- OneDrive-synced folder selected + persona ≠ enterprise → warning "*Your vault is inside a cloud-synced folder. Sync is still optional in Step 5 — but be aware OneDrive will already be syncing this folder at the OS level.*"
- No write permission → red banner with one-click "Pick a different folder."

**State written:** `vault_path`, `vault_origin` (created / opened / imported-from-X), import job ID if applicable.

---

### Step 4 — Theme + density

**Goal:** quick, visual, fun. Zero stakes.

Side-by-side live previews of a sample note in:
- **Theme:** System (default) · Light · Dark · High contrast
- **Density:** Comfortable · Compact · Cozy
- **Font:** Inter (default) · System UI · JetBrains Mono (for the dev persona; only suggestion, not enforced)

Changes apply instantly to the preview. No "Apply" button. `Next` saves.

**State written:** `theme`, `density`, `font_family`.

---

### Step 5 — Sync (BYOC)

**Goal:** connect one provider, or skip cleanly.

The persona's recommended provider is shown first with a primary `Connect` button. All other providers (GitHub, Google Drive, OneDrive, Dropbox, iCloud Drive, WebDAV, S3-compatible) are listed below as secondary buttons.

OAuth runs in the system browser (we never embed a webview for OAuth — that's a phishing footgun). The wizard shows a non-blocking "Waiting for browser…" pane with a clear `Cancel` button. While waiting, the user can click `Skip — set this up later` and proceed.

Once OAuth completes, we:
1. Verify token works (one read call).
2. Create the remote target if missing (e.g., `gh repo create lattice-vault --private` for GitHub; folder for Drive/OneDrive).
3. **Do not push yet.** Initial push happens in the background after the wizard completes, with a status pill in the bottom bar.

**State written:** `sync_provider`, `sync_target_id`, encrypted token in OS keychain (DPAPI / Keychain / Secret Service).

**Honest disclosure box** at the bottom:
> *We send your notes (after your encryption choice in the next step) to **<provider>** using the OAuth token you just authorized. Lattice does not see your credentials. You can disconnect at any time in Settings → Sync.*

---

### Step 6 — Encryption (E2EE)

**Goal:** make the right choice obvious without being preachy.

Default switch position depends on persona (Off for Student/Dev, On for Enterprise). The screen is the same for everyone:

```
┌─────────────────────────────────────────────────────────────────────┐
│   End-to-end encryption                                             │
│                                                                     │
│   With this on, your notes are encrypted on your device before      │
│   they reach <provider>. Even Lattice cannot read them.             │
│                                                                     │
│   Recommended if: you sync sensitive notes, share a cloud drive     │
│   with family, or work in a regulated industry.                     │
│                                                                     │
│   Not recommended if: you want to browse notes in the cloud         │
│   provider's web UI, or you might forget your passphrase.           │
│                                                                     │
│   [ ●─────○ ] Off          ← toggle                                 │
│                                                                     │
│   (When On, a passphrase step appears below.)                       │
└─────────────────────────────────────────────────────────────────────┘
```

If toggled **On**:

1. **Passphrase entry** (with strength meter, paste allowed, show/hide toggle). Minimum 12 chars; we suggest using a passphrase manager. The strength meter is [zxcvbn](https://github.com/dropbox/zxcvbn)-based.
2. **Recovery passphrase** — a second, separately-derived key. We generate a 6-word [BIP39-style](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki) phrase by default, with an option to enter your own. The user is forced to type it back to confirm — no exceptions, no "remind me later." This is the only friction we keep.
3. **Loud warning:** *"We have no copy of either passphrase. If you forget both, your notes are unrecoverable."* User checks a box acknowledging this before `Next` is enabled.

If toggled **Off**: instant `Next`. A persistent badge appears in the bottom status bar after onboarding ("Encryption off") with a one-click path to enable it later.

**State written:** `e2ee_enabled`, wrapped vault key in keychain, recovery-key wrapping in keychain (see [`impl-v2.md`](impl-v2.md) §9.5).

---

### Step 7 — AI assistant (BYOM)

**Goal:** acknowledge that AI is useful but make it the user's call.

Four options as a vertical list:

1. **Local — Ollama** (auto-selected if detected on `localhost:11434`). Shows the list of installed models with sizes; user picks one (default suggestion: `llama3.2:3b` for chat, `nomic-embed-text` for embeddings if found).
2. **Cloud — bring your own key** (OpenAI, Anthropic, Google, Azure OpenAI, Mistral, OpenRouter). Key is stored in OS keychain. Each provider links to its key-creation page.
3. **Org-managed** (enterprise persona only). Asks for an OpenAI-compatible base URL + auth header. Useful for Azure OpenAI behind a private endpoint, LiteLLM, etc.
4. **Skip — no AI for now.** This is the muted-but-equally-large button at the bottom.

**Telemetry-relevant disclosure:**
> *AI requests are sent to the provider you choose, with the scope you set per feature in Settings → AI → Privacy matrix. Lattice itself does not see your prompts.*

**State written:** `ai_provider`, `ai_model_id`, encrypted credentials in keychain. The Privacy matrix (see [`impl-v2.md`](impl-v2.md) §5.3) is initialized to the strictest preset: AI off for everything except "Suggest commit message" (which is the §4 carry).

---

### Step 8 — Calendar + extras (optional, persona-aware)

**Goal:** offer the things that turn Lattice into the user's daily driver.

The screen is a checklist of *small commitments*; each item the user toggles on triggers a mini-flow at the end of the wizard, not now.

```
┌───────────────────────────────────────────────────────────────────────┐
│   Make Lattice your daily driver                                      │
│                                                                       │
│   [✓] Daily journal      Create today's journal note at /journals/    │
│   [✓] Calendar           Connect Google / Outlook / Apple / Cal.com   │
│   [ ] Web Clipper        Install the browser extension after we're    │
│                          done                                         │
│   [ ] CLI               `lattice` shell command in your PATH          │
│   [ ] Telemetry          Send anonymous usage counts (off by default) │
│                                                                       │
│                                            [ ← Back ]   [ Next → ]    │
└───────────────────────────────────────────────────────────────────────┘
```

Persona-specific defaults pre-check the boxes:
- **Student:** Daily journal ✓, Calendar ✓ (Google)
- **Dev:** Daily journal ✓, CLI ✓
- **Enterprise:** Daily journal ✓, Calendar ✓ (Outlook + Teams)

Telemetry is **always unchecked** regardless of persona. We make the user opt in.

**State written:** `extras_enabled` array; deferred flows queued in `<config>/post-onboarding-queue.json`.

---

### Step 9 — Tour + "You're ready"

**Goal:** drop the user into the editor with one obvious next action.

Screen content:

```
┌────────────────────────────────────────────────────────────────────────┐
│   You're ready.                                                        │
│                                                                        │
│   Vault:     ~/Documents/Lattice Vault                                 │
│   Sync:      Google Drive (initial push: in progress…)                 │
│   Encryption: Off                                                      │
│   AI:        Ollama · llama3.2:3b                                      │
│                                                                        │
│   Shortcuts to remember:                                               │
│     Cmd/Ctrl + P     Command palette                                   │
│     Cmd/Ctrl + O     Quick switcher                                    │
│     Cmd/Ctrl + N     New note                                          │
│     Cmd/Ctrl + ,     Settings                                          │
│                                                                        │
│            [ Take the 60-second tour ]      [ Just open the editor ]   │
└────────────────────────────────────────────────────────────────────────┘
```

**"Take the tour"** opens `Welcome.md` (auto-created in the vault root) — a real, editable markdown file with embedded screenshots and inline interactive tips. Anchors: Editor, Graph, Backlinks, Canvas, Sync, Plugins, AI, Paper scaffolder. The user can delete it without consequence.

**"Just open the editor"** focuses the editor with a fresh untitled note.

**Post-onboarding background work, surfaced in the status bar:**
- Initial sync push (`Syncing 0 of N files…`).
- Import job from Step 3 (if any) (`Imported 240 of 1,830 notes…`).
- Deferred flows from Step 8 (calendar OAuth, CLI install, browser extension install) — each fires a non-blocking toast with a single-click action.

**State written:** `onboarding_completed_at` timestamp + `onboarding_version` (e.g., `"v2.0"`). On future launches we never show the wizard again unless the user explicitly re-runs it from Settings.

---

## 4. Special flows

### 4.1 Re-running onboarding

*Settings → Help → Re-run onboarding* replays steps 2–8 with current values pre-filled. Step 0 (EULA) and Step 1 (Welcome) are skipped. No data is destroyed; choosing a different vault in Step 3 just switches the active vault and leaves the old one untouched on disk.

### 4.2 Headless / MDM install

If the installer was invoked with the MDM args (see §1), the wizard:
1. Reads the pre-set values from `<config>/onboarding-prefill.json` (written by the installer).
2. Runs steps 2–8 silently in the background (no UI), validating each.
3. Shows only Step 9 ("You're ready") with the configured summary.
4. Logs a single line to `<config>/onboarding.log` describing what was set.

### 4.3 Network unplugged

The wizard always completes offline. Steps 5, 7, 8 that need the network simply degrade:
- Step 5 (Sync): all `Connect` buttons show a tiny offline icon + tooltip "We'll connect when you're back online." Skipping is the only path forward.
- Step 7 (AI): cloud providers grey out; Ollama still works if the local daemon is running.
- Step 8 (Calendar): same as Step 5.

On network restore, a status-bar pill appears: "Finish setting up Sync / AI / Calendar — 30 seconds."

### 4.4 Resuming after a crash

The wizard writes `<config>/onboarding.json` after every `Next` click. On next launch, if `onboarding_completed_at` is missing but the file has any state, we resume at the next incomplete step and show a small "Welcome back — picking up where you left off" banner.

### 4.5 Migrating from v1 (pre-onboarding installs)

For users who installed before the wizard existed:
1. On first launch after upgrade, detect the absence of `onboarding.json` *and* the presence of a `vaults.json` from the v1 vault store.
2. Skip steps 0–3 entirely (vault already known).
3. Land on Step 4 with a small banner: "*New in v2.0 — let's finish setting up the bits we didn't have before.*"
4. Steps 4–8 run as normal.

### 4.6 Multi-user (shared device)

Lattice stores onboarding state per OS user, in `<config>/Lattice/onboarding.json` (Windows: `%APPDATA%\Lattice\`, macOS: `~/Library/Application Support/Lattice/`, Linux: `$XDG_CONFIG_HOME/Lattice/`). A second user on the same machine gets their own wizard.

---

## 5. State, persistence, and contract

### 5.1 `onboarding.json` schema

```jsonc
{
  "onboarding_version": "v2.0",
  "eula_accepted_at": "2026-06-06T14:23:11Z",
  "persona": "student",                  // student | dev | enterprise
  "vault_path": "/Users/alex/Documents/Lattice Vault",
  "vault_origin": "created",             // created | opened | imported-obsidian | imported-logseq | ...
  "theme": "system",                     // system | light | dark | high-contrast
  "density": "comfortable",              // comfortable | compact | cozy
  "font_family": "inter",
  "sync_provider": "google_drive",       // null if skipped
  "sync_target_id": "0BxYz...folder_id",
  "e2ee_enabled": false,
  "ai_provider": "ollama",               // null if skipped
  "ai_model_id": "llama3.2:3b",
  "extras_enabled": ["daily_journal", "calendar:google"],
  "telemetry_opted_in": false,
  "onboarding_completed_at": "2026-06-06T14:26:04Z",
  "resume_step": null                    // set if user quit mid-flow
}
```

This file is **never synced to the cloud**. It is intentionally excluded from BYOC.

### 5.2 Side-effects written to the vault

| File | When | Why |
|---|---|---|
| `<vault>/Welcome.md` | End of Step 9, only if it doesn't already exist | User-facing tour |
| `<vault>/.lattice/config.toml` | After each step that affects vault behavior | Per-vault overrides for theme, AI, etc. |
| `<vault>/journals/<date>.md` | Step 8 if Daily Journal was checked | First daily note |
| `<vault>/.gitignore` | Step 5 if GitHub was chosen | Excludes `.lattice/state/`, `build/`, OS junk |

### 5.3 IPC commands (Tauri)

New Rust commands in [`src-tauri/src/commands.rs`](../src-tauri/src/commands.rs):

```rust
onboarding_get_state()              -> OnboardingState
onboarding_set_persona(persona)     -> ()
onboarding_create_vault(path)       -> Result<VaultId>
onboarding_open_vault(path)         -> Result<VaultId>
onboarding_import_detect()          -> Vec<DetectedVault>
onboarding_import_start(detected)   -> JobId
onboarding_set_theme(theme, density, font)
onboarding_oauth_begin(provider)    -> AuthSessionId
onboarding_oauth_poll(session_id)   -> Pending | Ok(token_handle) | Err
onboarding_set_e2ee(passphrase, recovery) -> Result<()>
onboarding_ai_detect_ollama()       -> OllamaStatus
onboarding_ai_set_provider(provider, model, creds)
onboarding_complete()               -> ()
onboarding_reset()                  -> ()    // Settings → re-run
```

All commands are pure functions over `onboarding.json` + side-effects above. None of them touch the network synchronously.

### 5.4 React component contract

```
src/components/onboarding/
├── OnboardingShell.tsx          // step router + persistent footer
├── OnboardingShell.css
├── steps/
│   ├── Step0Splash.tsx
│   ├── Step1Welcome.tsx
│   ├── Step2Persona.tsx
│   ├── Step3Vault.tsx
│   ├── Step4Theme.tsx
│   ├── Step5Sync.tsx
│   ├── Step6Encryption.tsx
│   ├── Step7AI.tsx
│   ├── Step8Extras.tsx
│   └── Step9Done.tsx
└── state/
    ├── onboardingStore.ts        // Zustand, mirrors onboarding.json
    └── personaPresets.ts         // declarative defaults per persona
```

`OnboardingShell` is rendered at app root *above* the editor when `onboarding_completed_at` is null. It dims the editor (still visible underneath in muted preview) so the user knows what they're setting up.

---

## 6. Accessibility checklist

Every screen must pass:
- [x] Tab order matches visual order.
- [x] `Esc` closes any inline modal (e.g., OAuth waiting pane).
- [x] All buttons have visible focus rings (2 px outline, theme-aware).
- [x] Color contrast ≥ 4.5:1 for body text, ≥ 3:1 for UI components (WCAG 2.2 AA).
- [x] Reduced-motion preference (`prefers-reduced-motion`) disables the splash fade and any step transitions.
- [x] Screen-reader announces step changes ("Step 5 of 9 — Sync").
- [x] Form errors announced via `aria-live="polite"`.
- [x] Font-size respects OS-level zoom up to 200%.
- [x] The OAuth waiting pane is fully keyboard-cancellable (`Esc` or `Cancel` button).

---

## 7. Telemetry events (only sent if the user opts in at Step 8)

| Event | Payload | Why |
|---|---|---|
| `onboarding_started` | `version`, `os` | Funnel top |
| `onboarding_step_completed` | `step` (0–9), `duration_ms`, `skipped` (bool) | Drop-off analysis |
| `onboarding_completed` | `total_duration_ms`, `persona`, `sync_provider_or_null`, `e2ee_on`, `ai_provider_or_null` | Funnel bottom |
| `onboarding_abandoned` | `last_step`, `idle_duration_ms` | Where users quit |

**Never sent:** vault path, vault name, file counts, passphrases (obviously), provider account identifiers, free-text input, OS user name. The payload is a fixed-shape JSON with no string fields beyond enums.

Transport: self-hosted [Plausible](https://plausible.io/) endpoint (chosen in Appendix A of [`impl-v2.md`](impl-v2.md#appendix-a)).

---

## 8. Edge cases and failure modes

| Situation | Behavior |
|---|---|
| User picks vault inside another vault | Refuse with "This folder is already part of another Lattice vault." |
| User picks vault on read-only volume | Refuse with one-click "Pick a different folder." |
| OAuth provider returns error (invalid_grant, denied, etc.) | Inline red banner with the provider's message; `Try again` + `Pick a different provider` + `Skip` buttons. |
| Ollama detected but daemon dies mid-step | Mark Step 7 model selector unavailable, show "Ollama stopped responding — start `ollama serve` and refresh, or pick a different provider." |
| Disk fills up while writing Welcome.md | Catch, show toast "Couldn't create Welcome.md (disk full)" — does **not** block Step 9 completion. |
| User Cmd+Q's during OAuth | Token-pending state is cleared on next launch; user resumes at Step 5. |
| Clock skew breaks OAuth | Detect HTTP 401 with `Date` header mismatch, prompt "Your system clock is off — please correct it and try again." |
| Two installations on the same OneDrive folder | Detect via a `.lattice/install-lock` UUID; second install offers to "Join the existing vault" instead of overwriting. |
| User refuses both passphrases in E2EE step | Toggle stays On but `Next` disabled; banner explains "We can't enable encryption without a passphrase." User can toggle Off and continue. |

---

## 9. Open questions (decide before implementation)

1. **Should Step 0's EULA checkbox default to checked?** Faster onboarding vs explicit consent. Recommendation: **unchecked** — matches Step 7 telemetry choice and the "no dark patterns" principle.
2. **Should Step 1's Welcome screen include a 15-second video?** Helps non-technical users; bloats the installer. Recommendation: **no video in v2** — `Welcome.md` carries the same content in editable text.
3. **Should personas have icons?** Yes, for scannability. Pick three: 🎓 (student), 🛠️ (dev), 🏢 (enterprise) — but use SVG, not emoji, so they theme correctly. *(Reminder: this is the only place in the project where emoji-like icons are used — the rest of the UI uses Lucide SVGs.)*
4. **Should Step 5 allow connecting more than one provider?** No in v2 — keeps the wizard simple; multi-provider sync ships as a Settings feature later.
5. **Should the wizard ship in v2.0 or v2.0.1?** Recommendation: **v2.0** — without onboarding, every new install today lands on an empty editor with no vault selected, which is the worst-first-impression failure mode we have.

---

## 10. Build sequence (engineering tasks)

Translates this design into shippable PRs, sized for ~1–2 days each.

1. **`OnboardingShell` + step router + persistent footer + `onboardingStore` Zustand.** No content yet — just the skeleton + state persistence to `onboarding.json` via a new `onboarding_get_state` / `onboarding_set_*` IPC.
2. **Step 0 Splash + EULA + auto-detect of existing vaults + Ollama detection (background).** Returns to Step 1 on Continue.
3. **Step 1 Welcome + Step 2 Persona + persona-preset application.** End-to-end test: pick each persona, verify defaults written.
4. **Step 3 Vault — create / open / import.** Import handler hooks into [`impl-v2.md`](impl-v2.md) §11 importers (initially Obsidian + Logseq).
5. **Step 4 Theme + density + font, with live preview.** Reuses the existing theme tokens; no new theming infra.
6. **Step 5 Sync — BYOC OAuth flow + offline degradation + status-bar push job.** GitHub adapter first (per persona "OSS Developer"), then Drive + OneDrive.
7. **Step 6 Encryption — passphrase entry, recovery passphrase generation + confirm, key wrap into keychain.** Reuses [`impl-v2.md`](impl-v2.md) §9 crypto.
8. **Step 7 AI — Ollama auto-detect + cloud-provider key entry + privacy matrix init.** Reuses [`impl-v2.md`](impl-v2.md) §5.3 BYOM router.
9. **Step 8 Extras — daily journal creation, calendar OAuth deferral, CLI install command, telemetry toggle wiring.**
10. **Step 9 Done — Welcome.md generator + status-bar background-jobs UI + "Take the tour" navigation.**
11. **Resume-from-crash + Re-run-from-Settings + MDM headless mode + migration-from-v1.**
12. **Accessibility pass (§6) + telemetry events (§7) + edge cases (§8).**

Land in this order to keep `main` shippable at every step — after step 3 we already have a working "pick a vault and go" experience; steps 4–10 add depth without ever breaking the happy path.

---

## 11. Cross-references

- [`impl-v2.md`](impl-v2.md) — full v2 plan (this onboarding doc is §10 expanded out).
- [`impl-v2.md`](impl-v2.md#5-plugin-system--byoc--byom) §5 — BYOC + BYOM detail used by Steps 5 and 7.
- [`impl-v2.md`](impl-v2.md#9-end-to-end-encryption-researched) §9 — crypto detail used by Step 6.
- [`impl-v2.md`](impl-v2.md#11-importers-built-in-tier-can-also-be-plugins) §11 — import adapters used by Step 3.
- [`current-state.md`](current-state.md) — what's already shipped (helps decide what Steps 5/6/7 can actually wire to today).
- [`impl.md`](impl.md) — original 5-phase plan, for historical context.
