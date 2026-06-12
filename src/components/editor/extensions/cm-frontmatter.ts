import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { RangeSetBuilder, StateField, EditorState } from "@codemirror/state";

/**
 * Widget for collapsed frontmatter
 */
class FrontmatterWidget extends WidgetType {
  constructor(readonly properties: Record<string, any>) {
    super();
  }

  toDOM() {
    const container = document.createElement("div");
    container.className = "cm-frontmatter-collapsed";
    container.style.cssText = `
      background: var(--bg-tertiary, #f5f5f5);
      border: 1px solid var(--border-color, #ddd);
      border-radius: 4px;
      padding: 8px 12px;
      margin: 8px 0;
      font-size: 13px;
      color: var(--text-secondary, #666);
      cursor: pointer;
      font-family: var(--font-monospace, monospace);
    `;

    const propertyCount = Object.keys(this.properties).length;
    const summary = document.createElement("span");
    summary.textContent = `📄 Frontmatter (${propertyCount} ${propertyCount === 1 ? 'property' : 'properties'})`;
    
    container.appendChild(summary);

    // Show first 3 properties as preview
    const previewDiv = document.createElement("div");
    previewDiv.style.cssText = "margin-top: 4px; font-size: 11px; opacity: 0.7;";
    
    const entries = Object.entries(this.properties).slice(0, 3);
    entries.forEach(([key, value]) => {
      const prop = document.createElement("div");
      const valueStr = typeof value === 'object' ? JSON.stringify(value) : String(value);
      prop.textContent = `${key}: ${valueStr.length > 30 ? valueStr.slice(0, 30) + '...' : valueStr}`;
      previewDiv.appendChild(prop);
    });

    if (Object.keys(this.properties).length > 3) {
      const more = document.createElement("div");
      more.textContent = `... and ${Object.keys(this.properties).length - 3} more`;
      previewDiv.appendChild(more);
    }

    container.appendChild(previewDiv);
    return container;
  }

  ignoreEvent() {
    return false;
  }
}

function buildFrontmatterDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = state.doc;

  // Check if document starts with ---
  if (doc.lines < 3) return builder.finish();
  
  const firstLine = doc.line(1);
  if (firstLine.text.trim() !== '---') return builder.finish();

  // Find closing ---
  let endLineNum = 0;
  for (let i = 2; i <= doc.lines; i++) {
    const line = doc.line(i);
    if (line.text.trim() === '---') {
      endLineNum = i;
      break;
    }
  }

  if (endLineNum === 0) return builder.finish();

  // Extract YAML content
  const yamlLines: string[] = [];
  for (let i = 2; i < endLineNum; i++) {
    yamlLines.push(doc.line(i).text);
  }

  // Parse YAML (simple key: value parser)
  const properties: Record<string, any> = {};
  yamlLines.forEach(line => {
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (match) {
      const [, key, value] = match;
      // Try to parse as JSON, fallback to string
      try {
        properties[key] = JSON.parse(value);
      } catch {
        properties[key] = value.replace(/^["']|["']$/g, '');
      }
    }
  });

  // Add widget after the closing ---
  const endLine = doc.line(endLineNum);
  const widget = Decoration.widget({
    widget: new FrontmatterWidget(properties),
    side: 1,
    block: true,
  });

  builder.add(endLine.to, endLine.to, widget);

  return builder.finish();
}

/**
 * Parse YAML frontmatter and provide folding widget
 */
export const frontmatterExtension = StateField.define<DecorationSet>({
  create(state) {
    return buildFrontmatterDecorations(state);
  },
  update(decorations, tr) {
    if (tr.docChanged) {
      return buildFrontmatterDecorations(tr.state);
    }
    return decorations.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});
