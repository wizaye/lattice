# Paper Export — Slice C implementation plan (Markdown → LaTeX / PDF / Overleaf-ready bundle)

> **Scope.** This is the implementation plan for the **paper-export pipeline**: turn the vault's plain `.md` files into a venue-perfect PDF *and* a self-contained LaTeX project the user can ship to Overleaf or compile offline. Two ingest paths:
>
> 1. **Built-in templates** — IEEE Conference / IEEE Journal / Springer LNCS / ACM / APA 7 (the §8.5.10 set), each shipped as both Typst and LaTeX flavors.
> 2. **BYOF — Bring Your Own Format** — the user drops a conference-supplied `.zip` (`IEEEtran.cls`, `bare_conf.tex`, `IEEEbib.bst`, …) onto the app, we parse it, and from that point markdown sections compile into that conference's exact format.
>
> Output, in the user's choice:
>
> - **PDF** — compiled in-process via bundled **Typst** (fast path, ~1 s for 20 pages) or **Tectonic** (LaTeX path, slower but exact).
> - **LaTeX project** — a complete folder (`.tex` files + `.cls` + `.bst` + `bibliography.bib` + `figures/`) the user can zip and upload to Overleaf, or tweak in TeXShop / VS Code LaTeX-Workshop / `latexmk` locally.
> - **Both** — most users want the PDF for the deadline and the project zip as their working copy.
>
> This doc expands on [`docs/impl-v2.md`](impl-v2.md) §8.1, §8.5, and §8.5.13 — those sections describe **what** we want; this doc is the concrete checklist for "Slice C" of the v2 roadmap.

---

## 1. Hard product rules

1. **Lattice never sends paper content to a hosted compiler.** Typst and Tectonic both run as in-process / sidecar binaries. The compile pipeline has no network dependency at deadline time. (Tectonic *may* download missing TeX Live packages on first compile — that's pre-cached during paper creation, not at submit-day o'clock.)
2. **Every byte the user writes stays in plain `.md` on disk.** Section files are markdown, never `.tex`. The `.tex` we emit lives under `build/` and is regenerated on every compile — users edit markdown, we own the `.tex`.
3. **The Overleaf bundle is byte-deterministic for the same input** so version diffs of the *generated* project are clean. Same input → same `build/main.tex` → reviewers see real semantic diffs.
4. **BYOF preserves the conference's bundle verbatim.** We never edit the user-supplied `.cls`/`.sty`/`.bst` files; we only generate a `byof.toml` adapter that maps their template's macros onto the user's markdown sections.
5. **One-click "Open in Overleaf"** — we package `project.zip` and either upload via Overleaf's upload-zip URL (`https://www.overleaf.com/docs?snip_uri=…`) or just open the zip in the system browser-download flow. No Overleaf account integration on our side.

This shapes everything below.

---

## 2. Where we are today

Slice A (local VCS) and Slice B (BYOC sync) are shipped (see `docs/byoc-plan.md`, repo memory `/memories/repo/lattice.md`). Concretely for paper export:

- The editor already renders markdown end-to-end with KaTeX math, wikilinks, code fences, figure embeds, footnotes (markdown-it-texmath + markdown-it base). See `src/components/editor/MarkdownPreview.tsx` and `src/components/editor/SlidesView.tsx`.
- PDF viewing already works — `src/components/editor/PdfView.tsx` uses pdfjs-dist 6.x with a worker URL pinned via `?url`. The inline preview pane for compiled papers reuses this viewer verbatim (no second PDF renderer to ship).
- File-tree drag-drop, `FileNode.kind` ("file"/"folder"/"canvas"/"pdf"/"graph"), and `read_file_bytes` IPC are all in place — BYOF zip ingest reuses the drag handlers and the bytes IPC.
- BYOC GitHub token (per-vault, in OS keychain via DPAPI on Windows / keyring on mac+linux) is already available if the user wants to push the generated LaTeX project to a private GitHub repo as a backup.

What does **NOT** exist yet:

