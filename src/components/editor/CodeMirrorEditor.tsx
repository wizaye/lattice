import { useEffect, useRef, useState } from "react";
import { EditorState, RangeSetBuilder, StateEffect, StateField, Transaction } from "@codemirror/state";
import {
  openSearchPanel,
  search,
  searchKeymap,
} from "@codemirror/search";
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
import type { Command } from "@codemirror/view";
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
import { useSettingsStore } from "../../state/settingsStore";
import type { FileNode } from "../../state/types";
import type { JumpToLineDetail } from "../../lib/backlinks";
import { outlinerExtension, shouldEnableOutliner } from "./cm-outliner";
import { vimMode as makeVimExtension } from "./extensions/cm-vim";
import { LoroProvider } from "../../lib/collab";
import {
  embedsExtension,
  calloutsExtension,
  frontmatterExtension,
  headingFoldExtension,
  sectionLinksExtension,
  slashCompletionSource,
  slashThemeExtension,
  livePreviewExtension,
} from "./extensions";

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
    padding: "32px 24px 96px 24px",
    color: "var(--text-normal)",
    maxWidth: "720px",
    marginLeft: "auto",
    marginRight: "auto",
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
  ".cm-activeLine": { backgroundColor: "var(--hover)" },
  ".cm-codeBlock": {
    fontFamily: "var(--font-mono)",
  },
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
    fontSize: "1.9em",
    lineHeight: "1.25",
  },
  {
    tag: t.heading2,
    color: "var(--text-normal)",
    fontWeight: "700",
    fontSize: "1.5em",
    lineHeight: "1.25",
  },
  {
    tag: t.heading3,
    color: "var(--text-normal)",
    fontWeight: "600",
    fontSize: "1.25em",
    lineHeight: "1.25",
  },
  {
    tag: t.heading4,
    color: "var(--text-normal)",
    fontWeight: "600",
    fontSize: "1.1em",
    lineHeight: "1.25",
  },
  {
    tag: t.heading5,
    color: "var(--text-normal)",
    fontWeight: "600",
    fontSize: "1.0em",
    lineHeight: "1.25",
  },
  {
    tag: t.heading6,
    color: "var(--text-muted)",
    fontWeight: "600",
    fontSize: "0.9em",
    lineHeight: "1.25",
  },
  { tag: t.strong, color: "var(--text-normal)", fontWeight: "700" },
  { tag: t.emphasis, color: "var(--text-normal)", fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  // Inline code: mono font + background/padding + slight accent
  {
    tag: t.monospace,
    fontFamily: "var(--font-mono)",
    color: "var(--syn-mono)",
    backgroundColor: "var(--hover)",
    padding: "1px 4px",
    borderRadius: "3px",
  },
  // Frontmatter YAML & metadata
  {
    tag: t.meta,
    fontFamily: "var(--font-mono)",
    color: "var(--text-muted)",
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

// ── Flash-line decoration (backlink jump-to-line target highlight) ──
// Why: clicking a backlink snippet in the right sidebar dispatches
// `lattice-jump-to-line` with a 1-based source line. The listener
// below scrolls the editor and fires `flashLineEffect.of(line)`; the
// state field paints a single-line decoration that the theme styles
// with a transient `var(--selection)` background. After ~1.2s the
// listener fires `clearFlashLineEffect.of(null)` and the background
// fades back to transparent via CSS transition.
const flashLineEffect = StateEffect.define<number>();
const clearFlashLineEffect = StateEffect.define<null>();

const flashLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(set, tr) {
    set = set.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(flashLineEffect)) {
        const ln = e.value;
        if (ln >= 1 && ln <= tr.state.doc.lines) {
          set = Decoration.set([
            Decoration.line({ class: "cm-flash-line" }).range(
              tr.state.doc.line(ln).from,
            ),
          ]);
        }
      } else if (e.is(clearFlashLineEffect)) {
        set = Decoration.none;
      }
    }
    return set;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const flashLineTheme = EditorView.baseTheme({
  ".cm-flash-line": {
    backgroundColor: "var(--selection)",
    transition: "background-color 1.2s ease-out",
  },
});

// ── List hanging indent ──
// Why: Obsidian renders nested ordered/bulleted lists with hanging indent
// so wrapped continuation lines align UNDER the content (not flush at
// column 0). With plain `EditorView.lineWrapping`, our wraps fell back
// to column 0, which made deeply-nested items look "sidelined" — the
// nested markers blurred into the parent's wrap text.
// How: for each line matching `^(\s*)([-*+]|\d+[.)])(\s+)`, add a line
// decoration with `padding-left: Xch; text-indent: -Xch;` where X is the
// full prefix width. The two declarations cancel for the first visual
// line (so source still reads normally) but `padding-left` keeps every
// wrapped continuation indented by X chars, giving the hanging-indent
// shape. `ch` is the width of "0" in the active font — close enough to
// the actual char width of `1. ` / `   1. `.
// NOTE: We do NOT draw indent guide lines here — Obsidian only draws
// them in reading mode (the source editor stays clean). The preview-mode
// guide lives in EditorArea.css under `.md-preview li:has(> ul, > ol)`.
const LIST_LINE_RE = /^(\s*)([-*+]|\d+[.)])(\s+)/;

