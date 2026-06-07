/**
 * GitGraph — SVG renderer for the History panel's commit DAG.
 *
 * Takes a flat list of `GraphCommit`s (already fetched via
 * `vcsLogGraph`) and renders one row per commit with:
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │  ●─┐         abc1234   feat: add graph view  alice  2h ago   │
 *   │  │ │ ●       def5678   chore: format         bob    3h ago   │
 *   │  │ ●─┘       9012345   Merge branch 'topic'  alice  4h ago   │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Left side: a fixed-width SVG strip showing lane lines + dots +
 *            connector curves.  Width grows with the deepest row's
 *            lane count, capped so we don't crowd the metadata.
 * Right side: branch/tag pill ribbons, short sha, summary, author
 *             avatar (initials), relative time.
 *
 * # Why SVG over Canvas
 *
 * - Crisp lines at any DPR, no manual `devicePixelRatio` math.
 * - Hover targets are native (`<circle>` gets pointer events for free).
 * - The whole graph diffs through React like normal DOM — no manual
 *   redraw loop, no out-of-sync rendering when commits stream in.
 *
 * # Layout constants
 *
 * Every row is `ROW_H` tall (24px feels right — matches `.cp-change-
 * row` density).  Each lane is `LANE_W` (14px) wide.  Dots are
 * `DOT_R` radius (4px).  Connectors are drawn as cubic beziers when
 * the lane changes between this row and its parent's row; straight
 * verticals otherwise.
 *
 * The SVG height = `rows.length * ROW_H + LANE_PAD * 2`; the SVG
 * width = `maxLanes * LANE_W + LANE_PAD * 2`.  We DON'T set viewBox
 * — natural pixel coords keep things sharp.
 */
import { useMemo, useState } from "react";
import { type GraphCommit } from "../../lib/vcs";
import {
  assignLanes,
  classifyRef,
  laneColor,
  type LaneRow,
} from "../../lib/gitGraph";
import "./GitGraph.css";

// ── Layout constants ───────────────────────────────────────────────────
const ROW_H = 24;
const LANE_W = 14;
const DOT_R = 4;
const LANE_PAD = 8;
/** Hard cap on lanes shown — beyond this the graph wraps via overflow-x. */
const MAX_LANES = 12;

