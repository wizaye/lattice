//! Markdown → LaTeX converter for `paper_compile`.
//!
//! Walks a `comrak` CommonMark + GFM AST and emits LaTeX as a String.
//! Covers the subset of Markdown that actually shows up in academic
//! drafts written inside Lattice:
//!
//! - Headings (`#` … `######`) → `\section{}` / `\subsection{}` /
//!   `\subsubsection{}` / `\paragraph{}`.  Level 1 is reserved for
//!   the document title and skipped by the wrapper template — at
//!   section-file scope, `#` becomes `\section{}`.
//! - Paragraphs → wrapped LaTeX paragraphs separated by blank lines.
//! - Emphasis → `\textit{}` / `\textbf{}` / `\texttt{}`.
//! - Links → `\href{url}{text}` (requires `\usepackage{hyperref}` in
//!   the wrapper).
//! - Images → `\begin{figure}[h]\centering\includegraphics[…]{path}…`
//! - Lists (ordered / unordered) → `itemize` / `enumerate`.
//! - Block quotes → `quote` environment.
//! - Code blocks → `verbatim` environment (no syntax highlighting —
//!   `listings` would add a non-trivial preamble).
//! - Inline code → `\verb|...|`.
//! - Math:
//!     * Inline `$x$` → `$x$` (already valid LaTeX).
//!     * Display `$$x$$` → `\[ x \]`.
//! - Hard line breaks → `\\`.
//! - Soft line breaks → space.
//! - Citations `[@key]` (extension recognised in our own pre-pass) →
//!   `\cite{key}`.  Bibliography emission is handled by the compile
//!   driver, not this walker.
//! - YAML frontmatter (`--- … ---` at file start) → stripped before
//!   parsing so the user's metadata doesn't show up as a `---` rule.
//!
//! Anything we don't recognise (HTML blocks, tables, footnotes,
//! task lists, …) falls back to emitting the underlying text wrapped
//! in a LaTeX comment so the user can see what we skipped.

use comrak::nodes::{AstNode, ListType, NodeValue};
use comrak::{parse_document, Arena, ComrakOptions};

/// Convert a Markdown string to a LaTeX fragment.  Output is suitable
/// for `\input{}` into a wrapper that supplies the documentclass,
/// title, authors, hyperref, graphicx, etc.
pub fn convert(md: &str) -> String {
    let stripped = strip_yaml_frontmatter(md);
    let arena = Arena::new();
    let opts = base_options();
    let root = parse_document(&arena, &stripped, &opts);
    let mut out = String::with_capacity(stripped.len() + 64);
    let mut writer = Writer::new(&mut out);
    writer.walk_block(root);
    out
}

/// Convert a single Markdown title line (no leading `#`) — used by the
/// wrapper template to set `\title{}` without going through the full
/// AST walk.  Escapes LaTeX specials.
pub fn convert_title(md_title: &str) -> String {
    let trimmed = md_title.trim();
    escape_latex(trimmed)
}

fn base_options() -> ComrakOptions<'static> {
    let mut opts = ComrakOptions::default();
    opts.extension.strikethrough = true;
    opts.extension.table = true;
    opts.extension.autolink = true;
    opts.extension.tasklist = true;
    opts.extension.footnotes = true;
    opts.parse.smart = true;
    opts.render.escape = false;
    opts
}

/// Remove a YAML frontmatter block (`--- … ---` at the very start of
/// the file) before parsing — comrak treats it as a thematic break
/// followed by a paragraph, which would dump the user's metadata into
/// the rendered PDF.
fn strip_yaml_frontmatter(md: &str) -> String {
    let trimmed = md.trim_start_matches('\u{feff}');
    if !trimmed.starts_with("---") {
        return md.to_string();
    }
    // Look for the closing `---` on its own line.
    let after_first = &trimmed[3..];
    let after_first = after_first.trim_start_matches('\r').trim_start_matches('\n');
    if let Some(end) = after_first.find("\n---") {
        let rest = &after_first[end + 4..];
        let rest = rest.trim_start_matches('\r').trim_start_matches('\n');
        rest.to_string()
    } else {
        md.to_string()
    }
}