const listHangingIndent = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(update: { docChanged: boolean; viewportChanged: boolean; view: EditorView }) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = this.build(update.view);
      }
    }
    build(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      for (const { from, to } of view.visibleRanges) {
        let pos = from;
        while (pos <= to) {
          const line = view.state.doc.lineAt(pos);
          const m = LIST_LINE_RE.exec(line.text);
          if (m) {
            const prefix = m[0].length; // leading WS + marker + trailing WS
            builder.add(
              line.from,
              line.from,
              Decoration.line({
                attributes: {
                  style: `padding-left:${prefix}ch;text-indent:-${prefix}ch;`,
                },
              }),
            );
          }
          if (line.to + 1 <= pos) break; // safety against zero-width loops
          pos = line.to + 1;
        }
      }
      return builder.finish();
    }
  },
  { decorations: (v) => v.decorations },
);

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

// ── List-aware Tab / Shift-Tab ──
// Plain `indentWithTab` adds 2 spaces, which is NOT enough to nest a
// CommonMark list under `1. ` (the parent's content column is 3, so the
// child must be indented ≥3 spaces). It also doesn't renumber ordered
// lists, so the visible source stays `2.` after the indent and reads
// wrong. These two commands fix both:
//   • Tab on a list line: indent by (marker + trailing whitespace) chars
//     (e.g. 3 for `1. `, 2 for `- `), and renumber ordered markers to `1.`
//     (the Obsidian convention for a new nested sublist).
//   • Shift-Tab on a list line: dedent by the same unit, capped by current
//     indent. Numbering is left alone on dedent (re-sequencing the new
//     parent's siblings is out of scope and would surprise the user).
// Both return `false` when no selected line is a list item, so the keymap
// falls through to `indentWithTab` for code / prose.
const LIST_MARKER_RE = /^(\s*)([-*+]|\d+[.)])(\s+)/;

function selectedLineNumbers(state: EditorState): number[] {
  const set = new Set<number>();
  for (const r of state.selection.ranges) {
    const fromLine = state.doc.lineAt(r.from).number;
    const toLine = state.doc.lineAt(r.to).number;
    for (let n = fromLine; n <= toLine; n++) set.add(n);
  }
  return [...set];
}

