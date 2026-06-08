//! Local preview server for built Quartz sites.
//!
//! Spawns a [`tiny_http::Server`] bound to `127.0.0.1:<random>` and
//! serves the contents of `<quartz>/public/` as a regular static
//! website.  One server per vault — starting a second preview for the
//! same vault tears down the first to avoid port leaks.
//!
//! ### Why `tiny_http` and not `axum`?
//!
//! The preview server is a one-purpose, loopback-only static file
//! server.  `axum`/`hyper` would pull in `tokio`, `tower`, `h2`,
//! `tower-http` — easily 80+ transitive crates and a 1.5 MB binary
//! bump.  `tiny_http` is ~600 LoC of synchronous code, no runtime
//! needed, and bind-to-port-0 lets the kernel pick a free port so we
//! can run many vault previews in parallel.
//!
//! ### Security posture
//!
//! - Always bound to `127.0.0.1` — `tiny_http::Server::http("127.0.0.1:0")`
//!   refuses to listen on any other interface, so a preview server
//!   cannot be reached from the network even on a misconfigured firewall.
//! - Paths are resolved against the canonicalised `public/` root and
//!   rejected if they escape it (the classic `..` traversal block).
//! - Only `GET` / `HEAD` are honoured; everything else returns 405.
//!
//! ### Lifecycle
//!
//! The [`REGISTRY`] global holds one [`PreviewHandle`] per active
//! vault.  Starting a preview drops the previous handle (which causes
//! the serve thread to observe `recv_timeout` returning an error and
//! exit cleanly).  Stopping a preview drops the entry — same shutdown
//! path.  Both operations are idempotent.

use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::Duration;

use tiny_http::{Header, Method, Response, Server, StatusCode};

/// A live preview server keyed by absolute vault root path.
struct PreviewHandle {
    /// `Arc` so the serve loop can hold a clone while the main
    /// registry holds the original.  Dropping both stops the server.
    server: Arc<Server>,
    /// Joined when the handle drops; the thread observes the dropped
    /// `Arc<Server>` via `recv_timeout` and exits.
    thread: Option<JoinHandle<()>>,
    /// `http://127.0.0.1:<port>/` form, returned to the UI.
    url: String,
}

impl Drop for PreviewHandle {
    fn drop(&mut self) {
        // tiny_http's recommended shutdown is to drop all references
        // to the server — `unblock()` then wakes any pending
        // `incoming_requests` call.  We additionally call `unblock`
        // here for paranoia in case our thread is parked on `recv`.
        self.server.unblock();
        if let Some(t) = self.thread.take() {
            // Wait briefly so the thread releases the port before
            // a follow-up start_preview tries to bind it.  A short
            // join is safe — the serve loop exits as soon as it
            // observes the unblock.
            let _ = t.join();
        }
    }
}

fn registry() -> &'static Mutex<HashMap<PathBuf, PreviewHandle>> {
    static R: OnceLock<Mutex<HashMap<PathBuf, PreviewHandle>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Start (or restart) a preview server for `vault_root`, serving
/// `public_dir`.  Returns the URL the UI should open.
///
/// `vault_root` is used only as the registry key — it doesn't have to
/// be the parent of `public_dir`.  `public_dir` IS the document root
/// and MUST be an existing directory.
pub fn start(vault_root: &Path, public_dir: &Path) -> Result<String, String> {
    let public = public_dir
        .canonicalize()
        .map_err(|e| format!("preview: cannot resolve {}: {}", public_dir.display(), e))?;
    if !public.is_dir() {
        return Err(format!(
            "preview: public directory does not exist: {}",
            public.display()
        ));
    }

    // Drop any prior handle for this vault BEFORE binding the new
    // port — Drop runs the unblock + join above, releasing the
    // previous port.
    {
        let mut map = registry().lock().map_err(|_| "preview registry poisoned")?;
        map.remove(vault_root);
    }

    // Bind on port 0 so the kernel hands us a free ephemeral port.
    let server = Server::http("127.0.0.1:0")
        .map_err(|e| format!("preview: failed to bind 127.0.0.1: {e}"))?;
    let port = server
        .server_addr()
        .to_ip()
        .ok_or_else(|| "preview: server address not an IP".to_string())?
        .port();
    let url = format!("http://127.0.0.1:{port}/");

    let server = Arc::new(server);
    let serve_server = Arc::clone(&server);
    let serve_root = public.clone();
    let thread = std::thread::Builder::new()
        .name(format!("lattice-preview-{port}"))
        .spawn(move || serve_loop(serve_server, serve_root))
        .map_err(|e| format!("preview: failed to spawn serve thread: {e}"))?;

    let handle = PreviewHandle {
        server,
        thread: Some(thread),
        url: url.clone(),
    };

    let mut map = registry().lock().map_err(|_| "preview registry poisoned")?;
    map.insert(vault_root.to_path_buf(), handle);
    Ok(url)
}

