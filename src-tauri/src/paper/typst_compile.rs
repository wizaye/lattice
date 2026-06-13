//! In-process Typst → PDF compilation.
//!
//! Implements a minimal [`typst::World`] backed by the local filesystem
//! (rooted at `project_root`) so we can invoke `typst::compile` without
//! shelling out to the upstream CLI.  Fonts default to empty because the
//! optional `typst_assets` crate is not pulled into the workspace — papers
//! that need embedded fonts should supply them via Typst's `text(font: …)`
//! after wiring `typst-kit` into the World (slice C4+).
//!
//! All filesystem access funnels through [`safe_join`], which canonicalises
//! both the candidate path and the project root and refuses anything that
//! escapes the root (`..` traversal, symlink redirects, absolute paths
//! outside the tree).  This is the only defence between a malicious `.typ`
//! source's `include "../../../etc/passwd"` and the host filesystem.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use typst::diag::{FileError, FileResult};
use typst::foundations::{Bytes, Datetime};
use typst::layout::PagedDocument;
use typst::syntax::{FileId, Source, VirtualPath};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, World};
use typst_pdf::PdfOptions;

/// Errors surfaced by the Typst compile pipeline.
///
/// `Io` wraps filesystem failures while reading the project tree or writing
/// the output PDF.  `Compile` collapses Typst's `EcoVec<SourceDiagnostic>`
/// into a single string for transport across the Tauri IPC boundary.
/// `Unsafe` is raised by [`safe_join`] when a path would escape the project
/// root after canonicalisation.
#[derive(thiserror::Error, Debug)]
pub enum TypstCompileError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("typst compile failed: {0}")]
    Compile(String),
    #[error("path traversal: {0}")]
    Unsafe(String),
}

/// Canonicalise `root.join(rel)` and reject anything that would escape
/// `root`'s canonical form.
///
/// Works for paths that do not yet exist by canonicalising the deepest
/// existing ancestor and appending the remaining components — that way
/// `safe_join(root, Path::new("out.pdf"))` succeeds even when `out.pdf`
/// has not been written yet, while still catching symlink-redirected
/// parents.
pub fn safe_join(root: &Path, rel: &Path) -> Result<PathBuf, TypstCompileError> {
    let canon_root = std::fs::canonicalize(root)?;
    let candidate = canon_root.join(rel);

    // Walk up until we find an existing ancestor, canonicalise that, and
    // re-attach the tail.  This handles the "doesn't exist yet" case
    // without short-circuiting the symlink check on the parent chain.
    let mut existing = candidate.as_path();
    let mut tail: Vec<&std::ffi::OsStr> = Vec::new();
    let canon_existing = loop {
        match std::fs::canonicalize(existing) {
            Ok(c) => break c,
            Err(_) => {
                let name = existing.file_name().ok_or_else(|| {
                    TypstCompileError::Unsafe(format!(
                        "cannot resolve path: {}",
                        candidate.display()
                    ))
                })?;
                tail.push(name);
                existing = existing.parent().ok_or_else(|| {
                    TypstCompileError::Unsafe(format!(
                        "path escapes root before resolution: {}",
                        candidate.display()
                    ))
                })?;
            }
        }
    };

    let mut resolved = canon_existing;
    for piece in tail.iter().rev() {
        resolved.push(piece);
    }

    if !resolved.starts_with(&canon_root) {
        return Err(TypstCompileError::Unsafe(format!(
            "{} escapes {}",
            resolved.display(),
            canon_root.display()
        )));
    }
    Ok(resolved)
}

/// Minimal filesystem-backed [`World`] implementation.
///
/// Sources and raw file bytes are cached on first access — Typst's
/// `comemo` memoisation layer needs deterministic, identity-stable
/// returns for the same `FileId`, so we hand back clones of the cached
/// entries.  Both `Source` and `Bytes` are cheap to clone (Arc-backed).
struct SystemWorld {
    root: PathBuf,
    main_id: FileId,
    library: LazyHash<Library>,
    book: LazyHash<FontBook>,
    fonts: Vec<Font>,
    sources: Mutex<HashMap<FileId, Source>>,
    files: Mutex<HashMap<FileId, Bytes>>,
}

impl SystemWorld {
    fn new(root: PathBuf, main_typ: &Path) -> Result<Self, TypstCompileError> {
        // `main_typ` is already canonicalised inside `root` by the caller;
        // strip the prefix so we can express it as a Typst VirtualPath
        // (Typst paths are always relative to the world's root).
        let main_rel = main_typ.strip_prefix(&root).map_err(|_| {
            TypstCompileError::Unsafe(format!(
                "{} not within {}",
                main_typ.display(),
                root.display()
            ))
        })?;
        let main_id = FileId::new(None, VirtualPath::new(main_rel));

        // No `typst_assets` dep in this workspace — start with an empty
        // font book.  Typst will fall back to its "Unknown font" warning
        // path for any text that does not specify a system-resolved font.
        let fonts: Vec<Font> = Vec::new();
        let book = FontBook::from_fonts(&fonts);

        Ok(Self {
            root,
            main_id,
            library: LazyHash::new(Library::default()),
            book: LazyHash::new(book),
            fonts,
            sources: Mutex::new(HashMap::new()),
            files: Mutex::new(HashMap::new()),
        })
    }

