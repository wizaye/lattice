import { ViewPlugin, Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { RangeSetBuilder, StateField, EditorState } from "@codemirror/state";

/**
 * Mermaid diagram widget
 */
class MermaidWidget extends WidgetType {
  constructor(readonly code: string, readonly id: string) {
    super();
  }

  toDOM() {
    const container = document.createElement("div");
    container.className = "cm-mermaid-diagram";
    container.id = this.id;
    container.style.cssText = `
      margin: 16px 0;
      padding: 16px;
      background: var(--bg-secondary, #f9f9f9);
      border-radius: 8px;
      overflow-x: auto;
    `;

    // Render mermaid (requires mermaid library)
    const pre = document.createElement("pre");
    pre.className = "mermaid";
    pre.textContent = this.code;
    container.appendChild(pre);

    // Trigger mermaid render if available
    if (typeof (window as any).mermaid !== 'undefined') {
      setTimeout(() => {
        (window as any).mermaid.init(undefined, pre);
      }, 100);
    } else {
      // Fallback: show code
      const code = document.createElement("code");
      code.textContent = this.code;
      code.style.cssText = "display: block; white-space: pre-wrap;";
      container.innerHTML = '';
      container.appendChild(code);
    }

    return container;
  }
}

/**
 * PlantUML diagram widget
 */
class PlantUMLWidget extends WidgetType {
  constructor(readonly code: string, readonly id: string) {
    super();
  }

  toDOM() {
    const container = document.createElement("div");
    container.className = "cm-plantuml-diagram";
    container.style.cssText = `
      margin: 16px 0;
      padding: 16px;
      background: var(--bg-secondary, #f9f9f9);
      border-radius: 8px;
      text-align: center;
    `;

    // Use PlantUML server to render
    const encoded = this.encodePlantUML(this.code);
    const img = document.createElement("img");
    img.src = `https://www.plantuml.com/plantuml/svg/${encoded}`;
    img.alt = "PlantUML Diagram";
    img.style.maxWidth = "100%";
    img.onerror = () => {
      // Fallback: show code
      container.innerHTML = '';
      const pre = document.createElement("pre");
      pre.textContent = this.code;
      pre.style.cssText = "text-align: left; white-space: pre-wrap;";
      container.appendChild(pre);
    };

    container.appendChild(img);
    return container;
  }

  encodePlantUML(code: string): string {
    // Simple base64-like encoding for PlantUML server
    // In production, use proper deflate + base64
    return btoa(code).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }
}

/**
 * LaTeX math widget (uses KaTeX)
 */
class LatexWidget extends WidgetType {
  constructor(readonly latex: string, readonly displayMode: boolean) {
    super();
  }

  toDOM() {
    const container = document.createElement("span");
    container.className = this.displayMode ? "cm-latex-display" : "cm-latex-inline";

    if (this.displayMode) {
      container.style.cssText = "display: block; margin: 16px 0; text-align: center;";
    }

    // Render with KaTeX if available
    if (typeof (window as any).katex !== 'undefined') {
      try {
        (window as any).katex.render(this.latex, container, {
          displayMode: this.displayMode,
          throwOnError: false,
        });
      } catch (e) {
        container.textContent = this.latex;
        container.style.color = "red";
      }
    } else {
      // Fallback: show raw LaTeX
      const code = document.createElement("code");
      code.textContent = this.displayMode ? `$$${this.latex}$$` : `$${this.latex}$`;
      container.appendChild(code);
    }

    return container;
  }
}

function buildMermaidDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = state.doc;
  const mermaidRegex = /^```mermaid\n([\s\S]*?)\n```$/gm;

  const text = doc.toString();
  let match;

  while ((match = mermaidRegex.exec(text)) !== null) {
    const code = match[1];
    const start = match.index;
    const end = start + match[0].length;
    const id = `mermaid-${start}`;

    const widget = Decoration.widget({
      widget: new MermaidWidget(code, id),
      side: 1,
      block: true,
    });

    builder.add(end, end, widget);
  }

  return builder.finish();
}

/**
 * Render Mermaid diagrams in ```mermaid blocks
 */
export const mermaidExtension = StateField.define<DecorationSet>({
  create(state) {
    return buildMermaidDecorations(state);
  },
  update(decorations, tr) {
    if (tr.docChanged) {
      return buildMermaidDecorations(tr.state);
    }
    return decorations.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

function buildPlantUMLDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = state.doc;
  const plantumlRegex = /^```plantuml\n([\s\S]*?)\n```$/gm;

  const text = doc.toString();
  let match;

  while ((match = plantumlRegex.exec(text)) !== null) {
    const code = match[1];
    const start = match.index;
    const end = start + match[0].length;
    const id = `plantuml-${start}`;

    const widget = Decoration.widget({
      widget: new PlantUMLWidget(code, id),
      side: 1,
      block: true,
    });

    builder.add(end, end, widget);
  }

  return builder.finish();
}

/**
 * Render PlantUML diagrams in ```plantuml blocks
 */
export const plantumlExtension = StateField.define<DecorationSet>({
  create(state) {
    return buildPlantUMLDecorations(state);
  },
  update(decorations, tr) {
    if (tr.docChanged) {
      return buildPlantUMLDecorations(tr.state);
    }
    return decorations.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * Render LaTeX math with KaTeX
 * Supports both inline $...$ and display $$...$$
 */
export const latexExtension = ViewPlugin.fromClass(
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

      // Match $$...$$ (display mode) and $...$ (inline mode)
      const displayLatexRegex = /\$\$([^\$]+)\$\$/g;
      const inlineLatexRegex = /\$([^\$]+)\$/g;

      for (let { from, to } of view.visibleRanges) {
        const text = view.state.doc.sliceString(from, to);

        // Display mode
        let match;
        while ((match = displayLatexRegex.exec(text)) !== null) {
          const latex = match[1];
          const start = from + match.index;
          const end = start + match[0].length;

          const widget = Decoration.replace({
            widget: new LatexWidget(latex, true),
          });

          builder.add(start, end, widget);
        }

        // Inline mode
        while ((match = inlineLatexRegex.exec(text)) !== null) {
          const latex = match[1];
          const start = from + match.index;
          const end = start + match[0].length;

          // Skip if it's part of $$...$$
          if (text[match.index - 1] === '$' || text[match.index + match[0].length] === '$') {
            continue;
          }

          const widget = Decoration.replace({
            widget: new LatexWidget(latex, false),
          });

          builder.add(start, end, widget);
        }
      }

      return builder.finish();
    }
  },
  {
    decorations: (v: any) => v.decorations,
  }
);