/// Stop the preview server for `vault_root`.  Idempotent — returning
/// `Ok(())` even when there was no active server.
pub fn stop(vault_root: &Path) -> Result<(), String> {
    let mut map = registry().lock().map_err(|_| "preview registry poisoned")?;
    // Drop runs the unblock + join.
    drop(map.remove(vault_root));
    Ok(())
}

/// Look up the URL of an active preview without starting one.  Used
/// by [`super::publish_status`] in a follow-up patch; left here so the
/// API surface is complete.
#[allow(dead_code)]
pub fn url_for(vault_root: &Path) -> Option<String> {
    let map = registry().lock().ok()?;
    map.get(vault_root).map(|h| h.url.clone())
}

/// Block on `incoming_requests`, dispatch each to [`handle_request`].
/// Exits cleanly when the server's last `Arc` drops (which happens
/// when [`stop`] removes the handle).
fn serve_loop(server: Arc<Server>, root: PathBuf) {
    // `recv_timeout` lets us poll for shutdown via the dropped Arc.
    // When the registry releases its handle, only this thread holds an
    // Arc; we still need the loop to wake up so the thread exits.
    // tiny_http's `unblock()` wakes a blocked recv; if we time out we
    // also check whether we're the last reference and exit.
    loop {
        match server.recv_timeout(Duration::from_secs(2)) {
            Ok(Some(req)) => {
                let _ = handle_request(req, &root);
            }
            Ok(None) => {
                // Timeout — check whether we're the last Arc.  If so,
                // the registry has dropped us and we should exit.
                if Arc::strong_count(&server) == 1 {
                    break;
                }
            }
            Err(_) => {
                // Server is shutting down (incoming socket closed).
                break;
            }
        }
    }
}

fn handle_request(req: tiny_http::Request, root: &Path) -> std::io::Result<()> {
    // Method gate — only static GETs/HEADs.
    match req.method() {
        Method::Get | Method::Head => {}
        _ => {
            return req.respond(
                Response::from_string("Method Not Allowed").with_status_code(StatusCode(405)),
            );
        }
    }

    // Path → on-disk file.  tiny_http already URL-decoded the path
    // for us; we still need to strip the leading `/` and resolve `..`
    // safely.
    let raw_path = req.url();
    let stripped = raw_path.split('?').next().unwrap_or("");
    let stripped = stripped.split('#').next().unwrap_or("");
    let target = match resolve_target(root, stripped) {
        Ok(p) => p,
        Err(_) => {
            return req.respond(
                Response::from_string("Forbidden").with_status_code(StatusCode(403)),
            );
        }
    };

    if !target.exists() {
        return req.respond(
            Response::from_string("Not Found").with_status_code(StatusCode(404)),
        );
    }

    // Directory → serve index.html if present.
    let file_path = if target.is_dir() {
        target.join("index.html")
    } else {
        target
    };

    if !file_path.is_file() {
        return req.respond(
            Response::from_string("Not Found").with_status_code(StatusCode(404)),
        );
    }

    // Sniff Content-Type from extension.
    let mime = mime_guess::from_path(&file_path)
        .first_or_octet_stream()
        .to_string();

    let mut file = File::open(&file_path)?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)?;
    let len = buf.len();

    let response = Response::from_data(buf).with_header(
        Header::from_bytes(&b"Content-Type"[..], mime.as_bytes()).unwrap(),
    );
    // Cache-Control: no-store so the user sees fresh content after a
    // rebuild without manually shift-reloading.
    let response = response.with_header(
        Header::from_bytes(&b"Cache-Control"[..], &b"no-store"[..]).unwrap(),
    );
    let response = response.with_header(
        Header::from_bytes(&b"Content-Length"[..], len.to_string().as_bytes()).unwrap(),
    );

    req.respond(response)
}

