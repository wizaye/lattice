//! Quartz install + build helpers.
//!
//! Implements the three subprocess calls that drive the publish
//! pipeline:
//!  1. **clone**  — `git clone --depth 1 https://github.com/jackyzha0/quartz.git <dest>`
//!  2. **install** — `npm install` inside `<dest>` (downloads ~150 MB
//!     of Quartz's transitive deps; takes 30-90s depending on cache).
//!  3. **build**   — `npx quartz build` inside `<dest>` (renders
//!     `<dest>/content/**/*.md` into `<dest>/public/`).
//!
//! Every shell-out is routed through [`super::proc::spawn`] so the
//! Windows PATHEXT shim trap (`npm` is a POSIX shell script next to
//! the real `npm.cmd` in Node's installer) cannot misfire.
//!
//! The two long-running commands (`npm install`, `npx quartz build`)
//! capture combined stdout+stderr on completion — we don't stream
//! progress to the UI yet because the IPC handler is `async fn`
//! returning a single `Result`.  Surfacing the first 4 KB of stderr
//! on failure is enough context for a user to act ("network error",
//! "ENOENT: no such file or directory", etc.) without us also having
//! to wire a Tauri event channel in this slice.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use wait_timeout::ChildExt;

use super::proc::spawn;
use super::toml::PublishTheme;

/// Upstream Quartz repo we clone from.  Pinned in code rather than in
/// `publish.toml` because allowing arbitrary URLs would make it
/// trivial to ship malicious build pipelines via a shared vault.
const QUARTZ_REPO_URL: &str = "https://github.com/jackyzha0/quartz.git";

/// Verbatim snapshot of `quartz.config.yaml` as produced by
/// `npx quartz create -t default -X new -l shortest -b localhost`.
///
/// Compiled into the binary so [`repair_quartz_config_if_needed`] can
/// restore a corrupted config WITHOUT depending on the `.lattice-orig`
/// snapshot existing — vaults scaffolded by older Lattice builds (or
/// users who manually deleted the backup) would otherwise be stuck
/// with an unrecoverable YAML once the `$indent` bug nuked their
/// keys.  The embedded template is the universal safety net.
///
/// The template is intentionally kept in lockstep with the upstream
/// defaults: if Quartz v6 ships with a new shape, this constant
/// should be updated in the same commit that bumps the pinned plugin
/// set so the recovery output always matches what `quartz_create`
/// would have produced.
const EMBEDDED_QUARTZ_CONFIG: &str = include_str!("quartz_config_template.yaml");

/// How long we wait for `git clone` before killing the child.  Quartz
/// is ~30 MB shallow-cloned; 3 min covers a slow corporate proxy.
const CLONE_TIMEOUT: Duration = Duration::from_secs(180);

/// `npm install` for Quartz pulls a few hundred packages and can take
/// 60-120s on first run with a cold cache.  10 min cap is defensive.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(600);

/// `npx quartz create` git-clones ~30-45 community plugin repos one at
/// a time (Quartz v5 split plugins out of core).  Each clone is small
/// but the round-trip cost adds up on slow corp links.  15 min is the
/// 95th-percentile budget.
const CREATE_TIMEOUT: Duration = Duration::from_secs(900);

/// `npx quartz plugin install --from-config` builds the just-cloned
/// plugin sources with tsc/esbuild.  Most plugins ship pre-built
/// `dist/` directories so this is fast (<1 min); 10 min cap is defensive.
const PLUGIN_INSTALL_TIMEOUT: Duration = Duration::from_secs(600);

/// Quartz's full-vault build is fast (~5 s for ~500 notes); 5 min is
/// plenty for everything short of pathological vaults.
const BUILD_TIMEOUT: Duration = Duration::from_secs(300);

/// Clone Quartz into `dest`.  Removes any pre-existing `dest/` first
/// so a re-run from a half-finished install can succeed.  After clone
/// completes, deletes `dest/.git` — the Quartz repo's history isn't
/// part of the user's vault and would otherwise show up in their VCS
/// tooling as an unrelated submodule.
pub fn clone_quartz(dest: &Path) -> Result<(), String> {
    if dest.exists() {
        // Wipe the target so `git clone` doesn't fail with
        // "destination path already exists and is not an empty directory".
        std::fs::remove_dir_all(dest)
            .map_err(|e| format!("failed to clear existing {}: {}", dest.display(), e))?;
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create {}: {}", parent.display(), e))?;
    }

    let dest_str = dest.to_string_lossy().to_string();
    let mut cmd = spawn("git");
    cmd.args([
        "clone",
        "--depth",
        "1",
        "--no-tags",
        QUARTZ_REPO_URL,
        &dest_str,
    ])
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());

    run_with_timeout("git clone", cmd, CLONE_TIMEOUT)?;

    // Drop Quartz's git history — it isn't ours and confuses VCS UIs.
    let dot_git = dest.join(".git");
    if dot_git.exists() {
        // best-effort cleanup; if Windows still has a file handle open
        // (rare with --depth 1) we surface a friendly hint rather than
        // erroring the whole flow.
        if let Err(e) = std::fs::remove_dir_all(&dot_git) {
            return Err(format!(
                "cloned Quartz, but failed to remove {} (you can delete it manually): {}",
                dot_git.display(),
                e
            ));
        }
    }

    Ok(())
}