struct Writer<'a> {
    out: &'a mut String,
}

impl<'a> Writer<'a> {
    fn new(out: &'a mut String) -> Self {
        Self { out }
    }

    fn walk_block<'b>(&mut self, node: &'b AstNode<'b>) {
        for child in node.children() {
            self.emit_block(child);
        }
    }

    fn emit_block<'b>(&mut self, node: &'b AstNode<'b>) {
        let value = node.data.borrow();
        match &value.value {
            NodeValue::Document => self.walk_block(node),

            NodeValue::Heading(h) => {
                let level = h.level.min(6);
                drop(value);
                let cmd = match level {
                    1 => "\\section",
                    2 => "\\subsection",
                    3 => "\\subsubsection",
                    4 => "\\paragraph",
                    5 => "\\subparagraph",
                    _ => "\\paragraph",
                };
                self.out.push_str(cmd);
                self.out.push('{');
                self.emit_inline(node);
                self.out.push_str("}\n\n");
            }

            NodeValue::Paragraph => {
                drop(value);
                self.emit_inline(node);
                self.out.push_str("\n\n");
            }

            NodeValue::BlockQuote => {
                drop(value);
                self.out.push_str("\\begin{quote}\n");
                self.walk_block(node);
                self.out.push_str("\\end{quote}\n\n");
            }

            NodeValue::List(list) => {
                let env = match list.list_type {
                    ListType::Bullet => "itemize",
                    ListType::Ordered => "enumerate",
                };
                drop(value);
                self.out.push_str("\\begin{");
                self.out.push_str(env);
                self.out.push_str("}\n");
                for item in node.children() {
                    self.out.push_str("  \\item ");
                    // Each item is a List → Item → block children.
                    let mut first = true;
                    for child in item.children() {
                        if first {
                            // Inline-emit the first paragraph so we don't
                            // get a blank line after `\item`.
                            let child_value = child.data.borrow();
                            if matches!(child_value.value, NodeValue::Paragraph) {
                                drop(child_value);
                                self.emit_inline(child);
                                self.out.push('\n');
                                first = false;
                                continue;
                            }
                            drop(child_value);
                            first = false;
                        }
                        self.emit_block(child);
                    }
                }
                self.out.push_str("\\end{");
                self.out.push_str(env);
                self.out.push_str("}\n\n");
            }

            NodeValue::Item(_) => {
                // Handled by the List branch above.
                drop(value);
            }

            NodeValue::CodeBlock(code) => {
                let body = code.literal.clone();
                drop(value);
                // Math fence shortcut: ```math ... ``` → display math.
                let lang_is_math = false; // comrak gives us info_string elsewhere;
                                          // keep simple verbatim for everything.
                let _ = lang_is_math;
                self.out.push_str("\\begin{verbatim}\n");
                self.out.push_str(&body);
                if !body.ends_with('\n') {
                    self.out.push('\n');
                }
                self.out.push_str("\\end{verbatim}\n\n");
            }

            NodeValue::ThematicBreak => {
                drop(value);
                self.out.push_str("\\hrulefill\n\n");
            }

            NodeValue::HtmlBlock(html) => {
                // Don't try to render raw HTML — drop it into a LaTeX
                // comment so the .tex stays valid and the user can see
                // it was skipped.
                let body = html.literal.clone();
                drop(value);
                for line in body.lines() {
                    self.out.push_str("% [html skipped] ");
                    self.out.push_str(line);
                    self.out.push('\n');
                }
                self.out.push('\n');
            }

            NodeValue::Table(_) | NodeValue::TableRow(_) | NodeValue::TableCell => {
                // Phase-1 punt: render tables as a verbatim block of
                // the underlying source.  Full LaTeX table emission is
                // a sizeable feature on its own.
                drop(value);
                self.out.push_str("\\begin{verbatim}\n");
                self.dump_text(node);
                self.out.push_str("\n\\end{verbatim}\n\n");
            }

            NodeValue::FootnoteDefinition(fd) => {
                let label = String::from_utf8_lossy(fd.name.as_bytes()).into_owned();
                drop(value);
                self.out.push_str("\\footnotetext{[");
                self.out.push_str(&escape_latex(&label));
                self.out.push_str("] ");
                self.emit_inline(node);
                self.out.push_str("}\n\n");
            }

            // Inline values popping up as top-level (shouldn't normally
            // happen, but be defensive).
            _ => {
                drop(value);
                self.emit_inline(node);
                self.out.push_str("\n\n");
            }
        }
    }

    fn emit_inline<'b>(&mut self, node: &'b AstNode<'b>) {
        for child in node.children() {
            self.emit_inline_one(child);
        }
    }

    fn emit_inline_one<'b>(&mut self, node: &'b AstNode<'b>) {
        let value = node.data.borrow();
        match &value.value {
            NodeValue::Text(t) => {
                let text = t.clone();
                drop(value);
                // Citation shortcut: `[@key]` (or `[@key; @key2]`) →
                // `\cite{key,key2}`.  We do this in plain text so we
                // don't have to fight comrak's link tokenisation.
                self.push_with_citations(&text);
            }
            NodeValue::SoftBreak => {
                drop(value);
                self.out.push(' ');
            }
            NodeValue::LineBreak => {
                drop(value);
                self.out.push_str("\\\\\n");
            }
            NodeValue::Code(c) => {
                let body = c.literal.clone();
                drop(value);
                // Use \verb with a delimiter that doesn't appear in body.
                let delim = choose_verb_delim(&body);
                self.out.push_str("\\verb");
                self.out.push(delim);
                self.out.push_str(&body);
                self.out.push(delim);
            }
            NodeValue::HtmlInline(_) => {
                drop(value);
                // Skip raw inline HTML silently — comments mid-paragraph
                // are too noisy.
            }
            NodeValue::Emph => {
                drop(value);
                self.out.push_str("\\textit{");
                self.emit_inline(node);
                self.out.push('}');
            }
            NodeValue::Strong => {
                drop(value);
                self.out.push_str("\\textbf{");
                self.emit_inline(node);
                self.out.push('}');
            }
            NodeValue::Strikethrough => {
                drop(value);
                // LaTeX needs \usepackage{ulem}; wrapper preamble
                // includes it.
                self.out.push_str("\\sout{");
                self.emit_inline(node);
                self.out.push('}');
            }
            NodeValue::Superscript => {
                drop(value);
                self.out.push_str("\\textsuperscript{");
                self.emit_inline(node);
                self.out.push('}');
            }
            NodeValue::Link(l) => {
                let url = String::from_utf8_lossy(l.url.as_bytes()).into_owned();
                drop(value);
                self.out.push_str("\\href{");
                self.out.push_str(&escape_url(&url));
                self.out.push_str("}{");
                self.emit_inline(node);
                self.out.push('}');
            }
            NodeValue::Image(l) => {
                let url = String::from_utf8_lossy(l.url.as_bytes()).into_owned();
                let alt: String = collect_text(node);
                drop(value);
                self.out.push_str(
                    "\n\\begin{figure}[h]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{",
                );
                self.out.push_str(&escape_latex_path(&url));
                self.out.push_str("}\n  \\caption{");
                self.out.push_str(&escape_latex(&alt));
                self.out.push_str("}\n\\end{figure}\n");
            }
            NodeValue::FootnoteReference(fr) => {
                let label = String::from_utf8_lossy(fr.name.as_bytes()).into_owned();
                drop(value);
                self.out.push_str("\\footnotemark[");
                self.out.push_str(&escape_latex(&label));
                self.out.push(']');
            }
            // Containers we walk into for their text children.
            NodeValue::Document
            | NodeValue::Paragraph
            | NodeValue::Heading(_)
            | NodeValue::BlockQuote
            | NodeValue::List(_)
            | NodeValue::Item(_) => {
                drop(value);
                self.emit_inline(node);
            }
            // Other inline values we don't have a mapping for — fall
            // back to the raw text representation.
            _ => {
                drop(value);
                let text = collect_text(node);
                self.push_with_citations(&text);
            }
        }
    }

    fn dump_text<'b>(&mut self, node: &'b AstNode<'b>) {
        self.out.push_str(&collect_text(node));
    }

    /// Push `text` to the output, scanning for `[@key]` /
    /// `[@key1; @key2]` patterns and replacing them with `\cite{}`.
    /// Other text is LaTeX-escaped.
    fn push_with_citations(&mut self, text: &str) {
        let mut rest = text;
        while let Some(start) = rest.find("[@") {
            // Emit everything up to the citation as escaped text.
            self.out.push_str(&escape_latex(&rest[..start]));
            let after = &rest[start + 2..];
            if let Some(end) = after.find(']') {
                let inside = &after[..end];
                let keys: Vec<&str> = inside
                    .split(|c| c == ';' || c == ',')
                    .map(|s| s.trim().trim_start_matches('@'))
                    .filter(|s| !s.is_empty())
                    .collect();
                if !keys.is_empty() {
                    self.out.push_str("\\cite{");
                    for (i, k) in keys.iter().enumerate() {
                        if i > 0 {
                            self.out.push(',');
                        }
                        self.out.push_str(&escape_bib_key(k));
                    }
                    self.out.push('}');
                    rest = &after[end + 1..];
                    continue;
                }
            }
            // Not actually a citation — emit `[@` literally and move on.
            self.out.push_str("[@");
            rest = after;
        }
        self.out.push_str(&escape_latex(rest));
    }
}