/// Resolve a URL path against the public root, rejecting anything that
/// would escape via `..` or absolute components.  Returns
/// `Err(())` for traversal attempts.
fn resolve_target(root: &Path, url_path: &str) -> Result<PathBuf, ()> {
    let trimmed = url_path.trim_start_matches('/');
    // Empty / "/" → serve the root directory.
    if trimmed.is_empty() {
        return Ok(root.to_path_buf());
    }
    let mut out = root.to_path_buf();
    for comp in Path::new(trimmed).components() {
        match comp {
            Component::Normal(s) => out.push(s),
            // Reject anything that could escape the root.  We don't
            // try to be clever about resolving `..` because Quartz's
            // own URLs never use it; if we see one it's a probe.
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return Err(()),
            Component::CurDir => {}
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn make_public(tmp: &Path) {
        std::fs::write(tmp.join("index.html"), "<h1>hello</h1>").unwrap();
        std::fs::create_dir_all(tmp.join("sub")).unwrap();
        std::fs::write(tmp.join("sub/page.html"), "<h2>sub</h2>").unwrap();
        let mut f = std::fs::File::create(tmp.join("logo.svg")).unwrap();
        writeln!(f, "<svg></svg>").unwrap();
    }

    #[test]
    fn resolve_target_handles_root_and_subpaths() {
        let r = PathBuf::from("/srv/public");
        assert_eq!(resolve_target(&r, "/").unwrap(), r);
        assert_eq!(
            resolve_target(&r, "/sub/page.html").unwrap(),
            r.join("sub").join("page.html")
        );
    }

    #[test]
    fn resolve_target_rejects_dotdot_traversal() {
        let r = PathBuf::from("/srv/public");
        assert!(resolve_target(&r, "/../etc/passwd").is_err());
        assert!(resolve_target(&r, "/sub/../../etc").is_err());
    }

    #[test]
    fn start_and_stop_serves_index_html() {
        // Skip when the loopback bind fails (sandboxed test runners).
        let tmp = tempdir_or_skip();
        let Some(tmp) = tmp else { return; };

        let vault = tmp.path().to_path_buf();
        let public = vault.join("public");
        std::fs::create_dir_all(&public).unwrap();
        make_public(&public);

        let url = match start(&vault, &public) {
            Ok(u) => u,
            Err(e) if e.contains("bind") => {
                eprintln!("skipping: cannot bind loopback in this env: {e}");
                return;
            }
            Err(e) => panic!("start failed: {e}"),
        };

        // Make a real HTTP GET via std::net to avoid pulling reqwest.
        let body = http_get(&url);
        assert!(body.contains("hello"), "expected index body, got: {body}");

        let sub = http_get(&format!("{url}sub/page.html"));
        assert!(sub.contains("sub"), "expected sub body, got: {sub}");

        let missing = http_get_status(&format!("{url}does-not-exist.html"));
        assert_eq!(missing, 404);

        let forbidden = http_get_status(&format!("{url}../etc/passwd"));
        // Note: many HTTP clients normalise `..` before sending; if
        // our request never reaches the server with `..` we'll get
        // 404 rather than 403.  Either is acceptable evidence the
        // traversal is blocked.
        assert!(matches!(forbidden, 403 | 404));

        // Cleanup.
        stop(&vault).unwrap();
    }

    /// Tiny dependency-free HTTP/1.0 GET (body-only).
    fn http_get(url: &str) -> String {
        let resp = http_raw(url);
        if let Some(idx) = resp.find("\r\n\r\n") {
            resp[idx + 4..].to_string()
        } else {
            resp
        }
    }

    fn http_get_status(url: &str) -> u16 {
        let resp = http_raw(url);
        let first = resp.lines().next().unwrap_or("");
        first
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse().ok())
            .unwrap_or(0)
    }

    /// Raw HTTP/1.0 request → raw response string, with hard 5s socket
    /// timeouts so a misbehaving server can't hang the test runner.
    fn http_raw(url: &str) -> String {
        let (host, port, path) = parse_url(url);
        use std::io::{Read, Write};
        let mut sock = std::net::TcpStream::connect((host.as_str(), port)).unwrap();
        sock.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        sock.set_write_timeout(Some(Duration::from_secs(5))).unwrap();
        write!(
            sock,
            "GET {path} HTTP/1.0\r\nHost: {host}\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
        // Drain manually so a half-closed peer cannot block us forever.
        let mut buf = [0u8; 4096];
        let mut out = Vec::with_capacity(4096);
        loop {
            match sock.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => out.extend_from_slice(&buf[..n]),
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut => break,
                Err(e) => panic!("socket read failed: {e}"),
            }
            // Hard cap so a runaway server cannot OOM us.
            if out.len() > 256 * 1024 {
                break;
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    }

    fn parse_url(url: &str) -> (String, u16, String) {
        // "http://127.0.0.1:54321/sub/page.html"
        let after_scheme = url.strip_prefix("http://").unwrap();
        let (host_port, path) = after_scheme.split_once('/').unwrap_or((after_scheme, ""));
        let (host, port) = host_port.split_once(':').unwrap_or(("127.0.0.1", "80"));
        (host.to_string(), port.parse().unwrap(), format!("/{path}"))
    }

    /// `tempfile` isn't in our dep list; mint a tmpdir under the OS
    /// temp root and return its handle (cleaned up on drop).
    fn tempdir_or_skip() -> Option<TempDir> {
        let base = std::env::temp_dir();
        let name = format!("lattice-preview-test-{}", std::process::id());
        let path = base.join(name);
        std::fs::create_dir_all(&path).ok()?;
        Some(TempDir { path })
    }

    struct TempDir {
        path: PathBuf,
    }
    impl TempDir {
        fn path(&self) -> &Path {
            &self.path
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}
