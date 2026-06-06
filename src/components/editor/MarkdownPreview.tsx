import { useEffect, useMemo, useRef } from "react";
import MarkdownIt from "markdown-it";

/**
 * Reading-mode renderer.
 *
 * Uses `markdown-it` to do full CommonMark + GFM-ish parsing (tables,
 * fenced code, strikethrough via the built-in `linkify`/`typographer`),
 * then post-processes the HTML to:
 *  - Rewrite `[[wikilinks]]` (which markdown-it doesn't know about) into
 *    clickable spans that dispatch the same `lattice-open-wikilink`
 *    custom event the source editor uses, so navigation is consistent
 *    across views.
 *  - Open bare URL links in a new tab via `target="_blank"`.
 *
 * The instance is memoized so we don't re-construct the parser on every
 * doc change \u2014 only the render call runs per change.
 */
const md = new MarkdownIt({
  html: false, // disallow raw HTML \u2014 we never trust file contents enough
  linkify: true, // auto-link bare URLs
  breaks: false, // GFM single-newline breaks would surprise markdown writers
  typographer: false, // keep punctuation literal
  highlight: undefined, // no syntax highlighting in preview for now
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
