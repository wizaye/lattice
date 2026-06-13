import { EditorView } from "@codemirror/view";

/**
 * cm-template-variables.ts
 *
 * Expands {{variable}} tokens in a note.
 * Called explicitly (not via a CM extension) so it fires once on note create
 * or when the user triggers it from a command.
 *
 * Available variables:
 *   {{title}}       — file name without extension
 *   {{date}}        — YYYY-MM-DD
 *   {{date:FORMAT}} — e.g. {{date:YYYY/MM/DD}}
 *   {{time}}        — HH:MM
 *   {{datetime}}    — YYYY-MM-DD HH:MM
 *   {{cursor}}      — moves cursor here (first occurrence wins; token removed)
 *   {{week}}        — ISO week number
 *   {{year}}        — YYYY
 *   {{month}}       — MM
 *   {{day}}         — DD
 */

function padZ(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function getISOWeek(d: Date): number {
  const date = new Date(d.getTime());
  date.setHours(0, 0, 0, 0);
  // Thursday in current week decides the year
  date.setDate(date.getDate() + 3 - ((date.getDay() + 6) % 7));
  const week1 = new Date(date.getFullYear(), 0, 4);
  return (
    1 +
    Math.round(
      ((date.getTime() - week1.getTime()) / 86400000 -
        3 +
        ((week1.getDay() + 6) % 7)) /
        7,
    )
  );
}

function formatDate(d: Date, fmt: string): string {
  return fmt
    .replace(/YYYY/g, String(d.getFullYear()))
    .replace(/YY/g, String(d.getFullYear()).slice(2))
    .replace(/MM/g, padZ(d.getMonth() + 1))
    .replace(/DD/g, padZ(d.getDate()))
    .replace(/HH/g, padZ(d.getHours()))
    .replace(/mm/g, padZ(d.getMinutes()))
    .replace(/ss/g, padZ(d.getSeconds()))
    .replace(/WW/g, padZ(getISOWeek(d)));
}

export interface TemplateContext {
  title?: string;
}

/**
 * Expand template variables in a string and return:
 *  - `result`      the expanded text
 *  - `cursorPos`   offset of the first {{cursor}} marker (or null)
 */
export function expandTemplateVariables(
  text: string,
  ctx: TemplateContext = {},
): { result: string; cursorPos: number | null } {
  const now = new Date();

  let cursorPos: number | null = null;

  const expanded = text.replace(
    /\{\{([^}]+)\}\}/g,
    (match, token: string) => {
      const t = token.trim();

      if (t === "cursor") {
        // Will be stripped; caller uses cursorPos
        return "\x00CURSOR\x00";
      }
      if (t === "title") return ctx.title ?? "";
      if (t === "date") return formatDate(now, "YYYY-MM-DD");
      if (t === "time") return formatDate(now, "HH:mm");
      if (t === "datetime") return formatDate(now, "YYYY-MM-DD HH:mm");
      if (t === "year") return String(now.getFullYear());
      if (t === "month") return padZ(now.getMonth() + 1);
      if (t === "day") return padZ(now.getDate());
      if (t === "week") return padZ(getISOWeek(now));
      if (t.startsWith("date:")) return formatDate(now, t.slice(5));

      // Unknown — leave as-is
      return match;
    },
  );

  // Locate the cursor sentinel
  const sentinelIdx = expanded.indexOf("\x00CURSOR\x00");
  const result = expanded.replace(/\x00CURSOR\x00/, "");
  if (sentinelIdx !== -1) cursorPos = sentinelIdx;

  return { result, cursorPos };
}

/**
 * Apply template-variable expansion to the current CodeMirror document.
 * Called from toolbar / command-palette actions.
 */
export function applyTemplateVariables(view: EditorView, ctx: TemplateContext = {}) {
  const doc = view.state.doc.toString();
  const { result, cursorPos } = expandTemplateVariables(doc, ctx);
  if (result === doc) return; // Nothing to expand

  view.dispatch({
    changes: { from: 0, to: doc.length, insert: result },
    ...(cursorPos !== null
      ? { selection: { anchor: cursorPos } }
      : {}),
  });
}
