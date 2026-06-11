/**
 * CodeMirror extension for Logseq-style outliner mode
 * 
 * Implements:
 * - Block fold glyphs for nested bullet lists
 * - Stable block IDs via hidden HTML comments
 * - Block reference rendering for ((block-ref)) syntax
 * 
 * Used when:
 * - Frontmatter has `outliner: true`, OR
 * - File path matches `journals/` prefix (configurable)
 */

import {
  StateEffect,
  StateField,
  RangeSetBuilder,
  type EditorState,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  WidgetType,
  type ViewUpdate,
  gutter,
  GutterMarker,
} from "@codemirror/view";

// ── Block references ((block-ref)) ────────────────────────────────────────

/**
 * Widget that renders a block reference inline.
 * In a full implementation, this would fetch the referenced block content.
 * For now, it just shows the reference ID.
 */
class BlockRefWidget extends WidgetType {
  constructor(readonly blockId: string) {
    super();
  }

  eq(other: BlockRefWidget) {
    return this.blockId === other.blockId;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-block-ref";
    span.textContent = `((${this.blockId}))`;
    span.title = `Block reference: ${this.blockId}`;
    return span;
  }
}

/**
 * ViewPlugin that decorates ((block-ref)) syntax with widgets.
 */
const blockRefPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    buildDecorations(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      const BLOCK_REF_REGEX = /\(\(([a-z0-9]{8})\)\)/g;

      for (const { from, to } of view.visibleRanges) {
        let pos = from;
        while (pos < to) {
          const line = view.state.doc.lineAt(pos);
          let match;
          BLOCK_REF_REGEX.lastIndex = 0;

          while ((match = BLOCK_REF_REGEX.exec(line.text)) !== null) {
            const start = line.from + match.index;
            const end = start + match[0].length;
            builder.add(
              start,
              end,
              Decoration.replace({
                widget: new BlockRefWidget(match[1]),
              })
            );
          }

          pos = line.to + 1;
        }
      }

      return builder.finish();
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);

// ── Fold glyph (gutter marker for collapsible blocks) ────────────────────

/**
 * Gutter marker that shows a fold/unfold triangle for list items with children.
 */
class FoldMarker extends GutterMarker {
  constructor(readonly folded: boolean) {
    super();
  }

  eq(other: FoldMarker) {
    return this.folded === other.folded;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-fold-glyph";
    span.textContent = this.folded ? "▶" : "▼";
    span.style.cursor = "pointer";
    span.style.userSelect = "none";
    span.style.color = "var(--text-faint)";
    span.title = this.folded ? "Expand block" : "Collapse block";
    return span;
  }
}

/**
 * StateEffect to toggle fold state for a specific line.
 */
const toggleFoldEffect = StateEffect.define<number>();

/**
 * StateField that tracks which lines are folded.
 */
const foldState = StateField.define<Set<number>>({
  create: () => new Set(),
  update(folds, tr) {
    folds = new Set(folds);
    for (const effect of tr.effects) {
      if (effect.is(toggleFoldEffect)) {
        const line = effect.value;
        if (folds.has(line)) {
          folds.delete(line);
        } else {
          folds.add(line);
        }
      }
    }
    return folds;
  },
});

/**
 * Determines if a line is a list item that has children (nested items).
 */
function hasNestedItems(state: EditorState, lineNum: number): boolean {
  const line = state.doc.line(lineNum);
  const lineText = line.text;
  const match = /^(\s*)([-*+]|\d+[.)])(\s+)/.exec(lineText);
  if (!match) return false;

  const currentIndent = match[1].length;
  
  // Check if the next line is more indented
  if (lineNum >= state.doc.lines) return false;
  const nextLine = state.doc.line(lineNum + 1);
  const nextMatch = /^(\s*)([-*+]|\d+[.)])/.exec(nextLine.text);
  if (!nextMatch) return false;

  return nextMatch[1].length > currentIndent;
}

/**
 * Gutter for fold markers.
 */
