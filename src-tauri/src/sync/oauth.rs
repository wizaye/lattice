//! PKCE helpers + loopback redirect server used by the Google
//! Drive adapter (and any future PKCE-style provider).
//!
//! Why hand-roll the redirect server?  Pulling in axum/hyper for a
//! single GET response would add ~200 transitive crates.  The
//! handler here only needs to read one request line, write one
//! response, and drop the socket.

use std::time::Duration;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::Rng;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::time::timeout;

use super::error::SyncError;

/// 64 random bytes → 86-char base64url string.  Well within the
/// 43-128 char range RFC 7636 requires for the PKCE code_verifier.
pub fn random_verifier() -> String {
    let mut buf = [0u8; 64];
    rand::thread_rng().fill(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

/// S256 challenge: base64url(sha256(verifier)).  No padding.
pub fn s256_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

/// 32-byte CSRF nonce, base64url.  Caller includes in the
/// authorize URL `state=` param and verifies on callback.
pub fn random_state() -> String {
    let mut buf = [0u8; 32];
    rand::thread_rng().fill(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

pub struct LoopbackCallback {
    pub code: String,
    pub state: String,
}

/// Start a one-shot HTTP listener on 127.0.0.1:<kernel-assigned port>.
/// Returns `(port, receiver)` immediately.  The caller is responsible
/// for opening the authorize URL in the user's browser; once the
/// browser redirects back to `http://127.0.0.1:<port>/...?code=...&state=...`,
/// the receiver resolves with the parsed callback.
///
/// The server times out after `ttl` and the receiver resolves with
/// [`SyncError::Oauth`] on parse failure or timeout.
pub async fn loopback_listen(
    ttl: Duration,
) -> Result<(u16, oneshot::Receiver<Result<LoopbackCallback, SyncError>>), SyncError> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| SyncError::Oauth(format!("could not bind loopback socket: {e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| SyncError::Oauth(format!("could not read loopback port: {e}")))?
        .port();

    let (tx, rx) = oneshot::channel();

    tokio::spawn(async move {
        let result = timeout(ttl, async {
            let (mut sock, _addr) = listener
                .accept()
                .await
                .map_err(|e| SyncError::Oauth(format!("accept failed: {e}")))?;

            // Read up to 16KB of the request — far more than the
            // ~300 bytes a real callback needs.  We bail as soon as
            // we see `\r\n` so we don't block on a long body.
            let mut buf = vec![0u8; 16 * 1024];
            let mut total = 0usize;
            let request_line = loop {
                let n = sock
                    .read(&mut buf[total..])
                    .await
                    .map_err(|e| SyncError::Oauth(format!("read failed: {e}")))?;
                if n == 0 {
                    return Err(SyncError::Oauth("client closed before sending request".into()));
                }
                total += n;
                if let Some(end) = buf[..total].windows(2).position(|w| w == b"\r\n") {
                    break String::from_utf8_lossy(&buf[..end]).to_string();
                }
                if total == buf.len() {
                    return Err(SyncError::Oauth("request line too long".into()));
                }
            };

            // Parse "GET /?code=...&state=... HTTP/1.1"
            let mut parts = request_line.split_whitespace();
            let _method = parts.next();
            let path = parts
                .next()
                .ok_or_else(|| SyncError::Oauth("malformed request line".into()))?;
            let query = path.splitn(2, '?').nth(1).unwrap_or("");

            let mut code: Option<String> = None;
            let mut state: Option<String> = None;
            let mut error: Option<String> = None;
            for pair in query.split('&') {
                let mut kv = pair.splitn(2, '=');
                let k = kv.next().unwrap_or("");
                let v = kv.next().unwrap_or("");
                let v_decoded = urlencoding::decode(v)
                    .map(|c| c.into_owned())
                    .unwrap_or_else(|_| v.to_string());
                match k {
                    "code" => code = Some(v_decoded),
                    "state" => state = Some(v_decoded),
                    "error" => error = Some(v_decoded),
                    _ => {}
                }
            }

            // Always reply with a polite HTML page so the user's
            // browser doesn't show a "connection refused" or raw
            // JSON blob.
            let body = if error.is_some() {
                "<html><body style='font-family:system-ui;padding:32px'>\
                <h2>Authorisation failed</h2>\
                <p>You can close this tab and return to Lattice.</p>\
                </body></html>"
            } else {
                "<html><body style='font-family:system-ui;padding:32px'>\
                <h2>Lattice is connected.</h2>\
                <p>You can close this tab.</p>\
                </body></html>"
            };
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
                 Content-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = sock.write_all(response.as_bytes()).await;
            let _ = sock.shutdown().await;

            if let Some(err) = error {
                return Err(SyncError::Oauth(format!("provider returned error: {err}")));
            }
            match (code, state) {
                (Some(code), Some(state)) => Ok(LoopbackCallback { code, state }),
                _ => Err(SyncError::Oauth(
                    "callback missing code or state".into(),
                )),
            }
        })
        .await;

        let result = match result {
            Ok(inner) => inner,
            Err(_) => Err(SyncError::Oauth(format!(
                "loopback callback timed out after {}s",
                ttl.as_secs()
            ))),
        };
        let _ = tx.send(result);
    });

    Ok((port, rx))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn s256_matches_rfc7636_appendix_b() {
        // RFC 7636 Appendix B test vector.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let challenge = s256_challenge(verifier);
        assert_eq!(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn verifier_length_in_range() {
        let v = random_verifier();
        assert!(v.len() >= 43);
        assert!(v.len() <= 128);
    }

    #[test]
    fn state_is_nonempty_url_safe() {
        let s = random_state();
        assert!(!s.is_empty());
        assert!(s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }
}
