import { useEffect, useMemo, useRef } from "react";
import MarkdownIt from "markdown-it";

// Mermaid is loaded lazily (only when a mermaid block is actually in the
// document) to keep the initial bundle small.
let mermaidReady = false;
async function ensureMermaid() {
  if (mermaidReady) return;
  const m = await import("mermaid");
  const isDark = document.documentElement.dataset.theme !== "light";
  m.default.initialize({
    startOnLoad: false,
    theme: isDark ? "dark" : "default",
    securityLevel: "loose",
    fontFamily: "var(--font-text, sans-serif)",
  });
  mermaidReady = true;
  return m.default;
}

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
  html: false,
  linkify: true,
  breaks: false,
  typographer: false,
  highlight: (str: string, lang: string) => {
    if (lang === "mermaid") {
      // Wrap in a div that will be processed by mermaid after render
      const escaped = str.replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return `<div class="mermaid-diagram" data-mermaid="${encodeURIComponent(str)}">${escaped}</div>`;
    }
    // Plain pre/code for all other languages
    return "";
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

  // Render mermaid diagrams after the HTML is injected into the DOM.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const diagrams = Array.from(el.querySelectorAll<HTMLElement>(".mermaid-diagram"));
    if (diagrams.length === 0) return;
    let cancelled = false;
    ensureMermaid().then((m) => {
      if (cancelled || !m) return;
      diagrams.forEach(async (div, idx) => {
        const graphDef = decodeURIComponent(div.dataset.mermaid ?? "");
        if (!graphDef) return;
        try {
          const id = `mermaid-${Date.now()}-${idx}`;
          const { svg } = await m.render(id, graphDef);
          if (!cancelled) {
            div.innerHTML = svg;
            div.removeAttribute("data-mermaid");
          }
        } catch (err) {
          div.innerHTML = `<pre class="mermaid-error">${String(err)}</pre>`;
        }
      });
    });
    return () => { cancelled = true; };
  }, [html]);

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
