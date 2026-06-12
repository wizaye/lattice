import { ViewPlugin, Decoration, DecorationSet, EditorView } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

/**
 * Obsidian-style callout types with colors
 */
const CALLOUT_TYPES: Record<string, { color: string; icon: string }> = {
  note: { color: "#3b82f6", icon: "📝" },
  abstract: { color: "#06b6d4", icon: "📋" },
  summary: { color: "#06b6d4", icon: "📋" },
  tldr: { color: "#06b6d4", icon: "📋" },
  info: { color: "#0ea5e9", icon: "ℹ️" },
  todo: { color: "#06b6d4", icon: "✅" },
  tip: { color: "#06b6d4", icon: "💡" },
  hint: { color: "#06b6d4", icon: "💡" },
  important: { color: "#06b6d4", icon: "🔥" },
  success: { color: "#10b981", icon: "✓" },
  check: { color: "#10b981", icon: "✓" },
  done: { color: "#10b981", icon: "✓" },
  question: { color: "#f59e0b", icon: "?" },
  help: { color: "#f59e0b", icon: "?" },
  faq: { color: "#f59e0b", icon: "?" },
  warning: { color: "#f59e0b", icon: "⚠" },
  caution: { color: "#f59e0b", icon: "⚠" },
  attention: { color: "#f59e0b", icon: "⚠" },
  failure: { color: "#ef4444", icon: "✗" },
  fail: { color: "#ef4444", icon: "✗" },
  missing: { color: "#ef4444", icon: "✗" },
  danger: { color: "#dc2626", icon: "⚡" },
  error: { color: "#dc2626", icon: "⚡" },
  bug: { color: "#dc2626", icon: "🐛" },
  example: { color: "#8b5cf6", icon: "📌" },
  quote: { color: "#6b7280", icon: "\"" },
  cite: { color: "#6b7280", icon: "\"" },
};

/**
 * Parse > [!type] callout blocks and add styling
 */
export const calloutsExtension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.buildDecorations(view);
    }

    update(update: any) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    buildDecorations(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      const doc = view.state.doc;

      // Match callout start: > [!type] optional title
      const calloutStartRegex = /^>\s*\[!(\w+)\]([+-]?)(?:\s+(.+))?$/;

      for (let lineNum = 1; lineNum <= doc.lines; lineNum++) {
        const line = doc.line(lineNum);
        const lineText = line.text;
        const match = calloutStartRegex.exec(lineText);

        if (match) {
          const calloutType = match[1].toLowerCase();
          // match[2] = foldable (+/-), match[3] = optional title — reserved for future use
          const config = CALLOUT_TYPES[calloutType] || CALLOUT_TYPES.note;

          // Find end of callout block (consecutive lines starting with >)
          let endLine = lineNum;
          while (endLine < doc.lines) {
            const nextLine = doc.line(endLine + 1);
            if (!nextLine.text.trim().startsWith('>')) break;
            endLine++;
          }

          // Add line decoration for callout styling
          for (let i = lineNum; i <= endLine; i++) {
            const currentLine = doc.line(i);
            
            const decoration = Decoration.line({
              attributes: {
                class: `cm-callout cm-callout-${calloutType}`,
                style: `border-left: 4px solid ${config.color}; background: ${config.color}15; padding-left: 12px; margin: 2px 0;`,
              },
            });

            builder.add(currentLine.from, currentLine.from, decoration);
          }
        }
      }

      return builder.finish();
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);
