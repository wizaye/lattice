//! Overleaf-ready zip bundle for `paper_emit_bundle`.
//!
//! Produces a flat zip that drops cleanly into Overleaf's "New Project
//! → Upload Project" dialog.  Layout:
//!
//! ```text
//! <paper-slug>-overleaf.zip
//! ├── main.tex            ← assembled from the same compile pipeline
//! │                          (single source of truth via
//! │                          `compile::assemble_body` + `compile::wrap_in_template`)
//! ├── references.bib      ← copied verbatim if present in the paper folder
//! ├── README.txt          ← upload-to-Overleaf instructions for the user
//! └── assets/             ← all non-source files from the paper folder
//!     ├── figure-1.png    (images, PDFs the user may have referenced)
//!     └── ...
//! ```
//!
//! Design decisions:
//!
//! 1. **Same `main.tex` as local compile.**  We deliberately do NOT
//!    reimplement the assembly here; we call into `compile::assemble_body`
//!    + `compile::wrap_in_template` so the Overleaf-cloud render matches
//!    the local `tectonic` render byte-for-byte (modulo TeX-Live
//!    version drift on Overleaf's side, which we can't control).  This
//!    also means template changes propagate to both paths automatically.
//!
//! 2. **No `\input` chain.**  Overleaf imports work best with one
//!    self-contained `main.tex`; multi-file `\input{sections/01-...}`
//!    imports break when Overleaf's project explorer doesn't reflect
//!    the directory we ship.  Inlining the section bodies into one
//!    file is dumber but more robust.
//!
//! 3. **`build/` excluded.**  We're writing the zip INTO `<paper>/build/`,
//!    and zipping while traversing would either deadlock or include
//!    stale `main.pdf`/`main.tex` from the previous compile.  Skip the
//!    whole `build/` subtree at copy time.
//!
//! 4. **Pure `deflate`, no bzip2.**  Cargo dep features are configured
//!    to use only the pure-Rust `flate2` backend so the build doesn't
//!    pull in a C compiler.  Overleaf accepts deflate (the only
//!    compression most static tools support anyway).

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use walkdir::WalkDir;
use zip::write::SimpleFileOptions;
use zip::CompressionMethod;

use super::compile;
use super::toml::PaperToml;

/// Source-file extensions that already live INSIDE `main.tex` via the
/// assembly step — emitting them again as siblings would just confuse
/// Overleaf's project explorer.
const SKIP_EXTENSIONS: &[&str] = &["md", "toml"];

/// Names that should NEVER ship in the bundle regardless of extension.
const SKIP_FILENAMES: &[&str] = &[".DS_Store", "Thumbs.db"];

/// Top-level folder names to exclude from the zip (matched on the
/// first path component relative to the paper root).
const SKIP_TOP_DIRS: &[&str] = &[".lattice", "build", ".git", "node_modules"];

/// Build an Overleaf-ready zip for `paper_abs` and write it to
/// `<paper_abs>/build/<slug>-overleaf.zip`.
///
/// Returns the absolute path to the zip on success.
pub fn emit_bundle(paper_abs: &Path) -> Result<PathBuf, String> {
    let cfg = PaperToml::load(&paper_abs.join(".lattice").join("paper.toml"))?;

    // Make sure build/ exists — that's where we drop the zip.
    let build_dir = paper_abs.join("build");
    std::fs::create_dir_all(&build_dir)
        .map_err(|e| format!("failed to create build dir: {e}"))?;

    // Assemble the single self-contained main.tex using the SAME code
    // path as `compile()` — guarantees the cloud-render matches the
    // local-render.
    let body = compile::assemble_body(paper_abs)?;
    let main_tex = compile::wrap_in_template(&cfg, &body);

    // Zip target path: <paper>/build/<slug>-overleaf.zip
    let slug = slugify_for_zip(&cfg.meta.title);
    let zip_path = build_dir.join(format!("{slug}-overleaf.zip"));

    // Stream the zip to a temp file first, then atomically rename — so
    // a previous Open-PDF reader holding the old zip doesn't corrupt
    // the new one mid-write.
    let tmp_path = build_dir.join(format!(".{slug}-overleaf.zip.tmp"));
    {
        let tmp_file = File::create(&tmp_path).map_err(|e| {
            format!("failed to create {}: {}", tmp_path.display(), e)
        })?;
        let mut zw = zip::ZipWriter::new(tmp_file);
        let opts = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o644);

        // 1. main.tex (the heart of the bundle).
        write_zip_string(&mut zw, "main.tex", &main_tex, opts)?;

        // 2. README.txt — Overleaf upload instructions for the user.
        write_zip_string(&mut zw, "README.txt", &readme_body(&cfg.meta.title), opts)?;

        // 3. references.bib — copy verbatim if the user has one.
        let refs = paper_abs.join("references.bib");
        if refs.is_file() {
            write_zip_path(&mut zw, "references.bib", &refs, opts)?;
        }
        // Some templates use bibliography.bib instead.
        let refs2 = paper_abs.join("bibliography.bib");
        if refs2.is_file() && !refs.is_file() {
            write_zip_path(&mut zw, "references.bib", &refs2, opts)?;
        }

        // 4. assets/ — every non-source, non-skip file under paper_abs
        //              (excluding .lattice/, build/, .git/, node_modules/).
        bundle_assets(&mut zw, paper_abs, opts)?;

        zw.finish().map_err(|e| format!("failed to finalise zip: {e}"))?;
    }

    // Atomic rename — on Windows this requires the destination to NOT
    // exist; remove first if present.
    if zip_path.exists() {
        let _ = std::fs::remove_file(&zip_path);
    }
    std::fs::rename(&tmp_path, &zip_path).map_err(|e| {
        format!(
            "failed to rename {} to {}: {}",
            tmp_path.display(),
            zip_path.display(),
            e
        )
    })?;

    Ok(zip_path)
}

