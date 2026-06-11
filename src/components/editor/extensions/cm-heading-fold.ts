import { ViewPlugin, Decoration, DecorationSet, EditorView, WidgetType, GutterMarker } from "@codemirror/view";
import { RangeSetBuilder, StateField, StateEffect } from "@codemirror/state";
import { gutter } from "@codemirror/view";

/**
 * State effect for toggling folds
 */
const toggleFoldEffect = StateEffect.define<{ from: number; to: number }>();

/**
 * State field for tracking folded ranges
 */
const foldedRangesField = StateField.define<Set<string>>({
  create() {
    return new Set();
  },
  update(foldedRanges, tr) {
    let newFoldedRanges = new Set(foldedRanges);
    
    for (let effect of tr.effects) {
      if (effect.is(toggleFoldEffect)) {
        const key = `${effect.value.from}-${effect.value.to}`;
        if (newFoldedRanges.has(key)) {
          newFoldedRanges.delete(key);
        } else {
          newFoldedRanges.add(key);
        }
      }
    }
    
    return newFoldedRanges;
  },
});

/**
 * Fold marker for gutter
 */
class FoldMarker extends GutterMarker {
  constructor(readonly isFolded: boolean, readonly from: number, readonly to: number) {
    super();
  }

  toDOM(view: EditorView) {
    const span = document.createElement("span");
    span.textContent = this.isFolded ? "▶" : "▼";
    span.style.cssText = `
      cursor: pointer;
      color: var(--text-secondary, #666);
      user-select: none;
      font-size: 10px;
    `;
    span.onclick = () => {
      view.dispatch({
        effects: toggleFoldEffect.of({ from: this.from, to: this.to }),
      });
    };
    return span;
  }
}

/**
 * Heading fold extension with gutter markers
 */
export const headingFoldExtension = [
  foldedRangesField,
  
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = this.buildDecorations(view);
      }

      update(update: any) {
        if (update.docChanged || update.viewportChanged || update.transactions.some((tr: any) => tr.effects.some((e: any) => e.is(toggleFoldEffect)))) {
          this.decorations = this.buildDecorations(update.view);
        }
      }

      buildDecorations(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        const doc = view.state.doc;
        const foldedRanges = view.state.field(foldedRangesField);

        // Find headings and their content ranges
        const headingRegex = /^(#{1,6})\s+(.+)$/;

        for (let lineNum = 1; lineNum <= doc.lines; lineNum++) {
          const line = doc.line(lineNum);
          const match = headingRegex.exec(line.text);

          if (match) {
            const level = match[1].length;
            
            // Find end of section (next heading of same or higher level)
            let endLineNum = lineNum + 1;
            while (endLineNum <= doc.lines) {
              const nextLine = doc.line(endLineNum);
              const nextMatch = headingRegex.exec(nextLine.text);
              if (nextMatch && nextMatch[1].length <= level) {
                break;
              }
              endLineNum++;
            }

            // If there's content to fold
            if (endLineNum > lineNum + 1) {
              const contentStart = doc.line(lineNum + 1).from;
              const contentEnd = doc.line(Math.min(endLineNum - 1, doc.lines)).to;
              
              const key = `${contentStart}-${contentEnd}`;
              const isFolded = foldedRanges.has(key);

              // Hide folded content
              if (isFolded) {
                const hideDeco = Decoration.replace({
                  block: true,
                });
                builder.add(contentStart, contentEnd, hideDeco);
                
                // Add ellipsis widget
                const ellipsis = Decoration.widget({
                  widget: new class extends WidgetType {
                    toDOM() {
                      const span = document.createElement("span");
                      span.textContent = "...";
                      span.style.cssText = "color: var(--text-faint, #999); margin-left: 8px;";
                      return span;
                    }
                  }(),
                  side: 1,
                });
                builder.add(line.to, line.to, ellipsis);
              }
            }
          }
        }

        return builder.finish();
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  ),

  // Gutter for fold markers
  gutter({
    class: "cm-foldGutter",
    markers: (view) => {
      const builder = new RangeSetBuilder<GutterMarker>();
      const doc = view.state.doc;
      const foldedRanges = view.state.field(foldedRangesField);
      const headingRegex = /^(#{1,6})\s+(.+)$/;

      for (let lineNum = 1; lineNum <= doc.lines; lineNum++) {
        const line = doc.line(lineNum);
        const match = headingRegex.exec(line.text);

        if (match) {
          const level = match[1].length;
          
          let endLineNum = lineNum + 1;
          while (endLineNum <= doc.lines) {
            const nextLine = doc.line(endLineNum);
            const nextMatch = headingRegex.exec(nextLine.text);
            if (nextMatch && nextMatch[1].length <= level) {
              break;
            }
            endLineNum++;
          }

          if (endLineNum > lineNum + 1) {
            const contentStart = doc.line(lineNum + 1).from;
            const contentEnd = doc.line(Math.min(endLineNum - 1, doc.lines)).to;
            const key = `${contentStart}-${contentEnd}`;
            const isFolded = foldedRanges.has(key);

            builder.add(
              line.from,
              line.from,
              new FoldMarker(isFolded, contentStart, contentEnd)
            );
          }
        }
      }

      return builder.finish();
    },
  }),
];
