// Backlinks engine — pure functions over the in-memory vault map.
//
// Why a dedicated module:
// - App.tsx was open-coding a 25-line regex scan inline on every render.
// - The legacy version had a real bug: `[[Target|Alias]]` and
//   `[[Target#anchor]]` never matched because the comparison used the
//   raw match group (`m[1]`) instead of the cleaned target name.
// - Backlinks also need to feed stats (mentions per file, mention count
//   total, unlinked mentions count) for the right sidebar header + the
//   floating status pill. Centralising the engine here is the only way
//   to keep the two views consistent.
//
// Public surface:
//   collectOutgoing(content)         → unique outgoing wikilink names
//   collectTags(content)             → unique #tag names
//   collectHeadings(content)         → ordered { level, text } headings
//   countWords(md)                   → { words, characters }
//   computeBacklinks(targetFile, …)  → BacklinkGroup[] grouped by source file
//   computeUnlinkedMentions(…)       → MentionGroup[] grouped by source file
//   countMentions(groups)            → flat total of mention occurrences
//
// All matchers strip fenced code blocks before scanning so we don't
// count `[[foo]]` written inside ```code fences (matches what every
// other PKM does).

import type { FileNode } from "../state/types";

// ─── Types ────────────────────────────────────────────────────────────

export type Snippet = {
  /** 1-based line number in the source file (after stripping CRLF). */
  line: number;
  /** The text of that whole line, trimmed. */
  text: string;
  /** Inclusive [start, end) character offsets of the match inside `text`. */
  matchStart: number;
  matchEnd: number;
};

export type BacklinkGroup = {
  fileId: string;
  fileName: string;
  /** Path-style display label (parent folder if disambiguation is needed). */
  displayPath: string;
  /** One entry per `[[wikilink]]` occurrence inside this source file. */
  snippets: Snippet[];
};

export type MentionGroup = {
  fileId: string;
  fileName: string;
  displayPath: string;
  snippets: Snippet[];
};

export type OutgoingRef = { name: string };
export type HeadingRef = { level: number; text: string };

/** Payload for the `lattice-jump-to-line` CustomEvent. Lines are 1-based
 *  (matches CodeMirror `doc.line(n)` and `Snippet.line`). */
export type JumpToLineDetail = {
  fileId: string;
  line: number;
  column?: number;
};

// ─── Helpers ──────────────────────────────────────────────────────────

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

/**
 * Strip fenced + inline code so scanners don't see wikilinks-in-code.
 * Preserves line count by replacing fenced bodies with same-shape blanks.
 */
function stripCodeFences(md: string): string {
  return md.replace(/```[\s\S]*?```/g, (block) => {
    // Replace with same-shape whitespace so line numbers stay aligned.
    return block.replace(/[^\n]/g, " ");
  });
}

/**
 * Parse a wikilink body like `Target|Alias` or `folder/Target#heading`
 * into just the target name (the part used for resolution).
 */
function wikilinkTarget(body: string): string {
  // strip alias after `|`
  const noAlias = body.split("|", 1)[0];
  // strip in-page anchor after `#`
  return noAlias.split("#", 1)[0].trim();
}

/**
 * Decide the human-readable text for a wikilink when rendered in a
 * snippet. Mirrors Obsidian's display rules:
 *   - `[[Target|Alias]]`        → `Alias`
 *   - `[[Target#heading|Alias]]` → `Alias`
 *   - `[[Target#heading]]`       → `Target` (heading dropped in snippets)
 *   - `[[folder/Target]]`        → `Target` (last path segment)
 *   - `[[Target]]`               → `Target`
 */
function wikilinkDisplayText(body: string): string {
  const pipe = body.indexOf("|");
  if (pipe !== -1) return body.slice(pipe + 1).trim();
  const hash = body.indexOf("#");
  const base = hash !== -1 ? body.slice(0, hash) : body;
  const slash = base.lastIndexOf("/");
  return (slash !== -1 ? base.slice(slash + 1) : base).trim();
}

