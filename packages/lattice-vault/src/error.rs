use thiserror::Error;

#[derive(Error, Debug)]
pub enum VaultError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Path traversal attempt: {0}")]
    PathTraversal(String),

    #[error("Invalid vault structure: {0}")]
    InvalidStructure(String),

    #[error("Note not found: {0}")]
    NoteNotFound(String),

    #[error("Parse error: {0}")]
    ParseError(String),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Watcher error: {0}")]
    Watcher(String),
}

pub type Result<T> = std::result::Result<T, VaultError>;