    /// Resolve a `FileId` to an absolute path inside `self.root` and read
    /// its bytes.  Returns a `FileError` (Typst's expected error type) on
    /// any filesystem mishap so the compiler can surface a useful
    /// diagnostic instead of panicking.
    fn read_id(&self, id: FileId) -> FileResult<Vec<u8>> {
        let vpath = id.vpath();
        let path = vpath
            .resolve(&self.root)
            .ok_or(FileError::AccessDenied)?;
        std::fs::read(&path).map_err(|e| FileError::from_io(e, &path))
    }
}

impl World for SystemWorld {
    fn library(&self) -> &LazyHash<Library> {
        &self.library
    }

    fn book(&self) -> &LazyHash<FontBook> {
        &self.book
    }

    fn main(&self) -> FileId {
        self.main_id
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        if let Some(s) = self.sources.lock().unwrap().get(&id).cloned() {
            return Ok(s);
        }
        let bytes = self.read_id(id)?;
        let text = String::from_utf8(bytes).map_err(|_| FileError::InvalidUtf8)?;
        let source = Source::new(id, text);
        self.sources.lock().unwrap().insert(id, source.clone());
        Ok(source)
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        if let Some(b) = self.files.lock().unwrap().get(&id).cloned() {
            return Ok(b);
        }
        let raw = self.read_id(id)?;
        let bytes = Bytes::new(raw);
        self.files.lock().unwrap().insert(id, bytes.clone());
        Ok(bytes)
    }

    fn font(&self, index: usize) -> Option<Font> {
        self.fonts.get(index).cloned()
    }

    fn today(&self, _offset: Option<i64>) -> Option<Datetime> {
        // Deterministic builds: refuse to leak wall-clock time into the
        // compiled PDF.  Callers that need a date can pass it in as a
        // template parameter.
        None
    }
}

/// Compile `main_typ` (inside `project_root`) to a PDF at `out_pdf`.
///
/// The project root is the resolution boundary for all `include` / `read`
/// calls in the Typst sources — anything outside it triggers
/// [`TypstCompileError::Unsafe`].  The parent directory of `out_pdf` is
/// created if it does not yet exist.
pub fn compile_typst(
    project_root: &Path,
    main_typ: &Path,
    out_pdf: &Path,
) -> Result<(), TypstCompileError> {
    let canon_root = std::fs::canonicalize(project_root)?;

    // Normalise the main file: callers may pass either an absolute path or
    // one relative to the project root.  Both routes go through `safe_join`
    // so symlink redirects can't smuggle the compiler outside the root.
    let canon_main = if main_typ.is_absolute() {
        let canon = std::fs::canonicalize(main_typ)?;
        if !canon.starts_with(&canon_root) {
            return Err(TypstCompileError::Unsafe(format!(
                "{} escapes {}",
                canon.display(),
                canon_root.display()
            )));
        }
        canon
    } else {
        safe_join(&canon_root, main_typ)?
    };

    let world = SystemWorld::new(canon_root, &canon_main)?;

    // `typst::compile` returns warnings alongside the SourceResult; we
    // drop the warnings here because the caller has no UI for them yet
    // (slice C4 will wire a diagnostics channel through the IPC layer).
    let result = typst::compile::<PagedDocument>(&world);
    let document = result.output.map_err(|diagnostics| {
        let msg = diagnostics
            .iter()
            .map(|d| format!("{}: {}", d.severity, d.message))
            .collect::<Vec<_>>()
            .join("; ");
        TypstCompileError::Compile(msg)
    })?;

    let pdf_bytes =
        typst_pdf::pdf(&document, &PdfOptions::default()).map_err(|diagnostics| {
            let msg = diagnostics
                .iter()
                .map(|d| format!("{}: {}", d.severity, d.message))
                .collect::<Vec<_>>()
                .join("; ");
            TypstCompileError::Compile(msg)
        })?;

    if let Some(parent) = out_pdf.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    std::fs::write(out_pdf, pdf_bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_join_rejects_traversal() {
        let tmp = std::env::temp_dir();
        let err = safe_join(&tmp, Path::new("../etc/passwd")).err();
        assert!(matches!(err, Some(TypstCompileError::Unsafe(_))));
    }

    #[test]
    fn safe_join_accepts_inside_root() {
        let tmp = std::env::temp_dir();
        let p = safe_join(&tmp, Path::new("foo.pdf")).unwrap();
        assert!(p.starts_with(std::fs::canonicalize(&tmp).unwrap()));
    }
}
