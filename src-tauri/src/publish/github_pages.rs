//! GitHub Pages publishing host.
//!
//! Takes an already-built static site directory and force-pushes its
//! contents to the `gh-pages` orphan branch of a user's GitHub repo over
//! HTTPS, authenticating with a PAT or GitHub App installation token.
//!
//! Token handling rules:
//!   - Tokens are accepted as `&str` and never logged, formatted with
//!     `Debug`, or written to disk.
//!   - The token is handed to `git2` via `Cred::userpass_plaintext`
//!     and goes no further than the libgit2 transport layer.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use git2::{
    build::CheckoutBuilder, Cred, IndexAddOption, PushOptions, RemoteCallbacks, Repository,
    Signature,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Stateless host object — all per-deploy state lives in `DeployOpts`.
pub struct GitHubPagesHost;

/// Inputs for a single deploy.
pub struct DeployOpts<'a> {
    /// Directory of static files to publish (already built).
    pub built_dir: &'a Path,
    /// HTTPS clone URL, e.g. `https://github.com/user/repo.git`.
    pub repo_https_url: &'a str,
    /// PAT or installation token. Never logged.
    pub token: &'a str,
    pub commit_message: &'a str,
    pub author_name: &'a str,
    pub author_email: &'a str,
    /// Optional custom domain. When `Some`, written to a `CNAME` file
    /// at the root of the deployed branch.
    pub cname: Option<&'a str>,
}

/// Result of a successful deploy.
pub struct DeployOutcome {
    pub commit_sha: String,
    /// Always `"gh-pages"`.
    pub branch: String,
    /// Canonical Pages URL: `https://{user}.github.io/{repo}/`.
    pub pages_url: String,
}

#[derive(thiserror::Error, Debug)]
pub enum PublishError {
    #[error("git error: {0}")]
    Git(#[from] git2::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid repo url: {0}")]
    InvalidUrl(String),
}

impl GitHubPagesHost {
    pub fn deploy(&self, opts: &DeployOpts) -> Result<DeployOutcome, PublishError> {
        // ---- 1. Parse the URL up front so we fail fast on bad input. ----
        let (user, repo) = parse_github_https_url(opts.repo_https_url)?;
        let pages_url = format!("https://{}.github.io/{}/", user, repo);

        // ---- 2. Create a unique temp working dir (no `tempfile` dep). ----
        let tmp = make_unique_tmpdir()?;
        // Best-effort cleanup happens at the end of the happy path; on
        // error we deliberately leak the dir so the caller can inspect.
        let result = deploy_inner(opts, &tmp, pages_url.clone());

        if result.is_ok() {
            let _ = fs::remove_dir_all(&tmp);
        }
        result
    }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

fn deploy_inner(
    opts: &DeployOpts,
    tmp: &Path,
    pages_url: String,
) -> Result<DeployOutcome, PublishError> {
    // 2. init a fresh repo in tmp.
    let repo = Repository::init(tmp)?;

    // 3. Copy all built files into tmp (skip any `.git/` from the source),
    //    then drop in `.nojekyll` and (optionally) `CNAME`.
    copy_dir_recursive(opts.built_dir, tmp)?;

    let nojekyll = tmp.join(".nojekyll");
    fs::File::create(&nojekyll)?;

    if let Some(domain) = opts.cname {
        let mut f = fs::File::create(tmp.join("CNAME"))?;
        f.write_all(domain.as_bytes())?;
    }

    // 4. Stage everything.
    let mut index = repo.index()?;
    index.add_all(["*"].iter(), IndexAddOption::DEFAULT, None)?;
    index.write()?;
    let tree_oid = index.write_tree()?;
    let tree = repo.find_tree(tree_oid)?;

    // 5. Create the orphan commit directly on refs/heads/gh-pages
    //    (no parents → orphan branch, no prior history needed).
    let sig = Signature::now(opts.author_name, opts.author_email)?;
    let commit_oid = repo.commit(
        Some("refs/heads/gh-pages"),
        &sig,
        &sig,
        opts.commit_message,
        &tree,
        &[],
    )?;

    // Move HEAD to the new branch and update the working tree so the
    // repo is in a consistent state (mostly for debuggability).
    repo.set_head("refs/heads/gh-pages")?;
    repo.checkout_head(Some(CheckoutBuilder::new().force()))?;

    // 6. Add origin, wire up token-based HTTPS auth, force-push.
    let mut remote = repo.remote("origin", opts.repo_https_url)?;

    let token = opts.token; // borrowed into the callback below
    let mut callbacks = RemoteCallbacks::new();
    callbacks.credentials(move |_url, _username_from_url, _allowed| {
        // GitHub accepts a PAT or installation token as the password
        // with the literal username "x-access-token" over HTTPS basic.
        Cred::userpass_plaintext("x-access-token", token)
    });

    let mut push_opts = PushOptions::new();
    push_opts.remote_callbacks(callbacks);

    // Leading '+' = force update.
    let refspec = "+refs/heads/gh-pages:refs/heads/gh-pages";
    remote.push(&[refspec], Some(&mut push_opts))?;

    Ok(DeployOutcome {
        commit_sha: commit_oid.to_string(),
        branch: "gh-pages".to_string(),
        pages_url,
    })
}

/// Recursively copy `src` into `dst`, skipping any directory literally
/// named `.git` (we don't want to drag a source repo's history along).
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    if !dst.exists() {
        fs::create_dir_all(dst)?;
    }
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let name = entry.file_name();
        if name == ".git" {
            continue;
        }
        let from = entry.path();
        let to = dst.join(&name);

