fn main() {
    load_workspace_env();
    tauri_build::build()
}

/// Read `<workspace_root>/.env` (gitignored) and re-export every
/// `LATTICE_*` key as a rustc env var so `option_env!` in
/// `src/sync/clients.rs` picks it up at compile time.
///
/// Format: plain `KEY=VALUE` lines. Blank lines and `#` comments are
/// skipped. Surrounding single/double quotes on the value are stripped.
/// We deliberately do NOT depend on a dotenv crate — keeps the build
/// closure tiny and avoids pulling unrelated transitive deps.
///
/// Lookup order (first hit wins, later sources do NOT override):
///   1. existing process env (lets `[env]` in `.cargo/config.toml`
///      or a real shell export win)
///   2. `<workspace_root>/.env`
fn load_workspace_env() {
    use std::collections::HashSet;
    use std::path::PathBuf;

    // src-tauri/build.rs lives one level below the workspace root.
    let manifest_dir = std::env::var_os("CARGO_MANIFEST_DIR")
        .map(PathBuf::from)
        .expect("CARGO_MANIFEST_DIR is always set by cargo");
    let env_path = manifest_dir.join("..").join(".env");

    // Always rerun the build script if .env is created/edited/deleted.
    // We pass the path even when missing — cargo handles that gracefully.
    println!("cargo:rerun-if-changed={}", env_path.display());

    // Also rerun on any of the keys we care about being set in the shell.
    for key in ALLOWED_KEYS {
        println!("cargo:rerun-if-env-changed={key}");
    }

    let contents = match std::fs::read_to_string(&env_path) {
        Ok(s) => s,
        Err(_) => return, // no .env file → nothing to do, option_env! falls back to None
    };

    let allowed: HashSet<&str> = ALLOWED_KEYS.iter().copied().collect();

    for (lineno, raw) in contents.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // Optional leading `export ` for shell compatibility.
        let line = line.strip_prefix("export ").unwrap_or(line);

        let Some((key, value)) = line.split_once('=') else {
            println!(
                "cargo:warning=.env line {} ignored (no `=`): {raw}",
                lineno + 1
            );
            continue;
        };
        let key = key.trim();
        if !allowed.contains(key) {
            // Quietly skip unrelated vars — .env may be shared with other tooling.
            continue;
        }

        // Don't clobber values already in the process env (so `.cargo/config.toml`
        // [env] or a real shell export still wins — useful for CI overrides).
        if std::env::var_os(key).is_some() {
            continue;
        }

        // Strip surrounding matched quotes; otherwise pass through verbatim
        // (don't try to interpret escape sequences — out of scope for these
        // tokens which are URL-safe by spec).
        let mut value = value.trim().to_string();
        if value.len() >= 2 {
            let bytes = value.as_bytes();
            let first = bytes[0];
            let last = bytes[bytes.len() - 1];
            if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
                value = value[1..value.len() - 1].to_string();
            }
        }

        // Emit as a rustc env so option_env!("KEY") sees it during the
        // upcoming compilation. NOTE: do NOT print the value into a normal
        // println! — only `cargo:rustc-env=` lines get consumed silently.
        println!("cargo:rustc-env={key}={value}");
    }
}

/// Keys we recognise in `.env`. Everything else is ignored so we don't
/// accidentally leak unrelated vars into rustc env (e.g. a shared `.env`
/// that has DATABASE_URL etc.).
const ALLOWED_KEYS: &[&str] = &[
    "LATTICE_GITHUB_CLIENT_ID",
    "LATTICE_GOOGLE_CLIENT_ID",
    "LATTICE_GOOGLE_CLIENT_SECRET",
];

