//! OAuth client identifiers, baked in at compile time via env vars.
//!
//! These are PUBLIC identifiers — they're not secrets.  The PKCE
//! `code_verifier` (Drive) and the device-code `device_code` (GitHub)
//! are what prove the request is legit, and neither leaves the user's
//! machine.  Compare to: GitHub CLI ships its own public client id
//! hard-coded in the binary.
//!
//! Dev builds where `LATTICE_*_CLIENT_ID` is missing build fine —
//! the adapter just returns a clear "set this env var to enable"
//! error when the user clicks Connect.

/// GitHub OAuth App client id.  Register at:
///   https://github.com/settings/applications/new
///   - Application name: Lattice
///   - Homepage URL:     https://lattice.dev (or your own)
///   - Authorization callback URL: http://127.0.0.1   (unused for Device Flow)
///   - Enable Device Flow: YES
pub const GITHUB_CLIENT_ID: Option<&str> = option_env!("LATTICE_GITHUB_CLIENT_ID");

/// Google Cloud OAuth 2.0 Client ID (Desktop application type).
/// Register at:  https://console.cloud.google.com/apis/credentials
///   - Application type: Desktop app
///   - Authorised redirect URI: http://127.0.0.1   (any port)
///   - Enable APIs: Google Drive API
pub const GOOGLE_CLIENT_ID: Option<&str> = option_env!("LATTICE_GOOGLE_CLIENT_ID");

/// Google for installed apps PKCE: client secret is OPTIONAL when the
/// app is registered as "Desktop" type and PKCE is used.  However,
/// Google's `oauth2.googleapis.com/token` endpoint will accept a
/// secret if supplied, and won't accept an empty secret if the client
/// is configured to require one.  We treat it as optional: if the env
/// var is set we send it, otherwise we send the PKCE verifier only.
pub const GOOGLE_CLIENT_SECRET: Option<&str> = option_env!("LATTICE_GOOGLE_CLIENT_SECRET");
