//! Built-in paper templates.
//!
//! Phase C1 ships **one** template end-to-end (`ieee-conf`) so the
//! "New Paper → IEEE Conf → folder appears" loop works.  The other
//! built-ins (IEEE Journal / Springer LNCS / ACM / APA 7) are declared
//! in the registry below so the picker can render real cards from day
//! one, but their `default_engine` is `Tectonic` and they'll route
//! through the BYOF/Tectonic adapter once it lands in phase C3/C4.
//!
//! `write_scaffold` writes the §12 file tree from the plan.  Every
//! file has real working content — no lorem ipsum — so the very first
//! `paper_compile` produces a paper that looks like a paper.

use std::io::Write;
use std::path::Path;

use super::{EngineKind, NewPaperRequest, TemplateInfo, TemplateSource};

/// Hard-coded built-in registry.  Returning by value (clone) keeps the
/// IPC layer trivial — there's no need for a `lazy_static` here.
pub fn built_in_templates() -> Vec<TemplateInfo> {
    vec![
        TemplateInfo {
            id: "ieee-conf".to_string(),
            label: "IEEE Conference".to_string(),
            description: "Two-column IEEE conference paper (compsoc / 10pt).".to_string(),
            source: TemplateSource::BuiltIn,
            engines: vec![EngineKind::Typst, EngineKind::Tectonic],
            default_engine: EngineKind::Typst,
            preview: None,
        },
        TemplateInfo {
            id: "ieee-journal".to_string(),
            label: "IEEE Journal (Transactions)".to_string(),
            description: "Single-column IEEE Transactions style — TPAMI/TSE/etc.".to_string(),
            source: TemplateSource::BuiltIn,
            engines: vec![EngineKind::Tectonic],
            default_engine: EngineKind::Tectonic,
            preview: None,
        },
        TemplateInfo {
            id: "springer-lncs".to_string(),
            label: "Springer LNCS".to_string(),
            description: "Lecture Notes in Computer Science — single column, 9pt.".to_string(),
            source: TemplateSource::BuiltIn,
            engines: vec![EngineKind::Tectonic],
            default_engine: EngineKind::Tectonic,
            preview: None,
        },
        TemplateInfo {
            id: "acm-sigconf".to_string(),
            label: "ACM SIGCONF".to_string(),
            description: "ACM sigconf two-column conference proceedings.".to_string(),
            source: TemplateSource::BuiltIn,
            engines: vec![EngineKind::Tectonic],
            default_engine: EngineKind::Tectonic,
            preview: None,
        },
        TemplateInfo {
            id: "apa7".to_string(),
            label: "APA 7th edition".to_string(),
            description: "Single-column APA 7 (psych / education).".to_string(),
            source: TemplateSource::BuiltIn,
            engines: vec![EngineKind::Tectonic],
            default_engine: EngineKind::Tectonic,
            preview: None,
        },
    ]
}

/// Write the §12 New-Paper scaffold to `paper_abs`.  The folder must
/// not exist yet (the caller, `paper_create`, already disambiguated).
pub fn write_scaffold(
    paper_abs: &Path,
    template: &TemplateInfo,
    req: &NewPaperRequest,
) -> std::io::Result<()> {
    std::fs::create_dir_all(paper_abs)?;
    std::fs::create_dir_all(paper_abs.join("sections"))?;
    std::fs::create_dir_all(paper_abs.join("figures"))?;
    std::fs::create_dir_all(paper_abs.join("tables"))?;
    std::fs::create_dir_all(paper_abs.join(".lattice"))?;

    let title = &req.title;
    let authors_yaml = render_authors_yaml(&req.authors);

    write(paper_abs.join("README.md"), readme_md(title, template))?;
    write(paper_abs.join("title.md"), title_md(title, &authors_yaml))?;
    write(paper_abs.join("abstract.md"), abstract_md(title))?;

    write(paper_abs.join("sections/01-introduction.md"), section_intro_md(title))?;
    write(paper_abs.join("sections/02-related-work.md"), section_related_md())?;
    write(paper_abs.join("sections/03-method.md"), section_method_md())?;
    write(paper_abs.join("sections/04-results.md"), section_results_md())?;
    write(paper_abs.join("sections/05-discussion.md"), section_discussion_md())?;
    write(paper_abs.join("sections/06-conclusion.md"), section_conclusion_md())?;

    write(paper_abs.join("figures/README.md"), figures_readme_md())?;
    // Stub architecture diagram so the very first compile shows a figure.
    write(paper_abs.join("figures/architecture.svg"), placeholder_svg())?;

    write(paper_abs.join("tables/results-table.md"), results_table_md())?;

    write(paper_abs.join("bibliography.bib"), bibliography_bib())?;
    write(paper_abs.join("citations.md"), citations_md())?;
    write(paper_abs.join("notes.md"), notes_md())?;

    write(paper_abs.join(".lattice/checklist.md"), checklist_md())?;
    write(paper_abs.join(".lattice/paper-state.json"), "{}\n")?;

    // Engine-specific entry-point: paper.typ for Typst, paper.tex for
    // Tectonic.  These are intentionally minimal — the real conversion
    // happens at compile time via md_to_typ / md_to_tex (phase C1/C4).
    match template.default_engine {
        EngineKind::Typst => write(paper_abs.join("paper.typ"), paper_typ_seed(template, title))?,
        EngineKind::Tectonic => write(paper_abs.join("paper.tex"), paper_tex_seed(template, title))?,
    }

    // .gitignore — build artefacts and `node_modules`-style noise.
    write(paper_abs.join(".gitignore"), gitignore_seed())?;

    Ok(())
}