/// Run `npm install` inside `dir`.  Captures combined output for the
/// error message but doesn't stream it — see module-level docs.
pub fn npm_install(dir: &Path) -> Result<(), String> {
    let mut cmd = spawn("npm");
    cmd.current_dir(dir)
        .arg("install")
        // Disable interactive prompts (npm sometimes asks about
        // funding messages or update notifiers); these can hang a
        // headless subprocess on certain corp setups.
        .args(["--no-audit", "--no-fund", "--loglevel=error"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    run_with_timeout("npm install", cmd, INSTALL_TIMEOUT)
}

/// Run `npx quartz build` inside `dir`.  Returns the path to the
/// produced `public/` directory after a successful build, or a
/// detailed error if the build failed (with Quartz's own stderr
/// excerpted — usually a markdown parse error pointing at a vault
/// file).
pub fn npx_quartz_build(dir: &Path) -> Result<PathBuf, String> {
    let mut cmd = spawn("npx");
    cmd.current_dir(dir)
        // `-y` so npx doesn't prompt to install missing packages on
        // first run (it shouldn't need to, since `npm install` ran
        // first, but the flag keeps the subprocess strictly
        // non-interactive).
        .args(["-y", "quartz", "build"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    run_with_timeout("npx quartz build", cmd, BUILD_TIMEOUT)?;

    let public_dir = dir.join("public");
    if !public_dir.is_dir() {
        return Err(format!(
            "quartz build reported success but {} does not exist",
            public_dir.display()
        ));
    }
    Ok(public_dir)
}

/// Run `npx quartz create` non-interactively to materialise the
/// `<dir>/.quartz/` scaffold (plugins + config) that Quartz v5 needs
/// before a build can resolve `../../.quartz/plugins` imports inside
/// upstream `quartz/components/Head.tsx`.  Without this step a fresh
/// clone fails the build with an esbuild "Could not resolve" error
/// at line 7 of Head.tsx.
///
/// Flags chosen so the create command never blocks on a `@clack`
/// prompt:
///   * `-t default` — template choice.  `default` is the lightest
///     starter; we re-populate `content/` from the vault on every
///     build anyway, so the chosen template only affects baseline
///     `quartz.config.yaml` defaults.
///   * `-X new` — setup strategy.  `new` means "empty content folder";
///     this is correct because `publish_build` then writes the
///     filtered vault into `content/`.
///   * `-l shortest` — wikilink resolution strategy (matches Obsidian
///     defaults; most users expect `[[Note]]` to find the file
///     wherever it lives).
///   * `-b localhost` — placeholder baseUrl for the initial config.
///     The real `baseUrl` for a deploy is patched in later by
///     `publish_deploy` when we know which host the user picked.
pub fn quartz_create(dir: &Path) -> Result<(), String> {
    let mut cmd = spawn("npx");
    cmd.current_dir(dir)
        .args([
            "-y", "quartz", "create",
            "-t", "default",
            "-X", "new",
            "-l", "shortest",
            "-b", "localhost",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    run_with_timeout("npx quartz create", cmd, CREATE_TIMEOUT)?;
    // Snapshot the pristine config so we can self-heal if a future
    // patcher run corrupts the file (see patch_quartz_config_theme +
    // ensure_quartz_config_intact).
    let cfg = dir.join("quartz.config.yaml");
    let backup = dir.join("quartz.config.yaml.lattice-orig");
    if cfg.is_file() && !backup.exists() {
        if let Err(e) = std::fs::copy(&cfg, &backup) {
            eprintln!(
                "lattice: failed to back up {} → {}: {}",
                cfg.display(),
                backup.display(),
                e
            );
        }
    }
    Ok(())
}

/// Run `npx quartz plugin install --from-config` inside `dir`.
///
/// Resolves every plugin referenced in `quartz.config.yaml` (the file
/// written by [`quartz_create`]) — clones any that aren't already on
/// disk and builds them (tsc / esbuild).  Idempotent: re-running with
/// no config changes is a fast no-op.
pub fn quartz_plugin_install(dir: &Path) -> Result<(), String> {
    let mut cmd = spawn("npx");
    cmd.current_dir(dir)
        .args(["-y", "quartz", "plugin", "install", "--from-config"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    run_with_timeout("npx quartz plugin install", cmd, PLUGIN_INSTALL_TIMEOUT)
}

/// Idempotently make sure `<dir>` has the Quartz v5 scaffold needed
/// for a build to succeed: `.quartz/plugins/` must exist (otherwise
/// upstream `Head.tsx`'s `import { CustomOgImagesEmitterName } from
/// "../../.quartz/plugins"` fails to resolve).
///
/// Lets `publish_build` self-heal an install that was scaffolded with
/// an older build of Lattice (or interrupted mid-init) without
/// requiring the user to delete `.lattice/publish/` and re-run the
/// publishing wizard.
///
/// `theme` is the user's customisation overrides from `publish.toml
/// [quartz.theme]` — applied on every call so a config edit in the
/// wizard reflects on the next build without an explicit re-init.
/// Pass `None` to skip the theme overlay (e.g. before a `publish.toml`
/// has been written).
pub fn ensure_scaffold(dir: &Path, theme: Option<&PublishTheme>) -> Result<(), String> {
    let plugins_dir = dir.join(".quartz").join("plugins");
    if !plugins_dir.is_dir() {
        quartz_create(dir)?;
        quartz_plugin_install(dir)?;
        if !plugins_dir.is_dir() {
            return Err(format!(
                "quartz create reported success but {} still does not exist — \
                 try deleting {} and re-running the publishing wizard.",
                plugins_dir.display(),
                dir.display()
            ));
        }
    }
    // Always re-apply the globby patch — cheap, idempotent, and
    // protects against `npm install` having reset the file.
    patch_globby_disable_gitignore(dir)?;

    // Make js-yaml lenient about duplicate frontmatter keys.
    // Without this, a single note with `- Config` (or any other key)
    // repeated in its frontmatter blows up the WHOLE build with
    // `YAMLException: duplicated mapping key` — taking down 500
    // perfectly-fine notes because of one typo in one file.
    // Best-effort: log + continue on failure (the build will still
    // run; the user just gets the strict-YAML error if their vault
    // has duplicate keys).
    if let Err(e) = patch_yaml_lenient_keys(dir) {
        eprintln!("lattice: yaml-lenient patch skipped: {e}");
    }

    // Re-apply the user's UI customisations on every build so the
    // wizard's "Customise" step is the source of truth for site
    // chrome.  Best-effort — a missing config file (e.g. mid-clone)
    // is logged and skipped rather than failing the whole build.
    if let Some(t) = theme {
        // Self-heal first: a buggy patcher in an earlier Lattice build
        // (the $indent named-capture bug, fixed 2025-01) could strip
        // every key name from quartz.config.yaml, producing `: value`
        // lines that YAML parses as duplicate null keys.  The repair
        // step detects that pattern and restores from either the
        // `.lattice-orig` backup OR the embedded upstream template
        // (so vaults that predate the backup pattern still self-heal).
        // It also proactively snapshots the current file as
        // `.lattice-orig` if no backup exists — bootstrapping the
        // backup for existing scaffolds so future corruption can
        // recover to the user's customised state.
        if let Err(e) = repair_quartz_config_if_needed(dir) {
            eprintln!("lattice: quartz.config.yaml recovery skipped: {e}");
        }
        if let Err(e) = patch_quartz_config_theme(dir, t) {
            eprintln!("lattice: theme patch skipped: {e}");
        }
    }
    Ok(())
}

/// Patch `<dir>/quartz/util/glob.ts` so its `globby(...)` call uses
/// `gitignore: false` instead of `gitignore: true`.
///
/// **Why this matters.** Lattice installs Quartz at
/// `<vault>/.lattice/publish/quartz/` and copies the user's notes
/// into `<quartz>/content/` before each build.  Most vaults have a
/// root-level `.gitignore` that ignores `.lattice/` (Lattice itself
/// writes that file during onboarding to keep its state out of the
/// user's git history).  Quartz's default file discovery walks UP
/// from `content/` looking for `.gitignore` files and, per git's own
/// spec, finds `.lattice/` excluded — which means every `.md` under
/// our content dir is treated as ignored.  Result: `Found 0 input
/// files` and a 404 on the preview homepage.
///
/// Lattice already controls publication scope via its own
/// `exclude.patterns` (see `exclude.rs`), so Quartz's gitignore
/// integration is redundant noise.  We disable it by string-replacing
/// the single `gitignore: true,` line in `quartz/util/glob.ts`.  The
/// patch is idempotent — running it on an already-patched file is a
/// no-op.
fn patch_globby_disable_gitignore(dir: &Path) -> Result<(), String> {
    let glob_ts = dir.join("quartz").join("util").join("glob.ts");
    let contents = match std::fs::read_to_string(&glob_ts) {
        Ok(s) => s,
        // Missing file → scaffold isn't where we expect; let the
        // caller's downstream build error surface a clearer message.
        Err(_) => return Ok(()),
    };
    if contents.contains("gitignore: false") {
        return Ok(()); // already patched
    }
    let Some(patched) = contents.replace_one("gitignore: true,", "gitignore: false,")
    else {
        // Quartz upstream changed the line — log via stderr (the
        // command output captured by tauri dev) and continue.  The
        // user will see "Found 0 input files" and can file an issue.
        eprintln!(
            "lattice: could not patch {} — `gitignore: true,` not found; \
             Quartz may have changed its glob.ts upstream",
            glob_ts.display()
        );
        return Ok(());
    };
    std::fs::write(&glob_ts, patched)
        .map_err(|e| format!("failed to write patched {}: {}", glob_ts.display(), e))?;
    Ok(())
}

/// Make js-yaml lenient about duplicate frontmatter keys.
///
/// **Why:** Quartz's `note-properties` plugin uses `gray-matter` ⇒
/// `js-yaml` to parse every note's YAML frontmatter.  By default
/// js-yaml runs the **CORE_SCHEMA** with `json: false`, which rejects
/// duplicate mapping keys (per the YAML 1.2 spec) and throws
/// `YAMLException: duplicated mapping key`.  One typo'd note (e.g. a
/// user accidentally writes `tags:` twice in their frontmatter) takes
/// down the **entire** publish build — every other note in the vault
/// stops getting rendered.
///
/// **What:** The plugin ships pre-built in `dist/index.js`; Quartz
/// loads that file at runtime, not `src/transformer.ts`, so we patch
/// the bundled JS directly.  The single call site is:
///
/// ```javascript
/// yaml: (s2) => jsYaml.load(s2, { schema: jsYaml.JSON_SCHEMA }),
/// ```
///
/// We append `, json: true` to the options bag.  Per the js-yaml docs,
/// `json: true` enables JSON-compatible parsing: duplicate keys are
/// silently accepted (last-write-wins, just like `JSON.parse` would
/// do).  This matches what Obsidian and most other markdown tools do.
///
/// **Idempotent:** A second invocation is a no-op (the marker string
/// `json: true` is checked first).
///
/// **Best-effort:** Missing file (e.g. Quartz renames the plugin in a
/// future version) is logged via stderr and silently skipped — the
/// build still runs, the user just sees the strict-YAML error if they
/// have a duplicate-key note.
fn patch_yaml_lenient_keys(dir: &Path) -> Result<(), String> {
    let plugin_js = dir
        .join(".quartz")
        .join("plugins")
        .join("note-properties")
        .join("dist")
        .join("index.js");
    let contents = match std::fs::read_to_string(&plugin_js) {
        Ok(s) => s,
        Err(_) => {
            // Plugin not installed (or renamed upstream) — nothing to
            // do.  The build will surface a clearer error if Quartz
            // fails for unrelated reasons.
            return Ok(());
        }
    };
    // Marker check — already patched?
    if contents.contains("schema: jsYaml.JSON_SCHEMA, json: true") {
        return Ok(());
    }
    let Some(patched) = contents.replace_one(
        "schema: jsYaml.JSON_SCHEMA }",
        "schema: jsYaml.JSON_SCHEMA, json: true }",
    ) else {
        eprintln!(
            "lattice: could not patch {} — `schema: jsYaml.JSON_SCHEMA }}` not found; \
             upstream note-properties plugin may have changed its bundle shape",
            plugin_js.display()
        );
        return Ok(());
    };
    std::fs::write(&plugin_js, patched).map_err(|e| {
        format!("failed to write patched {}: {}", plugin_js.display(), e)
    })?;
    Ok(())
}

/// Detect & repair `quartz.config.yaml` corruption, and ensure a
/// pristine `.lattice-orig` backup exists for future recoveries.
///
/// This is the recovery layer for the `$indent` named-capture bug
/// (fixed 2025-01 in [`replace_yaml_scalar`]) and any future bug that
/// produces null-key lines via a botched in-place patch.  Called from
/// [`ensure_scaffold`] before every theme patch — so even vaults
/// scaffolded by old buggy Lattice builds self-heal on the next
/// Build click without requiring the user to delete `.lattice/publish/`.
///
/// Recovery strategy (in order):
///   1. If file is intact → no change to file content.
///   2. If file is corrupted → restore from `.lattice-orig` if it
///      exists, else write the embedded upstream template
///      ([`EMBEDDED_QUARTZ_CONFIG`]).  Either way, the file ends up
///      as valid YAML the theme patcher can re-apply customisations
///      to on the next call.
///   3. After (1) or (2): if `.lattice-orig` is missing, snapshot the
///      current (good) file as the backup so a future corruption can
///      restore to user-customised state, not just to upstream
///      defaults.  This proactively heals vaults scaffolded before
///      we added the backup pattern.
///
/// "Corrupted" = at least one line matching `^[ \t]*:[ \t]` (a value
/// with no key — YAML parses these as `null:` and explodes once there
/// are >1 of them with `YAMLException: duplicated mapping key`).  We
/// deliberately do NOT trigger on "patched key is missing" because
/// upstream Quartz might genuinely rename or remove a field in a
/// future release; we'd rather log a warning from `replace_yaml_scalar`
/// than overwrite a user's newer config with our older template.
///
/// Returns `Ok(())` if the file is fine, was repaired, or just had a
/// backup snapshotted.  Returns `Err(...)` only on I/O failures —
/// the caller treats this as a soft warning and continues so a
/// transient permission error doesn't fail an otherwise-fine build.
fn repair_quartz_config_if_needed(dir: &Path) -> Result<(), String> {
    let cfg = dir.join("quartz.config.yaml");
    let backup = dir.join("quartz.config.yaml.lattice-orig");

    let contents = match std::fs::read_to_string(&cfg) {
        Ok(s) => s,
        Err(_) => return Ok(()), // file doesn't exist yet (pre-scaffold) — skip
    };

    // The smoking-gun pattern for the $indent bug: a line whose only
    // content before the colon is whitespace.  `^[ \t]*:[ \t]` is
    // precise enough never to match legitimate YAML (real keys always
    // have a non-whitespace character before the colon).
    let null_key = match regex::Regex::new(r"(?m)^[ \t]*:[ \t]") {
        Ok(r) => r,
        Err(_) => return Ok(()),
    };

    if null_key.is_match(&contents) {
        // Corrupted — choose recovery source and rewrite the file.
        let (source_label, recovered): (&str, String) = if backup.is_file() {
            let backup_contents = std::fs::read_to_string(&backup).map_err(|e| {
                format!("failed to read backup {}: {}", backup.display(), e)
            })?;
            if null_key.is_match(&backup_contents) {
                // The backup itself is also corrupted (e.g. user
                // somehow ran the buggy patcher AFTER snapshotting).
                // Fall through to the embedded template — losing the
                // user's old customisations is better than refusing
                // to build.
                eprintln!(
                    "lattice: backup {} is ALSO corrupted; falling back to embedded template",
                    backup.display()
                );
                ("embedded template", EMBEDDED_QUARTZ_CONFIG.to_string())
            } else {
                (".lattice-orig backup", backup_contents)
            }
        } else {
            ("embedded template", EMBEDDED_QUARTZ_CONFIG.to_string())
        };
        std::fs::write(&cfg, &recovered).map_err(|e| {
            format!("failed to write recovered {}: {}", cfg.display(), e)
        })?;
        eprintln!(
            "lattice: restored {} from {} after detecting null-key corruption \
             (theme customisations will be re-applied on this build)",
            cfg.display(),
            source_label
        );
    }

    // Ensure `.lattice-orig` exists so a future corruption can
    // recover to a user-known state.  Snapshots the CURRENT (good)
    // file, which may already contain user customisations from
    // previous wizard runs — that's intentional, the backup's job is
    // "a known-good state we can roll back to", not "the upstream
    // pristine".  The patcher is idempotent so re-applying current
    // customisations on top of this snapshot is a no-op.
    if !backup.exists() && cfg.is_file() {
        if let Err(e) = std::fs::copy(&cfg, &backup) {
            // Non-fatal — the file is good, we just can't snapshot
            // it.  Log + continue.
            eprintln!(
                "lattice: failed to snapshot {} → {} for future recovery: {}",
                cfg.display(),
                backup.display(),
                e
            );
        }
    }
    Ok(())
}

/// Apply the user's UI customisations from `publish.toml [quartz.theme]`
/// to `<dir>/quartz.config.yaml`.
///
/// Uses **line-anchored regex substitution** rather than YAML
/// round-tripping for three reasons:
///   1. No `serde_yaml` dependency (the only one of two surviving
///      forks is `serde_yml`, marked maintenance-only).
///   2. Round-tripping strips comments + reflows the file — we want
///      the user's `quartz.config.yaml` to look like the upstream
///      template so it's diff-friendly if they edit it by hand.
///   3. We only touch ~6 fields; a line-anchored replace is the
///      minimum-blast-radius edit.
///
/// Mutates the following keys when set (skips when the user left them
/// at default sentinels):
///   * `configuration.pageTitle` ← `theme.page_title` (when non-empty)
///   * `configuration.pageTitleSuffix` ← `theme.page_title_suffix` (always)
///   * `configuration.enablePopovers` ← `theme.popovers`
///   * `configuration.enableSPA` ← `theme.spa`
///   * `configuration.theme.typography.{header,body,code}` ← typography preset
///   * `configuration.theme.colors.{lightMode,darkMode}.{secondary,tertiary}`
///     ← palette preset
///
/// If the upstream YAML shape ever changes shape (e.g. Quartz v6 drops
/// `enableSPA`), the unmatched regex is logged via stderr and ignored.
fn patch_quartz_config_theme(dir: &Path, theme: &PublishTheme) -> Result<(), String> {
    let cfg = dir.join("quartz.config.yaml");
    let original = std::fs::read_to_string(&cfg)
        .map_err(|e| format!("failed to read {}: {}", cfg.display(), e))?;
    let mut text = original.clone();

    // pageTitle — only patch when user set one (otherwise keep upstream)
    if !theme.page_title.trim().is_empty() {
        text = replace_yaml_scalar(&text, "pageTitle", &yaml_quote(&theme.page_title));
    }
    // pageTitleSuffix — always patch (empty string is a meaningful value)
    text = replace_yaml_scalar(
        &text,
        "pageTitleSuffix",
        &yaml_quote(&theme.page_title_suffix),
    );
    // enableSPA / enablePopovers
    text = replace_yaml_scalar(&text, "enableSPA", if theme.spa { "true" } else { "false" });
    text = replace_yaml_scalar(
        &text,
        "enablePopovers",
        if theme.popovers { "true" } else { "false" },
    );

    // Typography (only when user picked a non-default preset)
    if let Some(fonts) = typography_fonts(&theme.typography) {
        text = replace_yaml_scalar(&text, "header", &yaml_quote(fonts.header));
        text = replace_yaml_scalar(&text, "body", &yaml_quote(fonts.body));
        text = replace_yaml_scalar(&text, "code", &yaml_quote(fonts.code));
    }

    // Palette — drives the link/accent colour pair in both modes
    if let Some(p) = palette_colors(&theme.palette) {
        // `secondary` + `tertiary` appear once in lightMode + once in
        // darkMode; replace_all swaps every occurrence with the same
        // string per mode (Quartz uses a slightly desaturated tone in
        // dark mode, but the diff is cosmetic — most user palettes
        // look fine using the same value in both modes).
        text = replace_yaml_scalar_all(&text, "secondary", &yaml_quote(p.secondary));
        text = replace_yaml_scalar_all(&text, "tertiary", &yaml_quote(p.tertiary));
    }

    if text == original {
        return Ok(());
    }
    std::fs::write(&cfg, text)
        .map_err(|e| format!("failed to write patched {}: {}", cfg.display(), e))?;
    Ok(())
}

/// Replace the **first** line matching `<indent>KEY: …` with
/// `<indent>KEY: <value>`.  No-op (with a stderr warning) if no match.
///
/// The pattern is intentionally permissive on the right-hand side so
/// the same call works against bare scalars (`pageTitle: Quartz 5`),
/// quoted scalars (`pageTitle: "Quartz 5"`), and trailing comments
/// (`enableSPA: true  # …`) — the regex eats everything from `:` to
/// end-of-line.
fn replace_yaml_scalar(text: &str, key: &str, value: &str) -> String {
    let pat = format!(r"(?m)^(?P<indent>[ \t]*){}:[^\r\n]*", regex::escape(key));
    let Ok(re) = regex::Regex::new(&pat) else {
        eprintln!("lattice: invalid regex for key `{key}`");
        return text.to_string();
    };
    // ${indent} (delimited!) — bare $indent eats following letters as part
    // of the variable name, so `$indentpageTitle` becomes the (undefined)
    // group `indentpageTitle` and expands to empty, dropping BOTH the
    // indent AND the key.  That bug corrupted quartz.config.yaml into
    // `: My BookWorm`-style lines, which YAML parsed as duplicate null
    // keys and crashed the whole build.
    let replacement = format!("${{indent}}{key}: {value}");
    let out = re.replacen(text, 1, replacement.as_str()).into_owned();
    if out == text {
        eprintln!(
            "lattice: quartz.config.yaml has no `{key}:` line — \
             upstream Quartz may have renamed the field"
        );
    }
    out
}

/// Replace **every** line matching `<indent>KEY: …`.  Used for keys
/// that legitimately appear more than once in the config (e.g.
/// `secondary` in both `lightMode` + `darkMode`).
fn replace_yaml_scalar_all(text: &str, key: &str, value: &str) -> String {
    let pat = format!(r"(?m)^(?P<indent>[ \t]*){}:[^\r\n]*", regex::escape(key));
    let Ok(re) = regex::Regex::new(&pat) else {
        eprintln!("lattice: invalid regex for key `{key}`");
        return text.to_string();
    };
    // Same delimited-named-capture fix as replace_yaml_scalar — see
    // that fn's comment for the gory story.
    let replacement = format!("${{indent}}{key}: {value}");
    re.replace_all(text, replacement.as_str()).into_owned()
}

/// Wrap a YAML scalar value in double quotes if it contains any
/// character that would change YAML semantics (`:`, `#`, leading `-`,
/// leading whitespace, empty string, etc.).  Bare alphanumeric+space
/// values are emitted unquoted to match the upstream Quartz
/// formatting style.
fn yaml_quote(v: &str) -> String {
    let needs_quote = v.is_empty()
        || v.contains(':')
        || v.contains('#')
        || v.contains('"')
        || v.contains('\'')
        || v.starts_with('-')
        || v.starts_with(' ')
        || v.trim_end() != v;
    if needs_quote {
        // Escape backslash + double-quote per the YAML double-quoted scalar spec.
        let escaped = v.replace('\\', "\\\\").replace('"', "\\\"");
        format!("\"{escaped}\"")
    } else {
        v.to_string()
    }
}

/// Typography presets — header / body / code Google Font names.
/// `"default"` returns `None` so the upstream `quartz.config.yaml`
/// stays intact.
struct TypographyPreset {
    header: &'static str,
    body: &'static str,
    code: &'static str,
}

fn typography_fonts(preset: &str) -> Option<TypographyPreset> {
    match preset {
        "modern-serif" => Some(TypographyPreset {
            header: "Crimson Pro",
            body: "Inter",
            code: "JetBrains Mono",
        }),
        "geometric-sans" => Some(TypographyPreset {
            header: "Inter",
            body: "Inter",
            code: "JetBrains Mono",
        }),
        "brutalist" => Some(TypographyPreset {
            header: "Space Grotesk",
            body: "Space Grotesk",
            code: "Space Mono",
        }),
        "elegant" => Some(TypographyPreset {
            header: "Cormorant Garamond",
            body: "Libre Franklin",
            code: "IBM Plex Mono",
        }),
        // "default" — keep upstream Schibsted Grotesk / Source Sans Pro / IBM Plex Mono
        _ => None,
    }
}

/// Colour presets — `secondary` (links + active graph node) +
/// `tertiary` (hover states + visited graph nodes).  `"default"`
/// returns `None` so the upstream `quartz.config.yaml` stays intact.
struct PalettePreset {
    secondary: &'static str,
    tertiary: &'static str,
}

fn palette_colors(preset: &str) -> Option<PalettePreset> {
    match preset {
        "ocean" => Some(PalettePreset { secondary: "#1f6feb", tertiary: "#388bfd" }),
        "forest" => Some(PalettePreset { secondary: "#2f7d32", tertiary: "#66bb6a" }),
        "sunset" => Some(PalettePreset { secondary: "#d84315", tertiary: "#ff7043" }),
        "mono"  => Some(PalettePreset { secondary: "#333333", tertiary: "#777777" }),
        "berry" => Some(PalettePreset { secondary: "#8e24aa", tertiary: "#ba68c8" }),
        // "default" — keep upstream #284b63 / #84a59d
        _ => None,
    }
}

/// Local helper — `str::replace` always returns a `String`, so the
/// caller can't tell whether anything matched.  We need that signal
/// to know whether to bail with the "upstream changed" message.
///
/// Named `replace_one` (not `replace_first`) because the latter is
/// in the process of being added to stdlib — see rust-lang/rust
/// issue #48919 — and we'd rather not race the name collision.
trait ReplaceOne {
    fn replace_one(&self, needle: &str, replacement: &str) -> Option<String>;
}

impl ReplaceOne for str {
    fn replace_one(&self, needle: &str, replacement: &str) -> Option<String> {
        let idx = self.find(needle)?;
        let mut out = String::with_capacity(self.len() + replacement.len());
        out.push_str(&self[..idx]);
        out.push_str(replacement);
        out.push_str(&self[idx + needle.len()..]);
        Some(out)
    }
}

/// Spawn the command, wait up to `timeout`, and report failure with
/// the last 4 KB of stderr so the UI gets actionable context.
fn run_with_timeout(label: &str, mut cmd: std::process::Command, timeout: Duration) -> Result<(), String> {
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            // The PATHEXT-aware spawn already tried hard; if we still
            // don't find the binary, give the user actionable advice.
            format!(
                "could not find the binary required for `{label}`. \
                 Please confirm Node.js, npm, and git are installed and on PATH."
            )
        } else {
            format!("{label}: spawn failed: {e}")
        }
    })?;

    match child.wait_timeout(timeout) {
        Ok(Some(status)) => {
            // Drain whatever the child printed (we ignore read errors —
            // a missing pipe is harmless after the child exits).
            let stdout = drain(child.stdout.take());
            let stderr = drain(child.stderr.take());
            if status.success() {
                Ok(())
            } else {
                // Surface BOTH streams.  Older callers only showed
                // stderr (and fell back to stdout only if stderr was
                // empty) — that hid the real error for tools like
                // Quartz CLI, which prints the actionable diagnostic
                // to stdout via its own logger while yargs prints
                // the help banner to stderr on any internal failure.
                // The result was a "command exited with 1" message
                // followed by nothing but help text, with the actual
                // cause (e.g. an esbuild parse error pointing at a
                // specific markdown file) silently dropped.
                //
                // We now always include both, labeled, each tail-
                // truncated to 4 KB so the combined message stays
                // bounded on pathologically chatty builds (Quartz can
                // emit ~50 KB of progress logs on a large vault).
                let mut combined = String::new();
                if !stdout.is_empty() {
                    combined.push_str("--- stdout ---\n");
                    combined.push_str(&truncate_tail(&stdout, 4096));
                    combined.push('\n');
                }
                if !stderr.is_empty() {
                    combined.push_str("--- stderr ---\n");
                    combined.push_str(&truncate_tail(&stderr, 4096));
                }
                if combined.is_empty() {
                    combined.push_str("(no output captured)");
                }
                Err(format!(
                    "{label} exited with {:?}\n{}",
                    status.code(),
                    combined
                ))
            }
        }
        Ok(None) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(format!(
                "{label} timed out after {}s",
                timeout.as_secs()
            ))
        }
        Err(e) => {
            let _ = child.kill();
            Err(format!("{label}: wait failed: {e}"))
        }
    }
}

fn drain<R: std::io::Read>(reader: Option<R>) -> String {
    let Some(mut r) = reader else {
        return String::new();
    };
    let mut buf = Vec::new();
    let _ = r.read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).into_owned()
}

/// Keep the last `n` characters of `s` (npm install logs can be
/// hundreds of KB; only the tail matters for diagnosis).
fn truncate_tail(s: &str, n: usize) -> String {
    if s.len() <= n {
        return s.to_string();
    }
    let start = s.len() - n;
    // Walk forward to a char boundary so we don't slice a UTF-8 byte.
    let mut idx = start;
    while idx < s.len() && !s.is_char_boundary(idx) {
        idx += 1;
    }
    format!("…(truncated, last {} bytes shown)\n{}", n, &s[idx..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_keeps_short_strings_intact() {
        assert_eq!(truncate_tail("hello", 100), "hello");
    }

    #[test]
    fn truncate_trims_long_strings_to_tail() {
        let long = "z".repeat(5000);
        let out = truncate_tail(&long, 100);
        assert!(out.contains("(truncated"));
        // tail should be exactly 100 'z's after the marker
        // ('z' chosen so it doesn't appear in the truncation message).
        let tail_zzz: String = out.chars().filter(|c| *c == 'z').collect();
        assert_eq!(tail_zzz.len(), 100);
    }

    #[test]
    fn truncate_respects_utf8_char_boundaries() {
        // Pad with ascii then end with a multi-byte char.
        let mut s = "x".repeat(5000);
        s.push('é'); // 2 bytes
        // Should not panic.
        let _ = truncate_tail(&s, 1);
    }

    // Regression: the $indent named-capture replacement bug.  Bare
    // `$indent` was parsed as `$indentpageTitle` (regex's variable-name
    // greedy match), expanded to empty, and dropped BOTH the indent
    // AND the key name.  Result: `  pageTitle: foo` → `: foo`, which
    // YAML parses as a null key.  Multiple of these in one file →
    // `YAMLException: duplicated mapping key`.
    #[test]
    fn replace_yaml_scalar_preserves_indent_and_key() {
        let input = "configuration:\n  pageTitle: Quartz 5\n  baseUrl: localhost\n";
        let out = replace_yaml_scalar(input, "pageTitle", "\"My Site\"");
        assert!(
            out.contains("  pageTitle: \"My Site\""),
            "expected `  pageTitle: \"My Site\"` in:\n{out}"
        );
        // Key name must survive.
        assert!(!out.contains("\n: "), "found null-key line in:\n{out}");
        // Other keys untouched.
        assert!(out.contains("  baseUrl: localhost"));
    }

    #[test]
    fn replace_yaml_scalar_all_preserves_indent_and_key() {
        let input = "      secondary: \"#284b63\"\n      secondary: \"#7b97aa\"\n";
        let out = replace_yaml_scalar_all(input, "secondary", "\"#abc123\"");
        // Both occurrences rewritten, with indent + key preserved.
        let count = out.matches("      secondary: \"#abc123\"").count();
        assert_eq!(count, 2, "expected 2 indented rewrites in:\n{out}");
        assert!(!out.contains("\n: "), "found null-key line in:\n{out}");
    }

    // Regression: the embedded template must be valid (no null-key
    // lines, all keys the theme patcher targets present at the
    // expected indents).  If this fails, the recovery layer would
    // restore a corrupted-on-arrival file and the next build would
    // immediately re-trip `YAMLException: duplicated mapping key`.
    #[test]
    fn embedded_template_has_no_null_key_lines() {
        let re = regex::Regex::new(r"(?m)^[ \t]*:[ \t]").unwrap();
        assert!(
            !re.is_match(EMBEDDED_QUARTZ_CONFIG),
            "embedded template contains null-key line — recovery would corrupt vaults"
        );
    }

    #[test]
    fn embedded_template_has_all_patched_keys() {
        // The theme patcher targets these keys at root indent.  If
        // any are missing, `replace_yaml_scalar` will log a warning
        // and the customisation will silently be dropped after a
        // recovery — defeating the point of the embedded fallback.
        for key in ["pageTitle", "pageTitleSuffix", "enableSPA", "enablePopovers"] {
            assert!(
                EMBEDDED_QUARTZ_CONFIG
                    .lines()
                    .any(|l| l.starts_with(&format!("  {key}:"))),
                "embedded template missing `  {key}:` at root indent"
            );
        }
        // Typography keys live nested under `theme.typography` at 6
        // spaces of indent.
        for key in ["header", "body", "code"] {
            assert!(
                EMBEDDED_QUARTZ_CONFIG
                    .lines()
                    .any(|l| l.starts_with(&format!("      {key}:"))),
                "embedded template missing `      {key}:` under typography"
            );
        }
    }

    // Regression: repair must actually recover the file (not just log
    // and give up like the previous version did when no `.lattice-orig`
    // backup existed).  This was the breaking-in-the-wild bug —
    // vaults scaffolded before we added backups stayed permanently
    // corrupted until the user manually deleted `.lattice/publish/`.
    #[test]
    fn repair_restores_from_embedded_template_when_no_backup() {
        let tmp = std::env::temp_dir().join(format!(
            "lattice-quartz-repair-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let cfg = tmp.join("quartz.config.yaml");
        // Reproduce the $indent-bug corruption: keys stripped, leaving
        // null-key lines that YAML parses as duplicate `null:`.
        std::fs::write(
            &cfg,
            "configuration:\n  pageTitle: Quartz 5\n: \"\"\n: true\n: true\n",
        )
        .unwrap();

        repair_quartz_config_if_needed(&tmp).unwrap();

        let recovered = std::fs::read_to_string(&cfg).unwrap();
        let null_re = regex::Regex::new(r"(?m)^[ \t]*:[ \t]").unwrap();
        assert!(
            !null_re.is_match(&recovered),
            "repair left null-key lines in:\n{recovered}"
        );
        assert!(recovered.contains("pageTitleSuffix:"));
        assert!(recovered.contains("enableSPA:"));
        assert!(recovered.contains("enablePopovers:"));
        // Backup should now exist (snapshotted from the recovered file).
        assert!(tmp.join("quartz.config.yaml.lattice-orig").is_file());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn repair_prefers_backup_over_embedded_template() {
        let tmp = std::env::temp_dir().join(format!(
            "lattice-quartz-repair-bkp-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let cfg = tmp.join("quartz.config.yaml");
        let backup = tmp.join("quartz.config.yaml.lattice-orig");
        // Backup has a distinctive marker we can check for in the
        // recovered file to confirm it was preferred over the
        // embedded template.
        std::fs::write(
            &backup,
            "configuration:\n  pageTitle: \"From Backup Sentinel\"\n  pageTitleSuffix: \"\"\n  enableSPA: true\n  enablePopovers: true\n",
        )
        .unwrap();
        std::fs::write(
            &cfg,
            "configuration:\n: \"\"\n: true\n: true\n",
        )
        .unwrap();

        repair_quartz_config_if_needed(&tmp).unwrap();

        let recovered = std::fs::read_to_string(&cfg).unwrap();
        assert!(
            recovered.contains("From Backup Sentinel"),
            "expected recovery from backup, got:\n{recovered}"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn repair_snapshots_backup_for_existing_intact_scaffolds() {
        // Vaults scaffolded by old Lattice builds (before backups
        // existed) have a fine config but no `.lattice-orig`.  The
        // repair routine must bootstrap the backup so a FUTURE
        // corruption can recover to the user-customised state.
        let tmp = std::env::temp_dir().join(format!(
            "lattice-quartz-snapshot-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let cfg = tmp.join("quartz.config.yaml");
        let backup = tmp.join("quartz.config.yaml.lattice-orig");
        std::fs::write(
            &cfg,
            "configuration:\n  pageTitle: \"My Custom Site\"\n  enableSPA: false\n",
        )
        .unwrap();
        assert!(!backup.exists());

        repair_quartz_config_if_needed(&tmp).unwrap();

        // File should be untouched (was already intact).
        let after = std::fs::read_to_string(&cfg).unwrap();
        assert!(after.contains("My Custom Site"));
        // Backup should now exist, mirroring the (good) current file.
        assert!(backup.is_file(), "expected backup to be snapshotted");
        assert_eq!(after, std::fs::read_to_string(&backup).unwrap());

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