/**
 * Rewrite `[[wikilink]]` markup in a line to its display text and
 * remap a raw character range (e.g. the position of a backlink hit
 * in the ORIGINAL line) onto the rendered line. Used by `snippetAt`
 * so the right-sidebar snippet never shows raw `[[Target|Alias]]`
 * markup — it shows `Alias` and highlights exactly that range.
 *
 * Invariant: positions inside a wikilink collapse to the START of
 * its display text on the input side, and to the END on the output
 * side. So a raw range that EXACTLY brackets a wikilink (matchStart
 * = `[`, matchEnd = char after `]]`) maps onto the full display
 * text — which is what the highlighter wants.
 */
function renderLineDisplay(
  raw: string,
  rawMatchStart: number,
  rawMatchEnd: number,
): { text: string; matchStart: number; matchEnd: number } {
  let text = "";
  // map[i] = rendered offset corresponding to raw offset i. For
  // characters inside a `[[...]]` the value is the START of the
  // wikilink's display text; map[rawCloseEnd] is set on the next
  // iteration to the position AFTER the display text.
  const map: number[] = new Array(raw.length + 1).fill(0);
  let i = 0;
  while (i < raw.length) {
    if (raw.charCodeAt(i) === 91 /* [ */ && raw.charCodeAt(i + 1) === 91) {
      const close = raw.indexOf("]]", i + 2);
      if (close !== -1 && close > i + 2) {
        const body = raw.slice(i + 2, close);
        const display = wikilinkDisplayText(body);
        const renderedStart = text.length;
        for (let k = i; k < close + 2; k++) map[k] = renderedStart;
        text += display;
        i = close + 2;
        continue;
      }
    }
    map[i] = text.length;
    text += raw[i];
    i++;
  }
  map[raw.length] = text.length;
  const safeStart = Math.max(0, Math.min(raw.length, rawMatchStart));
  const safeEnd = Math.max(safeStart, Math.min(raw.length, rawMatchEnd));
  return {
    text,
    matchStart: map[safeStart],
    matchEnd: map[safeEnd],
  };
}

/**
 * Case-insensitive equality of two wikilink targets, after normalising
 * both to their basename (last path segment).
 */
function targetMatches(linkTarget: string, fileBaseName: string): boolean {
  const a = linkTarget.toLowerCase();
  const b = fileBaseName.toLowerCase();
  if (a === b) return true;
  // Allow folder/Target style links by comparing only the last segment.
  const aBase = a.split("/").pop() ?? a;
  return aBase === b;
}

/**
 * Strip `.md` (or other markdown extensions) off a filename. We only
 * compare backlink targets against the *display* name.
 */
function baseNameWithoutExt(name: string): string {
  return name.replace(/\.(md|markdown)$/i, "");
}

/**
 * Build a 1-line snippet at the given character offset inside `content`.
 * Returns null if the offset is out of range.
 *
 * The snippet's `text` is the matching line with all `[[wikilink]]`
 * markup rewritten to its display form (alias > target > basename),
 * and `matchStart`/`matchEnd` point at the position of the match
 * WITHIN that rendered string — so the right sidebar can render a
 * highlight on top of human-readable text instead of raw brackets.
 */