fn write(path: std::path::PathBuf, body: impl AsRef<[u8]>) -> std::io::Result<()> {
    let mut f = std::fs::File::create(path)?;
    f.write_all(body.as_ref())
}

fn render_authors_yaml(authors: &[super::NewPaperAuthor]) -> String {
    if authors.is_empty() {
        return "  - name: \"Your Name\"\n    affiliation: \"Your Affiliation\"\n".to_string();
    }
    let mut out = String::new();
    for a in authors {
        out.push_str("  - name: \"");
        out.push_str(&a.name.replace('"', "\\\""));
        out.push_str("\"\n");
        if let Some(e) = &a.email {
            out.push_str("    email: \"");
            out.push_str(&e.replace('"', "\\\""));
            out.push_str("\"\n");
        }
        if let Some(aff) = &a.affiliation {
            out.push_str("    affiliation: \"");
            out.push_str(&aff.replace('"', "\\\""));
            out.push_str("\"\n");
        }
        if let Some(o) = &a.orcid {
            out.push_str("    orcid: \"");
            out.push_str(&o.replace('"', "\\\""));
            out.push_str("\"\n");
        }
    }
    out
}

// ─── File seed bodies ────────────────────────────────────────────────────

fn readme_md(title: &str, template: &TemplateInfo) -> String {
    format!(
        "# {title}\n\nThis folder is a Lattice **paper**.\n\n\
        - Template: `{tid}` ({tlabel})\n\
        - Default engine: `{engine}`\n\n\
        ## Compile\n\n\
        Click **Compile** in the paper toolbar (or run the `Compile paper` command).  \
        The output PDF lands at `build/paper.pdf`.\n\n\
        ## Edit\n\n\
        Section bodies live under `sections/`.  Authors, title, and keywords are in `title.md`'s frontmatter.  \
        Bibliography entries go in `bibliography.bib` — `[@key]` in the Markdown becomes `\\cite{{key}}` on compile.\n\n\
        ## Configure\n\n\
        Per-paper settings (engine, template flavor, preflight rules) are in `.lattice/paper.toml`.  \
        See `docs/paper-export-plan.md` for the full schema.\n",
        title = title,
        tid = template.id,
        tlabel = template.label,
        engine = template.default_engine.as_str(),
    )
}

fn title_md(title: &str, authors_yaml: &str) -> String {
    format!(
        "---\ntitle: \"{title}\"\nauthors:\n{authors}\
        keywords: [\"local-first\", \"personal-knowledge-management\"]\n---\n\n# {title}\n",
        title = title,
        authors = authors_yaml,
    )
}

fn abstract_md(title: &str) -> String {
    format!(
        "# Abstract\n\n\
        Replace this paragraph with your ~250-word abstract for *{title}*.  \
        State the problem, the contribution, the result, and the implication in four sentences.  \
        Avoid jargon in the first sentence — the abstract is the only part of the paper most readers will ever read.\n",
        title = title,
    )
}

fn section_intro_md(title: &str) -> String {
    format!(
        "# Introduction\n\n\
        *{title}* opens by motivating the problem from a reader who has never heard of your field.  \
        Sketch the gap, claim the contribution, and forward-reference the rest of the paper.\n\n\
        - Motivation paragraph (why does this matter outside your subfield?).\n\
        - Contribution bullets (what is new — be specific).\n\
        - Paper roadmap (one sentence per remaining section).\n",
        title = title,
    )
}

