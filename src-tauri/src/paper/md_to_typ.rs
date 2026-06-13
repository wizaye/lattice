//! Markdown → Typst syntax converter.
//!
//! This module converts a subset of CommonMark to Typst markup that can be
//! handed to `typst_compile::compile_typst`.  Only the constructs the paper
//! export pipeline actually emits are translated — anything richer falls
//! through as escaped plain text rather than mangling the output.
//!
//! Mapping rules (see paper-export plan, slice C3):
//!
//!   `# H1`        → `= H1`
//!   `## H2`       → `== H2`
//!   `### H3`      → `=== H3`
//!   `**bold**`    → `*bold*`
//!   `*italic*`    → `_italic_`
//!   `` `code` ``  → `` `code` `` (inline raw, identical syntax)
//!   ```` ```lang\n...\n``` ```` → ```` ```lang\n...\n``` ```` (raw block)
//!   `- item`      → `- item`
//!   `1. item`     → `+ item`
//!   `[t](u)`      → `#link("u")[t]`
//!   blank line    → paragraph break
//!
//! Text nodes are run through [`escape_typst`] so the Typst sigils
//! (`#`, `$`, `*`, `_`, `\`, `<`, `>`, `@`) do not leak through and trigger
//! unintended formatting / function calls.

use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Parser, Tag, TagEnd};

/// Escape Typst-significant characters in a text node so they render
/// literally instead of being interpreted as markup.
///
/// Backslash is handled implicitly by the match arm (it is in the list).
/// Because we iterate char-by-char and only ever prepend `\` to one of the
/// listed chars, there is no risk of double-escaping a previously inserted
/// backslash.
pub fn escape_typst(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' | '#' | '$' | '*' | '_' | '<' | '>' | '@' => {
                out.push('\\');
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out
}

/// Escape a URL for embedding inside `#link("...")` — only `\` and `"`
/// need escaping inside Typst string literals.
fn escape_typst_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            _ => out.push(c),
        }
    }
    out
}

