import { useEffect, useRef, useState } from "react";
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
  HighlightStyle,
  bracketMatching,
} from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
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
// Uses the app's own CSS tokens (set in App.css for both `:root` and
// `:root[data-theme="light"]`) so light / dark switch instantly without
// re-creating the editor. The previous version referenced `--fg` /
// `--bg-2` which weren't defined anywhere — that's why light-mode text
// rendered as the fallback `#dcdcdc` (invisible on a white surface).
const editorThemeBase = {
  "&": {
    color: "var(--text-normal)",
    backgroundColor: "transparent",
    height: "100%",
    fontFamily: "var(--font-text)",
    fontSize: "var(--editor-font-size, 16px)",
    lineHeight: "1.7",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-text)",
    overflow: "auto",
  },
  ".cm-content": {
    caretColor: "var(--text-normal)",
    fontFamily: "var(--font-text)",
    padding: "16px 24px 80px 24px",
    color: "var(--text-normal)",
  },
  ".cm-line": { color: "var(--text-normal)" },
  ".cm-lineNumbers .cm-gutterElement": {
    padding: "0 12px 0 8px",
    color: "var(--text-faint)",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--text-normal)",
    borderLeftWidth: "2px",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    {
      backgroundColor: "var(--selection) !important",
    },
  ".cm-panels": {
    backgroundColor: "var(--bg-header)",
    color: "var(--text-normal)",
    borderTop: "1px solid var(--border-strong)",
  },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-selectionMatch": { backgroundColor: "var(--selection)" },
  "&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket": {
    backgroundColor: "var(--selection)",
    outline: "1px solid var(--border-strong)",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--text-faint)",
    border: "none",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--text-muted)",
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "transparent",
    border: "none",
    color: "var(--text-faint)",
  },
  ".cm-tooltip": {
    border: "1px solid var(--border-strong)",
    backgroundColor: "var(--bg-header)",
    color: "var(--text-normal)",
    borderRadius: "6px",
    boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
  },
  ".cm-tooltip-autocomplete": {
    "& > ul > li": {
      color: "var(--text-normal)",
      padding: "4px 8px",
    },
    "& > ul > li[aria-selected]": {
      backgroundColor: "var(--accent)",
      color: "#fff",
    },
  },
};

const editorThemeDark = EditorView.theme(editorThemeBase, { dark: true });
const editorThemeLight = EditorView.theme(editorThemeBase, { dark: false });

