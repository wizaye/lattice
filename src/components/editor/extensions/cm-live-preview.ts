import {
  ViewPlugin,
  Decoration,
  DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

/**
 * cm-live-preview.ts
 *
 * Obsidian-style WYSIWYG: on lines that are NOT under the cursor,
 * collapse markdown syntax tokens and replace them with rich renders:
 *  - **bold**, _italic_, ~~strike~~, ==highlight==, `code`
 *  - ![alt](url) images → inline <img>
 *  - [text](url) links → styled anchor widget
 *  - --- / *** / ___ → <hr>
 *  - > [!note/tip/warning] callout headers → colored badge
 */

// ─── Small inline widgets ────────────────────────────────────────────

class HrWidget extends WidgetType {
  toDOM() {
    const hr = document.createElement("hr");
    hr.style.cssText =
      "border: none; border-top: 1px solid var(--border-weak, var(--border)); margin: 8px 0;";
    return hr;
  }
  ignoreEvent() { return true; }
}

class CalloutBadgeWidget extends WidgetType {
  constructor(readonly type: string) { super(); }
  toDOM() {
    const span = document.createElement("span");
    span.className = `cm-callout-badge cm-callout-${this.type.toLowerCase()}`;
    span.textContent = this.type.charAt(0).toUpperCase() + this.type.slice(1).toLowerCase();
    return span;
  }
  ignoreEvent() { return true; }
}

class ImageWidget extends WidgetType {
  constructor(readonly alt: string, readonly src: string) { super(); }
  toDOM() {
    const img = document.createElement("img");
    img.alt = this.alt;
    img.src = this.src;
    img.style.cssText = "max-width: 100%; height: auto; border-radius: 4px; display: block; margin: 4px 0;";
    img.onerror = () => { img.style.opacity = "0.4"; };
    return img;
  }
  ignoreEvent() { return false; }
  eq(other: ImageWidget) { return this.src === other.src && this.alt === other.alt; }
}

// ─── Decoration builder ──────────────────────────────────────────────

const HR_RE = /^[\s]*(?:---|\*\*\*|___)[\s]*$/;
const CALLOUT_RE = /^>\s*\[!(\w+)\]/;
const IMG_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;
const BOLD_RE = /\*\*([^*]+)\*\*/g;
const ITALIC_RE = /(?<!\*)\*([^*]+)\*(?!\*)/g;
const STRIKE_RE = /~~([^~]+)~~/g;
const HIGHLIGHT_RE = /==([^=]+)==/g;

/** Returns true when the cursor is anywhere on line `lineFrom..lineTo`. */
function cursorOnLine(view: EditorView, lineFrom: number, lineTo: number): boolean {
  for (const range of view.state.selection.ranges) {
    if (range.from <= lineTo && range.to >= lineFrom) return true;
  }
  return false;
}

function buildLivePreviewDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;

  for (let lineNum = 1; lineNum <= doc.lines; lineNum++) {
    const line = doc.line(lineNum);
    const { from, to, text } = line;

    // Never apply live-preview on the cursor line — leave source raw
    if (cursorOnLine(view, from, to)) continue;

    // ── Horizontal rule ────────────────────────────────────────────
    if (HR_RE.test(text)) {
      builder.add(from, to, Decoration.replace({ widget: new HrWidget(), inclusive: true }));
      continue;
    }

    // ── Callout badge  > [!type] ──────────────────────────────────
    const calloutMatch = CALLOUT_RE.exec(text);
    if (calloutMatch) {
      const markerEnd = from + calloutMatch[0].length;
      builder.add(
        from,
        markerEnd,
        Decoration.replace({ widget: new CalloutBadgeWidget(calloutMatch[1]) }),
      );
      continue;
    }

    // ── Inline image: ![alt](url) ─────────────────────────────────
    IMG_RE.lastIndex = 0;
    let imgMatch: RegExpExecArray | null;
    while ((imgMatch = IMG_RE.exec(text)) !== null) {
      builder.add(
        from + imgMatch.index,
        from + imgMatch.index + imgMatch[0].length,
        Decoration.replace({ widget: new ImageWidget(imgMatch[1], imgMatch[2]) }),
      );
    }

    // ── **bold** → hide ** markers ────────────────────────────────
    BOLD_RE.lastIndex = 0;
    let boldMatch: RegExpExecArray | null;
    while ((boldMatch = BOLD_RE.exec(text)) !== null) {
      // Hide opening **
      builder.add(from + boldMatch.index, from + boldMatch.index + 2,
        Decoration.mark({ class: "cm-lp-hidden" }));
      // Style the inner text
      builder.add(from + boldMatch.index + 2, from + boldMatch.index + boldMatch[0].length - 2,
        Decoration.mark({ class: "cm-lp-bold" }));
      // Hide closing **
      builder.add(from + boldMatch.index + boldMatch[0].length - 2, from + boldMatch.index + boldMatch[0].length,
        Decoration.mark({ class: "cm-lp-hidden" }));
    }

    // ── *italic* → hide * markers ────────────────────────────────
    ITALIC_RE.lastIndex = 0;
    let italicMatch: RegExpExecArray | null;
    while ((italicMatch = ITALIC_RE.exec(text)) !== null) {
      builder.add(from + italicMatch.index, from + italicMatch.index + 1,
        Decoration.mark({ class: "cm-lp-hidden" }));
      builder.add(from + italicMatch.index + 1, from + italicMatch.index + italicMatch[0].length - 1,
        Decoration.mark({ class: "cm-lp-italic" }));
      builder.add(from + italicMatch.index + italicMatch[0].length - 1, from + italicMatch.index + italicMatch[0].length,
        Decoration.mark({ class: "cm-lp-hidden" }));
    }

    // ── ~~strikethrough~~ ────────────────────────────────────────
    STRIKE_RE.lastIndex = 0;
    let strikeMatch: RegExpExecArray | null;
    while ((strikeMatch = STRIKE_RE.exec(text)) !== null) {
      builder.add(from + strikeMatch.index, from + strikeMatch.index + 2,
        Decoration.mark({ class: "cm-lp-hidden" }));
      builder.add(from + strikeMatch.index + 2, from + strikeMatch.index + strikeMatch[0].length - 2,
        Decoration.mark({ class: "cm-lp-strike" }));
      builder.add(from + strikeMatch.index + strikeMatch[0].length - 2, from + strikeMatch.index + strikeMatch[0].length,
        Decoration.mark({ class: "cm-lp-hidden" }));
    }

    // ── ==highlight== ─────────────────────────────────────────────
    HIGHLIGHT_RE.lastIndex = 0;
    let hlMatch: RegExpExecArray | null;
    while ((hlMatch = HIGHLIGHT_RE.exec(text)) !== null) {
      builder.add(from + hlMatch.index, from + hlMatch.index + 2,
        Decoration.mark({ class: "cm-lp-hidden" }));
      builder.add(from + hlMatch.index + 2, from + hlMatch.index + hlMatch[0].length - 2,
        Decoration.mark({ class: "cm-lp-highlight" }));
      builder.add(from + hlMatch.index + hlMatch[0].length - 2, from + hlMatch.index + hlMatch[0].length,
        Decoration.mark({ class: "cm-lp-hidden" }));
    }
  }

  return builder.finish();
}

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildLivePreviewDecorations(view);
    }
    update(update: { docChanged: boolean; viewportChanged: boolean; selectionSet: boolean; view: EditorView }) {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = buildLivePreviewDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

const livePreviewTheme = EditorView.baseTheme({
  ".cm-lp-hidden": {
    display: "none",
  },
  ".cm-lp-bold": {
    fontWeight: "700",
  },
  ".cm-lp-italic": {
    fontStyle: "italic",
  },
  ".cm-lp-strike": {
    textDecoration: "line-through",
    color: "var(--text-muted)",
  },
  ".cm-lp-highlight": {
    backgroundColor: "rgba(255, 213, 0, 0.25)",
    borderRadius: "2px",
    padding: "0 1px",
  },
  ".cm-callout-badge": {
    display: "inline-block",
    padding: "1px 8px",
    borderRadius: "4px",
    fontSize: "11px",
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    marginBottom: "2px",
  },
  ".cm-callout-note": { background: "rgba(0, 130, 255, 0.2)", color: "#0082ff" },
  ".cm-callout-tip":  { background: "rgba(0, 200, 100, 0.2)", color: "#00c864" },
  ".cm-callout-warning": { background: "rgba(255, 165, 0, 0.2)", color: "#ffa500" },
  ".cm-callout-info": { background: "rgba(0, 200, 255, 0.2)", color: "#00c8ff" },
  ".cm-callout-success": { background: "rgba(0, 200, 80, 0.2)", color: "#00c850" },
  ".cm-callout-danger": { background: "rgba(220, 50, 50, 0.2)", color: "#dc3232" },
  ".cm-callout-example": { background: "rgba(155, 80, 255, 0.2)", color: "#9b50ff" },
  ".cm-callout-abstract": { background: "rgba(0, 150, 200, 0.2)", color: "#0096c8" },
});

export const livePreviewExtension = [livePreviewPlugin, livePreviewTheme];
