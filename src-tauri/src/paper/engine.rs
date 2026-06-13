//! LaTeX compile-engine abstraction — Strategy pattern.
//!
//! # SOLID Design
//!
//! ## Open / Closed
//! New engines (e.g. LuaLaTeX, Typst) are added by implementing
//! `CompileEngine` and registering them in `EnginePipeline::default()`.
//! No existing engine code is modified.
//!
//! ## Single Responsibility
//! Each `CompileEngine` owns exactly one engine's invocation logic.
//!
//! ## Interface Segregation
//! The `CompileEngine` trait is deliberately minimal: `name`,
//! `is_available`, `run`.  Anything richer (e.g. capability flags) is
//! supplied via optional methods with default implementations.
//!
//! ## Dependency Inversion
//! `compile::compile_paper()` receives a `&EnginePipeline` rather than
//! hard-coding which engines exist.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use wait_timeout::ChildExt;

use crate::publish::proc::spawn;

// ── Trait ────────────────────────────────────────────────────────────────

/// A single LaTeX compilation strategy.
pub trait CompileEngine: Send + Sync {
    /// Short display name used in error messages ("tectonic", …).
    fn name(&self) -> &'static str;

    /// Returns true iff the engine binary is available on PATH.
    fn is_available(&self) -> bool {
        let mut cmd = spawn(self.binary());
        let mut child = match cmd
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(c) => c,
            Err(_) => return false,
        };
        match child.wait_timeout(Duration::from_secs(5)) {
            Ok(Some(s)) => s.success(),
            _ => { let _ = child.kill(); false }
        }
    }

    /// The executable name passed to `spawn()`.
    fn binary(&self) -> &'static str;

    /// Run compilation.  `build_dir` is the working directory;
    /// `tex_file` is the filename relative to it (usually `"main.tex"`).
    fn run(&self, build_dir: &Path, tex_file: &str) -> Result<(), String>;
}

// ── Concrete engines ─────────────────────────────────────────────────────

/// Tectonic — modern, self-contained, no system TeX install required.
pub struct TectonicEngine;

impl CompileEngine for TectonicEngine {
    fn name(&self) -> &'static str { "tectonic" }
    fn binary(&self) -> &'static str { "tectonic" }
    fn run(&self, build_dir: &Path, tex_file: &str) -> Result<(), String> {
        run_engine(
            self.name(),
            spawn(self.binary())
                .current_dir(build_dir)
                .args(["-X", "compile", "--keep-logs", tex_file])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped()),
            Duration::from_secs(180),
        )
    }
}

/// latexmk — handles multi-pass cross-references and bibliography.
pub struct LatexmkEngine;

impl CompileEngine for LatexmkEngine {
    fn name(&self) -> &'static str { "latexmk" }
    fn binary(&self) -> &'static str { "latexmk" }
    fn run(&self, build_dir: &Path, tex_file: &str) -> Result<(), String> {
        run_engine(
            self.name(),
            spawn(self.binary())
                .current_dir(build_dir)
                .args(["-pdf", "-interaction=nonstopmode", tex_file])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped()),
            Duration::from_secs(120),
        )
    }
}

/// pdflatex — run twice for forward-reference resolution.
pub struct PdflatexEngine;

impl CompileEngine for PdflatexEngine {
    fn name(&self) -> &'static str { "pdflatex" }
    fn binary(&self) -> &'static str { "pdflatex" }
    fn run(&self, build_dir: &Path, tex_file: &str) -> Result<(), String> {
        let args = ["-interaction=nonstopmode", "-halt-on-error", tex_file];
        // Two passes for cross-references
        run_engine(
            self.name(),
            spawn(self.binary()).current_dir(build_dir).args(args)
                .stdout(Stdio::piped()).stderr(Stdio::piped()),
            Duration::from_secs(60),
        )?;
        run_engine(
            self.name(),
            spawn(self.binary()).current_dir(build_dir).args(args)
                .stdout(Stdio::piped()).stderr(Stdio::piped()),
            Duration::from_secs(60),
        )
    }
}

/// xelatex — last-ditch fallback for systems that only ship XeLaTeX.
pub struct XelatexEngine;

