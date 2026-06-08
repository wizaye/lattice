//! LaTeX compile pipeline for `paper_compile`.
//!
//! Reads a paper folder's section files, converts each to LaTeX via
//! [`super::md_to_tex`], wraps the result in a portable IEEE-style
//! article template, writes `build/main.tex`, then shells out to the
//! first available LaTeX engine on `PATH` (in this priority order):
//!
//! 1. **`tectonic`**       — modern, self-contained, no system TeX
//!    install needed beyond the single `tectonic` binary.
//! 2. **`latexmk -pdf`**   — handles multi-pass cross-references and
//!    bibliography automatically.
//! 3. **`pdflatex`** (×2)  — fallback when neither tectonic nor
//!    latexmk is present.  Two passes resolve forward references.
//! 4. **`xelatex`** (×2)   — last-ditch fallback for systems that
//!    only ship XeLaTeX (some Mac MacTeX installs).
//!
//! All four are routed through [`crate::publish::proc::spawn`] so the
//! Windows PATHEXT shim trap doesn't bite (tectonic ships as
//! `tectonic.exe`, but pdflatex/xelatex/latexmk on MiKTeX install as
//! `.exe` files — proc::spawn handles both).
//!
//! On success: returns the absolute path to `build/paper.pdf`.
//! On no-engine: returns a friendly error pointing the user at the
//! Tectonic install page.
//! On compile error: returns the last 4 KB of the engine's stderr so
//! the user can see which `.tex` line failed.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use wait_timeout::ChildExt;

use crate::publish::proc::spawn;

use super::md_to_tex;
use super::toml::PaperToml;

/// Run the full md → tex → pdf pipeline on `paper_abs`.
///
/// `paper_abs` is the on-disk paper folder (the parent of
/// `.lattice/paper.toml`).  Returns the absolute path to the produced
/// PDF on success.
pub fn compile(paper_abs: &Path) -> Result<PathBuf, String> {
    let cfg = PaperToml::load(&paper_abs.join(".lattice").join("paper.toml"))?;
    let build_dir = paper_abs.join("build");
    std::fs::create_dir_all(&build_dir)
        .map_err(|e| format!("failed to create build dir: {e}"))?;

    // 1. Assemble the LaTeX document.
    let body = assemble_body(paper_abs)?;
    let tex = wrap_in_template(&cfg, &body);
    let main_tex = build_dir.join("main.tex");
    std::fs::write(&main_tex, tex.as_bytes())
        .map_err(|e| format!("failed to write {}: {}", main_tex.display(), e))?;

    // 2. Pick an engine and run it.
    let engine = pick_engine().ok_or_else(|| {
        "No LaTeX engine found on PATH. Install one of:\n\
         - Tectonic (recommended): https://tectonic-typesetting.github.io\n\
         - MiKTeX: https://miktex.org/download\n\
         - TeX Live: https://tug.org/texlive/\n\
         then re-run Compile."
            .to_string()
    })?;
    engine.run(&build_dir, "main.tex")?;

    // 3. Verify the PDF is there.
    let pdf = build_dir.join("main.pdf");
    if !pdf.is_file() {
        return Err(format!(
            "{} reported success but {} is missing",
            engine.label(),
            pdf.display()
        ));
    }

    // 4. Move to the configured output path (default `build/paper.pdf`).
    let configured = paper_abs.join(&cfg.build.output);
    if let Some(parent) = configured.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            format!("failed to create output parent {}: {}", parent.display(), e)
        })?;
    }
    if configured != pdf {
        // Replace any existing file at the configured target.
        if configured.exists() {
            let _ = std::fs::remove_file(&configured);
        }
        std::fs::copy(&pdf, &configured).map_err(|e| {
            format!(
                "failed to copy {} to {}: {}",
                pdf.display(),
                configured.display(),
                e
            )
        })?;
    }

    Ok(configured)
}