// ── Syntax highlighting ──
// PRINCIPLE: don't recolor body text. Only structural punctuation,
// inline code, and code-block tokens get pigment; everything else
// inherits `--text-normal`. Earlier versions tinted `t.list` and
// `t.link`, which the Lezer-markdown grammar applies to the WHOLE
// list item / link expression (not just the marker), turning every
// numbered/bulleted line purple. Wikilinks already get their own
// `--accent` color via the .cm-wikilink decoration class.
const markdownHighlight = HighlightStyle.define([
  // Markdown structure — keep body color, just weight/size/italic
  {
    tag: t.heading1,
    color: "var(--text-normal)",
    fontWeight: "700",
    fontSize: "1.6em",
    lineHeight: "1.3",
  },
  {
    tag: t.heading2,
    color: "var(--text-normal)",
    fontWeight: "700",
    fontSize: "1.35em",
    lineHeight: "1.3",
  },
  {
    tag: t.heading3,
    color: "var(--text-normal)",
    fontWeight: "600",
    fontSize: "1.2em",
  },
  {
    tag: t.heading4,
    color: "var(--text-normal)",
    fontWeight: "600",
    fontSize: "1.08em",
  },
  {
    tag: [t.heading5, t.heading6],
    color: "var(--text-normal)",
    fontWeight: "600",
  },
  { tag: t.strong, color: "var(--text-normal)", fontWeight: "700" },
  { tag: t.emphasis, color: "var(--text-normal)", fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  // Inline code: mono font + slight accent — only spans `code`
  {
    tag: t.monospace,
    fontFamily: "var(--font-mono)",
    color: "var(--syn-mono)",
  },
  // Bare URLs (https://...) get the accent color; markdown `[text](url)`
  // links get NO color override — `t.link` would tint the whole `[text]`
  // span which is way too aggressive. Users can spot real wikilinks via
  // the dedicated `.cm-wikilink` decoration plugin.
  { tag: t.url, color: "var(--accent)" },
  // Block quotes — italicized + muted
  { tag: t.quote, color: "var(--text-muted)", fontStyle: "italic" },
  // Markdown structural punctuation (heading `#`, list `-`/`1.`, fence
  // markers, hr, etc.) sits in `processingInstruction` for lang-markdown.
  // Render it faint so the markers don't shout but stay visible.
  { tag: t.processingInstruction, color: "var(--text-faint)" },
  { tag: t.contentSeparator, color: "var(--text-muted)" },
  { tag: t.meta, color: "var(--text-muted)" },
  // ─ Code-block tokens (only inside ```lang fences) ─
  { tag: t.keyword, color: "var(--syn-keyword)" },
  { tag: [t.string, t.special(t.string)], color: "var(--syn-string)" },
  { tag: t.comment, color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: t.number, color: "var(--syn-number)" },
  { tag: [t.atom, t.bool, t.null], color: "var(--syn-atom)" },
  { tag: [t.typeName, t.className], color: "var(--syn-type)" },
  { tag: t.function(t.variableName), color: "var(--syn-function)" },
  { tag: t.variableName, color: "var(--syn-variable)" },
  { tag: t.propertyName, color: "var(--syn-variable)" },
  { tag: t.tagName, color: "var(--syn-tag)" },
  { tag: t.attributeName, color: "var(--syn-attr)" },
  { tag: [t.operator, t.derefOperator], color: "var(--text-muted)" },
  { tag: t.punctuation, color: "var(--text-muted)" },
  { tag: t.bracket, color: "var(--text-muted)" },
  { tag: t.invalid, color: "#f97583" },
]);

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
    color: "var(--accent)",
    cursor: "pointer",
    textDecoration: "underline",
    textDecorationColor: "transparent",
    transition: "text-decoration-color 0.15s, background-color 0.15s",
    borderRadius: "3px",
    padding: "0 2px",
  },
  ".cm-wikilink:hover": {
    backgroundColor: "var(--hover)",
    textDecorationColor: "var(--accent)",
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

  // Track active theme so we can pick the matching CodeMirror theme
  // extension (the `{dark}` flag controls native scrollbar/color-scheme
  // hints). Watching `<html data-theme>` keeps it in sync with the
  // app-level toggle in App.tsx without prop drilling.
  const [isDark, setIsDark] = useState(() => {
    if (typeof document === "undefined") return true;
    return document.documentElement.dataset.theme !== "light";
  });
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const sync = () => setIsDark(root.dataset.theme !== "light");
    const obs = new MutationObserver(sync);
    obs.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (!editorRef.current || !filePath) return;
    // Already showing this file with a live view? Keep it \u2014 the content
    // sync effect below will push any new prop value into the doc.
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
      doc: content ?? "",
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
        isDark ? editorThemeDark : editorThemeLight,
        syntaxHighlighting(markdownHighlight),
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
    // Re-create only when the file path or theme changes. Content
    // updates (initial load, external edits) are handled by the sync
    // effect below \u2014 NOT by destroying & rebuilding the editor, which
    // would steal focus and wipe undo history.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, isDark]);

  // Sync external content into the editor doc.
  //
  // Cases handled:
  //   1. File was opened via drag-drop \u2014 editor mounts with `content=""`
  //      while disk read is in flight; when the real content arrives we
  //      replace the empty doc with it.
  //   2. Another pane just edited the same file \u2014 mirror the change.
  //   3. Theme switch recreated the view above \u2014 reseed the doc.
  //
  // We don't clobber the user's in-progress edits: if the editor is
  // focused AND marked dirty, skip the overwrite. (Earlier this check
  // also fired on initial load when nothing was dirty, blocking the
  // first-paint sync \u2014 hence the explicit isDirty gate.)
  useEffect(() => {
    if (!viewRef.current) return;
    const next = content ?? "";
    const currentDoc = viewRef.current.state.doc.toString();
    if (next === currentDoc) return;
    const isDirty = useEditorStore.getState().dirtyFiles.has(filePath);
    if (viewRef.current.hasFocus && isDirty) return;
    viewRef.current.dispatch({
      changes: { from: 0, to: currentDoc.length, insert: next },
    });
  }, [content, filePath]);

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