- Any `src-tauri/src/paper/` module.
- Any Typst or Tectonic dependency in `Cargo.toml`.
- Any `Paper → New Paper…` command, command palette entry, or paper-folder detection (`.lattice/paper.toml`).
- Any `.lattice/byof-templates/` zip-ingest path.
- Any "compile" button in the editor toolbar, or sidecar-PDF reload mechanism.
- Any markdown→LaTeX converter (we have markdown-it → HTML; we don't yet have markdown-it → TeX).

Slice C is the work to make all of that real.

---

## 3. Engine choice — Typst first, Tectonic for BYOF

Two compile engines ship in the same binary; the active one is per-paper, recorded in `.lattice/paper.toml`.

| Engine | When it's the default | How we ship it | Why |
|---|---|---|---|
| **Typst** (v0.13+) | Built-in templates (IEEE / Springer / ACM / APA / Thesis) | Native Rust crate `typst` + `typst-pdf` — link as a library, no subprocess, no extra binary | Single-binary, no TeX Live, builds offline in < 1 s on a 20-page paper. Already widely supported by IEEE/Springer Typst template community packages. |
| **Tectonic** (v0.15+) | BYOF (conference-supplied `.cls`/`.sty`/`.bst`) and any built-in template the user explicitly switches to the LaTeX flavor | Bundled as a **Tauri sidecar** binary (`src-tauri/binaries/tectonic-<arch>-<os>`) using `tauri.conf.json` → `bundle.externalBin`. ~40 MB per platform, gated to download-on-first-use to keep the installer small. | Tectonic is a single-binary LaTeX engine with on-demand CTAN package fetching + a frozen local mirror for offline. Compiles unmodified IEEEtran / Springer LNCS / ACM SIGCONF bundles. No system TeX Live install required. |

**Why both, not one:** Typst is faster, simpler, network-free, and the user *never* sees `.tex`. But the user's conference will sometimes hand them a `.cls` we can't legally reflow into Typst (proprietary IEEE journal templates, niche workshop formats). Tectonic is the escape valve so the user is never told "your conference isn't supported." See §8.5.13 in `impl-v2.md` for the BYOF rationale.

**What we do NOT do:**

- Ship a portable TeX Live install. ~5 GB unpacked, breaks signed-app distribution, network-bandwidth-hostile to students on metered connections. Tectonic's on-demand CTAN mirror covers >99% of what BYOF needs.
- Run cloud LaTeX. Defeats the "no server" hard rule and pushes paper drafts through someone else's box at deadline o'clock.
- Wrap a system `pdflatex` / `xelatex`. Too much variance across user installs (TeX Live 2018 on a lab machine vs MacTeX 2026 on a laptop vs MikTeX on Windows). Tectonic gives us one engine identity across all users.

---

## 4. Crate / module layout

One new module tree under `src-tauri/`, plus a new frontend lib + store + UI surface — same shape as the BYOC slice.

```text
src-tauri/src/
├── git.rs              # existing
├── sync/               # existing (BYOC slice)
├── commands.rs         # existing
├── lib.rs              # MODIFIED — register paper_* invoke handlers
└── paper/              # NEW
    ├── mod.rs          # PaperEngine enum, IPC commands, paper.toml load/save
    ├── toml.rs         # .lattice/paper.toml + .lattice/byof-templates/*/byof.toml schemas
    ├── md_to_tex.rs    # markdown-it-equivalent → LaTeX writer (comrak-backed)
    ├── md_to_typ.rs    # markdown → Typst writer (subset of comrak AST → Typst syntax)
    ├── typst_compile.rs # in-process Typst library compile + bibliography wiring
    ├── tectonic_run.rs # spawn the sidecar Tectonic binary; stream progress
    ├── byof_import.rs  # unzip + sniff main .tex + macro/section/package extraction
    ├── byof_adapter.rs # apply byof.toml to .md → .tex emission
    ├── bundle.rs       # build/project.zip emitter for Overleaf upload
    ├── preflight.rs    # missing-package / missing-font / page-count / TODO checker
    └── templates/      # bundled Typst + LaTeX templates (ieee-conf, springer-lncs, …)
        ├── ieee-conf/  # paper.typ + figures/, the §8.5.10 set
        ├── ieee-journal/
        ├── springer-lncs/
        ├── acm-sigconf/
        ├── apa-7/
        ├── thesis-generic/
        └── lab-report/
```

Frontend mirror under `src/`:

```text
src/
├── lib/
│   └── paper.ts                # NEW — IPC wrappers (mirrors lib/byoc.ts shape)
├── state/
│   └── paperStore.ts           # NEW — Zustand: per-paper compile state, progress, errors
└── components/
    ├── paper/
    │   ├── NewPaperModal.tsx   # NEW — template picker + author block + parent folder
    │   ├── NewPaperModal.css
    │   ├── ByofImportModal.tsx # NEW — drag-zip + preflight summary + Adapt button
    │   ├── ByofImportModal.css
    │   ├── PaperToolbar.tsx    # NEW — Compile / Export / Overleaf buttons, surfaces in EditorArea
    │   └── PaperPreflightCard.tsx # NEW — yellow card with checklist warnings
    └── editor/
        └── EditorArea.tsx       # MODIFIED — show PaperToolbar when active tab is inside a paper folder
```

### New Rust dependencies

Add to `src-tauri/Cargo.toml`:

```toml
# Markdown AST — same engine GitHub uses; we already need an AST-level parser
# (markdown-it on the JS side produces HTML, not AST). comrak gives us
# CommonMark + GFM + math fences + footnotes.
comrak = { version = "0.28", default-features = false, features = ["syntect"] }

# Typst as a library — compile in-process, no subprocess, no extra binary.
typst       = "0.13"
typst-pdf   = "0.13"
typst-assets = "0.13"   # bundled fonts so the typst output is identical across machines

# Zip read/write for BYOF import + Overleaf bundle export.
zip = "2"

# Walk the user's vault folder to find figure/table references.
walkdir = "2"          # already pulled in transitively by sync/, declare explicitly
```

Tectonic is **not** a Rust dependency — it's a sidecar binary (see §3). Specifically:

- Pre-built sidecar binaries from `https://github.com/tectonic-typesetting/tectonic/releases` are downloaded by `npm run setup-sidecars` (a new script) and placed in `src-tauri/binaries/`.
- `tauri.conf.json` → `bundle.externalBin = ["binaries/tectonic"]` so the binary is included in the installer and resolvable at runtime via `tauri::api::process::Command::new_sidecar("tectonic")`.
- Add `tauri-plugin-shell = "2"` as a Tauri plugin so we can spawn Tectonic and stream stdout/stderr.
- Add `"shell:allow-execute"` and `"shell:allow-spawn"` permissions to `src-tauri/capabilities/default.json`, scoped to `binaries/tectonic` only.

Frontend deps: none new beyond what's already there. We reuse `<PdfView>` for the inline preview, the existing dialog plugin for file pickers, and the existing opener plugin for "Open in Overleaf".

---

## 5. The `paper.toml` schema (per-paper config)

Lives at `<paper>/.lattice/paper.toml`. Single source of truth for everything the compile pipeline needs to know.

```toml
[meta]
id      = "01HXAY83RKQE1Q4M6XZ7FY2A8P"  # ULID, stable across renames
title   = "On the Local-First PKM"
created = "2026-06-10T12:42:00Z"
schema  = 1                               # bump when we make breaking changes

[engine]
kind     = "typst"     # "typst" | "tectonic"
template = "ieee-conf" # built-in id from src-tauri/src/paper/templates/, OR
                       # "byof:ieee-tpds-2026" for a BYOF-imported one
flavor   = "default"   # template-specific knob (e.g. "single-column" for IEEE Journal)

[authors]
# Each [[authors.entry]] is rendered into the template's author macro.
# The template owns how authors look; we just provide the structured data.
[[authors.entry]]
name        = "Ada Lovelace"
email       = "ada@example.org"
affiliation = "Department of CS, Example University"
orcid       = "0000-0002-1825-0097"

[bibliography]
files = ["bibliography.bib"]            # also accepts .yaml CSL-JSON
style = "ieee"                           # template default if unset
zotero = { auto_import = true,           # watch ~/Zotero/storage/* for changes
           better_bibtex_path = "~/Zotero/lattice.bib" }

[sections]
order = [
  "title.md",
  "abstract.md",
  "sections/01-introduction.md",
  "sections/02-related-work.md",
  "sections/03-method.md",
  "sections/04-results.md",
  "sections/05-discussion.md",
  "sections/06-conclusion.md",
]

[figures]
default_placement = "t"                  # LaTeX float placement; Typst ignores
default_width    = "\\linewidth"

[build]
output         = "build/paper.pdf"
project_bundle = "build/paper-overleaf.zip"
keep_tex       = true                    # write build/main.tex even on Typst engine
                                          # (lets the user open the project in Overleaf
                                          #  using Tectonic as a fallback compiler)
diff_against   = "submitted-v1"          # git tag/SHA; empty = no diff PDF

[preflight]
max_pages       = 8         # template-specific; emitted with the template
require_orcid   = true
require_anon    = false     # set true for double-blind submissions
forbid_markers  = ["TODO", "FIXME", "\\todo"]
```

All fields are optional except `[meta]` and `[engine]`. Defaults come from the template's bundled `paper.defaults.toml`.

---

## 6. BYOF — `byof.toml` schema (per-imported-format config)

Lives at `<vault>/.lattice/byof-templates/<id>/byof.toml`. Generated by `byof_import.rs`; hand-editable.

This is the schema from `impl-v2.md` §8.5.13 made canonical here so the importer + the compile pipeline + the UI all read the same shape.

```toml
[meta]
id         = "ieee-tpds-2026"
imported   = "2026-06-10T11:02:00Z"
source_zip = "ieee-tpds-2026.zip"
source_hash = "blake3:7c4f…"            # for "re-import → 3-way merge" detection

[class]
file    = "IEEEtran.cls"                # path inside .lattice/byof-templates/ieee-tpds-2026/
name    = "IEEEtran"
options = ["conference", "a4paper", "10pt"]

[bibliography]
style   = "IEEEtran"
file    = "IEEEbib.bst"
backend = "bibtex"                      # "bibtex" | "biber"

[packages]
required = ["graphicx", "amsmath", "amssymb", "cite", "url"]
optional = ["microtype"]

[macros]
title   = "\\title{{{ title }}}"
authors = "\\IEEEauthorblockN{{{ name }}}\n\\IEEEauthorblockA{{{ affiliation }}}"

[sections]
"sections/01-introduction.md" = { command = "\\section",    title = "Introduction" }
"sections/02-related-work.md" = { command = "\\section",    title = "Related Work" }
"sections/03-method.md"       = { command = "\\section",    title = "Methods" }
"sections/04-results.md"      = { command = "\\section",    title = "Results" }
"sections/05-discussion.md"   = { command = "\\section",    title = "Discussion" }
"sections/06-conclusion.md"   = { command = "\\section",    title = "Conclusion" }

[figure_macro]
single = """
\\begin{figure}[t]
  \\includegraphics[width=\\linewidth]{{{ path }}}
  \\caption{{{ caption }}}
  \\label{{{ label }}}
\\end{figure}"""

twocol = """
\\begin{figure*}[t]
  \\includegraphics[width=\\linewidth]{{{ path }}}
  \\caption{{{ caption }}}
  \\label{{{ label }}}
\\end{figure*}"""

[preflight]
missing_fonts    = []                   # filled by importer; non-empty blocks build
missing_packages = []
warnings         = [
  "Template uses \\IEEEPARstart in the intro — first paragraph will be auto-rewrapped.",
]
external_tools   = []                   # e.g. ["bibexport", "gnuplot"] — surfaced before compile
```

`byof_import.rs` populates this by:

1. Unzipping the user's bundle into `<vault>/.lattice/byof-templates/<id>/`.
2. Finding the main `.tex` (heuristic: largest `.tex` containing `\documentclass`).
3. Lexing for `\documentclass[…]{…}`, every `\usepackage{…}`, `\bibliographystyle{…}`, and every `\section{…}`/`\subsection{…}` between `\begin{document}` and `\end{document}`.
4. Sniffing custom macro definitions (`\newcommand`, `\def`, `\providecommand`) that look author/title-shaped (signatures involving `#1` + `\textit` / `\textbf` / known IEEE-style commands).
5. Dry-running Tectonic with the sample document to materialise any missing CTAN packages — anything that fails on a real machine is logged into `[preflight].missing_packages` so the user sees it before compile time.

**Re-import path:** if the user drags a new zip with the same `[meta].id`, we 3-way merge the new auto-generated `byof.toml` against (a) the previous auto-generated `byof.toml` and (b) the user's hand-edited current one — preserving manual macro fixes the user made.

---

## 7. The `PaperEngine` trait

The compile orchestration is engine-agnostic. Two impls today (Typst + Tectonic); future engines (e.g. Pandoc → docx for the Word `.dotx` BYOF path in §8.5.13) slot in as a third.

```rust
// src-tauri/src/paper/mod.rs
#[async_trait::async_trait]
pub trait PaperEngine: Send + Sync {
    /// Stable enum value used in IPC + paper.toml.
    fn kind(&self) -> EngineKind;

    /// Compile the paper. Streams progress (parsing → typesetting → linking)
    /// back to the frontend via Tauri events on `paper://progress`.
    /// Returns the absolute path to the produced PDF on success.
    async fn compile(&self, paper: &Path, cfg: &PaperToml, progress: ProgressSink) -> Result<PathBuf, PaperError>;

    /// Emit the LaTeX project under `<paper>/build/project/` AND zip it to
    /// `<paper>/build/project.zip`. Typst engine still produces a .tex via
    /// `pandoc-equivalent` so the same Overleaf-export button works for both.
    async fn emit_bundle(&self, paper: &Path, cfg: &PaperToml) -> Result<PathBuf, PaperError>;

    /// Run the preflight checks from cfg.preflight against the current vault state.
    /// Returns a list of {severity, message, file?, line?} entries the UI shows.
    async fn preflight(&self, paper: &Path, cfg: &PaperToml) -> Result<Vec<PreflightFinding>, PaperError>;

    /// Generate the visual PDF diff vs cfg.build.diff_against (a git tag/SHA).
    /// Uses `latexdiff` if available, falls back to a built-in pdf-diff
    /// (page-by-page color-overlay) when not.
    async fn diff(&self, paper: &Path, cfg: &PaperToml) -> Result<Option<PathBuf>, PaperError>;
}