function snippetAt(content: string, offset: number, matchLen: number): Snippet | null {
  if (offset < 0 || offset >= content.length) return null;
  // Find line bounds.
  let lineStart = content.lastIndexOf("\n", offset - 1) + 1;
  let lineEnd = content.indexOf("\n", offset);
  if (lineEnd === -1) lineEnd = content.length;
  const rawLine = content.slice(lineStart, lineEnd);
  const trimmedLeft = rawLine.replace(/^\s+/, "");
  const leftTrimDelta = rawLine.length - trimmedLeft.length;
  // 1-based line count.
  let line = 1;
  for (let i = 0; i < lineStart; i++) {
    if (content.charCodeAt(i) === 10 /* \n */) line++;
  }
  // Position of the raw match inside the leading-trimmed line.
  const rawStart = Math.max(0, offset - lineStart - leftTrimDelta);
  const rawEnd = Math.min(trimmedLeft.length, rawStart + matchLen);
  // Rewrite wikilinks to display text and remap the match range.
  const rendered = renderLineDisplay(trimmedLeft, rawStart, rawEnd);
  const text = rendered.text.replace(/\s+$/, "");
  const matchStart = Math.max(0, Math.min(text.length, rendered.matchStart));
  const matchEnd = Math.max(matchStart, Math.min(text.length, rendered.matchEnd));
  return { line, text, matchStart, matchEnd };
}

/**
 * For a file id, compute its display path relative to other files
 * with the same basename. Walks every file in the vault to detect
 * collisions; for small vaults this is fine and there's nothing
 * cached to invalidate.
 */
function shortestDisplayPath(file: FileNode, vault: Map<string, FileNode>): string {
  const target = baseNameWithoutExt(file.name);
  let collision = false;
  vault.forEach((node) => {
    if (node.id === file.id) return;
    if (node.kind !== "file") return;
    if (baseNameWithoutExt(node.name).toLowerCase() === target.toLowerCase()) {
      collision = true;
    }
  });
  if (!collision) return target;
  // Fall back to the parent folder. The vault is flat, so derive
  // the parent from FileNode.path if present; otherwise just prepend
  // a `?` marker. (We can replace this with a proper resolveLinkToPath
  // lookup once the indexer can walk paths reliably for the mock vault.)
  const path = (file as { path?: string }).path;
  if (typeof path === "string" && path.length > 0) {
    const parts = path.split(/[\\/]/);
    if (parts.length >= 2) {
      return `${parts[parts.length - 2]}/${target}`;
    }
  }
  return target;
}

// ─── Outgoing / tags / headings (pulled from old App.tsx) ──────────────

export function collectOutgoing(content: string): OutgoingRef[] {
  const stripped = stripCodeFences(content);
  const seen = new Set<string>();
  const out: OutgoingRef[] = [];
  let m: RegExpExecArray | null;
  WIKILINK_RE.lastIndex = 0;
  while ((m = WIKILINK_RE.exec(stripped))) {
    const name = wikilinkTarget(m[1]);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name });
  }
  return out;
}

export function collectTags(content: string): string[] {
  const stripped = stripCodeFences(content);
  const re = /(?:^|\s)#([A-Za-z0-9_\-/]+)/g;
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped))) {
    const key = m[1].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m[1]);
  }
  return out;
}

