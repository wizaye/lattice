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
const TASK_RE_DETAILED = /^([\s>]*-\s+\[)(.)(\]\s+)(.*?)(?:\s+<!--\s*id:\s*([\w-]+)\s*-->)?$/;

function renderHtml(source: string, fileId?: string): string {
  const html = md.render(source);
  const wikilinksProcessed = html.replace(WIKILINK_RE, (_full, target: string, alias?: string) => {
    const label = (alias ?? target).trim();
    const t = target.trim().replace(/"/g, "&quot;");
    return `<a href="#" class="md-wikilink" data-target="${t}">${escapeText(label)}</a>`;
  });

  const lines = source.split("\n");
  const taskLineIndices: number[] = [];
  lines.forEach((line, idx) => {
    if (TASK_RE_DETAILED.test(line)) {
      taskLineIndices.push(idx);
    }
  });

  let taskCounter = 0;
  const processedHtml = wikilinksProcessed.replace(/<li>\[([ xX\/\-])\]\s*(.*?)(?:\s+<!--\s*id:\s*([\w-]+)\s*-->)?<\/li>/g, (_, marker, text, stableId) => {
    const lineIdx = taskLineIndices[taskCounter];
    taskCounter++;
    
    const isChecked = marker === "x" || marker === "X";
    const isInProgress = marker === "/" || marker === "-";
    
    // Create checkbox input
    let checkboxHtml = `<input type="checkbox" class="md-task-checkbox" disabled ${isChecked ? "checked" : ""}/>`;
    if (isInProgress) {
      checkboxHtml = `<input type="checkbox" class="md-task-checkbox md-task-inprogress" disabled />`;
    }
    
    // Clean stable ID comment out of task text
    const cleanText = text.replace(/<!--\s*id:\s*[\w-]+\s*-->/g, "").trim();
    const resolvedTaskId = stableId || (fileId && lineIdx !== undefined ? `${fileId}:${lineIdx}` : "");

    const editBtnHtml = fileId && lineIdx !== undefined
      ? ` <button class="md-task-meta-trigger" data-file-id="${fileId}" data-line-idx="${lineIdx}" data-task-id="${resolvedTaskId}" title="Edit task details">✏️</button>`
      : "";

    return `<li class="task-list-item">${checkboxHtml} <span class="task-list-item-text">${cleanText}</span>${editBtnHtml}</li>`;
  });

  return processedHtml;
}

function escapeText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

type Props = {
  source: string;
  fileId?: string;
};

export function MarkdownPreview({ source, fileId }: Props) {
  const html = useMemo(() => renderHtml(source ?? "", fileId), [source, fileId]);
  const containerRef = useRef<HTMLDivElement>(null);

  // Delegated click handler: any anchor with `.md-wikilink` dispatches
  // the global event the editor already listens for in App.tsx. We use
  // delegation so we don't re-bind per-link on every render.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;

      // Handle Task Metadata edit trigger click
      const trigger = target.closest(".md-task-meta-trigger") as HTMLButtonElement | null;
      if (trigger) {
        e.preventDefault();
        const fId = trigger.dataset.fileId;
        const lineIdxStr = trigger.dataset.lineIdx;
        const taskId = trigger.dataset.taskId;
        if (fId && lineIdxStr && taskId) {
          window.dispatchEvent(
            new CustomEvent("lattice-open-task-modal", {
              detail: {
                fileId: fId,
                line: parseInt(lineIdxStr, 10) + 1, // 1-based line number
                taskId: taskId,
              },
            })
          );
        }
        return;
      }

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