#[derive(Copy, Clone, Eq, PartialEq, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EngineKind {
    Typst,
    Tectonic,
}
```

`ProgressSink` is the same shape the BYOC slice uses — a small `mpsc::UnboundedSender<ProgressMsg>` that the IPC layer forwards to the frontend as a Tauri event.

---

## 8. IPC surface (registered in `src-tauri/src/lib.rs`)

Mirrors the BYOC `byoc_*` naming convention. **All paths are absolute and validated by `vault_dir()` / `paper_dir()` first** — same hardening pattern that fixed the `__mock__` leak in slice A.

| IPC command | Purpose | Returns |
|---|---|---|
| `paper_list_templates()` | Enumerate `src-tauri/src/paper/templates/` + every `.lattice/byof-templates/*/byof.toml` in the active vault. | `Vec<TemplateInfo>` |
| `paper_create(vault, parent_rel, title, authors, template_id)` | Scaffold a new paper folder (§8.5.2 layout from `impl-v2.md`). Returns absolute path. | `PathBuf` |
| `paper_status(paper)` | Read `paper.toml` + `.lattice/paper-state.json` (last compile time, exit code, PDF mtime). | `PaperStatus` |
| `paper_compile(paper)` | Resolve engine → run `engine.compile(...)`. Emits `paper://progress` events. | `PathBuf` (output PDF) |
| `paper_preflight(paper)` | Run preflight without compiling. | `Vec<PreflightFinding>` |
| `paper_emit_bundle(paper)` | Emit `build/project/` + `build/project.zip` for Overleaf. | `PathBuf` (zip) |
| `paper_open_overleaf(paper)` | Call `paper_emit_bundle` then open `https://www.overleaf.com/docs?snip_uri=<local-file-url>` in the system browser via `tauri-plugin-opener`. *Or* (when the local serving sidecar isn't available) reveal the zip in the file explorer with a "drag this into Overleaf" toast. | `String` (URL or path opened) |
| `paper_diff(paper)` | Visual PDF diff vs `cfg.build.diff_against`. | `Option<PathBuf>` |
| `paper_byof_import(vault, zip_path)` | Unpack + parse + write `byof.toml`. Returns the new template id. | `String` |
| `paper_byof_re_import(vault, byof_id, zip_path)` | Re-import with 3-way merge of `byof.toml`. | `String` |
| `paper_byof_remove(vault, byof_id)` | Delete `.lattice/byof-templates/<id>/`. | `()` |
| `paper_set_compile_engine(paper, engine_kind)` | Update `paper.toml [engine].kind`. | `()` |

All command names are validated by the existing `vault_dir`/`is_real_vault` guard. **Mock vault rejected at the TS layer** (no `paper_*` IPC ever leaves the `__mock__` sentinel), exactly like BYOC.

---

## 9. Frontend integration

### `src/lib/paper.ts` (new)

Thin `invoke<T>(...)` wrappers + the mirror DTOs (camelCase, matching the `#[serde(rename_all = "camelCase")]` on every Rust struct). One file, ~250 LOC, no UI.

### `src/state/paperStore.ts` (new)

Zustand store, ~300 LOC. Flat map keyed by paper folder absolute path. State per paper:

```ts
type PaperRowState = {
  status: "idle" | "compiling" | "ready" | "error";
  lastCompiledAt?: string;
  lastEngine?: "typst" | "tectonic";
  lastPdfPath?: string;
  lastProjectZipPath?: string;
  lastError?: string;
  progressPercent?: number;    // 0..100 — fed by paper://progress events
  progressStage?: string;      // "Parsing markdown" | "Typesetting page 4" | "Writing PDF"
  preflight?: PreflightFinding[];
};
```

Subscribes once to `paper://progress` via `listen<…>()` (HMR-safe via `import.meta.hot.dispose`). All actions are no-op for the mock vault — same pattern as BYOC.

### `src/components/paper/NewPaperModal.tsx` (new)

Three-step wizard:

1. Template picker (cards). Filters: "Built-in" / "Imported (BYOF)" / "All".
2. Author block (name + email + affiliation + ORCID; rows addable).
3. Parent folder picker + title field. "Create" calls `paper_create` then `openFile(<paper>/sections/01-introduction.md)`.

### `src/components/paper/ByofImportModal.tsx` (new)

- Drop a zip onto the modal (or via `tauri-plugin-dialog` open-file) → call `paper_byof_import`.
- Show the preflight summary returned from the importer (missing packages, missing fonts, custom-macro panel for the user to fill in once).
- "Adapt" button writes the final `byof.toml` and registers the template in the picker.

### `src/components/paper/PaperToolbar.tsx` (new)

Rendered inside `EditorArea.tsx`'s Pane when `isInPaper(activeFile)` (helper that walks up the path looking for `.lattice/paper.toml`).

Layout (left-to-right):

```
[ ▶ Compile ] [ ⌐ Preflight ] [ 📄 Open PDF ] [ ⤴ Export ▾ ] [ Engine: Typst ▾ ] [ status pill ]
```

- **Compile** — calls `paper_compile`; status pill shows percent/stage.
- **Preflight** — opens `PaperPreflightCard` over the editor.
- **Open PDF** — opens `build/paper.pdf` as a new tab in the same pane using the existing `PdfView`. **Reload-on-change**: `paperStore` exposes `lastCompiledAt`; `PdfView` re-reads the bytes when the mtime changes (already supported by the `read_file_bytes` IPC + a small `useEffect` keyed off `lastCompiledAt`).
- **Export ▾** — dropdown:
  - "Open in Overleaf" → `paper_open_overleaf`.
  - "Save LaTeX project as zip…" → `paper_emit_bundle` + `dialog.save` → copy.
  - "Save LaTeX project as folder…" → `paper_emit_bundle` + `dialog.save` → folder copy.
  - "Save PDF as…" → `dialog.save`.
- **Engine ▾** — Typst / Tectonic radio. Persists to `paper.toml [engine].kind`.

### `EditorArea.tsx` (modified)

Add the `<PaperToolbar />` between the existing tab strip and the editor body, gated by `isInPaper(activeFile)`. Zero changes to existing toolbars for non-paper files.

### Status pill integration

Status pill grows a **"📄 Paper: 6 pages • IEEE Conf"** capsule when the active file is inside a paper. Click → opens `PaperToolbar`'s settings panel (same pattern as the BYOC cloud capsule).

### Command palette (post step 3 from §13 ship order)

When the command palette lands:

- `New Paper…` → opens `NewPaperModal`.
- `Compile paper` → `paper_compile` on active paper.
- `Open paper PDF` → opens `build/paper.pdf` for active paper.
- `Import conference format (BYOF)…` → opens `ByofImportModal`.

---

## 10. Markdown → LaTeX / Typst (`md_to_tex.rs` + `md_to_typ.rs`)

Both writers consume the same comrak AST. The conversion rules are intentionally restrictive — if the user writes pure markdown, the output looks great; if they reach for raw HTML, we pass through with a `% HTML pass-through` comment so the failure mode is visible in the build log.

**Common rules:**

| Markdown | LaTeX (`md_to_tex`) | Typst (`md_to_typ`) |
|---|---|---|
| `# Heading` | `\section{Heading}` (level 1) / `\subsection{…}` (level 2) … | `= Heading` / `== Heading` |
| `**bold**` | `\textbf{bold}` | `*bold*` |
| `*italic*` | `\emph{italic}` | `_italic_` |
| `` `code` `` | `\texttt{code}` | `` `code` `` |
| ```` ```rust\nfn …\n``` ```` | `\begin{lstlisting}[language=Rust] … \end{lstlisting}` | ``` ```rust\nfn …\n``` ``` (Typst native) |
| `$E=mc^2$` | `$E=mc^2$` | `$E = m c^2$` (Typst syntax) |
| `$$ \int … $$` | `\begin{equation} … \end{equation}` | `$ integral … $` |
| `[link](url)` | `\href{url}{link}` (with `\usepackage{hyperref}`) | `#link("url")[link]` |
| `[[Target]]` | converts to the target's section label if intra-paper (`\ref{sec:target}`); otherwise drops to `\textit{Target}` with a footnote URL if the target has a published URL via the publish manifest (see `docs/publishing-plan.md`); otherwise plain text fallback. | same logic, Typst syntax. |
| `![caption](figures/x.png){#fig:x width=80%}` | uses `[figure_macro].single` from `byof.toml` (BYOF) or the template default | uses `#figure(image("…"), caption: "…") <fig-x>` |
| Footnotes (`[^1]`) | `\footnote{…}` | `#footnote[…]` |
| Tables (GFM) | `\begin{tabular}` via `booktabs` (template imports `\usepackage{booktabs}`) | Typst `#table(...)` |
| Citations `[@key]` | `\cite{key}` | `#cite(<key>)` |
| Frontmatter | merged into `[authors]` / `[meta]` of `paper.toml`; not emitted into the body | same |
| `> [!note] …` callouts | `\begin{quote} … \end{quote}` (template may override via a `[callouts]` table) | `#quote(...)` |

**Raw escape hatches:**

- ` ```latex … ``` ` and ` ```typst … ``` ` — passed through verbatim into the target engine; ignored by the other.
- Inline raw: a line starting with `\\` (LaTeX) or `#raw(...)` (Typst) is forwarded.

**Things we explicitly do not auto-convert** (the build log warns):

- Embedded HTML (`<div>…</div>`) — wrapped in a `% raw HTML — please port` comment in LaTeX; rejected in Typst with a friendly error pointing at the offending file:line.
- KaTeX-only macros (`\bra`, `\ket`) — surfaced in preflight so the user knows to add `\providecommand` in a template-extension file.

---

## 11. Project bundle (Overleaf-ready) — `bundle.rs`

`paper_emit_bundle` always emits a self-contained project even when the active engine is Typst. The layout:

```text
build/project/
├── main.tex                # converted from sections/*.md
├── bibliography.bib        # copied verbatim
├── figures/                # copied (relative paths preserved)
├── style/                  # any custom .sty the user has under .lattice/byof-templates/<id>/
├── IEEEtran.cls            # for BYOF, the user's exact bundle is copied here
├── README.md               # "compile with `latexmk -pdf main.tex` or upload main.tex to Overleaf"
└── .lattice/
    └── lineage.toml        # { source_paper, source_commit_sha, generated_at } — for traceability
```

Then `build/project.zip` is a deterministic zip of that folder. Determinism rules:

- Files added in lexicographic order.
- All mtimes set to a fixed epoch (`SOURCE_DATE_EPOCH` from the git commit being exported, or `2026-01-01T00:00:00Z` for uncommitted work).
- No `.DS_Store` / `Thumbs.db` / `.git*` files included (filtered via the same `.gitignore` engine git uses — implementation: re-use the `vcs_status` parser to identify ignored paths).

**Overleaf upload URL pattern:** Overleaf supports `https://www.overleaf.com/docs?snip_uri=<url-encoded-public-https-url-to-zip>`. Since we don't host the zip, we have two fallbacks:

1. **Preferred:** start a one-shot Tauri sidecar HTTP server on `127.0.0.1:<random>` that serves the zip for ~60 s, generate the full URL, open it. Overleaf fetches the zip server-side and creates a project. (Some Overleaf instances refuse non-public hosts — when that's the case, fall back to (2).)
2. **Fallback:** call `revealItemInDir(zip_path)` and toast: "Drag the highlighted zip into the Overleaf 'New Project → Upload Project' dialog."

Both flows are tried in order by `paper_open_overleaf`; the actual chosen path is recorded in `.lattice/paper-state.json` so we tell the user what happened in the toast.

---

## 12. The `New Paper…` scaffold — exact files written

When `paper_create` runs, we write the §8.5.2 tree from `impl-v2.md` to disk. **Every file is real working content** so the very first compile produces a 6-page PDF that looks like a real paper. No lorem ipsum.

```text
<parent>/<slug-of-title>/
├── paper.typ                            # or paper.tex when [engine].kind = "tectonic"
├── README.md                            # how to use this folder
├── title.md                             # YAML frontmatter: title, authors, keywords
├── abstract.md                          # ~250-word placeholder
├── sections/
│   ├── 01-introduction.md
│   ├── 02-related-work.md
│   ├── 03-method.md
│   ├── 04-results.md
│   ├── 05-discussion.md
│   └── 06-conclusion.md
├── figures/
│   ├── README.md                        # "drop figures here; the editor names them automatically"
│   └── architecture.svg                 # stub diagram so the first compile shows a figure
├── tables/
│   └── results-table.md                 # markdown-table source; converted into LaTeX/Typst on compile
├── bibliography.bib                     # 3 real example entries (turing1950, mccarthy1960, hopper1952)
├── citations.md                         # human-readable index; auto-maintained
├── notes.md                             # scratchpad; excluded from build (frontmatter `build: false`)
├── .lattice/
│   ├── paper.toml                       # §5 schema
│   ├── checklist.md                     # §13 (submission checklist)
│   └── paper-state.json                 # populated on first compile
└── build/                               # .gitignored; created on first compile
```

The folder is auto-staged via the existing VCS layer (calling `vcs_stage` on every new file then `vcs_commit_all` with message `"Scaffold new paper: <title>"`).

---

## 13. Submission checklist — `.lattice/checklist.md`

Template-bundled, auto-checked. Same shape as §8.5.8 of `impl-v2.md`:

```markdown
- [x] All authors listed with ORCID iDs (3/3 ORCIDs found in title.md)
- [x] Abstract under 250 words (currently 217)
- [x] All figures have captions
- [ ] All figures have alt-text (2 of 5 missing — see fig-results.png, fig-arch.png)
- [x] All cited works present in bibliography.bib (0 missing)
- [ ] Page count under conference limit (currently 9, limit is 8)
- [x] No \todo or TODO markers in body text
- [ ] Anonymous submission: author names removed (IEEE TPDS double-blind)
```

The boxes with bracketed numbers (`(3/3 ORCIDs found)`) are auto-rerun on every compile and the box state is mutated in-place by `preflight.rs`. Manual checks have a button in `PaperPreflightCard` to mark them done.

---

## 14. UX surface summary

| Surface | What it does | Where it lives |
|---|---|---|
| Command Palette → "New Paper…" | Opens `NewPaperModal` | post step 3 ship order |
| Right-click vault folder → "New Paper here…" | Same, with `parent` pre-filled | `FileTree.tsx` context menu |
| Drag `.zip` onto vault root | Sniffs for a `.tex` inside → if found, opens `ByofImportModal`; else falls through to existing drop handler | `FileTree.tsx` drop handler |
| Editor toolbar (when active file is in a paper) | `PaperToolbar` (Compile / Preflight / Export ▾) | `EditorArea.tsx` |
| StatusPill capsule "📄 IEEE Conf • 6 pp" | Click → settings → paper compile log + engine swap | `StatusPill.tsx` |
| Settings → Paper | List of paper folders in the vault, per-paper compile history, BYOF template list with re-import / remove buttons | `SettingsModal.tsx` (new "Paper" tab) |
| Onboarding step 7 (academic preset) | Mentions paper scaffolder, opens a "Build your first paper now?" CTA on finish | `OnboardingShell.tsx` |

---

## 15. Cross-feature integration

- **VCS (slice A):** every compile commits nothing (compiles are local-only); but `Cmd+S Compile` does NOT auto-commit. Compiled PDFs are in `build/`, gitignored. The exception: `Paper → Tag for submission` (`submitted-v1`) creates a git tag — that's the anchor `cfg.build.diff_against` uses.
- **BYOC (slice B):** the generated `build/project.zip` can be pushed to a private GitHub repo using the existing BYOC GitHub token as a "paper backup" — opt-in toggle in `PaperToolbar`'s settings panel. Same repo the vault syncs to is reused (no second repo for paper backups).
- **Publishing (slice D, `docs/publishing-plan.md`):** the publish manifest knows which notes are referenced by which paper. A note that's both `[[wikilinked]]` from a paper section AND published gets its public URL injected as the `\href{...}` target so the printed PDF cross-references work.
- **AI / BYOM (later slice):** "Tighten this paragraph" (§8.5.12) and "Translate Methods → plain English (press release)" are bolt-ons on `PaperToolbar`'s right edge. Off by default per `[ai_assist].enabled = false` in `paper.toml`.

---

## 16. Phased ship order (Slice C — within itself)

> Slice C lands as **§13 step 10** in the global queue (already so in `impl-v2.md`). Inside the slice we ship in this order so each step is independently testable:

1. **C1 — Typst engine + IEEE Conf template + Compile button.** Smallest end-to-end loop: `New Paper… → IEEE Conf → Compile → PDF appears in side pane`. No BYOF, no Tectonic, no Overleaf bundle. Validates the AST pipeline + the `<PdfView>` reload behaviour.
2. **C2 — `bundle.rs` + Overleaf "Open in browser" path.** Adds the `paper_emit_bundle` IPC + the Overleaf upload URL pattern. Validates the deterministic zip + the local sidecar HTTP server.
3. **C3 — The other 4 built-in templates** (IEEE Journal / Springer LNCS / ACM / APA 7) wired through the same engine. Tests template surface area.
4. **C4 — Tectonic sidecar + LaTeX flavor of every built-in template.** Same template ids, different `engine.kind`. Validates the Tectonic spawn pipeline + CTAN package fetch + offline behaviour.
5. **C5 — BYOF import (`byof_import.rs` + `ByofImportModal`).** Drag a zip → preflight → adapt → first compile with a real conference bundle.
6. **C6 — Citation management** (Zotero watch + `[@key]` autocomplete + DOI paste import). Touches the markdown editor's CodeMirror autocomplete extension. Reuses the existing `flatVault` index to dedupe.
7. **C7 — Preflight + checklist + visual PDF diff.** The "reviewer love" feature set.
8. **C8 — AI assist** (gated behind BYOM landing). "Tighten paragraph" + "Suggest related work" + "Translate Methods to plain English".
9. **C9 — Word `.docx` BYOF** (CHI late-breaking, medical journals). Adds a pandoc-equivalent path through `paper.docx` reference-doc rendering. Same `byof.toml` shape, different `[engine].kind = "pandoc-docx"`. Optional v1.5.

Each step is mergeable on its own; each step adds value visible to a real user.

---

## 17. Security checklist (OWASP-relevant)

| Concern | Mitigation |
|---|---|
| **Path traversal** in `paper_create(parent_rel, ...)` | Canonicalise `parent_rel` against `vault_path`; reject if the result is not a child of `vault_path`. Reject any component that is `..` or starts with `~`. Same hardening pattern as `vcs_*`. |
| **Zip-slip** in BYOF import (`paper_byof_import`) | Iterate entries with `zip::ZipFile::name()`; reject any name containing `..` or absolute paths (`\\`, `/` prefix, `C:\\` prefix on Windows). Reject any entry that would resolve outside `<vault>/.lattice/byof-templates/<id>/`. |
| **Tectonic shelling to arbitrary binaries** | Sidecar resolution uses `Command::new_sidecar("tectonic")` — Tauri resolves only against `binaries/` from `tauri.conf.json`. Argv is fixed; the only user-influenced value is the working directory (validated). |
| **Malicious `.cls` running `\write18` / `\immediate\write18`** | Tectonic disables shell-escape by default; we do NOT pass `-shell-escape`. Surfaced in preflight if the user's template requires it; on first attempt we prompt with a sandbox confirmation. |
| **Overleaf zip leak** | The sidecar HTTP server binds to `127.0.0.1:<random>`, serves a single path (the just-generated zip), expires after 60 s or first GET. Random URL token + Referer check (`https://www.overleaf.com`) on the GET. |
| **Compile reading arbitrary vault files** | `md_to_tex` / `md_to_typ` only inline files listed in `paper.toml [sections].order` + `[figures]` paths resolved relative to the paper folder. Refuses any path that escapes the paper root. |
| **Untrusted markdown HTML** | We DO NOT pass HTML through to the final PDF without an explicit `\unsafe-html`-style fence (which itself emits a build-log warning). Default policy = drop with a `% HTML stripped` comment. |
| **Tokens never appear in compile logs** | Tectonic + Typst neither receive nor have any reason to receive tokens. The Overleaf upload URL is the only place a short-lived random token appears, and it's printed only into `.lattice/paper-state.json` (not the global log). |
| **BYOF zip bombs** | Reject any zip whose uncompressed size exceeds 200 MB OR contains > 5 000 entries. Reject any single entry whose compression ratio > 1 000:1. |
| **Long-running Tectonic builds DoSing the UI** | Compile runs on the tokio runtime; the IPC layer wraps it in `tokio::time::timeout(300s, …)`. UI's Cancel button calls `tectonic_run::cancel(paper_id)` which `kill()`s the sidecar process. |

---

## 18. What is NOT in slice C

(Defer to a later slice — explicitly out of scope so reviewers can stop the discussion.)

- **Real-time collaborative editing of paper sections.** That needs Automerge / CRDT; deferred to v3 (see `impl.md` phase 2.3). Co-authors collaborate via BYOC sync today — fine for single-author or async-coauthored papers.
- **Track-changes per-author colored gutter.** Recorded as a follow-up; needs git-blame UI work first.
- **Custom paper templates as community plugins.** Lands with the plugin marketplace (§5.4); until then templates are bundled with the app.
- **Web-app Overleaf-style real-time co-edit.** Out of scope — Lattice is desktop-first; Overleaf upload is the bridge.
- **`arxiv` upload from inside Lattice.** Manual for v1 — the user downloads the project zip and uploads it to arxiv themselves.

---

## 19. Verification gates

Each slice-C step lands only when:

- `cargo check --lib` clean.
- `cargo test -p lattice-paper` green (new tests at minimum: `md_to_tex` 30 fixtures, `byof_import` 5 real conference bundles, `bundle.rs` deterministic-zip hash check).
- `bun run build` clean.
- Manual smoke test: open `examples/papers/ieee-sample/` in a dev build, hit Compile, see a PDF in the side pane within 2 s on a Ryzen 7 / 16 GB box.
- BYOF smoke: drag the IEEE TPDS 2026 zip in, adapt, compile, byte-compare the resulting PDF against the reference `pdflatex bare_conf.tex` PDF — ≥ 99% page-hash similarity (small differences from font-substitution timestamps are OK).

---

## 20. Frozen contracts (don't change without migration)

- `paper.toml` schema version is in `[meta].schema = 1`. Bump when a breaking change lands; provide a migration path in `paper/toml.rs`.
- `byof.toml` schema version is `[meta].schema = 1` too (independent of paper.toml).
- All IPC commands use `#[serde(rename_all = "camelCase")]` on every DTO (matches the BYOC + VCS pattern).
- Sidecar binary name is `tectonic` (no version suffix) — update via `npm run setup-sidecars`, never by changing the resolution name.
- `build/project.zip` SOURCE_DATE_EPOCH rule is part of the API — third-party tools that check determinism rely on it.

---

## 21. Open questions

1. **Typst version pinning.** Typst is moving fast; we pin to a single minor (0.13) for the entire app and bump on a slow cadence. Worth it to expose a "this paper uses Typst 0.13.2" line in `paper.toml [engine].version`?
2. **Tectonic distribution.** Bundled sidecar (decision above) vs "detect on PATH like Node for publishing" (mirrors the publishing-plan.md call). Recommended: bundled, because the paper deadline is a worse failure mode than the publish flow. Confirm.
3. **Bibliography backend.** Default to BibTeX for max template compatibility; opt-in biber when the BYOF importer detects `\usepackage{biblatex}`. Confirm.
4. **Overleaf upload security.** The sidecar HTTP server pattern is the cleanest; alternative is a "save zip and let the user upload" toast. Default to sidecar, fallback to toast. Confirm.
5. **Citation engine.** Use Pandoc's `--citeproc` semantics for `[@key]` resolution (CSL-JSON support out of the box) vs roll our own. Recommend Pandoc semantics; we already need a markdown-to-AST layer for the same compile pipeline.

---

## 22. Companion docs

- [`docs/impl-v2.md`](impl-v2.md) §8.1, §8.5, §8.5.13 — what we want
- [`docs/byoc-plan.md`](byoc-plan.md) — slice-B template for this doc; many UI / IPC patterns reused verbatim
- [`docs/publishing-plan.md`](publishing-plan.md) — slice-D plan; cross-references for the `[[wikilink]]` → published-URL injection rule
- [`docs/current-state.md`](current-state.md) — shipped surface today
- [`/memories/repo/lattice.md`](../memories/repo/lattice.md) — repo-scoped facts (VCS / BYOC / editor / preview)
