import { useEffect, useRef } from "react";
import { EditorState, Transaction } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  highlightActiveLine,
  rectangularSelection,
  crosshairCursor,
  Decoration,
  ViewPlugin,
  type DecorationSet,
  MatchDecorator,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  bracketMatching,
} from "@codemirror/language";
import {
  closeBrackets,
  closeBracketsKeymap,
  autocompletion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { useVaultStore } from "../../state/vaultStore";
import { useEditorStore } from "../../state/editorStore";
import type { FileNode } from "../../state/types";

// ── Theme ──
// Uses CSS variables so it works with lattice's dark/light theme toggle.
const editorTheme = EditorView.theme(
  {
    "&": {
      color: "var(--fg, #dcdcdc)",
      backgroundColor: "transparent",
      height: "100%",
      fontFamily: "var(--font-mono, 'SF Mono', 'Fira Code', monospace)",
      fontSize: "var(--editor-font-size, 15px)",
      lineHeight: "1.7",
    },
    "&.cm-focused": {
      outline: "none",
    },
    ".cm-content": {
      caretColor: "var(--fg, #dcdcdc)",
      fontFamily:
        "var(--font-sans, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif)",
      padding: "4px 24px",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      padding: "0 16px 0 8px !important",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--fg, #dcdcdc)",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      {
        backgroundColor: "var(--selection-bg, rgba(255,255,255,0.15)) !important",
      },
    ".cm-panels": {
      backgroundColor: "var(--bg-2, #252526)",
      color: "var(--fg, #dcdcdc)",
    },
    ".cm-activeLine": { backgroundColor: "transparent" },
    ".cm-selectionMatch": {
      backgroundColor: "var(--selection-bg, rgba(255,255,255,0.15))",
    },
    "&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket": {
      backgroundColor: "var(--selection-bg, rgba(255,255,255,0.15))",
      outline: "1px solid var(--border, rgba(255,255,255,0.1))",
    },
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: "var(--fg-3, #666)",
      border: "none",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "transparent",
      color: "var(--fg-2, #999)",
    },
    ".cm-foldPlaceholder": {
      backgroundColor: "transparent",
      border: "none",
      color: "var(--fg-3, #666)",
    },
    ".cm-tooltip": {
      border: "1px solid var(--border, rgba(255,255,255,0.1))",
      backgroundColor: "var(--bg-2, #252526)",
    },
    ".cm-tooltip-autocomplete": {
      "& > ul > li": {
        color: "var(--fg, #dcdcdc)",
      },
      "& > ul > li[aria-selected]": {
        backgroundColor: "var(--accent-bg, rgba(100,149,237,0.3))",
        color: "var(--fg, #dcdcdc)",
      },
    },
  },
  { dark: true },
);

// ── Wikilink decoration ──
const wikilinkDecorator = new MatchDecorator({
  regexp: /\[\[([^\]]+)\]\]/g,
  decoration: (match) => {
    return Decoration.mark({
      class: "cm-wikilink",
      attributes: { "data-target": match[1] },
    });
  },
});

const wikilinkPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = wikilinkDecorator.createDeco(view);
    }
    update(update: any) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = wikilinkDecorator.updateDeco(
          update,
          this.decorations,
        );
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);

const wikilinkStyle = EditorView.baseTheme({
  ".cm-wikilink": {
    color: "var(--accent, cornflowerblue)",
    cursor: "pointer",
    textDecoration: "underline",
    textDecorationColor: "transparent",
    transition: "text-decoration-color 0.15s, background-color 0.15s",
    borderRadius: "3px",
    padding: "0 2px",
  },
  ".cm-wikilink:hover": {
    backgroundColor: "rgba(255, 255, 255, 0.12)",
  },
});

// ── Wikilink autocomplete ──
function collectAllFiles(
  nodes: FileNode[],
): { name: string; id: string }[] {
  const results: { name: string; id: string }[] = [];
  for (const node of nodes) {
    if (node.kind !== "folder") {
      if (node.name.toLowerCase().endsWith(".md")) {
        results.push({
          name: node.name.replace(/\.md$/i, ""),
          id: node.id,
        });
      } else if (!node.name.endsWith(".canvas")) {
        // Other text files
        results.push({ name: node.name, id: node.id });
      }
    }
    if (node.children) {
      results.push(...collectAllFiles(node.children));
    }
  }
  return results;
}