/// Concatenate the paper's title / abstract / section files into one
/// LaTeX body string.  Order:
///
///   1. abstract.md (wrapped in `\begin{abstract}...\end{abstract}`)
///   2. sections/*.md in lexicographic order (so `01-introduction.md`
///      comes before `02-related-work.md`).
///   3. bibliography.bib → emitted as `\bibliography{}` in the
///      template wrapper, not here.
fn assemble_body(paper_abs: &Path) -> Result<String, String> {
    let mut out = String::new();

    // Abstract.
    let abstract_path = paper_abs.join("abstract.md");
    if abstract_path.is_file() {
        let md = std::fs::read_to_string(&abstract_path)
            .map_err(|e| format!("failed to read abstract.md: {e}"))?;
        let body = md_to_tex::convert(&md);
        // The template emits the abstract macro for the documentclass;
        // we strip the leading `\section{Abstract}` if present and use
        // the rest verbatim.
        let cleaned = body
            .lines()
            .filter(|l| !l.trim_start().starts_with("\\section{Abstract"))
            .collect::<Vec<_>>()
            .join("\n");
        out.push_str("\\begin{abstract}\n");
        out.push_str(&cleaned);
        if !cleaned.ends_with('\n') {
            out.push('\n');
        }
        out.push_str("\\end{abstract}\n\n");
    }

    // Sections.
    let sections_dir = paper_abs.join("sections");
    if sections_dir.is_dir() {
        let mut paths: Vec<PathBuf> = std::fs::read_dir(&sections_dir)
            .map_err(|e| format!("failed to read sections/: {e}"))?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| {
                p.extension()
                    .and_then(|s| s.to_str())
                    .map(|e| e.eq_ignore_ascii_case("md"))
                    .unwrap_or(false)
            })
            .collect();
        paths.sort();
        for p in paths {
            let md = std::fs::read_to_string(&p)
                .map_err(|e| format!("failed to read {}: {}", p.display(), e))?;
            out.push_str(&md_to_tex::convert(&md));
            out.push('\n');
        }
    }

    if out.trim().is_empty() {
        return Err(
            "paper has no abstract.md or sections/*.md content — nothing to compile."
                .to_string(),
        );
    }

    Ok(out)
}

/// Wrap a LaTeX body fragment in a portable article-class template.
///
/// We deliberately use `article` rather than `IEEEtran` because:
///  - Tectonic + a vanilla MiKTeX install have `article` available by
///    default; `IEEEtran` requires a separate package download.
///  - The user's IEEE submission gets re-typeset by the publisher
///    anyway — the local Compile output is for reading + iteration,
///    not camera-ready PDF.
///
/// Bibliography: if `bibliography.bib` exists in the paper folder, we
/// emit `\bibliography{../bibliography}` (latexmk/tectonic auto-detect
/// the bibtex pass).  Otherwise the line is omitted.
fn wrap_in_template(cfg: &PaperToml, body: &str) -> String {
    let title = md_to_tex::convert_title(&cfg.meta.title);
    let mut authors_block = String::new();
    if !cfg.authors.entries.is_empty() {
        let parts: Vec<String> = cfg
            .authors
            .entries
            .iter()
            .map(|a| {
                let mut s = md_to_tex::convert_title(&a.name);
                if let Some(aff) = &a.affiliation {
                    s.push_str(" \\\\ \\small ");
                    s.push_str(&md_to_tex::convert_title(aff));
                }
                s
            })
            .collect();
        authors_block.push_str(&parts.join(" \\and "));
    } else {
        authors_block.push_str("Anonymous");
    }

    let mut tex = String::with_capacity(body.len() + 2048);
    tex.push_str(
        r#"% Auto-generated by Lattice paper_compile — DO NOT EDIT BY HAND.
% Edit your Markdown sources and re-run Compile.
\documentclass[10pt,conference]{article}
\usepackage[T1]{fontenc}
\usepackage[utf8]{inputenc}
\usepackage{lmodern}
\usepackage{graphicx}
\usepackage{hyperref}
\usepackage{xcolor}
\usepackage{geometry}
\usepackage{enumitem}
\usepackage[normalem]{ulem}
\geometry{margin=1in}
\hypersetup{colorlinks=true,linkcolor=blue,urlcolor=blue,citecolor=blue}
"#,
    );
    tex.push_str("\\title{");
    tex.push_str(&title);
    tex.push_str("}\n");
    tex.push_str("\\author{");
    tex.push_str(&authors_block);
    tex.push_str("}\n");
    tex.push_str("\\date{}\n\n");
    tex.push_str("\\begin{document}\n");
    tex.push_str("\\maketitle\n\n");
    tex.push_str(body);
    // Bibliography placeholder — we don't auto-emit \bibliography
    // because we'd need to also configure \bibliographystyle for the
    // chosen template.  Users with bibs can add `\bibliographystyle{plain}`
    // and `\bibliography{../bibliography}` to their body explicitly,
    // or use latexmk's auto-detection.
    tex.push_str("\n\\end{document}\n");
    tex
}

// ─── Engine selection ────────────────────────────────────────────────────

#[derive(Copy, Clone)]
enum Engine {
    Tectonic,
    Latexmk,
    Pdflatex,
    Xelatex,
}