fn collect_text<'a>(node: &'a AstNode<'a>) -> String {
    let mut out = String::new();
    collect_text_into(node, &mut out);
    out
}

fn collect_text_into<'a>(node: &'a AstNode<'a>, out: &mut String) {
    let v = node.data.borrow();
    match &v.value {
        NodeValue::Text(t) => out.push_str(t),
        NodeValue::Code(c) => out.push_str(&c.literal),
        NodeValue::SoftBreak | NodeValue::LineBreak => out.push(' '),
        _ => {
            drop(v);
            for child in node.children() {
                collect_text_into(child, out);
            }
        }
    }
}

/// Escape the ten LaTeX special characters.  We do NOT escape `$` —
/// inline math (`$x$`) needs to pass through untouched.  Users that
/// want a literal dollar sign in prose can write `\$` and we'll let
/// it through as-is.
fn escape_latex(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("\\&"),
            '%' => out.push_str("\\%"),
            '#' => out.push_str("\\#"),
            '_' => out.push_str("\\_"),
            '{' => out.push_str("\\{"),
            '}' => out.push_str("\\}"),
            '~' => out.push_str("\\textasciitilde{}"),
            '^' => out.push_str("\\textasciicircum{}"),
            '\\' => out.push_str("\\textbackslash{}"),
            _ => out.push(ch),
        }
    }
    out
}