fn section_related_md() -> String {
    "# Related Work\n\nGroup prior work into 2–4 themes.  \
    For each theme, cite the canonical entry once (`[@author2024]`), \
    then say what you *do differently*, not just what they did.\n".to_string()
}

fn section_method_md() -> String {
    "# Methods\n\nDescribe the method in enough detail that a competent reader can reimplement.  \
    Use one figure (in `figures/architecture.svg`) and pseudocode where helpful.  \
    State the assumptions explicitly.\n".to_string()
}

fn section_results_md() -> String {
    "# Results\n\nLead with the headline finding (one sentence).  \
    Then the supporting evidence: the main table (`tables/results-table.md`), \
    one ablation, one comparison.  \
    Reserve discussion of *why* for the next section.\n".to_string()
}

fn section_discussion_md() -> String {
    "# Discussion\n\nInterpret the results.  \
    Address the obvious objections.  \
    State the limitations honestly — reviewers love it when authors do this work for them.\n".to_string()
}

fn section_conclusion_md() -> String {
    "# Conclusion\n\nRestate the contribution in one paragraph.  \
    Point forward to one or two natural follow-ups.  \
    No new results in the conclusion.\n".to_string()
}

fn figures_readme_md() -> String {
    "# figures/\n\nDrop figures here as `.svg`, `.pdf`, `.png`, or `.jpg`.  \
    Reference them from Markdown with `![caption](figures/your-figure.svg){#fig:label width=80%}`.  \
    The compile pipeline copies them verbatim into the LaTeX project bundle.\n".to_string()
}

fn placeholder_svg() -> String {
    // 600x300 placeholder so the first compile produces a paper with a
    // visible figure block.  Hand-rolled to avoid an external dep.
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
     <svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 600 300\">\n\
     <rect x=\"0\" y=\"0\" width=\"600\" height=\"300\" fill=\"#f3f4f6\" stroke=\"#9ca3af\" stroke-width=\"2\"/>\n\
     <text x=\"300\" y=\"150\" text-anchor=\"middle\" font-family=\"sans-serif\" font-size=\"24\" fill=\"#4b5563\">\n\
     Architecture diagram — replace me\n\
     </text>\n\
     </svg>\n".to_string()
}

fn results_table_md() -> String {
    "# Results table\n\n\
     | Method            | Accuracy | F1   | Cost  |\n\
     |-------------------|---------:|-----:|------:|\n\
     | Baseline          |    72.4% | 0.71 | $1.00 |\n\
     | + Our contribution|    81.2% | 0.79 | $1.05 |\n\
     | Strong baseline   |    79.6% | 0.77 | $4.20 |\n".to_string()
}

fn bibliography_bib() -> String {
    "@article{turing1950,\n  author    = {Alan M. Turing},\n  title     = {Computing Machinery and Intelligence},\n  journal   = {Mind},\n  volume    = {59},\n  number    = {236},\n  pages     = {433--460},\n  year      = {1950}\n}\n\n\
     @article{mccarthy1960,\n  author    = {John McCarthy},\n  title     = {Recursive Functions of Symbolic Expressions and Their Computation by Machine, {Part I}},\n  journal   = {Communications of the ACM},\n  volume    = {3},\n  number    = {4},\n  pages     = {184--195},\n  year      = {1960}\n}\n\n\
     @article{hopper1952,\n  author    = {Grace M. Hopper},\n  title     = {The Education of a Computer},\n  journal   = {Proceedings of the ACM National Meeting},\n  pages     = {243--249},\n  year      = {1952}\n}\n".to_string()
}

fn citations_md() -> String {
    "# Citations index\n\nAuto-maintained by Lattice.  Each entry from `bibliography.bib` appears here as a clickable backlink target.\n".to_string()
}

fn notes_md() -> String {
    "---\nbuild: false\n---\n\n# Scratch notes\n\nThis file is excluded from the build (frontmatter `build: false`).  \
    Use it for reviewer-feedback notes, todo lists, and freeform planning.\n".to_string()
}

fn checklist_md() -> String {
    "# Submission checklist\n\n\
     - [ ] Title under venue word limit\n\
     - [ ] Abstract reads cleanly without context\n\
     - [ ] Anonymisation (if double-blind)\n\
     - [ ] All figures have alt text\n\
     - [ ] All authors have ORCIDs\n\
     - [ ] Bibliography compiles cleanly\n\
     - [ ] Reproducibility appendix attached\n".to_string()
}