impl Engine {
    fn label(self) -> &'static str {
        match self {
            Engine::Tectonic => "tectonic",
            Engine::Latexmk => "latexmk",
            Engine::Pdflatex => "pdflatex",
            Engine::Xelatex => "xelatex",
        }
    }

    fn binary(self) -> &'static str {
        match self {
            Engine::Tectonic => "tectonic",
            Engine::Latexmk => "latexmk",
            Engine::Pdflatex => "pdflatex",
            Engine::Xelatex => "xelatex",
        }
    }

    fn run(self, build_dir: &Path, main_tex: &str) -> Result<(), String> {
        match self {
            Engine::Tectonic => {
                run_cmd(
                    "tectonic",
                    spawn(self.binary())
                        .current_dir(build_dir)
                        .args(["-X", "compile", "--keep-logs", main_tex])
                        .stdout(Stdio::piped())
                        .stderr(Stdio::piped()),
                    Duration::from_secs(180),
                )
            }
            Engine::Latexmk => {
                // -pdf runs pdflatex by default; -interaction=nonstopmode
                // makes the subprocess strictly non-interactive.
                run_cmd(
                    "latexmk",
                    spawn(self.binary())
                        .current_dir(build_dir)
                        .args([
                            "-pdf",
                            "-interaction=nonstopmode",
                            "-halt-on-error",
                            main_tex,
                        ])
                        .stdout(Stdio::piped())
                        .stderr(Stdio::piped()),
                    Duration::from_secs(300),
                )
            }
            Engine::Pdflatex | Engine::Xelatex => {
                // Two passes for forward references.  We tolerate
                // non-zero exit from the first pass (cross-refs not
                // resolved yet) and only fail on the second.
                let bin = self.binary();
                let _ = run_cmd(
                    bin,
                    spawn(bin)
                        .current_dir(build_dir)
                        .args(["-interaction=nonstopmode", "-halt-on-error", main_tex])
                        .stdout(Stdio::piped())
                        .stderr(Stdio::piped()),
                    Duration::from_secs(180),
                );
                run_cmd(
                    bin,
                    spawn(bin)
                        .current_dir(build_dir)
                        .args(["-interaction=nonstopmode", "-halt-on-error", main_tex])
                        .stdout(Stdio::piped())
                        .stderr(Stdio::piped()),
                    Duration::from_secs(180),
                )
            }
        }
    }
}

/// Probe each engine in priority order and return the first one
/// that's actually on PATH.  Uses `--version` as the cheapest probe.
fn pick_engine() -> Option<Engine> {
    for eng in [Engine::Tectonic, Engine::Latexmk, Engine::Pdflatex, Engine::Xelatex] {
        if probe_engine(eng.binary()) {
            return Some(eng);
        }
    }
    None
}

fn probe_engine(bin: &str) -> bool {
    match spawn(bin)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(mut child) => {
            // Don't actually wait for output — we only care that the
            // binary exists.  Kill it after a beat to keep the probe
            // fast even when the engine's --version output is slow.
            match child.wait_timeout(Duration::from_secs(10)) {
                Ok(Some(status)) => status.success(),
                Ok(None) => {
                    let _ = child.kill();
                    false
                }
                Err(_) => false,
            }
        }
        Err(_) => false,
    }
}

fn run_cmd(label: &str, cmd: &mut std::process::Command, timeout: Duration) -> Result<(), String> {
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("{label}: spawn failed: {e}"))?;
    match child.wait_timeout(timeout) {
        Ok(Some(status)) => {
            let stdout = drain(child.stdout.take());
            let stderr = drain(child.stderr.take());
            if status.success() {
                Ok(())
            } else {
                let mut combined = String::new();
                if !stderr.is_empty() {
                    combined.push_str(&truncate_tail(&stderr, 4096));
                }
                if combined.is_empty() && !stdout.is_empty() {
                    combined.push_str(&truncate_tail(&stdout, 4096));
                }
                if combined.is_empty() {
                    combined.push_str("(no output captured)");
                }
                Err(format!(
                    "{label} exited with {:?}\n--- output ---\n{}",
                    status.code(),
                    combined
                ))
            }
        }
        Ok(None) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(format!("{label} timed out after {}s", timeout.as_secs()))
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

fn truncate_tail(s: &str, n: usize) -> String {
    if s.len() <= n {
        return s.to_string();
    }
    let start = s.len() - n;
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
    fn template_wraps_body_with_documentclass_and_maketitle() {
        let mut cfg = PaperToml::default();
        cfg.meta.title = "My Paper".to_string();
        let tex = wrap_in_template(&cfg, "\\section{Body}\n");
        assert!(tex.contains("\\documentclass[10pt,conference]{article}"));
        assert!(tex.contains("\\title{My Paper}"));
        assert!(tex.contains("\\maketitle"));
        assert!(tex.contains("\\section{Body}"));
        assert!(tex.contains("\\end{document}"));
    }

    #[test]
    fn template_escapes_special_chars_in_title() {
        let mut cfg = PaperToml::default();
        cfg.meta.title = "AI & ML in 100% of cases".to_string();
        let tex = wrap_in_template(&cfg, "");
        assert!(tex.contains("\\title{AI \\& ML in 100\\% of cases}"));
    }

    #[test]
    fn template_falls_back_to_anonymous_when_no_authors() {
        let mut cfg = PaperToml::default();
        cfg.meta.title = "X".to_string();
        let tex = wrap_in_template(&cfg, "");
        assert!(tex.contains("\\author{Anonymous}"));
    }
}
