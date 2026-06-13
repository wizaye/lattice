import { useEffect, useMemo, useRef } from "react";
import MarkdownIt from "markdown-it";
import Reveal from "reveal.js";
// Reveal.js v6 exports CSS via top-level specifiers (no `dist/`
// prefix) — its `package.json` `exports` map only allows
// `reveal.js/reveal.css` and `reveal.js/theme/*`.  Using the legacy
// `reveal.js/dist/...` paths trips Vite's exports resolver.
import "reveal.js/reveal.css";
// `black` is the theme closest to Lattice's dark chrome.  We pull a
// second light-friendly theme in via a swap at runtime (see effect
// below) so light-mode users get a presentable deck too.
import "reveal.js/theme/black.css";

/**
 * Slide-deck view for a single markdown file (Reveal.js).
 *
 * Slide-break convention (matches Reveal's markdown plugin and most
 * markdown-based slide tools — Marp, Pandoc, GitPitch):
 *   - `---` on its own line  →  new horizontal slide
 *   - `--`  on its own line  →  new vertical sub-slide (nested below
 *                                the previous horizontal one).
 *
 * Why we DON'T use `RevealMarkdown` plugin:
 *   The plugin parses with marked + does its own KaTeX wiring.  We
 *   already have markdown-it + texmath configured exactly how the
 *   reading-mode preview expects it (same KaTeX options, same wikilink
 *   rewrites).  Rendering ourselves keeps the slide rendering pixel-
 *   identical to the reading-mode preview, so authors can iterate in
 *   one view and present in the other without surprises.
 *
 * Reveal lifecycle quirks (learned the hard way):
 *  - You can have only ONE active Reveal instance per page; calling
 *    `new Reveal(el)` again with a different element while the first
 *    is still alive throws "Reveal already initialized".  We dispose
 *    via `destroy()` on cleanup.
 *  - `Reveal(el)` REQUIRES `el` to contain `.slides > section` nodes
 *    BEFORE `initialize()` is called — it counts/wires them in `init`.
 *    Re-render-after-source-change therefore destroys the instance
 *    and re-creates it, vs trying to patch slides in place (which
 *    Reveal supports but only with `slidesUpdate()` and has a
 *    history of regressions).
 *  - Reveal sets `body { overflow: hidden }` globally during init —
 *    fine for full-page decks but breaks our tab system.  We scope
 *    via `embedded: true` so it only manipulates the deck root, not
 *    the document body.
 */

const slidesMd = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: false,
});

// Same wikilink regex as MarkdownPreview — kept duplicated rather
// than imported because MarkdownPreview's export surface is the
// component, not the regex, and there's no shared "markdown utils"
// module yet.  When the third site needs it, lift to `lib/markdown.ts`.
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function escapeText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderSlideHtml(source: string): string {
  const html = slidesMd.render(source);
  return html.replace(WIKILINK_RE, (_full, target: string, alias?: string) => {
    const label = (alias ?? target).trim();
    return `<a href="#" class="md-wikilink" data-target="${escapeAttr(target.trim())}">${escapeText(label)}</a>`;
  });
}

/**
 * Split a markdown source into the nested-slides shape Reveal expects.
 *
 * Returns a 2-D array: outer = horizontal slides, inner = vertical
 * sub-slides under that horizontal.  When a source has no `---` at
 * all we still return a single-element outer array so the deck
 * renders one slide instead of throwing.
 *
 * Match rule: `^---$` or `^--$` on its own line, with optional
 * trailing whitespace.  Crucially we DON'T match `---` inside a
 * fenced code block (which would split, e.g., a YAML front-matter
 * example), so we walk line-by-line and track ``` toggle state.
 */
