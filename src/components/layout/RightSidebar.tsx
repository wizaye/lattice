import { useState } from "react";
import type {
  BacklinkGroup,
  JumpToLineDetail,
  MentionGroup,
  Snippet,
} from "../../lib/backlinks";
import {
  IcArchive,
  IcChevronDown,
  IcLink,
  IcLinkOff,
  IcList,
  IcTag,
} from "../common/Icons";
import "./RightSidebar.css";

type OutgoingRef = { name: string };
type HeadingRef = { level: number; text: string };

export type RightView =
  | "links"
  | "outgoing"
  | "tags"
  | "saved"
  | "outline";

type Props = {
  hasOpenFile: boolean;
  /** Display name (no extension) of the currently open file. */
  activeFileName: string | null;
  backlinks: BacklinkGroup[];
  /** Plain-text mentions of the active file that aren't yet wikilinks. */
  unlinked: MentionGroup[];
  outgoing: OutgoingRef[];
  tags: string[];
  headings: HeadingRef[];
  /** Open a file in the active leaf. Triggered when clicking a snippet. */
  onOpenFile?: (fileId: string) => void;
  /** Resolve an unresolved outgoing-link name to a file id, if possible. */
  onOpenByName?: (name: string) => void;
  /** When true, the OS draws no top-right window-control cluster — so the
      rs-header doesn't need to reserve room for it. */
  isMac?: boolean;
};

const VIEW_TITLES: Record<RightView, string> = {
  links: "Backlinks",
  outgoing: "Outgoing links",
  tags: "Tags",
  saved: "Saved",
  outline: "Outline",
};

/**
 * Right sidebar column — header acts as a view switcher (mirrors the
 * left sidebar pattern) + a body that renders the active panel.
 * No footer: backlinks/words/characters live in a separate floating
 * status pill anchored to the app's bottom-right corner.
 *
 * The Backlinks view now shows a stats strip (mentions, files, unlinked)
 * + an expandable list of snippets per source file. Clicking a snippet
 * opens that file. On Windows/Linux the header reserves
 * `--win-controls-w` worth of right padding so that the panel-switcher
 * icons (and the drag region) never slip under the floating
 * Minimize/Maximize/Close cluster, no matter how wide the sidebar gets.
 */