export function collectHeadings(content: string): HeadingRef[] {
  const out: HeadingRef[] = [];
  let inFence = false;
  for (const raw of content.split(/\r?\n/)) {
    if (/^```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw);
    if (!m) continue;
    out.push({ level: m[1].length, text: m[2] });
  }
  return out;
}

export function countWords(md: string): { words: number; characters: number } {
  const stripped = md
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]*`/g, "")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/[#>*_`\-]/g, "")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1");
  const words = stripped.split(/\s+/).filter(Boolean).length;
  const characters = md.length;
  return { words, characters };
}

// ─── The two big ones ─────────────────────────────────────────────────

/**
 * Find every file in the vault that contains a `[[wikilink]]` resolving
 * to `targetFile`. Each result group lists one snippet per occurrence
 * (so the right sidebar can show context, not just file names).
 *
 * The active file is excluded from its own backlinks (self-links would
 * be useless noise in the panel).
 */
export function computeBacklinks(
  targetFile: FileNode,
  vault: Map<string, FileNode>,
): BacklinkGroup[] {
  const target = baseNameWithoutExt(targetFile.name);
  const out: BacklinkGroup[] = [];

  vault.forEach((node) => {
    if (node.id === targetFile.id) return;
    if (node.kind !== "file") return;
    const content = node.content;
    if (!content) return;

    const cleaned = stripCodeFences(content);
    const snippets: Snippet[] = [];
    let m: RegExpExecArray | null;
    WIKILINK_RE.lastIndex = 0;
    while ((m = WIKILINK_RE.exec(cleaned))) {
      const t = wikilinkTarget(m[1]);
      if (!t) continue;
      if (!targetMatches(t, target)) continue;
      const snip = snippetAt(content, m.index, m[0].length);
      if (snip) snippets.push(snip);
    }
    if (snippets.length === 0) return;

    out.push({
      fileId: node.id,
      fileName: baseNameWithoutExt(node.name),
      displayPath: shortestDisplayPath(node, vault),
      snippets,
    });
  });

  // Stable order: most-linked file first, then alphabetical.
  out.sort((a, b) =>
    b.snippets.length - a.snippets.length ||
    a.fileName.localeCompare(b.fileName, undefined, { sensitivity: "base" }),
  );
  return out;
}

/**
 * Find plain-text mentions of the target file's basename in other
 * files that are NOT inside a `[[wikilink]]`. Whole-word match
 * (case-insensitive). Skips fenced code blocks. Skips the target
 * file itself.
 *
 * Bounded: max 50 source files, max 5 snippets per file. Anything
 * beyond that is a sign the basename is so common (e.g. "Today")
 * that the panel would be useless noise.
 */
export function computeUnlinkedMentions(
  targetFile: FileNode,
  vault: Map<string, FileNode>,
  opts: { maxFiles?: number; maxPerFile?: number } = {},
): MentionGroup[] {
  const maxFiles = opts.maxFiles ?? 50;
  const maxPerFile = opts.maxPerFile ?? 5;
  const target = baseNameWithoutExt(targetFile.name);
  // Skip 1-letter and 2-letter basenames — too noisy ("a", "go", "to").
  if (target.length < 3) return [];

  // Build a case-insensitive whole-word matcher. Escape regex specials.
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<![\\w\\[])${escaped}(?![\\w\\]])`, "gi");

  const out: MentionGroup[] = [];

  vault.forEach((node) => {
    if (out.length >= maxFiles) return;
    if (node.id === targetFile.id) return;
    if (node.kind !== "file") return;
    const content = node.content;
    if (!content) return;

    const cleaned = stripCodeFences(content);
    const snippets: Snippet[] = [];
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(cleaned))) {
      // Guard: skip if this match is inside a `[[wikilink]]` — that's
      // already a real backlink, not an unlinked mention.
      const before = cleaned.slice(Math.max(0, m.index - 80), m.index);
      const after = cleaned.slice(m.index + m[0].length, m.index + m[0].length + 80);
      const openBrace = before.lastIndexOf("[[");
      const closeBraceBefore = before.lastIndexOf("]]");
      if (openBrace !== -1 && openBrace > closeBraceBefore) {
        const closeBraceAfter = after.indexOf("]]");
        if (closeBraceAfter !== -1) continue;
      }
      const snip = snippetAt(content, m.index, m[0].length);
      if (snip) snippets.push(snip);
      if (snippets.length >= maxPerFile) break;
    }
    if (snippets.length === 0) return;

    out.push({
      fileId: node.id,
      fileName: baseNameWithoutExt(node.name),
      displayPath: shortestDisplayPath(node, vault),
      snippets,
    });
  });

  out.sort((a, b) =>
    b.snippets.length - a.snippets.length ||
    a.fileName.localeCompare(b.fileName, undefined, { sensitivity: "base" }),
  );
  return out;
}

/** Sum `snippets.length` across every group. Used for header stats. */
export function countMentions(groups: { snippets: Snippet[] }[]): number {
  let n = 0;
  for (const g of groups) n += g.snippets.length;
  return n;
}