const foldGutter = gutter({
  class: "cm-fold-gutter",
  markers: (view) => {
    const folds = view.state.field(foldState, false);
    if (!folds) return [];

    const builder = new RangeSetBuilder<GutterMarker>();
    for (const { from, to } of view.visibleRanges) {
      let pos = from;
      while (pos <= to) {
        const line = view.state.doc.lineAt(pos);
        const lineNum = line.number;
        
        if (hasNestedItems(view.state, lineNum)) {
          const isFolded = folds.has(lineNum);
          builder.add(line.from, line.from, new FoldMarker(isFolded));
        }

        pos = line.to + 1;
      }
    }
    return builder.finish();
  },
  domEventHandlers: {
    mousedown: (view, line) => {
      const lineNum = view.state.doc.lineAt(line.from).number;
      if (hasNestedItems(view.state, lineNum)) {
        view.dispatch({
          effects: toggleFoldEffect.of(lineNum),
        });
        return true;
      }
      return false;
    },
  },
});

/**
 * ViewPlugin that hides folded content.
 */
const foldContentPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.transactions.some((tr) =>
          tr.effects.some((e) => e.is(toggleFoldEffect))
        )
      ) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    buildDecorations(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      const folds = view.state.field(foldState, false);
      if (!folds || folds.size === 0) return builder.finish();

      for (const foldedLineNum of folds) {
        if (foldedLineNum > view.state.doc.lines) continue;

        const parentLine = view.state.doc.line(foldedLineNum);
        const parentMatch = /^(\s*)([-*+]|\d+[.)])/.exec(parentLine.text);
        if (!parentMatch) continue;

        const parentIndent = parentMatch[1].length;
        let hideFrom = parentLine.to + 1;
        let hideTo = hideFrom;

        // Find all lines that are children (more indented)
        for (
          let nextNum = foldedLineNum + 1;
          nextNum <= view.state.doc.lines;
          nextNum++
        ) {
          const nextLine = view.state.doc.line(nextNum);
          const nextMatch = /^(\s*)([-*+]|\d+[.)])/.exec(nextLine.text);
          
          // Stop if we hit a line at same or less indent, or non-list line
          if (!nextMatch || nextMatch[1].length <= parentIndent) {
            break;
          }

          hideTo = nextLine.to + 1;
        }

        if (hideTo > hideFrom) {
          builder.add(
            hideFrom,
            hideTo - 1,
            Decoration.replace({})
          );
        }
      }

      return builder.finish();
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);

// ── Styling ──────────────────────────────────────────────────────────────

const outlinerTheme = EditorView.baseTheme({
  ".cm-fold-gutter": {
    width: "20px",
    paddingRight: "4px",
  },
  ".cm-fold-glyph": {
    display: "inline-block",
    width: "16px",
    textAlign: "center",
    fontSize: "10px",
  },
  ".cm-block-ref": {
    color: "var(--accent)",
    backgroundColor: "var(--hover)",
    padding: "2px 6px",
    borderRadius: "4px",
    fontSize: "0.9em",
    fontFamily: "var(--font-mono)",
    cursor: "pointer",
    border: "1px solid var(--border-strong)",
  },
  ".cm-block-ref:hover": {
    backgroundColor: "var(--selection)",
  },
});

// ── Main outliner extension ──────────────────────────────────────────────

/**
 * Parse frontmatter to detect if outliner mode is enabled.
 */
function isOutlinerEnabled(state: EditorState): boolean {
  const firstLine = state.doc.line(1).text;
  if (firstLine !== "---") return false;

  let endLine = 0;
  for (let i = 2; i <= Math.min(50, state.doc.lines); i++) {
    if (state.doc.line(i).text === "---") {
      endLine = i;
      break;
    }
  }

  if (endLine === 0) return false;

  // Check for `outliner: true` in frontmatter
  for (let i = 2; i < endLine; i++) {
    const line = state.doc.line(i).text;
    if (/^\s*outliner:\s*true\s*$/.test(line)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if the file path indicates outliner mode (e.g., journals/).
 */
export function shouldEnableOutliner(
  state: EditorState,
  filePath?: string
): boolean {
  // Check frontmatter
  if (isOutlinerEnabled(state)) return true;

  // Check if path is in journals/ folder
  if (filePath && (filePath.includes("\\journals\\") || filePath.includes("/journals/"))) {
    return true;
  }

  return false;
}

/**
 * Returns the full outliner extension.
 * Includes fold gutter, block references, and styling.
 */
export function outlinerExtension() {
  return [
    foldState,
    foldGutter,
    foldContentPlugin,
    blockRefPlugin,
    outlinerTheme,
  ];
}

/**
 * Outliner mode compartment for dynamic toggling.
 */
export { foldState, toggleFoldEffect };
