import { useState } from "react";
import {
  IcArchive,
  IcLink,
  IcLinkOff,
  IcList,
  IcTag,
} from "../common/Icons";
import "./RightSidebar.css";

type Backlink = {
  fileId: string;
  fileName: string;
};
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
  backlinks: Backlink[];
  outgoing: OutgoingRef[];
  tags: string[];
  headings: HeadingRef[];
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
 * The header has NO right-padding reservation for the window controls;
 * its icons sit at the natural left edge, and the floating window
 * controls (z-index 100) simply cover them when the sidebar is narrow.
 */
export function RightSidebar({
  hasOpenFile,
  backlinks,
  outgoing,
  tags,
  headings,
}: Props) {
  const [view, setView] = useState<RightView>("links");

  const counts: Record<RightView, number> = {
    links: backlinks.length,
    outgoing: outgoing.length,
    tags: tags.length,
    saved: 0,
    outline: headings.length,
  };

  return (
    <>
      {/* Header — view switcher (Links / Outgoing / Tags / Saved / Outline) */}
      <div className="col-header rs-header" data-tauri-drag-region>
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
            <div className="rs-section-body">
              {!hasOpenFile ? (
                <div className="rs-empty">No file is open.</div>
              ) : view === "links" ? (
                backlinks.length > 0 ? (
                  <ul className="rs-link-list">
                    {backlinks.map((b) => (
                      <li key={b.fileId} className="rs-link-item">
                        <IcLink />
                        <span className="rs-link-name">{b.fileName}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="rs-empty">No backlinks found.</div>
                )
              ) : view === "outgoing" ? (
                outgoing.length > 0 ? (
                  <ul className="rs-link-list">
                    {outgoing.map((o) => (
                      <li key={o.name} className="rs-link-item">
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
              </div>
              <div className="rs-section-body" />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
