import { useEffect, useMemo, useRef } from "react";
import MarkdownIt from "markdown-it";
import katex from "katex";
// markdown-it-texmath has no bundled types; the plugin signature we
// rely on (`(md, options)`) is simple enough to declare inline rather
// than carrying a dummy `.d.ts` shim around.
// @ts-expect-error — no types ship with the package.
import texmath from "markdown-it-texmath";
import "katex/dist/katex.min.css";

/**
 * Reading-mode renderer.
 *
 * Uses `markdown-it` to do full CommonMark + GFM-ish parsing (tables,
 * fenced code, strikethrough via the built-in `linkify`/`typographer`),
 * adds KaTeX math via `markdown-it-texmath`, then post-processes the
 * HTML to:
 *  - Rewrite `[[wikilinks]]` (which markdown-it doesn't know about) into
 *    clickable spans that dispatch the same `lattice-open-wikilink`
 *    custom event the source editor uses, so navigation is consistent
 *    across views.
 *  - Open bare URL links in a new tab via `target="_blank"`.
 *
 * Math syntax (the `dollars` delimiter preset on texmath):
 *  - Inline:   `$E = mc^2$`
 *  - Display:  `$$\int_0^1 x^2 dx$$`
 *  - Escapes:  `\$` renders as a literal `$` (texmath honours this).
 *
 * The instance is memoized so we don't re-construct the parser on every
 * doc change — only the render call runs per change.
 */
const md = new MarkdownIt({
  html: false, // disallow raw HTML — we never trust file contents enough
  linkify: true, // auto-link bare URLs
  breaks: false, // GFM single-newline breaks would surprise markdown writers
  typographer: false, // keep punctuation literal
  highlight: undefined, // no syntax highlighting in preview for now
}).use(texmath, {
  // `dollars` is the Obsidian / Pandoc / GitHub flavor: $inline$ and
  // $$display$$. `katex` swaps to KaTeX as the math engine (vs the
  // default MathJax shape) so we don't ship MathJax's heavier runtime.
  engine: katex,
  delimiters: "dollars",
  katexOptions: {
    // Don't crash the whole document on a single malformed expression —
    // render the offending span in red and keep going. This matches the
    // "soft failure" behaviour both Obsidian and Quarto use.
    throwOnError: false,
    // Errors are typically a typo by the author; surfacing them in
    // place (vs swallowing) makes them easy to spot.
    errorColor: "var(--text-error, #e57373)",
    // `strict: false` allows things like `\unicode` and unknown macros
    // to render best-effort instead of erroring; we're a notes app, not
    // a typesetter.
    strict: false as const,
    // KaTeX trust controls which commands can produce HTML (\href,
    // \includegraphics). Default-deny — math in untrusted notes should
    // not be able to inject links or load remote resources.
    trust: false,
  },
});

// Pre-compile the [[wikilink]] pattern. Capture group 1 = link target,
// optional alias is `[[Target|Alias]]` (group 2). Runs against the
// rendered HTML, NOT the raw markdown \u2014 markdown-it has already
// escaped `<`, `>`, `&`, so the brackets we match are guaranteed to be
// real ASCII brackets from the user's source.
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

function renderHtml(source: string): string {
  const html = md.render(source);
  return html.replace(WIKILINK_RE, (_full, target: string, alias?: string) => {
    const label = (alias ?? target).trim();
    const t = target.trim().replace(/"/g, "&quot;");
    return `<a href="#" class="md-wikilink" data-target="${t}">${escapeText(label)}</a>`;
  });
}

function escapeText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

type Props = {
  source: string;
};

export function MarkdownPreview({ source }: Props) {
  const html = useMemo(() => renderHtml(source ?? ""), [source]);
  const containerRef = useRef<HTMLDivElement>(null);

  // Delegated click handler: any anchor with `.md-wikilink` dispatches
  // the global event the editor already listens for in App.tsx. We use
  // delegation so we don't re-bind per-link on every render.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const link = target.closest(".md-wikilink") as HTMLAnchorElement | null;
      if (!link) return;
      e.preventDefault();
      const dataTarget = link.dataset.target;
      if (!dataTarget) return;
      window.dispatchEvent(
        new CustomEvent("lattice-open-wikilink", {
          detail: { target: dataTarget },
        }),
      );
    };
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  }, []);

  return (
    <div
      ref={containerRef}
      className="md-preview"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