/// Convert a Markdown source string to a Typst-markup string.
///
/// The output is deliberately whitespace-light: a blank line separates
/// block-level constructs, headings/paragraphs end in `\n\n`, list items
/// end in `\n`.  Callers that need pretty-printing can run the result
/// through their own formatter.
pub fn markdown_to_typst(md: &str) -> String {
    let parser = Parser::new(md);
    let mut out = String::new();

    // `None` = unordered list, `Some(start)` = ordered list seeded at `start`.
    // Length of the stack is the current nesting depth; we use it to indent
    // nested items two spaces per level so Typst sees them as sub-lists.
    let mut list_stack: Vec<Option<u64>> = Vec::new();

    // Code blocks are emitted verbatim — no Typst-escaping, no link capture.
    let mut in_code_block = false;

    // Link state: text events between `Tag::Link` start/end go into
    // `link_text` so we can emit `#link("url")[text]` atomically at the
    // `TagEnd::Link` rather than streaming `[` / `]` and hoping nothing
    // weird shows up in between.
    let mut in_link = false;
    let mut link_url = String::new();
    let mut link_text = String::new();

    for event in parser {
        match event {
            Event::Start(tag) => match tag {
                Tag::Heading { level, .. } => {
                    let prefix = match level {
                        HeadingLevel::H1 => "= ",
                        HeadingLevel::H2 => "== ",
                        HeadingLevel::H3 => "=== ",
                        HeadingLevel::H4 => "==== ",
                        HeadingLevel::H5 => "===== ",
                        HeadingLevel::H6 => "====== ",
                    };
                    out.push_str(prefix);
                }
                Tag::Paragraph => { /* implicit; trailing blank line on End */ }
                Tag::Strong => out.push('*'),
                Tag::Emphasis => out.push('_'),
                Tag::List(start) => list_stack.push(start),
                Tag::Item => {
                    let depth = list_stack.len().saturating_sub(1);
                    for _ in 0..depth {
                        out.push_str("  ");
                    }
                    let is_ordered = matches!(list_stack.last(), Some(Some(_)));
                    if is_ordered {
                        out.push_str("+ ");
                    } else {
                        out.push_str("- ");
                    }
                }
                Tag::CodeBlock(kind) => {
                    in_code_block = true;
                    let lang = match kind {
                        CodeBlockKind::Fenced(lang) => lang.to_string(),
                        CodeBlockKind::Indented => String::new(),
                    };
                    out.push_str("```");
                    out.push_str(&lang);
                    out.push('\n');
                }
                Tag::Link { dest_url, .. } => {
                    in_link = true;
                    link_url = dest_url.to_string();
                    link_text.clear();
                }
                Tag::BlockQuote(_) => out.push_str("#quote(block: true)["),
                _ => { /* ignore: tables, images, footnotes, html, … */ }
            },
            Event::End(end) => match end {
                TagEnd::Heading(_) => out.push_str("\n\n"),
                TagEnd::Paragraph => out.push_str("\n\n"),
                TagEnd::Strong => out.push('*'),
                TagEnd::Emphasis => out.push('_'),
                TagEnd::List(_) => {
                    list_stack.pop();
                    if list_stack.is_empty() {
                        out.push('\n');
                    }
                }
                TagEnd::Item => out.push('\n'),
                TagEnd::CodeBlock => {
                    in_code_block = false;
                    out.push_str("```\n\n");
                }
                TagEnd::Link => {
                    in_link = false;
                    out.push_str("#link(\"");
                    out.push_str(&escape_typst_string(&link_url));
                    out.push_str("\")[");
                    out.push_str(&link_text);
                    out.push(']');
                    link_text.clear();
                    link_url.clear();
                }
                TagEnd::BlockQuote(_) => out.push_str("]\n\n"),
                _ => {}
            },
            Event::Text(t) => {
                if in_code_block {
                    out.push_str(&t);
                } else if in_link {
                    link_text.push_str(&escape_typst(&t));
                } else {
                    out.push_str(&escape_typst(&t));
                }
            }
            Event::Code(t) => {
                // Inline raw — Typst syntax matches CommonMark: backtick-delimited.
                if in_link {
                    link_text.push('`');
                    link_text.push_str(&t);
                    link_text.push('`');
                } else {
                    out.push('`');
                    out.push_str(&t);
                    out.push('`');
                }
            }
            Event::SoftBreak => {
                if in_link {
                    link_text.push(' ');
                } else {
                    out.push('\n');
                }
            }
            Event::HardBreak => {
                if in_link {
                    link_text.push(' ');
                } else {
                    // Typst hard line break: trailing backslash on the line.
                    out.push_str(" \\\n");
                }
            }
            Event::Rule => out.push_str("#line(length: 100%)\n\n"),
            // Drop HTML, footnotes, task list markers, tables — Typst has its
            // own constructs and silently swallowing keeps output well-formed.
            _ => {}
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headings_map_to_equals() {
        assert!(markdown_to_typst("# Hello").starts_with("= Hello"));
        assert!(markdown_to_typst("## Hi").starts_with("== Hi"));
        assert!(markdown_to_typst("### Yo").starts_with("=== Yo"));
    }

    #[test]
    fn bold_and_italic() {
        let out = markdown_to_typst("**bold** and *italic*");
        assert!(out.contains("*bold*"));
        assert!(out.contains("_italic_"));
    }

    #[test]
    fn escape_sigils() {
        assert_eq!(escape_typst("a#b$c"), "a\\#b\\$c");
        assert_eq!(escape_typst("a@b"), "a\\@b");
        assert_eq!(escape_typst("\\"), "\\\\");
    }

    #[test]
    fn link_emits_typst_link() {
        let out = markdown_to_typst("[label](https://example.com)");
        assert!(out.contains("#link(\"https://example.com\")[label]"));
    }

    #[test]
    fn ordered_list_uses_plus() {
        let out = markdown_to_typst("1. one\n2. two\n");
        assert!(out.contains("+ one"));
        assert!(out.contains("+ two"));
    }

    #[test]
    fn fenced_code_preserved_verbatim() {
        let out = markdown_to_typst("```rust\nfn f() {}\n```");
        assert!(out.contains("```rust\nfn f() {}\n```"));
    }
}
