import {
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";

interface SlashCommand {
  label: string;
  detail: string;
  insert: string;
  /** Move cursor back this many characters after insert */
  cursorBack?: number;
}

const SLASH_COMMANDS: SlashCommand[] = [
  // Headings
  { label: "/h1", detail: "Heading 1", insert: "# " },
  { label: "/h2", detail: "Heading 2", insert: "## " },
  { label: "/h3", detail: "Heading 3", insert: "### " },
  { label: "/h4", detail: "Heading 4", insert: "#### " },

  // Lists
  { label: "/ul", detail: "Bullet list", insert: "- " },
  { label: "/ol", detail: "Numbered list", insert: "1. " },
  { label: "/todo", detail: "Task / checkbox", insert: "- [ ] " },
  { label: "/toggle", detail: "In-progress task", insert: "- [/] " },

  // Blocks
  { label: "/quote", detail: "Block quote", insert: "> " },
  { label: "/code", detail: "Code block", insert: "```\n\n```", cursorBack: 4 },
  { label: "/hr", detail: "Horizontal rule", insert: "\n---\n" },
  { label: "/table", detail: "Table", insert: "| Col 1 | Col 2 |\n| --- | --- |\n| | |\n", cursorBack: 5 },

  // Callouts (Obsidian-compatible)
  { label: "/note", detail: "Note callout", insert: "> [!note]\n> " },
  { label: "/tip", detail: "Tip callout", insert: "> [!tip]\n> " },
  { label: "/warning", detail: "Warning callout", insert: "> [!warning]\n> " },
  { label: "/info", detail: "Info callout", insert: "> [!info]\n> " },
  { label: "/success", detail: "Success callout", insert: "> [!success]\n> " },
  { label: "/danger", detail: "Danger callout", insert: "> [!danger]\n> " },
  { label: "/example", detail: "Example callout", insert: "> [!example]\n> " },
  { label: "/abstract", detail: "Abstract callout", insert: "> [!abstract]\n> " },

  // Math
  { label: "/math", detail: "Inline math", insert: "$", cursorBack: 0 },
  { label: "/mathblock", detail: "Math block", insert: "$$\n\n$$", cursorBack: 3 },

  // Diagrams
  { label: "/mermaid", detail: "Mermaid diagram", insert: "```mermaid\ngraph TD\n  A --> B\n```", cursorBack: 4 },

  // Links & embeds
  { label: "/link", detail: "Wikilink", insert: "[[", cursorBack: 0 },
  { label: "/embed", detail: "Embed note/image", insert: "![[", cursorBack: 0 },
  { label: "/url", detail: "External link", insert: "[]()", cursorBack: 1 },
  { label: "/image", detail: "Image link", insert: "![]()", cursorBack: 1 },

  // Inline formatting
  { label: "/bold", detail: "Bold text", insert: "****", cursorBack: 2 },
  { label: "/italic", detail: "Italic text", insert: "__", cursorBack: 1 },
  { label: "/strike", detail: "Strikethrough", insert: "~~~~", cursorBack: 2 },
  { label: "/highlight", detail: "Highlight", insert: "====", cursorBack: 2 },
  { label: "/code-inline", detail: "Inline code", insert: "``", cursorBack: 1 },

  // Frontmatter
  { label: "/frontmatter", detail: "YAML frontmatter", insert: "---\ntitle: \ntags: []\n---\n", cursorBack: 12 },

  // Date / time
  {
    label: "/date",
    detail: "Today's date",
    insert: new Date().toISOString().slice(0, 10),
  },
  {
    label: "/time",
    detail: "Current time",
    insert: new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
  },
  {
    label: "/datetime",
    detail: "Date + time",
    insert: new Date().toISOString().slice(0, 16).replace("T", " "),
  },
];

function slashCompletions(context: CompletionContext): CompletionResult | null {
  // Match "/" at the start of a word boundary (beginning of line or after whitespace)
  const match = context.matchBefore(/(?:^|\s)\/\w*/);
  if (!match) return null;
  // Only trigger when explicitly invoked or user typed a slash
  if (!context.explicit && !match.text.trimStart().startsWith("/")) return null;

  const slashStart = match.from + match.text.indexOf("/");
  const query = match.text.slice(match.text.indexOf("/") + 1).toLowerCase();

  const filtered = SLASH_COMMANDS.filter(
    (c) =>
      query === "" ||
      c.label.slice(1).includes(query) ||
      c.detail.toLowerCase().includes(query),
  );

  return {
    from: slashStart,
    options: filtered.map((cmd) => ({
      label: cmd.label,
      detail: cmd.detail,
      type: "keyword",
      apply: (view: EditorView, _completion, from, to) => {
        let insert = cmd.insert;
        // Replace date/time tokens dynamically
        if (cmd.label === "/date") insert = new Date().toISOString().slice(0, 10);
        if (cmd.label === "/time") insert = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
        if (cmd.label === "/datetime") insert = new Date().toISOString().slice(0, 16).replace("T", " ");

        view.dispatch({
          changes: { from, to, insert },
          selection: {
            anchor: from + insert.length - (cmd.cursorBack ?? 0),
          },
        });
      },
    })),
    filter: false,
  };
}

/** Theme for the slash-command popup: adds a "/" prefix icon to entries */
const slashTheme = EditorView.baseTheme({
  ".cm-tooltip-autocomplete .cm-completionIcon-keyword::after": {
    content: "'/'",
    fontWeight: "600",
    color: "var(--accent)",
  },
});

/**
 * Export the raw completion source so callers can merge it
 * with other sources in a single autocompletion() call.
 * Do NOT export an autocompletion() extension here — having two
 * autocompletion facets registered causes a "Config merge conflict"
 * error.
 */
export { slashCompletions as slashCompletionSource };
export const slashThemeExtension = slashTheme;
