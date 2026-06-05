import React from "react";

/**
 * Minimal, dependency-free markdown renderer covering only what this
 * UI showcase needs: ATX headings, paragraphs, blank-line breaks,
 * bold/italic, inline code, autolinks, and Obsidian-style wiki links.
 *
 * Not a spec-compliant parser; intentionally tiny.
 */

type Props = {
  source: string;
  onOpenWikiLink?: (name: string) => void;
};

export function Markdown({ source, onOpenWikiLink }: Props) {
  const blocks = splitBlocks(source);
  return (
    <>
      {blocks.map((block, i) => renderBlock(block, i, onOpenWikiLink))}
    </>
  );
}

function splitBlocks(src: string): string[] {
  return src.replace(/\r\n/g, "\n").split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
}

function renderBlock(
  block: string,
  key: number,
  onOpenWikiLink?: (name: string) => void,
): React.ReactNode {
  const h = /^(#{1,6})\s+(.*)$/.exec(block);
  if (h) {
    const level = h[1].length;
    const text = h[2];
    const Tag = `h${level}` as keyof React.JSX.IntrinsicElements;
    return <Tag key={key}>{renderInline(text, onOpenWikiLink)}</Tag>;
  }

  if (/^[-*]\s+/.test(block)) {
    const items = block.split(/\n/).map((l) => l.replace(/^[-*]\s+/, ""));
    return (
      <ul key={key}>
        {items.map((it, i) => (
          <li key={i}>{renderInline(it, onOpenWikiLink)}</li>
        ))}
      </ul>
    );
  }

  return <p key={key}>{renderInline(block, onOpenWikiLink)}</p>;
}

function renderInline(text: string, onOpenWikiLink?: (name: string) => void): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  // Token regex (order matters): wikilink, bold, italic, code, link, autolink.
  const re =
    /(\[\[([^\]]+)\]\])|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))|(https?:\/\/\S+)/g;

  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) {
      const name = m[2];
      out.push(
        <a
          key={key++}
          className="wikilink"
          onClick={(e) => {
            e.preventDefault();
            onOpenWikiLink?.(name);
          }}
          href="#"
        >
          {name}
        </a>,
      );
    } else if (m[3]) {
      out.push(<strong key={key++}>{m[4]}</strong>);
    } else if (m[5]) {
      out.push(<em key={key++}>{m[6]}</em>);
    } else if (m[7]) {
      out.push(<code key={key++}>{m[8]}</code>);
    } else if (m[9]) {
      out.push(
        <a key={key++} href={m[11]} target="_blank" rel="noreferrer">
          {m[10]}
        </a>,
      );
    } else if (m[12]) {
      out.push(
        <a key={key++} href={m[12]} target="_blank" rel="noreferrer">
          {m[12]}
        </a>,
      );
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Count words in markdown content (after stripping markdown syntax). */
export function countWords(src: string): number {
  const stripped = src
    .replace(/`{1,3}[^`]*`{1,3}/g, " ")
    .replace(/[#*_>\-[\]()`!]/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .trim();
  if (!stripped) return 0;
  return stripped.split(/\s+/).length;
}