function splitSlides(source: string): string[][] {
  const horizontals: string[][] = [];
  let curHoriz: string[] = [];
  let curSlide: string[] = [];
  let inFence = false;
  let fenceMark: "```" | "~~~" | null = null;

  const flushSlide = () => {
    curHoriz.push(curSlide.join("\n"));
    curSlide = [];
  };
  const flushHoriz = () => {
    flushSlide();
    horizontals.push(curHoriz);
    curHoriz = [];
  };

  for (const line of source.split(/\r?\n/)) {
    // Fence tracking — only the literal triple-backtick/tilde at line
    // start (with optional info string) flips state.
    if (!inFence) {
      if (/^```/.test(line)) {
        inFence = true;
        fenceMark = "```";
      } else if (/^~~~/.test(line)) {
        inFence = true;
        fenceMark = "~~~";
      }
    } else if (
      (fenceMark === "```" && /^```\s*$/.test(line)) ||
      (fenceMark === "~~~" && /^~~~\s*$/.test(line))
    ) {
      inFence = false;
      fenceMark = null;
    }

    if (!inFence) {
      if (/^---\s*$/.test(line)) {
        flushHoriz();
        continue;
      }
      if (/^--\s*$/.test(line)) {
        flushSlide();
        continue;
      }
    }
    curSlide.push(line);
  }
  // Flush whatever's pending.
  flushHoriz();

  // Drop trailing empty horizontals so a source with a stray final
  // `---` doesn't render a blank slide at the end.
  while (
    horizontals.length > 1 &&
    horizontals[horizontals.length - 1].every((s) => s.trim().length === 0)
  ) {
    horizontals.pop();
  }

  return horizontals;
}

type Props = {
  source: string;
};

export function SlidesView({ source }: Props) {
  const deckRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<{
    destroy(): void;
    layout(): void;
    sync(): void;
  } | null>(null);

  // Build the slide DOM string from the source.  Memoized on `source`
  // so flipping view modes (preview → slides → preview) doesn't
  // re-parse markdown when the body hasn't actually changed.
  const slidesHtml = useMemo(() => {
    const horizontals = splitSlides(source ?? "");
    const parts: string[] = [];
    for (const stack of horizontals) {
      if (stack.length === 1) {
        parts.push(`<section>${renderSlideHtml(stack[0])}</section>`);
      } else {
        parts.push("<section>");
        for (const slide of stack) {
          parts.push(`<section>${renderSlideHtml(slide)}</section>`);
        }
        parts.push("</section>");
      }
    }
    return parts.join("");
  }, [source]);

  useEffect(() => {
    const root = deckRef.current;
    if (!root) return;

    // Tear down any prior instance — Reveal blows up if `initialize`
    // is called against an already-initialised root.
    if (instanceRef.current) {
      try {
        instanceRef.current.destroy();
      } catch {
        /* noop — already torn down (e.g. by React strict-mode double effect) */
      }
      instanceRef.current = null;
    }

    // Reveal mutates the DOM it owns (`.slides > section`), so we
    // rebuild that subtree from scratch each render.  Cheaper than
    // diffing — slide decks are small (typically <50 slides) and
    // Reveal's internal state caches off the DOM at init.
    const slides = root.querySelector(".slides");
    if (slides) slides.innerHTML = slidesHtml;

    // `embedded: true` is the critical flag — without it Reveal
    // hijacks the entire viewport (`body { overflow: hidden }`, full-
    // screen styles), which breaks tabs/splits/sidebars.  Embedded
    // mode keeps it scoped to `root` and lets us style around it.
    const inst = new Reveal(root, {
      embedded: true,
      hash: false, // don't pollute the URL bar
      controls: true,
      progress: true,
      slideNumber: "c/t", // "current / total"
      keyboard: true,
      transition: "slide",
      // Keep auto-resize on so the deck fits whatever pane size the
      // user gives us via the splitter.
      autoSlide: 0,
      // Width / height are the LOGICAL slide size (Reveal scales the
      // whole deck to fit the container).  16:10 keeps slides feeling
      // notebook-like rather than widescreen-TV.
      width: 960,
      height: 600,
      margin: 0.05,
      minScale: 0.2,
      maxScale: 2.0,
      // Reveal v6 auto-flips to "scroll view" when the container is
      // narrower than `scrollActivationWidth` (default 435px) — that's
      // sensible on mobile, but disastrous in a split-pane app where
      // panes are often < 500px wide.  Setting this to `null` (any
      // non-number) disables the auto-switch and keeps the classic
      // single-slide deck mode regardless of pane width.  Users can
      // still toggle scroll view manually via the `O`/keyboard if we
      // ever expose that.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scrollActivationWidth: null as any,
    });
    void inst.initialize().then(() => {
      // Cache the instance for cleanup + window-resize layout calls.
      // The `then` is required: `initialize` is async and the layout
      // pass it kicks off depends on the cached size.
      instanceRef.current = inst as unknown as typeof instanceRef.current;
    });

    return () => {
      try {
        inst.destroy();
      } catch {
        /* noop */
      }
      instanceRef.current = null;
    };
  }, [slidesHtml]);

  // Re-layout when the surrounding pane is resized — Reveal won't
  // notice splitter drags on its own because the container size
  // changes without a window-level resize event.
  useEffect(() => {
    const root = deckRef.current;
    if (!root) return;
    const ro = new ResizeObserver(() => {
      const inst = instanceRef.current;
      if (inst) {
        try {
          inst.layout();
        } catch {
          /* noop — happens if observer fires post-destroy */
        }
      }
    });
    ro.observe(root);
    return () => ro.disconnect();
  }, []);

  // Delegated click handler for wikilinks — identical contract to
  // MarkdownPreview: dispatch `lattice-open-wikilink` and let App.tsx
  // route the navigation.
  useEffect(() => {
    const root = deckRef.current;
    if (!root) return;
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
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, []);

  return (
    <div className="slides-view">
      {/* `reveal` is Reveal's required root class; `.slides` is where
          we inject the per-slide `<section>` nodes.  Reveal walks the
          DOM under .slides to count + initialise. */}
      <div ref={deckRef} className="reveal slides-host">
        <div className="slides" />
      </div>
    </div>
  );
}