/// Write a string `body` as a file `name` into `zw`.
fn write_zip_string<W: Write + std::io::Seek>(
    zw: &mut zip::ZipWriter<W>,
    name: &str,
    body: &str,
    opts: SimpleFileOptions,
) -> Result<(), String> {
    zw.start_file(name, opts)
        .map_err(|e| format!("failed to start zip entry {name}: {e}"))?;
    zw.write_all(body.as_bytes())
        .map_err(|e| format!("failed to write zip entry {name}: {e}"))?;
    Ok(())
}

/// Stream the contents of `src` into the zip as `name`.
fn write_zip_path<W: Write + std::io::Seek>(
    zw: &mut zip::ZipWriter<W>,
    name: &str,
    src: &Path,
    opts: SimpleFileOptions,
) -> Result<(), String> {
    zw.start_file(name, opts)
        .map_err(|e| format!("failed to start zip entry {name}: {e}"))?;
    let mut f = File::open(src)
        .map_err(|e| format!("failed to open {}: {}", src.display(), e))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)
        .map_err(|e| format!("failed to read {}: {}", src.display(), e))?;
    zw.write_all(&buf)
        .map_err(|e| format!("failed to write zip entry {name}: {e}"))?;
    Ok(())
}

/// Walk `paper_abs` and emit every binary asset (images, PDFs, etc.)
/// into `assets/` inside the zip.  Skips source markdown, paper.toml,
/// `.lattice/`, `build/`, `.git/`, `node_modules/`, OS junk files.
fn bundle_assets<W: Write + std::io::Seek>(
    zw: &mut zip::ZipWriter<W>,
    paper_abs: &Path,
    opts: SimpleFileOptions,
) -> Result<(), String> {
    for entry in WalkDir::new(paper_abs)
        .min_depth(1)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !is_skipped_dir(e.path(), paper_abs))
    {
        let entry = entry
            .map_err(|e| format!("walkdir error under {}: {}", paper_abs.display(), e))?;
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();

        // Skip OS junk by name.
        if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
            if SKIP_FILENAMES.contains(&name) {
                continue;
            }
        }

        // Skip source extensions (markdown / toml are inlined into main.tex,
        // bib is copied to root).
        if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
            let lower = ext.to_ascii_lowercase();
            if SKIP_EXTENSIONS.contains(&lower.as_str()) {
                continue;
            }
            // references.bib + bibliography.bib are handled separately
            // (copied to the zip root, not assets/).
            if lower == "bib" {
                continue;
            }
        }

        // Relative path under paper_abs, with forward slashes (zip spec).
        let rel = path
            .strip_prefix(paper_abs)
            .map_err(|e| format!("strip_prefix failed for {}: {}", path.display(), e))?;
        let rel_str = rel
            .to_str()
            .ok_or_else(|| format!("non-UTF8 path: {}", path.display()))?
            .replace('\\', "/");
        let zip_name = format!("assets/{rel_str}");

        write_zip_path(zw, &zip_name, path, opts)?;
    }
    Ok(())
}

/// True iff `path` is inside a top-level subdir we never want to ship.
/// Only matches the FIRST path component under `paper_abs` so a deeply
/// nested `something/build/` (e.g. a referenced art-asset folder) is
/// still included.
fn is_skipped_dir(path: &Path, paper_abs: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(paper_abs) else {
        return false;
    };
    let first = rel.components().next();
    let Some(std::path::Component::Normal(name)) = first else {
        return false;
    };
    let Some(name) = name.to_str() else {
        return false;
    };
    SKIP_TOP_DIRS.contains(&name)
}

/// Produce a filesystem-safe slug from the paper title for the zip
/// filename.  Lowercase ASCII, runs of non-alnum collapse to `-`, no
/// leading/trailing `-`.  Caps at 64 chars to keep Windows MAX_PATH
/// happy when the user has the vault buried 8 levels deep.
fn slugify_for_zip(title: &str) -> String {
    let mut out = String::with_capacity(title.len());
    let mut last_dash = true;
    for c in title.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        out.push_str("paper");
    }
    if out.len() > 64 {
        out.truncate(64);
        while out.ends_with('-') {
            out.pop();
        }
    }
    out
}

/// The README we drop at the root of the zip so the user knows what to
/// do with it on Overleaf.
fn readme_body(title: &str) -> String {
    format!(
        "{title}\n{rule}\n\n\
        This zip was generated by Lattice (paper_emit_bundle).\n\n\
        How to compile on Overleaf:\n\
        \n\
        1. Go to https://www.overleaf.com/project\n\
        2. Click \"New Project\" -> \"Upload Project\".\n\
        3. Drag this zip into the upload zone.\n\
        4. Overleaf will unzip and detect `main.tex` as the entry\n   point automatically (or set it via Menu -> Settings\n   -> Main document).\n\
        5. Hit \"Recompile\".\n\n\
        How to compile locally with Tectonic:\n\
        \n\
        Unzip this archive, then run:\n\
        \n    tectonic main.tex\n\n\
        The PDF lands next to `main.tex` as `main.pdf`.\n\n\
        Contents:\n\
        - main.tex         : self-contained LaTeX source\n\
        - references.bib   : BibTeX bibliography (if present)\n\
        - assets/          : images and other binary assets referenced\n                     by main.tex\n\n\
        -- generated by Lattice -- https://github.com/lattice-md\n",
        title = title,
        rule = "=".repeat(title.chars().count().max(8)),
    )
}