const indentListLine: Command = (view) => {
  const { state } = view;
  type Hit = {
    line: ReturnType<typeof state.doc.line>;
    leadingWs: string;
    marker: string;
    trailingWs: string;
  };
  const hits: Hit[] = [];
  for (const n of selectedLineNumbers(state)) {
    const line = state.doc.line(n);
    const m = LIST_MARKER_RE.exec(line.text);
    if (!m) return false; // Mixed selection — let indentWithTab handle it.
    hits.push({ line, leadingWs: m[1], marker: m[2], trailingWs: m[3] });
  }
  if (hits.length === 0) return false;

  const changes = hits.map(({ line, leadingWs, marker, trailingWs }) => {
    const indent = " ".repeat(marker.length + trailingWs.length);
    if (/^\d+/.test(marker)) {
      // Restart ordered numbering to 1 (e.g. "2." -> "1.", "10)" -> "1)").
      const suffix = marker.replace(/^\d+/, "");
      const newMarker = "1" + suffix;
      return {
        from: line.from,
        to: line.from + leadingWs.length + marker.length,
        insert: indent + leadingWs + newMarker,
      };
    }
    return { from: line.from, insert: indent };
  });

  view.dispatch({ changes, userEvent: "input.indent" });
  return true;
};

const dedentListLine: Command = (view) => {
  const { state } = view;
  type Hit = {
    line: ReturnType<typeof state.doc.line>;
    leadingWs: string;
    marker: string;
    trailingWs: string;
  };
  const hits: Hit[] = [];
  for (const n of selectedLineNumbers(state)) {
    const line = state.doc.line(n);
    const m = LIST_MARKER_RE.exec(line.text);
    if (!m) return false;
    if (m[1].length === 0) return false; // Already at column 0 — no-op.
    hits.push({ line, leadingWs: m[1], marker: m[2], trailingWs: m[3] });
  }
  if (hits.length === 0) return false;

  const changes = hits.map(({ line, leadingWs, marker, trailingWs }) => {
    const unit = marker.length + trailingWs.length;
    const remove = Math.min(unit, leadingWs.length);
    return { from: line.from, to: line.from + remove };
  });

  view.dispatch({ changes, userEvent: "delete.dedent" });
  return true;
};

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

  const showLineNumbers = useSettingsStore((s) => s.lineNumbers);
  const wordWrap = useSettingsStore((s) => s.wordWrap);
  const vimEnabled = useSettingsStore((s) => s.vimMode);
  const collabEnabled = useSettingsStore((s) => s.collabEnabled);

  // LoroProvider is created per file, stored in a ref so the same instance
  // survives theme/setting changes that recreate the CM6 editor.
  const loroProviderRef = useRef<LoroProvider | null>(null);

  // Create or destroy the Loro provider when collab is toggled or file changes
  useEffect(() => {
    if (!collabEnabled || !filePath) {
      loroProviderRef.current?.destroy();
      loroProviderRef.current = null;
      return;
    }
    // New file → new provider
    const provider = new LoroProvider(filePath);
    loroProviderRef.current = provider;
    return () => {
      provider.destroy();
      if (loroProviderRef.current === provider) loroProviderRef.current = null;
    };
  }, [collabEnabled, filePath]);

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

    // Check if outliner mode should be enabled
    const tempState = EditorState.create({ doc: content ?? "" });
    const enableOutliner = shouldEnableOutliner(tempState, filePath);

    const state = EditorState.create({
      doc: content ?? "",
      extensions: [
        ...(showLineNumbers ? [lineNumbers()] : []),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        highlightActiveLine(),
        rectangularSelection(),
        crosshairCursor(),
        bracketMatching(),
        closeBrackets(),
        ...(wordWrap ? [EditorView.lineWrapping] : []),
        keymap.of([
          ...closeBracketsKeymap,
          // List-aware Tab handlers go BEFORE indentWithTab so they take
          // precedence on list lines and fall through everywhere else.
          { key: "Tab", run: indentListLine },
          { key: "Shift-Tab", run: dedentListLine },
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
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
        flashLineField,
        flashLineTheme,
        listHangingIndent,
        // Search panel — Ctrl+F / Cmd+F opens in-editor find bar
        search({ top: false }),
        // Enable outliner extensions when appropriate
        ...(enableOutliner ? [outlinerExtension()] : []),
        // Vim mode (must come before other keymaps to take priority)
        ...makeVimExtension(vimEnabled),
        // Obsidian-compat extensions (single ViewPlugin — no spread)
        embedsExtension,
        calloutsExtension,
        frontmatterExtension,
        ...headingFoldExtension,
        sectionLinksExtension,
        // Slash command theme only (completion source merged below)
        slashThemeExtension,
        // Live preview: collapse markdown syntax on non-cursor lines
        ...livePreviewExtension,
        // Single autocompletion() merging wikilinks + slash commands
        autocompletion({
          override: [wikilinkCompletions, slashCompletionSource],
          activateOnTyping: true,
        }),
        // Loro CRDT sync extension (only when collab is enabled)
        ...(loroProviderRef.current ? [loroProviderRef.current.getCM6Extension()] : []),
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
          // Broadcast vim mode changes so the status bar can reflect them
          if (vimEnabled) {
            const vimState = (update.state as any).vim;
            const mode: string = vimState?.mode ?? "normal";
            window.dispatchEvent(new CustomEvent("lattice-vim-mode", { detail: { mode } }));
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

    // Bind the Loro provider to this view so remote changes can be applied
    let unbindLoro: (() => void) | null = null;
    if (loroProviderRef.current) {
      unbindLoro = loroProviderRef.current.bind(view);
    }

    return () => {
      clearTimeout(debounceTimer);
      unbindLoro?.();
      view.destroy();
      viewRef.current = null;
      loadedFileRef.current = null;
    };
    // Re-create when file path, theme, vim mode, or collab flag changes.
    // Content updates are handled by the sync effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, isDark, showLineNumbers, wordWrap, vimEnabled, collabEnabled]);

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

  // DocMoreMenu "Find…" / "Replace…" → open CodeMirror search panel.
  // The DocMoreMenu dispatches `lattice-editor-find` on the window;
  // we self-filter by filePath so only the active file's editor opens.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ filePath?: string; withReplace?: boolean }>).detail;
      if (detail?.filePath && detail.filePath !== filePath) return;
      const view = viewRef.current;
      if (!view) return;
      view.focus();
      openSearchPanel(view);
    };
    window.addEventListener("lattice-editor-find", handler as EventListener);
    return () => window.removeEventListener("lattice-editor-find", handler as EventListener);
  }, [filePath]);

  // Jump-to-line bridge (backlink snippet → editor line). Listens
  // globally because multiple CodeMirror editors may be mounted across
  // panes; we self-filter by `filePath`. Scrolls the target line to
  // vertical center, places the cursor at column 0, and paints a
  // transient `.cm-flash-line` highlight that fades after ~1.2s.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<JumpToLineDetail>).detail;
      if (!detail || detail.fileId !== filePath) return;
      const view = viewRef.current;
      if (!view) return;
      const total = view.state.doc.lines;
      const ln = Math.max(1, Math.min(total, Math.floor(detail.line)));
      const lineInfo = view.state.doc.line(ln);
      const col = Math.max(
        0,
        Math.min(lineInfo.length, Math.floor(detail.column ?? 0)),
      );
      const anchor = lineInfo.from + col;
      view.dispatch({
        selection: { anchor },
        effects: [
          EditorView.scrollIntoView(anchor, { y: "center" }),
          flashLineEffect.of(ln),
        ],
      });
      // Clear the flash after a short delay so the highlight feels
      // like a momentary pulse rather than a permanent mark.
      const id = window.setTimeout(() => {
        const v = viewRef.current;
        if (!v) return;
        v.dispatch({ effects: clearFlashLineEffect.of(null) });
      }, 1200);
      return () => window.clearTimeout(id);
    };
    window.addEventListener("lattice-jump-to-line", handler as EventListener);
    return () =>
      window.removeEventListener(
        "lattice-jump-to-line",
        handler as EventListener,
      );
  }, [filePath]);

  return (
    <div
      ref={editorRef}
      className="editor-container"
      style={{ height: "100%", overflow: "hidden" }}
    />
  );
}