export function GitGraph({
  commits,
  onSelectCommit,
  selectedCommitId,
}: {
  commits: GraphCommit[];
  /** Fired when the user clicks a commit row (dot, sha, or summary). */
  onSelectCommit?: (commit: GraphCommit) => void;
  /** Highlight this commit's row in selected state. */
  selectedCommitId?: string;
}) {
  // Lane assignment is cheap (O(N · L)) and stable for a given input,
  // so a memo keyed on `commits` is plenty — no need for useDeferred
  // or a worker.
  const rows = useMemo<LaneRow<GraphCommit>[]>(
    () => assignLanes(commits),
    [commits],
  );

  // Build a sha → row-index map so connectors can find their parents
  // even when a parent is further down the list (always true since
  // we're newest-first).  Missing parents (parent older than our
  // limit) are skipped — connector just stops at the row edge.
  const indexBySha = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach((r, i) => m.set(r.commit.id, i));
    return m;
  }, [rows]);

  const maxLanes = useMemo(
    () =>
      rows.reduce(
        (m, r) =>
          Math.max(m, r.lanesBefore.length, ...r.parentLanes.map((p) => p + 1)),
        1,
      ),
    [rows],
  );
  const laneCols = Math.min(maxLanes, MAX_LANES);

  // Hover state — drives the per-row highlight + parent-line emphasis.
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (rows.length === 0) {
    return null;
  }

  return (
    <div className="gg" style={{ "--gg-row-h": `${ROW_H}px` } as React.CSSProperties}>
      {/* The SVG strip on the left — overlays every row's dot + lines. */}
      <svg
        className="gg-svg"
        width={laneCols * LANE_W + LANE_PAD * 2}
        height={rows.length * ROW_H}
        role="presentation"
        aria-hidden
      >
        {/* Pass 1: lane-passing-through lines (drawn behind dots). */}
        {rows.map((row, i) => {
          const y0 = i * ROW_H;
          const y1 = y0 + ROW_H;
          return row.lanesBefore.map((sha, lane) => {
            if (sha === null) return null;
            // Don't redraw the line in our own lane — that's handled
            // by the connector below (which knows whether we have a
            // parent continuing the column).
            if (lane === row.lane) return null;
            const x = LANE_PAD + lane * LANE_W + LANE_W / 2;
            return (
              <line
                key={`pass-${i}-${lane}`}
                className="gg-lane-line"
                x1={x}
                y1={y0}
                x2={x}
                y2={y1}
                stroke={laneColor(lane)}
                strokeWidth={1.5}
              />
            );
          });
        })}

        {/* Pass 2: connectors from each commit to its parents. */}
        {rows.map((row, i) => {
          const px = LANE_PAD + row.lane * LANE_W + LANE_W / 2;
          const py = i * ROW_H + ROW_H / 2;
          return row.parentLanes.map((parentLane, pi) => {
            const parentSha = row.commit.parents[pi];
            const parentIdx = indexBySha.get(parentSha);
            // Parent off-screen (older than our limit) — draw a stub
            // line that fades into the bottom edge.
            const cy =
              parentIdx === undefined
                ? rows.length * ROW_H
                : parentIdx * ROW_H + ROW_H / 2;
            const cx = LANE_PAD + parentLane * LANE_W + LANE_W / 2;

            if (cx === px) {
              // Straight vertical — first parent staying in our column.
              return (
                <line
                  key={`conn-${i}-${pi}`}
                  className="gg-conn"
                  x1={px}
                  y1={py}
                  x2={cx}
                  y2={cy}
                  stroke={laneColor(parentLane)}
                  strokeWidth={1.5}
                />
              );
            }
            // Bezier — branch / merge curve.  Control points placed
            // halfway between rows so the curve has a nice S-shape.
            const midY = py + ROW_H / 2;
            const d = `M ${px} ${py} C ${px} ${midY}, ${cx} ${midY}, ${cx} ${cy}`;
            return (
              <path
                key={`conn-${i}-${pi}`}
                className="gg-conn"
                d={d}
                stroke={laneColor(parentLane)}
                strokeWidth={1.5}
                fill="none"
              />
            );
          });
        })}

        {/* Pass 3: commit dots (drawn on top). */}
        {rows.map((row, i) => {
          const cx = LANE_PAD + row.lane * LANE_W + LANE_W / 2;
          const cy = i * ROW_H + ROW_H / 2;
          const isMerge = row.commit.parents.length > 1;
          const isHead = row.commit.refs.some(
            (r) => r === "HEAD" || r.startsWith("HEAD -> "),
          );
          return (
            <circle
              key={`dot-${i}`}
              className={`gg-dot${isHead ? " gg-dot-head" : ""}${isMerge ? " gg-dot-merge" : ""}${selectedCommitId === row.commit.id ? " gg-dot-selected" : ""}`}
              cx={cx}
              cy={cy}
              r={isHead ? DOT_R + 1 : DOT_R}
              fill={isHead ? "var(--bg, #1e1e1e)" : laneColor(row.lane)}
              stroke={laneColor(row.lane)}
              strokeWidth={isHead ? 2 : 1}
            />
          );
        })}
      </svg>

      {/* Right-side metadata rows.  These are pointer-events:auto so
          click + hover work; the SVG underneath is pointer-events:none
          (set in CSS) so it doesn't block them. */}
      <ul className="gg-rows" style={{ marginLeft: laneCols * LANE_W + LANE_PAD * 2 }}>
        {rows.map((row, i) => {
          const selected = selectedCommitId === row.commit.id;
          return (
            <li
              key={row.commit.id}
              className={`gg-row${selected ? " gg-row-selected" : ""}${hoverIdx === i ? " gg-row-hover" : ""}`}
              style={{ height: ROW_H }}
              onMouseEnter={() => setHoverIdx(i)}
              onMouseLeave={() => setHoverIdx((h) => (h === i ? null : h))}
              onClick={() => onSelectCommit?.(row.commit)}
              title={row.commit.id}
            >
              {/* Branch / tag pills */}
              {row.commit.refs.length > 0 && (
                <span className="gg-refs">
                  {row.commit.refs.map((raw, ri) => {
                    const { kind, name } = classifyRef(raw);
                    return (
                      <span
                        key={ri}
                        className={`gg-ref gg-ref-${kind}`}
                        title={raw}
                      >
                        {name}
                      </span>
                    );
                  })}
                </span>
              )}
              <span className="gg-sha">{row.commit.shortId}</span>
              <span className="gg-summary">{row.commit.summary}</span>
              <Avatar author={row.commit.author} />
              <span className="gg-time">
                {formatRelativeTime(row.commit.timestamp)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ─── Avatar ────────────────────────────────────────────────────────────
//
// Author initials in a colour deterministically derived from the
// email — same email always gets the same hue across sessions.
// 28x28 felt heavy in a 24px-tall row; 16px is the sweet spot.

function Avatar({ author }: { author: string }) {
  const { initials, color, displayName } = useMemo(
    () => avatarFor(author),
    [author],
  );
  return (
    <span
      className="gg-avatar"
      style={{ background: color }}
      title={displayName}
      aria-label={displayName}
    >
      {initials}
    </span>
  );
}

/**
 * Parse an "Alice <alice@example.com>" string into a render-ready
 * avatar descriptor.  Initials use the first letter of the name's
 * first two whitespace-separated tokens; falls back to first two
 * letters of the email local part when name is empty.
 */
function avatarFor(author: string): {
  initials: string;
  color: string;
  displayName: string;
} {
  // Split "Name <email>" — be lenient about extra spaces.
  const m = author.match(/^\s*(.*?)\s*<([^>]*)>\s*$/);
  const name = (m?.[1] ?? "").trim();
  const email = (m?.[2] ?? "").trim();

  let initials: string;
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean);
    initials = (
      (parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? parts[0]?.[1] ?? "")
    ).toUpperCase();
  } else if (email) {
    initials = email.slice(0, 2).toUpperCase();
  } else {
    initials = "??";
  }
  if (!initials) initials = "??";

  // Hue from a tiny string hash of the email (or name as fallback).
  const seed = (email || name || "anon").toLowerCase();
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  // Mid-saturation pastel — readable on both light + dark backgrounds.
  const color = `hsl(${hue}, 55%, 42%)`;
  const displayName = name || email || "Unknown author";
  return { initials, color, displayName };
}

// ─── Time formatting ───────────────────────────────────────────────────

/**
 * Slightly richer than ChangesPanel's inline helper — we use
 * `Intl.RelativeTimeFormat` for the bigger buckets (weeks / months)
 * so the labels read naturally without us having to hand-tune them.
 */
function formatRelativeTime(unixSeconds: number): string {
  if (!unixSeconds) return "";
  const now = Date.now() / 1000;
  const delta = Math.max(0, now - unixSeconds);
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  if (delta < 7 * 86400) return `${Math.floor(delta / 86400)}d ago`;
  if (delta < 30 * 86400) return `${Math.floor(delta / (7 * 86400))}w ago`;
  // For older commits, show the actual date — relative gets fuzzy.
  const date = new Date(unixSeconds * 1000);
  return date.toLocaleDateString(undefined, {
    year: "2-digit",
    month: "short",
    day: "numeric",
  });
}