        if file_type.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if file_type.is_file() {
            if let Some(parent) = to.parent() {
                if !parent.exists() {
                    fs::create_dir_all(parent)?;
                }
            }
            fs::copy(&from, &to)?;
        } else if file_type.is_symlink() {
            // On the platforms we care about for Pages deploys, just
            // dereference and copy the target's bytes — symlinks in a
            // static site bundle are unusual and Pages won't honor them.
            if let Ok(target) = fs::read_link(&from) {
                let resolved = if target.is_absolute() {
                    target
                } else {
                    from.parent().unwrap_or(src).join(target)
                };
                if resolved.is_file() {
                    fs::copy(&resolved, &to)?;
                }
            }
        }
    }
    Ok(())
}

/// Manual temp dir under `std::env::temp_dir()`; name disambiguated by
/// nanoseconds-since-epoch so concurrent deploys don't collide.
fn make_unique_tmpdir() -> std::io::Result<PathBuf> {
    let base = std::env::temp_dir();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id();
    let dir = base.join(format!("lattice-ghpages-{}-{}", pid, nanos));
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Parse `https://github.com/{user}/{repo}` (optionally with `.git`
/// suffix and/or a trailing slash) into `(user, repo)`.
fn parse_github_https_url(url: &str) -> Result<(String, String), PublishError> {
    const PREFIX: &str = "https://github.com/";
    let rest = url
        .strip_prefix(PREFIX)
        .ok_or_else(|| PublishError::InvalidUrl(url.to_string()))?;
    let rest = rest.trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);

    let mut parts = rest.splitn(2, '/');
    let user = parts
        .next()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| PublishError::InvalidUrl(url.to_string()))?;
    let repo = parts
        .next()
        .filter(|s| !s.is_empty() && !s.contains('/'))
        .ok_or_else(|| PublishError::InvalidUrl(url.to_string()))?;

    Ok((user.to_string(), repo.to_string()))
}

// ---------------------------------------------------------------------------
// Tests (URL parsing only — the git2 path requires a live remote).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_https_url_with_dot_git() {
        let (u, r) = parse_github_https_url("https://github.com/alice/site.git").unwrap();
        assert_eq!(u, "alice");
        assert_eq!(r, "site");
    }

    #[test]
    fn parses_https_url_without_dot_git() {
        let (u, r) = parse_github_https_url("https://github.com/alice/site").unwrap();
        assert_eq!(u, "alice");
        assert_eq!(r, "site");
    }

    #[test]
    fn parses_https_url_with_trailing_slash() {
        let (u, r) = parse_github_https_url("https://github.com/alice/site/").unwrap();
        assert_eq!(u, "alice");
        assert_eq!(r, "site");
    }

    #[test]
    fn rejects_non_github_url() {
        assert!(parse_github_https_url("https://gitlab.com/alice/site.git").is_err());
    }

    #[test]
    fn rejects_url_missing_repo() {
        assert!(parse_github_https_url("https://github.com/alice").is_err());
    }
}