impl CompileEngine for XelatexEngine {
    fn name(&self) -> &'static str { "xelatex" }
    fn binary(&self) -> &'static str { "xelatex" }
    fn run(&self, build_dir: &Path, tex_file: &str) -> Result<(), String> {
        let args = ["-interaction=nonstopmode", "-halt-on-error", tex_file];
        run_engine(
            self.name(),
            spawn(self.binary()).current_dir(build_dir).args(args)
                .stdout(Stdio::piped()).stderr(Stdio::piped()),
            Duration::from_secs(60),
        )?;
        run_engine(
            self.name(),
            spawn(self.binary()).current_dir(build_dir).args(args)
                .stdout(Stdio::piped()).stderr(Stdio::piped()),
            Duration::from_secs(60),
        )
    }
}

// ── Pipeline (OCP: new engine = implement trait + push to list) ──────────

/// Ordered list of engines to try.  The first available engine wins.
pub struct EnginePipeline {
    engines: Vec<Box<dyn CompileEngine>>,
}

impl EnginePipeline {
    pub fn with_engines(engines: Vec<Box<dyn CompileEngine>>) -> Self {
        Self { engines }
    }

    /// Return the first available engine, or a friendly error listing
    /// the install URLs.
    pub fn pick(&self) -> Option<&dyn CompileEngine> {
        self.engines.iter().find(|e| e.is_available()).map(|e| e.as_ref())
    }

    /// Compile `tex_file` in `build_dir` using the first available
    /// engine.  Returns the engine name on success.
    pub fn compile(&self, build_dir: &Path, tex_file: &str) -> Result<String, String> {
        let engine = self.pick().ok_or_else(|| {
            "No LaTeX engine found on PATH. Install one of:\n\
             - Tectonic: https://tectonic-typesetting.github.io\n\
             - MiKTeX:   https://miktex.org/download\n\
             - TeX Live: https://tug.org/texlive/"
                .to_string()
        })?;
        engine.run(build_dir, tex_file)?;
        Ok(engine.name().to_string())
    }
}

/// Default pipeline: tectonic → latexmk → pdflatex → xelatex
impl Default for EnginePipeline {
    fn default() -> Self {
        Self::with_engines(vec![
            Box::new(TectonicEngine),
            Box::new(LatexmkEngine),
            Box::new(PdflatexEngine),
            Box::new(XelatexEngine),
        ])
    }
}

// ── Shared subprocess runner ─────────────────────────────────────────────

/// Spawn `cmd`, wait up to `timeout`, drain stdout+stderr on background
/// threads to avoid pipe-buffer deadlock, and surface a meaningful error
/// on non-zero exit or timeout.
///
/// This is the same pattern used in `paper/compile.rs` previously;
/// extracted here so all engine implementations share identical timeout
/// and pipe-drain behaviour.
pub fn run_engine(
    name: &str,
    cmd: &mut std::process::Command,
    timeout: Duration,
) -> Result<(), String> {
    let mut child = cmd.spawn()
        .map_err(|e| format!("{name}: spawn failed: {e}"))?;

    // Drain stdout and stderr on background threads to avoid
    // pipe-buffer deadlock (Tectonic can emit hundreds of KB of
    // bundle-download progress).
    let stdout_thread = {
        let stdout = child.stdout.take();
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut s) = stdout {
                let _ = std::io::Read::read_to_end(&mut s, &mut buf);
            }
            buf
        })
    };
    let stderr_thread = {
        let stderr = child.stderr.take();
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut s) = stderr {
                let _ = std::io::Read::read_to_end(&mut s, &mut buf);
            }
            buf
        })
    };

    let status = match child.wait_timeout(timeout) {
        Ok(Some(s)) => s,
        Ok(None) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("{name}: timed out after {}s", timeout.as_secs()));
        }
        Err(e) => return Err(format!("{name}: wait failed: {e}")),
    };

    let stderr_bytes = stderr_thread.join().unwrap_or_default();
    let _stdout_bytes = stdout_thread.join().unwrap_or_default();

    if !status.success() {
        let stderr = String::from_utf8_lossy(&stderr_bytes);
        let tail_len = stderr.len().saturating_sub(4096);
        return Err(format!(
            "{name} failed (exit {:?}):\n{}",
            status.code(),
            &stderr[tail_len..]
        ));
    }
    Ok(())
}