export function RightSidebar({
  hasOpenFile,
  activeFileName,
  backlinks,
  unlinked,
  outgoing,
  tags,
  headings,
  onOpenFile,
  onOpenByName,
  isMac,
}: Props) {
  const [view, setView] = useState<RightView>("links");

  const totalMentions = backlinks.reduce((n, g) => n + g.snippets.length, 0);
  const totalUnlinked = unlinked.reduce((n, g) => n + g.snippets.length, 0);

  const counts: Record<RightView, number> = {
    links: totalMentions,
    outgoing: outgoing.length,
    tags: tags.length,
    saved: 0,
    outline: headings.length,
  };

  return (
    <>
      {/* Header — view switcher (Links / Outgoing / Tags / Saved / Outline) */}
      <div
        className="col-header rs-header"
        data-tauri-drag-region
        style={isMac ? undefined : { paddingRight: "var(--win-controls-w)" }}
      >
        {/* Wrap the panel-switcher buttons in a flex-shrink container that
            clips at its own content edge. With `overflow: hidden` and a
            min-width of 0, the buttons get visually clipped at the
            rs-header's content box (i.e. before the reserved
            window-controls strip) instead of overflowing into the padding
            zone where Minimize/Maximize/Close sit. */}
        <div className="rs-header-tabs">
          <button
            className={`icon-btn${view === "links" ? " active" : ""}`}
            title="Backlinks"
            onClick={() => setView("links")}
          >
            <IcLink />
          </button>
          <button
            className={`icon-btn${view === "outgoing" ? " active" : ""}`}
            title="Outgoing links"
            onClick={() => setView("outgoing")}
          >
            <IcLinkOff />
          </button>
          <button
            className={`icon-btn${view === "tags" ? " active" : ""}`}
            title="Tags"
            onClick={() => setView("tags")}
          >
            <IcTag />
          </button>
          <button
            className={`icon-btn${view === "saved" ? " active" : ""}`}
            title="Saved"
            onClick={() => setView("saved")}
          >
            <IcArchive />
          </button>
          <button
            className={`icon-btn${view === "outline" ? " active" : ""}`}
            title="Outline"
            onClick={() => setView("outline")}
          >
            <IcList />
          </button>
        </div>
        <div className="rs-header-drag" data-tauri-drag-region />
      </div>

      {/* Body */}
      <div className="col-body">
        <div className="rs-content">
          <div className="rs-section">
            <div className="rs-section-header">
              <span className="rs-section-title">{VIEW_TITLES[view]}</span>
              <span className="rs-section-count">{counts[view]}</span>
            </div>

            {/* Stats strip — only meaningful for backlinks view. */}
            {view === "links" && hasOpenFile && (
              <div className="rs-stats" title="Backlink stats">
                <div className="rs-stat">
                  <span className="rs-stat-num">{totalMentions}</span>
                  <span className="rs-stat-lbl">
                    {totalMentions === 1 ? "mention" : "mentions"}
                  </span>
                </div>
                <div className="rs-stat-sep" aria-hidden />
                <div className="rs-stat">
                  <span className="rs-stat-num">{backlinks.length}</span>
                  <span className="rs-stat-lbl">
                    {backlinks.length === 1 ? "file" : "files"}
                  </span>
                </div>
                <div className="rs-stat-sep" aria-hidden />
                <div className="rs-stat rs-stat-muted">
                  <span className="rs-stat-num">{totalUnlinked}</span>
                  <span className="rs-stat-lbl">unlinked</span>
                </div>
              </div>
            )}

            <div className="rs-section-body">
              {!hasOpenFile ? (
                <div className="rs-empty">No file is open.</div>
              ) : view === "links" ? (
                backlinks.length > 0 ? (
                  <BacklinkList
                    groups={backlinks}
                    onOpen={onOpenFile}
                    variant="linked"
                  />
                ) : (
                  <div className="rs-empty">
                    No backlinks to{" "}
                    <strong>{activeFileName || "this note"}</strong> yet.
                  </div>
                )
              ) : view === "outgoing" ? (
                outgoing.length > 0 ? (
                  <ul className="rs-link-list">
                    {outgoing.map((o) => (
                      <li
                        key={o.name}
                        className="rs-link-item"
                        onClick={() => onOpenByName?.(o.name)}
                        title={`Open "${o.name}"`}
                      >
                        <IcLink />
                        <span className="rs-link-name">{o.name}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="rs-empty">No outgoing links.</div>
                )
              ) : view === "tags" ? (
                tags.length > 0 ? (
                  <ul className="rs-tag-list">
                    {tags.map((t) => (
                      <li key={t} className="rs-tag">
                        #{t}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="rs-empty">No tags in this note.</div>
                )
              ) : view === "saved" ? (
                <div className="rs-empty">No saved items.</div>
              ) : /* outline */ headings.length > 0 ? (
                <ul className="rs-outline-list">
                  {headings.map((h, i) => (
                    <li
                      key={`${h.level}-${i}-${h.text}`}
                      className="rs-outline-item"
                      data-level={h.level}
                    >
                      {h.text}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="rs-empty">No headings in this note.</div>
              )}
            </div>
          </div>

          {view === "links" && hasOpenFile && (
            <div className="rs-section">
              <div className="rs-section-header">
                <span className="rs-section-title">Unlinked mentions</span>
                <span className="rs-section-count">{totalUnlinked}</span>
              </div>
              <div className="rs-section-body">
                {unlinked.length === 0 ? (
                  <div className="rs-empty">
                    No unlinked mentions of{" "}
                    <strong>{activeFileName || "this note"}</strong>.
                  </div>
                ) : (
                  <BacklinkList
                    groups={unlinked}
                    onOpen={onOpenFile}
                    variant="unlinked"
                  />
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ─── Backlink list (grouped, collapsible) ────────────────────────────

type ListProps = {
  groups: BacklinkGroup[] | MentionGroup[];
  onOpen?: (fileId: string) => void;
  variant: "linked" | "unlinked";
};

function BacklinkList({ groups, onOpen, variant }: ListProps) {
  return (
    <ul className="rs-bl-list">
      {groups.map((g) => (
        <BacklinkGroupItem
          key={g.fileId}
          group={g}
          onOpen={onOpen}
          variant={variant}
        />
      ))}
    </ul>
  );
}

function BacklinkGroupItem({
  group,
  onOpen,
  variant,
}: {
  group: BacklinkGroup | MentionGroup;
  onOpen?: (fileId: string) => void;
  variant: "linked" | "unlinked";
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <li className={`rs-bl-group${expanded ? " expanded" : ""}`}>
      <div className="rs-bl-head">
        <button
          type="button"
          className="rs-bl-chevron"
          aria-label={expanded ? "Collapse" : "Expand"}
          onClick={() => setExpanded((v) => !v)}
        >
          <IcChevronDown />
        </button>
        <button
          type="button"
          className="rs-bl-title"
          title={group.displayPath}
          onClick={() => onOpen?.(group.fileId)}
        >
          <span className="rs-bl-name">{group.fileName}</span>
          <span className="rs-bl-badge">{group.snippets.length}</span>
        </button>
      </div>
      {expanded && (
        <ul className="rs-bl-snippets">
          {group.snippets.map((s, i) => (
            <li
              key={`${s.line}-${i}`}
              className="rs-bl-snip"
              onClick={() => {
                onOpen?.(group.fileId);
                // Defer so a freshly-mounted editor for this file has its
                // listener attached before we fire. CodeMirror editors
                // self-filter by fileId, so this is harmless for non-target
                // editors mounted in other panes.
                setTimeout(() => {
                  window.dispatchEvent(
                    new CustomEvent<JumpToLineDetail>(
                      "lattice-jump-to-line",
                      { detail: { fileId: group.fileId, line: s.line } },
                    ),
                  );
                }, 0);
              }}
              title={`Line ${s.line} · click to open`}
            >
              <span className="rs-bl-line">L{s.line}</span>
              <span className="rs-bl-text">
                {renderSnippetWithHighlight(s, variant)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Render the snippet text with the match highlighted. We rebuild the
 * span as `(textBefore)<mark>(match)</mark>(textAfter)` so highlights
 * survive any leading-whitespace trim done in the snippet builder.
 */
function renderSnippetWithHighlight(
  snip: Snippet,
  variant: "linked" | "unlinked",
) {
  const { text, matchStart, matchEnd } = snip;
  if (matchStart < 0 || matchEnd > text.length || matchStart >= matchEnd) {
    return <span>{text}</span>;
  }
  const before = text.slice(0, matchStart);
  const match = text.slice(matchStart, matchEnd);
  const after = text.slice(matchEnd);
  return (
    <>
      <span>{before}</span>
      <mark className={`rs-bl-mark ${variant}`}>{match}</mark>
      <span>{after}</span>
    </>
  );
}
