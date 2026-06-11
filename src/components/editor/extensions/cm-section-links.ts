import { ViewPlugin, Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

/**
 * Widget for section links with click handling
 */
class SectionLinkWidget extends WidgetType {
  constructor(readonly noteName: string, readonly section: string, readonly displayText: string) {
    super();
  }

  toDOM() {
    const link = document.createElement("span");
    link.className = "cm-wikilink cm-section-link";
    link.textContent = this.displayText;
    link.style.cssText = `
      color: var(--link-color, #3b82f6);
      cursor: pointer;
      text-decoration: none;
      border-bottom: 1px dotted currentColor;
    `;
    
    link.onclick = (e) => {
      e.preventDefault();
      // Emit custom event for parent to handle navigation
      const event = new CustomEvent('navigate-to-section', {
        detail: { note: this.noteName, section: this.section },
        bubbles: true,
      });
      link.dispatchEvent(event);
    };

    return link;
  }

  ignoreEvent() {
    return false;
  }
}

/**
 * Parse [[Note#Section]] and [[Note#Section|Alias]] wikilinks
 */
export const sectionLinksExtension = ViewPlugin.fromClass(
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
      
      // Match [[Note#Section]] or [[Note#Section|Alias]]
      const sectionLinkRegex = /\[\[([^#\]]+)#([^|\]]+)(?:\|([^\]]+))?\]\]/g;

      for (let { from, to } of view.visibleRanges) {
        const text = view.state.doc.sliceString(from, to);
        let match;

        while ((match = sectionLinkRegex.exec(text)) !== null) {
          const noteName = match[1];
          const section = match[2];
          const alias = match[3];
          const displayText = alias || `${noteName}#${section}`;
          
          const start = from + match.index;
          const end = start + match[0].length;

          // Replace entire [[...]] with clickable widget
          const decoration = Decoration.replace({
            widget: new SectionLinkWidget(noteName, section, displayText),
          });

          builder.add(start, end, decoration);
        }
      }

      return builder.finish();
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);
