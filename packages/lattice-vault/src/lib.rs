pub mod error;
pub mod types;
pub mod safepath;
pub mod parse;
pub mod vault;
pub mod cache;
pub mod watcher;
pub mod search;

pub use error::{VaultError, Result};
pub use types::*;
pub use vault::Vault;
pub use search::{SearchBackend, SearchConfig, SearchResult, detect_search_backends, search};