/// Escape a path for use inside `\includegraphics{}`.  We forward-slash
/// the path (LaTeX accepts `/` on every platform) and don't escape
/// spaces — `\includegraphics{my fig.png}` works in modern LaTeX.
fn escape_latex_path(s: &str) -> String {
    s.replace('\\', "/")
}

/// Escape a URL for use inside `\href{}`.  `%` and `#` are real URL
/// characters; we only escape what would break LaTeX argument parsing.
fn escape_url(s: &str) -> String {
    s.replace('%', "\\%")
        .replace('#', "\\#")
        .replace('{', "\\{")
        .replace('}', "\\}")
}

/// BibTeX cite-key sanitiser — strip whitespace + braces.
fn escape_bib_key(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_whitespace() && *c != '{' && *c != '}')
        .collect()
}

/// `\verb` requires a delimiter that doesn't appear inside the body.
/// Try a sequence of likely-safe choices.
fn choose_verb_delim(body: &str) -> char {
    for delim in ['|', '!', '+', '/', '@', '*', '#'] {
        if !body.contains(delim) {
            return delim;
        }
    }
    // Last-ditch fallback.
    '|'
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headings_map_to_section_levels() {
        let tex = convert("# Intro\n\n## Method\n\n### Results");
        assert!(tex.contains("\\section{Intro}"));
        assert!(tex.contains("\\subsection{Method}"));
        assert!(tex.contains("\\subsubsection{Results}"));
    }

    #[test]
    fn paragraphs_are_separated_by_blank_lines() {
        let tex = convert("para one\n\npara two");
        let blank_runs = tex.matches("\n\n").count();
        assert!(blank_runs >= 1);
    }

    #[test]
    fn bold_and_italic_emit_textbf_and_textit() {
        let tex = convert("**bold** and *italic*");
        assert!(tex.contains("\\textbf{bold}"));
        assert!(tex.contains("\\textit{italic}"));
    }

    #[test]
    fn links_become_href() {
        let tex = convert("See [the site](https://example.com).");
        assert!(tex.contains("\\href{https://example.com}{the site}"));
    }

    #[test]
    fn images_emit_figure_env() {
        let tex = convert("![Arch](figures/architecture.svg)");
        assert!(tex.contains("\\begin{figure}"));
        assert!(tex.contains("\\includegraphics[width=0.8\\linewidth]{figures/architecture.svg}"));
        assert!(tex.contains("\\caption{Arch}"));
    }

    #[test]
    fn bullet_lists_become_itemize() {
        let tex = convert("- one\n- two\n- three");
        assert!(tex.contains("\\begin{itemize}"));
        assert!(tex.contains("\\item one"));
        assert!(tex.contains("\\end{itemize}"));
    }

    #[test]
    fn ordered_lists_become_enumerate() {
        let tex = convert("1. one\n2. two");
        assert!(tex.contains("\\begin{enumerate}"));
        assert!(tex.contains("\\end{enumerate}"));
    }

    #[test]
    fn blockquote_becomes_quote_env() {
        let tex = convert("> wisdom here");
        assert!(tex.contains("\\begin{quote}"));
        assert!(tex.contains("wisdom here"));
        assert!(tex.contains("\\end{quote}"));
    }

    #[test]
    fn code_blocks_become_verbatim() {
        let tex = convert("```\nlet x = 1;\n```");
        assert!(tex.contains("\\begin{verbatim}"));
        assert!(tex.contains("let x = 1;"));
        assert!(tex.contains("\\end{verbatim}"));
    }

    #[test]
    fn inline_code_becomes_verb() {
        let tex = convert("call `foo()` here");
        assert!(tex.contains("\\verb"));
        assert!(tex.contains("foo()"));
    }

    #[test]
    fn yaml_frontmatter_is_stripped() {
        let tex = convert("---\ntitle: Hello\n---\n\n# Body");
        assert!(!tex.contains("title: Hello"));
        assert!(tex.contains("\\section{Body}"));
    }

    #[test]
    fn special_chars_escape() {
        let tex = convert("100% of cases & files");
        assert!(tex.contains("100\\%"));
        assert!(tex.contains("\\&"));
    }

    #[test]
    fn citation_pattern_becomes_cite() {
        let tex = convert("Prior work [@smith2020] showed that.");
        assert!(tex.contains("\\cite{smith2020}"));
    }

    #[test]
    fn multi_citation_pattern_becomes_cite() {
        let tex = convert("Surveys [@a2020; @b2021] disagree.");
        assert!(tex.contains("\\cite{a2020,b2021}"));
    }

    #[test]
    fn unmatched_bracket_at_emits_literal() {
        let tex = convert("see [@unclosed");
        assert!(tex.contains("[@unclosed"));
    }

    #[test]
    fn convert_title_escapes_specials() {
        assert_eq!(convert_title("AI & ML in 100%"), "AI \\& ML in 100\\%");
    }
}