fn paper_typ_seed(template: &TemplateInfo, title: &str) -> String {
    // Minimal Typst entry point.  The real conversion (markdown → Typst
    // AST) lands in phase C1's compile half; for now this gives the user
    // a `paper.typ` they can open in any Typst editor as a sanity check.
    format!(
        "// Lattice paper — engine = typst, template = {tid}.\n\
         // Source of truth is the Markdown under sections/.  This file\n\
         // is the entry point the compile pipeline regenerates on every\n\
         // run; hand-edits will be overwritten unless `[build].keep_tex = true`.\n\
         \n\
         #set document(title: \"{title}\")\n\
         #set page(paper: \"a4\")\n\
         \n\
         = {title}\n\
         \n\
         // The compile pipeline replaces this comment with the converted\n\
         // sections from sections/*.md.\n",
        tid = template.id,
        title = escape_typst(title),
    )
}

fn paper_tex_seed(template: &TemplateInfo, title: &str) -> String {
    format!(
        "% Lattice paper — engine = tectonic, template = {tid}.\n\
         % Source of truth is the Markdown under sections/.  This file is\n\
         % the entry point the compile pipeline regenerates on every run;\n\
         % hand-edits will be overwritten unless [build].keep_tex = true.\n\
         \\documentclass[conference]{{IEEEtran}}\n\
         \\title{{{title}}}\n\
         \\begin{{document}}\n\
         \\maketitle\n\
         % The compile pipeline replaces this comment with the converted\n\
         % sections from sections/*.md.\n\
         \\end{{document}}\n",
        tid = template.id,
        title = escape_tex(title),
    )
}

fn gitignore_seed() -> String {
    "# Lattice paper — build artefacts\nbuild/\n*.aux\n*.log\n*.out\n*.toc\n*.bbl\n*.blg\n*.synctex.gz\n".to_string()
}

fn escape_typst(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

fn escape_tex(s: &str) -> String {
    // Minimal — enough for titles in the seed.  The real md_to_tex
    // writer (phase C1 compile half) does the full escape table.
    s.replace('\\', "\\textbackslash{}")
        .replace('{', "\\{")
        .replace('}', "\\}")
        .replace('$', "\\$")
        .replace('%', "\\%")
        .replace('&', "\\&")
        .replace('#', "\\#")
        .replace('_', "\\_")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn built_in_registry_has_five_templates() {
        let v = built_in_templates();
        assert_eq!(v.len(), 5);
        assert!(v.iter().any(|t| t.id == "ieee-conf"));
        assert!(v.iter().any(|t| t.id == "apa7"));
    }

    #[test]
    fn write_scaffold_produces_expected_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let paper = tmp.path().join("test-paper");
        let template = built_in_templates()
            .into_iter()
            .find(|t| t.id == "ieee-conf")
            .unwrap();
        let req = NewPaperRequest {
            vault: tmp.path().to_string_lossy().to_string(),
            parent_rel: String::new(),
            title: "Test Paper".to_string(),
            template_id: "ieee-conf".to_string(),
            authors: vec![super::super::NewPaperAuthor {
                name: "Ada Lovelace".to_string(),
                email: Some("ada@example.org".to_string()),
                affiliation: Some("Example University".to_string()),
                orcid: None,
            }],
        };
        write_scaffold(&paper, &template, &req).unwrap();

        assert!(paper.join("README.md").is_file());
        assert!(paper.join("title.md").is_file());
        assert!(paper.join("abstract.md").is_file());
        assert!(paper.join("sections/01-introduction.md").is_file());
        assert!(paper.join("sections/06-conclusion.md").is_file());
        assert!(paper.join("figures/architecture.svg").is_file());
        assert!(paper.join("tables/results-table.md").is_file());
        assert!(paper.join("bibliography.bib").is_file());
        assert!(paper.join(".lattice/checklist.md").is_file());
        assert!(paper.join("paper.typ").is_file());
        assert!(paper.join(".gitignore").is_file());

        let title = std::fs::read_to_string(paper.join("title.md")).unwrap();
        assert!(title.contains("Ada Lovelace"));
        assert!(title.contains("ada@example.org"));
    }

    #[test]
    fn escape_tex_handles_specials() {
        assert_eq!(escape_tex("100%"), "100\\%");
        assert_eq!(escape_tex("a&b"), "a\\&b");
    }
}