function wikilinkCompletions(
  context: CompletionContext,
): CompletionResult | null {
  const match = context.matchBefore(/\[\[[^\]]*/);
  if (!match) return null;

  const query = match.text.slice(2).toLowerCase();
  const tree = useVaultStore.getState().fileTree;
  const allFiles = collectAllFiles(tree);

  const options = allFiles
    .filter(
      (f) =>
        query === "" ||
        f.name.toLowerCase().includes(query),
    )
    .map((f) => ({
      label: f.name,
      apply: (view: EditorView) => {
        view.dispatch({
          changes: {
            from: match.from,
            to: context.pos,
            insert: `[[${f.name}]]`,
          },
        });
      },
    }));

  return {
    from: match.from,
    options,
    filter: false,
  };
}

// ── Component ──
type Props = {
  /** Current file content. */
  content: string;
  /** Absolute path of the file being edited. */
  filePath: string;
  /** Called on every content change (debounced internally). */
  onChange: (content: string) => void;
  /** Called on Cmd/Ctrl+S. */
  onSave: () => void;
};

export function CodeMirrorEditor({ content, filePath, onChange, onSave }: Props) {
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const loadedFileRef = useRef<string | null>(null);

  // Stable callback refs to avoid re-creating the editor on every render
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  useEffect(() => {
    if (!editorRef.current || !filePath) return;
    // Don't re-create if we're already showing this file
    if (loadedFileRef.current === filePath && viewRef.current) return;

    // Destroy previous instance
    if (viewRef.current) {
      viewRef.current.destroy();
      viewRef.current = null;
    }

    loadedFileRef.current = filePath;
    const currentPath = filePath;

    let debounceTimer: ReturnType<typeof setTimeout>;

    const state = EditorState.create({
      doc: content,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        highlightActiveLine(),
        rectangularSelection(),
        crosshairCursor(),
        bracketMatching(),
        closeBrackets(),
        EditorView.lineWrapping,
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
          {
            key: "Mod-s",
            run: () => {
              onSaveRef.current();
              return true;
            },
          },
        ]),
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        editorTheme,
        syntaxHighlighting(defaultHighlightStyle),
        wikilinkPlugin,
        wikilinkStyle,
        autocompletion({
          override: [wikilinkCompletions],
          activateOnTyping: true,
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && update.transactions.some(tr => tr.annotation(Transaction.userEvent))) {
            // Mark dirty immediately
            const es = useEditorStore.getState();
            if (!es.dirtyFiles.has(currentPath)) {
              es.markDirty(currentPath);
            }
            // Debounce the content update
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
              const newContent = update.state.doc.toString();
              onChangeRef.current(newContent);
            }, 50);
          }
        }),
        EditorView.domEventHandlers({
          click: (_event, _view) => {
            const target = _event.target as HTMLElement;
            const wikilink = target.closest(".cm-wikilink") as HTMLElement;
            if (wikilink) {
              const linkTarget = wikilink.getAttribute("data-target");
              if (linkTarget) {
                // Dispatch a custom event that App.tsx can listen for
                window.dispatchEvent(
                  new CustomEvent("lattice-open-wikilink", {
                    detail: { target: linkTarget },
                  }),
                );
              }
              return true;
            }
          },
        }),
      ],
    });

    const view = new EditorView({ state, parent: editorRef.current });
    viewRef.current = view;

    return () => {
      clearTimeout(debounceTimer);
      view.destroy();
      viewRef.current = null;
      loadedFileRef.current = null;
    };
    // Re-create when file path changes or when content first loads.
    // `content !== undefined` ensures it runs once content is fetched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, content !== undefined]);

  // Sync external content changes (e.g. from another pane editing the same file)
  useEffect(() => {
    if (!viewRef.current || content === undefined) return;
    if (viewRef.current.hasFocus) return;

    const currentDoc = viewRef.current.state.doc.toString();
    if (content !== currentDoc) {
      viewRef.current.dispatch({
        changes: { from: 0, to: currentDoc.length, insert: content },
      });
    }
  }, [content]);

  // Global Cmd+S handler (catches save even when editor isn't focused)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        onSaveRef.current();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <div
      ref={editorRef}
      className="editor-container"
      style={{ height: "100%", overflow: "hidden" }}
    />
  );
}
