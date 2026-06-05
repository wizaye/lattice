/**
 * CanvasView — infinite 2D whiteboard / canvas editor for `.canvas`
 * files.
 *
 * Mirrors the core Obsidian Canvas UX (text cards + arrow edges in the
 * open JSON Canvas 1.0 format, https://jsoncanvas.org/spec/1.0/) and
 * layers Excalidraw-style whiteboard tools on top:
 *
 *   Navigation
 *     - Pan: middle-click drag, Space+drag, two-finger trackpad.
 *     - Zoom: wheel (centered on cursor), HUD +/- buttons.
 *     - Fit to content / reset zoom from the right HUD.
 *
 *   Selection (V — Select tool)
 *     - Click / shift-click to add or toggle.
 *     - Marquee with left-drag on empty space.
 *     - Ctrl+A select all, Esc clear, Del/Backspace remove.
 *     - Drag a selected node to move; multi-select moves together with
 *       alignment guides snapping to other nodes' edges + centers.
 *     - Resize handles on a single selected node (8 grabbers).
 *     - Side connector dots on hover/select — drag to another card to
 *       draw a directed arrow edge.
 *     - Double-click empty space to drop a text card; double-click a
 *       card to edit its text.
 *
 *   Whiteboard tools
 *     - P — Pen: freehand stroke (smoothed Bezier).
 *     - E — Eraser: drag over strokes / cards to delete on contact.
 *     - R — Rectangle, O — Ellipse, D — Diamond: click-drag to draw.
 *     - A — Arrow: click-drag a connector between two nodes.
 *     - T — Text: click to drop an empty text card and enter edit.
 *     - G — Group selection into a labelled container; selecting the
 *       group moves all members together.
 *
 *   Export (top-right menu)
 *     - PNG  — rasterized snapshot of the current document bounds.
 *     - SVG  — vector export (nodes + edges + strokes).
 *     - JSON — the underlying `.canvas` file body.
 *
 * Persistence: every mutation funnels through `commit()` which calls
 * `onChange(serializeCanvas(doc))` so the vault stays authoritative.
 * The lattice-specific node types (`draw`, `shape`, and the `children`
 * property on groups) round-trip through Obsidian without corruption
 * because JSON.parse/stringify preserves unknown fields.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type CanvasDoc,
  type CanvasDrawNode,
  type CanvasEdge,
  type CanvasGroupNode,
  type CanvasNode,
  type CanvasShapeKind,
  type CanvasShapeNode,
  type CanvasSide,
  type CanvasTextNode,
  parseCanvas,
  pointsBounds,
  resolveCanvasColor,
  serializeCanvas,
  strokeToPath,
} from "../../state/canvas";
import {
  IcArrowTool,
  IcCircle,
  IcCursor,
  IcDiamond,
  IcEraser,
  IcExpand,
  IcExport,
  IcGrip,
  IcGroup,
  IcHand,
  IcMinus,
  IcPencil,
  IcPlus,
  IcSquare,
  IcStickyNote,
  IcSwap,
  IcTextTool,
  IcTrash,
} from "../common/Icons";
import "./CanvasView.css";

type Props = {
  /** Raw `.canvas` file body. Parsed on mount + when this changes. */
  source: string;
  /** Called with serialized JSON after every edit. */
  onChange: (json: string) => void;
};

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 4;
const GRID_PX = 20;
const DEFAULT_CARD_W = 220;
const DEFAULT_CARD_H = 80;
const HANDLE_HIT = 8;
/** How close (in world px) two edges/centers must be to trigger a snap
 *  + guide line. Scaled down by zoom so the snap feels consistent
 *  in screen pixels regardless of current magnification. */
const SNAP_PX = 6;
/** Minimum world distance between freehand sample points so we don't
 *  emit thousands of redundant nodes on a single stroke. */
const PEN_MIN_DIST = 1.5;
const PEN_DEFAULT_STROKE_WIDTH = 2;
const SHAPE_DEFAULT_STROKE_WIDTH = 2;

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

type Viewport = { x: number; y: number; zoom: number };

/** Toolbar selection. `select` is the default arrow-cursor mode; every
 *  other tool replaces left-click on empty space with that tool's
 *  primary gesture. Pan is always available via Space / middle-click
 *  regardless of the current tool. */
type Tool =
  | "select"
  | "hand"
  | "pen"
  | "eraser"
  | "rect"
  | "ellipse"
  | "diamond"
  | "arrow"
  | "text";

type Gesture =
  | null
  | { kind: "pan"; startX: number; startY: number; vp: Viewport }
  | {
      kind: "move-nodes";
      startX: number;
      startY: number;
      ids: string[];
      /** Per-node origin snapshot. For draw nodes we also snapshot the
       *  original `points` array so we can translate every sample by
       *  the same delta as the bbox (otherwise the visible stroke
       *  would stay put while only its hit-rect moved). */
      origins: Map<
        string,
        { x: number; y: number; points?: number[] }
      >;
      /** Snap guides surfaced by the most recent move; rendered as
       *  dashed world-space lines. */
      guides: AlignGuide[];
    }
  | {
      kind: "resize-node";
      id: string;
      handle: ResizeHandle;
      startX: number;
      startY: number;
      orig: { x: number; y: number; width: number; height: number };
    }
  | {
      kind: "marquee";
      startWorldX: number;
      startWorldY: number;
      curWorldX: number;
      curWorldY: number;
      additive: boolean;
    }
  | {
      kind: "draw-edge";
      fromId: string;
      fromSide: CanvasSide;
      curWorldX: number;
      curWorldY: number;
      hoverNodeId: string | null;
    }
  | {
      kind: "pen";
      /** Flat [x0,y0,x1,y1,...] world-space sample list. */
      points: number[];
    }
  | {
      kind: "shape";
      shape: "rect" | "ellipse" | "diamond";
      startWorldX: number;
      startWorldY: number;
      curWorldX: number;
      curWorldY: number;
    }
  | {
      kind: "arrow-tool";
      startWorldX: number;
      startWorldY: number;
      curWorldX: number;
      curWorldY: number;
      fromNodeId: string | null;
      hoverNodeId: string | null;
    }
  | { kind: "erase"; lastX: number; lastY: number };

type ResizeHandle =
  | "n"
  | "s"
  | "e"
  | "w"
  | "ne"
  | "nw"
  | "se"
  | "sw";

/** A single alignment guide line surfaced while moving nodes. The
 *  matched coordinate (`at`) is on `axis`; `span` is the cross-axis
 *  segment we should draw — the union of the moving and reference
 *  node extents on that axis, so the guide visually connects the two
 *  edges that are aligning instead of stretching across the whole
 *  canvas (Figma/Excalidraw-style). */
type AlignGuide =
  | { axis: "x"; at: number; span: [number, number] }
  | { axis: "y"; at: number; span: [number, number] };

/** Where the floating tool palette is pinned. Four edge docks center
 *  the bar along that edge; `float` uses arbitrary x/y so the user
 *  can drop it anywhere on the canvas. Persisted to localStorage. */
type ToolbarDock = "left" | "right" | "top" | "bottom" | "float";
type ToolbarPos = {
  dock: ToolbarDock;
  /** Only meaningful when dock === "float". Screen-space px relative
   *  to the canvas root's top-left. */
  x?: number;
  y?: number;
};

const TOOLBAR_LS_KEY = "lattice.canvas.toolbarPos";
/** Snap distance (screen px) — drag releases within this of an edge
 *  re-dock to that edge. */
const TOOLBAR_SNAP_PX = 56;

function loadToolbarPos(): ToolbarPos {
  try {
    const raw = localStorage.getItem(TOOLBAR_LS_KEY);
    if (raw) {
      const v = JSON.parse(raw) as ToolbarPos;
      if (v && typeof v.dock === "string") return v;
    }
  } catch {
    /* localStorage may be unavailable (Tauri sandboxed env, etc.) */
  }
  return { dock: "left" };
}

// Stable id generator — externally-authored ids might collide with
// auto-incrementing numerics, so we namespace ours.
let _idCounter = 0;
function newId(prefix: string): string {
  _idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${_idCounter.toString(36)}`;
}

// ---------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------

function inferSide(node: CanvasNode, toX: number, toY: number): CanvasSide {
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;
  const dx = toX - cx;
  const dy = toY - cy;
  if (Math.abs(dx) / node.width > Math.abs(dy) / node.height) {
    return dx > 0 ? "right" : "left";
  }
  return dy > 0 ? "bottom" : "top";
}

function sidePoint(
  node: CanvasNode,
  side: CanvasSide,
): { x: number; y: number } {
  switch (side) {
    case "top":
      return { x: node.x + node.width / 2, y: node.y };
    case "bottom":
      return { x: node.x + node.width / 2, y: node.y + node.height };
    case "left":
      return { x: node.x, y: node.y + node.height / 2 };
    case "right":
      return { x: node.x + node.width, y: node.y + node.height / 2 };
  }
}

function edgePath(
  from: { x: number; y: number },
  fromSide: CanvasSide,
  to: { x: number; y: number },
  toSide: CanvasSide,
): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  const k = Math.min(160, Math.max(40, dist * 0.4));
  const c1 = offsetBySide(from, fromSide, k);
  const c2 = offsetBySide(to, toSide, k);
  return `M ${from.x} ${from.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${to.x} ${to.y}`;
}

function offsetBySide(
  p: { x: number; y: number },
  side: CanvasSide,
  k: number,
): { x: number; y: number } {
  switch (side) {
    case "top":
      return { x: p.x, y: p.y - k };
    case "bottom":
      return { x: p.x, y: p.y + k };
    case "left":
      return { x: p.x - k, y: p.y };
    case "right":
      return { x: p.x + k, y: p.y };
  }
}

function rectsOverlap(
  a: { x: number; y: number; width: number; height: number },
  bx0: number,
  by0: number,
  bx1: number,
  by1: number,
): boolean {
  return !(
    a.x + a.width < Math.min(bx0, bx1) ||
    a.x > Math.max(bx0, bx1) ||
    a.y + a.height < Math.min(by0, by1) ||
    a.y > Math.max(by0, by1)
  );
}

/** Returns true if a point lies inside a node's axis-aligned rect. */
function pointInNode(
  n: CanvasNode,
  x: number,
  y: number,
  pad = 0,
): boolean {
  return (
    x >= n.x - pad &&
    x <= n.x + n.width + pad &&
    y >= n.y - pad &&
    y <= n.y + n.height + pad
  );
}

/** Returns true if (x,y) is within `tol` world-units of any segment
 *  in `points` (a flat [x0,y0,x1,y1,...] array). Treats a single-point
 *  stroke as a tiny disc so click-select still works on dots. */
function pointNearStroke(
  points: number[],
  x: number,
  y: number,
  tol: number,
): boolean {
  if (points.length < 2) return false;
  if (points.length === 2) {
    return Math.hypot(points[0] - x, points[1] - y) <= tol;
  }
  const t2 = tol * tol;
  for (let i = 0; i + 3 < points.length; i += 2) {
    const ax = points[i];
    const ay = points[i + 1];
    const bx = points[i + 2];
    const by = points[i + 3];
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq === 0 ? 0 : ((x - ax) * dx + (y - ay) * dy) / lenSq;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const px = ax + t * dx;
    const py = ay + t * dy;
    const ddx = x - px;
    const ddy = y - py;
    if (ddx * ddx + ddy * ddy <= t2) return true;
  }
  return false;
}

/** Returns true if (x,y) is within `tol` world-units of the cubic
 *  Bezier edge from `from` (out side `fromSide`) to `to` (in side
 *  `toSide`). Sampled at 24 steps which is plenty for the curvature
 *  range we ever emit. Mirrors the control-point math in `edgePath`. */
function pointNearEdge(
  from: { x: number; y: number },
  fromSide: CanvasSide,
  to: { x: number; y: number },
  toSide: CanvasSide,
  x: number,
  y: number,
  tol: number,
): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  const k = Math.min(160, Math.max(40, dist * 0.4));
  const c1 = offsetBySide(from, fromSide, k);
  const c2 = offsetBySide(to, toSide, k);
  const t2 = tol * tol;
  const STEPS = 24;
  let prevX = from.x;
  let prevY = from.y;
  for (let i = 1; i <= STEPS; i++) {
    const t = i / STEPS;
    const omt = 1 - t;
    const bx =
      omt * omt * omt * from.x +
      3 * omt * omt * t * c1.x +
      3 * omt * t * t * c2.x +
      t * t * t * to.x;
    const by =
      omt * omt * omt * from.y +
      3 * omt * omt * t * c1.y +
      3 * omt * t * t * c2.y +
      t * t * t * to.y;
    const sx = bx - prevX;
    const sy = by - prevY;
    const lenSq = sx * sx + sy * sy;
    let u =
      lenSq === 0 ? 0 : ((x - prevX) * sx + (y - prevY) * sy) / lenSq;
    if (u < 0) u = 0;
    else if (u > 1) u = 1;
    const px = prevX + u * sx;
    const py = prevY + u * sy;
    const ddx = x - px;
    const ddy = y - py;
    if (ddx * ddx + ddy * ddy <= t2) return true;
    prevX = bx;
    prevY = by;
  }
  return false;
}

/** Compute the bbox of a node set (returns null for empty sets). */
function nodesBounds(
  nodes: CanvasNode[],
): { x: number; y: number; width: number; height: number } | null {
  if (nodes.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const n of nodes) {
    if (n.x < x0) x0 = n.x;
    if (n.y < y0) y0 = n.y;
    if (n.x + n.width > x1) x1 = n.x + n.width;
    if (n.y + n.height > y1) y1 = n.y + n.height;
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

// ---------------------------------------------------------------------
// Alignment guides
// ---------------------------------------------------------------------

/**
 * Compute snap deltas + guide lines when dragging `moving` nodes
 * against a backdrop of `others`. We compare each moving node's
 * left/centerX/right against every other node's left/centerX/right
 * (and the same on Y). The closest match within `threshold` wins per
 * axis, snapping the delta so the candidate edge lands exactly on the
 * matched coordinate.
 *
 * Returns `{ dx, dy, guides }` where dx/dy are the (possibly adjusted)
 * deltas to apply, and `guides` are the world-space lines to draw.
 */
function computeAlignSnap(
  proposedDx: number,
  proposedDy: number,
  moving: CanvasNode[],
  others: CanvasNode[],
  threshold: number,
): { dx: number; dy: number; guides: AlignGuide[] } {
  if (moving.length === 0 || others.length === 0) {
    return { dx: proposedDx, dy: proposedDy, guides: [] };
  }

  // Project all moving-side candidate coordinates after the proposed
  // delta. We keep min/center/max per axis so a single drag can snap
  // any edge, not just the top-left corner. We also keep the moving
  // node reference so we can derive a cross-axis extent for the guide.
  const movingProj = moving.map((n) => ({
    node: n,
    minX: n.x + proposedDx,
    midX: n.x + proposedDx + n.width / 2,
    maxX: n.x + proposedDx + n.width,
    minY: n.y + proposedDy,
    midY: n.y + proposedDy + n.height / 2,
    maxY: n.y + proposedDy + n.height,
  }));

  // For the cross-axis span we need each candidate target coordinate
  // along with the node it came from (so we can read that node's
  // perpendicular extent). Flat parallel arrays keep the inner loop
  // allocation-free.
  const otherXs: number[] = [];
  const otherXNodes: CanvasNode[] = [];
  const otherYs: number[] = [];
  const otherYNodes: CanvasNode[] = [];
  for (const n of others) {
    otherXs.push(n.x, n.x + n.width / 2, n.x + n.width);
    otherXNodes.push(n, n, n);
    otherYs.push(n.y, n.y + n.height / 2, n.y + n.height);
    otherYNodes.push(n, n, n);
  }

  let bestX: {
    delta: number;
    dist: number;
    at: number;
    movingNode: CanvasNode | null;
    otherNode: CanvasNode | null;
  } = { delta: 0, dist: Infinity, at: 0, movingNode: null, otherNode: null };
  let bestY: {
    delta: number;
    dist: number;
    at: number;
    movingNode: CanvasNode | null;
    otherNode: CanvasNode | null;
  } = { delta: 0, dist: Infinity, at: 0, movingNode: null, otherNode: null };

  for (const m of movingProj) {
    for (const cand of [m.minX, m.midX, m.maxX]) {
      for (let i = 0; i < otherXs.length; i++) {
        const target = otherXs[i];
        const d = target - cand;
        const ad = Math.abs(d);
        if (ad < bestX.dist && ad <= threshold) {
          bestX = {
            delta: d,
            dist: ad,
            at: target,
            movingNode: m.node,
            otherNode: otherXNodes[i],
          };
        }
      }
    }
    for (const cand of [m.minY, m.midY, m.maxY]) {
      for (let i = 0; i < otherYs.length; i++) {
        const target = otherYs[i];
        const d = target - cand;
        const ad = Math.abs(d);
        if (ad < bestY.dist && ad <= threshold) {
          bestY = {
            delta: d,
            dist: ad,
            at: target,
            movingNode: m.node,
            otherNode: otherYNodes[i],
          };
        }
      }
    }
  }

  const guides: AlignGuide[] = [];
  if (bestX.dist <= threshold && bestX.movingNode && bestX.otherNode) {
    // Vertical guide (constant X) — span the union of the moving and
    // other node Y extents (apply proposed snap so the moving node's
    // projected position is honored).
    const m = bestX.movingNode;
    const o = bestX.otherNode;
    const finalDy = proposedDy + (bestY.dist <= threshold ? bestY.delta : 0);
    const mMinY = m.y + finalDy;
    const mMaxY = m.y + m.height + finalDy;
    const span: [number, number] = [
      Math.min(mMinY, o.y),
      Math.max(mMaxY, o.y + o.height),
    ];
    guides.push({ axis: "x", at: bestX.at, span });
  }
  if (bestY.dist <= threshold && bestY.movingNode && bestY.otherNode) {
    // Horizontal guide (constant Y).
    const m = bestY.movingNode;
    const o = bestY.otherNode;
    const finalDx = proposedDx + (bestX.dist <= threshold ? bestX.delta : 0);
    const mMinX = m.x + finalDx;
    const mMaxX = m.x + m.width + finalDx;
    const span: [number, number] = [
      Math.min(mMinX, o.x),
      Math.max(mMaxX, o.x + o.width),
    ];
    guides.push({ axis: "y", at: bestY.at, span });
  }
  return {
    dx: proposedDx + (bestX.dist <= threshold ? bestX.delta : 0),
    dy: proposedDy + (bestY.dist <= threshold ? bestY.delta : 0),
    guides,
  };
}

// ---------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------

export function CanvasView({ source, onChange }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);

  // Parse on mount / when the underlying file changes. We key on the
  // raw source string identity (not the parsed object) so in-flight
  // viewport / selection survives spurious re-renders.
  const [doc, setDoc] = useState<CanvasDoc>(() => parseCanvas(source));
  const lastSourceRef = useRef(source);
  useEffect(() => {
    if (source !== lastSourceRef.current) {
      lastSourceRef.current = source;
      setDoc(parseCanvas(source));
      setSelection(new Set());
      setEditingId(null);
    }
  }, [source]);

  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [hoverNodeId, setHoverNodeId] = useState<string | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [tool, setTool] = useState<Tool>("select");
  const [exportOpen, setExportOpen] = useState(false);
  const [toolbarPos, setToolbarPos] = useState<ToolbarPos>(loadToolbarPos);
  const [toolbarMenuOpen, setToolbarMenuOpen] = useState(false);
  /** Live screen-space position while the user is mid-drag. Decoupled
   *  from `toolbarPos` so we don't thrash localStorage every frame. */
  const [toolbarDrag, setToolbarDrag] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const gestureRef = useRef<Gesture>(null);
  const [tick, forceTick] = useState(0);
  const bump = useCallback(() => forceTick((n) => (n + 1) & 0xffff), []);

  // ----- commit -------------------------------------------------------
  const commit = useCallback(
    (next: CanvasDoc | ((prev: CanvasDoc) => CanvasDoc)) => {
      setDoc((prev) => {
        const n = typeof next === "function" ? next(prev) : next;
        // Defer the parent notify out of the setState reducer so we
        // don't trigger React's "setState during render" warning when
        // the parent (App) reduces our onChange into its own state.
        queueMicrotask(() => onChange(serializeCanvas(n)));
        return n;
      });
    },
    [onChange],
  );

  // ----- toolbar position persistence --------------------------------
  // Mirror the user's docked position back to localStorage so the bar
  // remembers where they left it across reloads / file switches.
  useEffect(() => {
    try {
      localStorage.setItem(TOOLBAR_LS_KEY, JSON.stringify(toolbarPos));
    } catch {
      /* sandboxed env — silently skip persistence */
    }
  }, [toolbarPos]);

  /** Begin dragging the toolbar. Tracks pointer until release, then
   *  snaps to the closest edge if within `TOOLBAR_SNAP_PX`, otherwise
   *  drops at the released coords in `float` mode. */
  const onToolbarGripPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const grip = e.currentTarget as HTMLElement;
      const bar = grip.closest<HTMLElement>(".canvas-toolbar");
      const root = rootRef.current;
      if (!bar || !root) return;
      const barRect = bar.getBoundingClientRect();
      const rootRect = root.getBoundingClientRect();
      // Offset from the bar's top-left to the pointer at grab time;
      // we keep the same offset under the cursor while dragging.
      const offX = e.clientX - barRect.left;
      const offY = e.clientY - barRect.top;
      let curX = barRect.left - rootRect.left;
      let curY = barRect.top - rootRect.top;
      grip.setPointerCapture(e.pointerId);

      const onMove = (mv: PointerEvent) => {
        curX = mv.clientX - rootRect.left - offX;
        curY = mv.clientY - rootRect.top - offY;
        // Clamp inside the canvas root so the toolbar can't be lost.
        const maxX = Math.max(0, rootRect.width - barRect.width);
        const maxY = Math.max(0, rootRect.height - barRect.height);
        curX = Math.min(Math.max(0, curX), maxX);
        curY = Math.min(Math.max(0, curY), maxY);
        setToolbarDrag({ x: curX, y: curY });
      };
      const onUp = () => {
        grip.removeEventListener("pointermove", onMove);
        grip.removeEventListener("pointerup", onUp);
        grip.removeEventListener("pointercancel", onUp);
        setToolbarDrag(null);
        // Snap-to-edge if close to any side, else stay floating.
        const distLeft = curX;
        const distTop = curY;
        const distRight = rootRect.width - (curX + barRect.width);
        const distBottom = rootRect.height - (curY + barRect.height);
        const min = Math.min(distLeft, distRight, distTop, distBottom);
        if (min <= TOOLBAR_SNAP_PX) {
          if (min === distLeft) setToolbarPos({ dock: "left" });
          else if (min === distRight) setToolbarPos({ dock: "right" });
          else if (min === distTop) setToolbarPos({ dock: "top" });
          else setToolbarPos({ dock: "bottom" });
        } else {
          setToolbarPos({ dock: "float", x: curX, y: curY });
        }
      };
      grip.addEventListener("pointermove", onMove);
      grip.addEventListener("pointerup", onUp);
      grip.addEventListener("pointercancel", onUp);
    },
    [],
  );

  // ----- coordinate conversion ---------------------------------------
  const screenToWorld = useCallback(
    (sx: number, sy: number): { x: number; y: number } => {
      const r = rootRef.current?.getBoundingClientRect();
      if (!r) return { x: 0, y: 0 };
      return {
        x: (sx - r.left - viewport.x) / viewport.zoom,
        y: (sy - r.top - viewport.y) / viewport.zoom,
      };
    },
    [viewport],
  );

  // ----- selection helpers -------------------------------------------
  const isSelected = useCallback(
    (id: string) => selection.has(id),
    [selection],
  );
  const selectOnly = useCallback(
    (id: string) => setSelection(new Set([id])),
    [],
  );
  const toggleInSelection = useCallback(
    (id: string) =>
      setSelection((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );
  const clearSelection = useCallback(() => setSelection(new Set()), []);

  // ----- viewport actions --------------------------------------------
  const zoomBy = useCallback(
    (factor: number, anchorScreen?: { x: number; y: number }) => {
      setViewport((vp) => {
        const next = Math.max(
          MIN_ZOOM,
          Math.min(MAX_ZOOM, vp.zoom * factor),
        );
        if (!anchorScreen || !rootRef.current) {
          return { ...vp, zoom: next };
        }
        const r = rootRef.current.getBoundingClientRect();
        const ax = anchorScreen.x - r.left;
        const ay = anchorScreen.y - r.top;
        const worldX = (ax - vp.x) / vp.zoom;
        const worldY = (ay - vp.y) / vp.zoom;
        return {
          zoom: next,
          x: ax - worldX * next,
          y: ay - worldY * next,
        };
      });
    },
    [],
  );

  const fitToContent = useCallback(() => {
    if (doc.nodes.length === 0 || !rootRef.current) {
      setViewport({ x: 0, y: 0, zoom: 1 });
      return;
    }
    const PAD = 60;
    const b = nodesBounds(doc.nodes);
    if (!b) return;
    const r = rootRef.current.getBoundingClientRect();
    const zx = (r.width - PAD * 2) / b.width;
    const zy = (r.height - PAD * 2) / b.height;
    const zoom = Math.max(MIN_ZOOM, Math.min(1, Math.min(zx, zy)));
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    setViewport({
      zoom,
      x: r.width / 2 - cx * zoom,
      y: r.height / 2 - cy * zoom,
    });
  }, [doc.nodes]);

  const didInitialFitRef = useRef(false);
  useLayoutEffect(() => {
    if (didInitialFitRef.current) return;
    didInitialFitRef.current = true;
    fitToContent();
  }, [fitToContent]);

  // ----- node mutations ----------------------------------------------
  const addTextNodeAt = useCallback(
    (worldX: number, worldY: number) => {
      const node: CanvasTextNode = {
        id: newId("n"),
        type: "text",
        x: Math.round(worldX - DEFAULT_CARD_W / 2),
        y: Math.round(worldY - DEFAULT_CARD_H / 2),
        width: DEFAULT_CARD_W,
        height: DEFAULT_CARD_H,
        text: "",
      };
      commit((prev) => ({ ...prev, nodes: [...prev.nodes, node] }));
      setSelection(new Set([node.id]));
      setEditingId(node.id);
    },
    [commit],
  );

  const deleteSelection = useCallback(() => {
    if (selection.size === 0) return;
    commit((prev) => {
      const keepNode = (n: CanvasNode) => !selection.has(n.id);
      const keptIds = new Set(
        prev.nodes.filter(keepNode).map((n) => n.id),
      );
      return {
        nodes: prev.nodes.filter(keepNode),
        edges: prev.edges.filter(
          (e) =>
            !selection.has(e.id) &&
            keptIds.has(e.fromNode) &&
            keptIds.has(e.toNode),
        ),
      };
    });
    setSelection(new Set());
    setEditingId(null);
  }, [selection, commit]);

  const setNodeText = useCallback(
    (id: string, text: string) => {
      commit((prev) => ({
        ...prev,
        nodes: prev.nodes.map((n) =>
          n.id === id && (n.type === "text" || n.type === "shape")
            ? ({ ...n, text } as CanvasNode)
            : n,
        ),
      }));
    },
    [commit],
  );

  /** Group the current selection into a single CanvasGroupNode. The
   *  group's bbox wraps the selection with a padding so the label has
   *  somewhere to live, and member ids are stored on `children` so a
   *  later drag moves them all together (see expandWithGroupMembers). */
  const groupSelection = useCallback(() => {
    if (selection.size < 1) return;
    commit((prev) => {
      const members = prev.nodes.filter(
        (n) => selection.has(n.id) && n.type !== "group",
      );
      if (members.length === 0) return prev;
      const b = nodesBounds(members);
      if (!b) return prev;
      const PAD = 24;
      const HEADER = 28; // room for the label strip at the top
      const group: CanvasGroupNode = {
        id: newId("g"),
        type: "group",
        x: Math.round(b.x - PAD),
        y: Math.round(b.y - PAD - HEADER),
        width: Math.round(b.width + PAD * 2),
        height: Math.round(b.height + PAD * 2 + HEADER),
        label: "Group",
        children: members.map((m) => m.id),
      };
      // Insert the group BEFORE its members so it renders behind them.
      return {
        ...prev,
        nodes: [group, ...prev.nodes],
      };
    });
  }, [selection, commit]);

  /** Inverse of groupSelection: drop selected group containers while
   *  preserving their member nodes in place. */
  const ungroupSelection = useCallback(() => {
    if (selection.size === 0) return;
    commit((prev) => ({
      ...prev,
      nodes: prev.nodes.filter(
        (n) => !(n.type === "group" && selection.has(n.id)),
      ),
    }));
    setSelection(new Set());
  }, [selection, commit]);

  /** When the user drags a group (or has groups in their selection),
   *  expand the moving id list to include every member of every
   *  selected group so the children follow. */
  const expandWithGroupMembers = useCallback(
    (ids: Set<string>): Set<string> => {
      const out = new Set(ids);
      for (const id of ids) {
        const n = doc.nodes.find((nn) => nn.id === id);
        if (n && n.type === "group" && Array.isArray(n.children)) {
          for (const child of n.children) out.add(child);
        }
      }
      return out;
    },
    [doc.nodes],
  );

  // ----- export -------------------------------------------------------
  const exportJson = useCallback(() => {
    downloadBlob(
      new Blob([serializeCanvas(doc)], { type: "application/json" }),
      "canvas.canvas",
    );
  }, [doc]);

  const exportSvg = useCallback(() => {
    const svg = renderDocAsSvg(doc);
    downloadBlob(new Blob([svg], { type: "image/svg+xml" }), "canvas.svg");
  }, [doc]);

  const exportPng = useCallback(async () => {
    const svg = renderDocAsSvg(doc);
    try {
      const blob = await svgToPngBlob(svg, 2 /* device pixel scale */);
      downloadBlob(blob, "canvas.png");
    } catch (err) {
      // Fall back to SVG so the user still gets *something*. PNG
      // conversion can fail on Tauri/WebView when canvas tainting
      // rules trip — surface the SVG instead.
      console.warn("PNG export failed, falling back to SVG", err);
      downloadBlob(
        new Blob([svg], { type: "image/svg+xml" }),
        "canvas.svg",
      );
    }
  }, [doc]);

  // ----- hit-test helper used by both eraser + arrow tool -----------
  const eraseAt = useCallback(
    (x: number, y: number) => {
      let touched = false;
      setDoc((prev) => {
        // Eraser tolerance — slightly larger in screen px than the
        // visible stroke so light brushes still register, but scaled
        // down by zoom so the felt-tip size feels consistent.
        const TOL = 8 / Math.max(0.5, viewport.zoom);
        const nextNodes = prev.nodes.filter((n) => {
          if (n.type === "draw") {
            const dn = n as CanvasDrawNode;
            // Cheap bbox prefilter (pad by tolerance) then exact
            // distance-to-segment test against the stored samples.
            if (!pointInNode(n, x, y, TOL)) return true;
            const strokeTol =
              (dn.strokeWidth ?? PEN_DEFAULT_STROKE_WIDTH) / 2 + TOL;
            if (pointNearStroke(dn.points, x, y, strokeTol)) {
              touched = true;
              return false;
            }
            return true;
          }
          // Cards/shapes/groups: bbox hit (no padding so the eraser
          // doesn't yank cards from a few px away).
          if (pointInNode(n, x, y, 0)) {
            touched = true;
            return false;
          }
          return true;
        });
        // Edges: keep ones that survive both endpoints AND aren't
        // touched by the eraser.
        const keptIds = new Set(nextNodes.map((n) => n.id));
        const nextEdges = prev.edges.filter((e) => {
          if (!keptIds.has(e.fromNode) || !keptIds.has(e.toNode)) {
            return false;
          }
          const fromNode = prev.nodes.find((n) => n.id === e.fromNode);
          const toNode = prev.nodes.find((n) => n.id === e.toNode);
          if (!fromNode || !toNode) return false;
          const fromSide =
            e.fromSide ??
            inferSide(
              fromNode,
              toNode.x + toNode.width / 2,
              toNode.y + toNode.height / 2,
            );
          const toSide =
            e.toSide ??
            inferSide(
              toNode,
              fromNode.x + fromNode.width / 2,
              fromNode.y + fromNode.height / 2,
            );
          const from = sidePoint(fromNode, fromSide);
          const to = sidePoint(toNode, toSide);
          if (pointNearEdge(from, fromSide, to, toSide, x, y, TOL)) {
            touched = true;
            return false;
          }
          return true;
        });
        if (!touched) return prev;
        const out = { nodes: nextNodes, edges: nextEdges };
        // Same deferral as in `commit` — keep parent notification out
        // of the setState reducer.
        queueMicrotask(() => onChange(serializeCanvas(out)));
        return out;
      });
    },
    [onChange, viewport.zoom],
  );

  // ----- keyboard ----------------------------------------------------
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const ae = document.activeElement;
      const inEditor =
        ae instanceof HTMLElement &&
        (ae.tagName === "TEXTAREA" ||
          ae.tagName === "INPUT" ||
          ae.isContentEditable);
      if (e.code === "Space" && !spaceDown && !inEditor) setSpaceDown(true);
      if (inEditor) return;

      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelection(new Set(doc.nodes.map((n) => n.id)));
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selection.size > 0) {
          e.preventDefault();
          deleteSelection();
        }
        return;
      }
      if (e.key === "Escape") {
        setEditingId(null);
        clearSelection();
        setTool("select");
        return;
      }
      if (e.key === "1" && e.shiftKey) {
        e.preventDefault();
        fitToContent();
        return;
      }
      if (e.key === "0" && !mod) {
        e.preventDefault();
        setViewport((vp) => ({ ...vp, zoom: 1 }));
        return;
      }
      // G — group selection (lowercase) / Ctrl+Shift+G — ungroup
      if (e.key.toLowerCase() === "g") {
        if (mod && e.shiftKey) {
          e.preventDefault();
          ungroupSelection();
          return;
        }
        if (!mod && !e.shiftKey && !e.altKey) {
          e.preventDefault();
          groupSelection();
          return;
        }
      }
      // Tool shortcuts (single key, no modifier)
      if (!mod && !e.shiftKey && !e.altKey) {
        const map: Record<string, Tool> = {
          v: "select",
          h: "hand",
          p: "pen",
          e: "eraser",
          r: "rect",
          o: "ellipse",
          d: "diamond",
          a: "arrow",
          t: "text",
        };
        const next = map[e.key.toLowerCase()];
        if (next) {
          e.preventDefault();
          setTool(next);
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceDown(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [
    doc.nodes,
    selection,
    deleteSelection,
    clearSelection,
    fitToContent,
    groupSelection,
    ungroupSelection,
    spaceDown,
  ]);

  // ----- wheel: zoom / pan -------------------------------------------
  // The React synthetic `onWheel` is passive in React 19, so don't bother
  // calling preventDefault here \u2014 the native listener below does it
  // synchronously on a non-passive binding.
  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      // Don't pan/zoom when the wheel happens over floating chrome
      // (toolbar, HUD, zoom chip, menus) — those need their own scroll
      // semantics and should never alter the canvas viewport.
      if (
        (e.target as HTMLElement).closest(
          ".canvas-toolbar, .canvas-hud, .canvas-zoom-chip, .canvas-export-menu, .canvas-toolbar-dock-menu",
        )
      ) {
        return;
      }
      if (e.ctrlKey || e.metaKey || !e.shiftKey) {
        const factor = Math.exp(-e.deltaY * 0.0015);
        zoomBy(factor, { x: e.clientX, y: e.clientY });
      } else {
        setViewport((vp) => ({
          ...vp,
          x: vp.x - e.deltaY,
          y: vp.y - e.deltaX,
        }));
      }
    },
    [zoomBy],
  );

  // React 19's onWheel is passive; install a native non-passive listener
  // so preventDefault works for zoom.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const handler = (ev: WheelEvent) => {
      if (ev.ctrlKey || ev.metaKey || !ev.shiftKey) ev.preventDefault();
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  // ----- pointer dispatch --------------------------------------------
  // Two-layer model:
  //   1. PRIORITY interactions: clicking on an existing element (resize
  //      handle, connector dot, card, or freehand stroke) always wins
  //      over the active draw tool. This matches Figma/Excalidraw —
  //      hovering a shape shows the grab cursor and the click drags it,
  //      regardless of which tool is armed. The Eraser is the only
  //      exception (its primary gesture is to consume things along the
  //      pointer path, including hits on existing nodes).
  //   2. Tool-specific empty-space gesture: only if the priority layer
  //      didn't claim the click. The Select tool's empty-space gesture
  //      is the marquee; every other tool produces its own primary
  //      shape / stroke / text card.
  const onPointerDown = (e: React.PointerEvent) => {
    // ===== Overlay UI guard ==========================================
    // The toolbar, HUD buttons, zoom chip, export menu, dock menu, and
    // any other floating chrome live inside .canvas-root as siblings
    // of .canvas-world. Without this guard, clicking any of them would
    // also fire this handler and start a draw/select gesture at the
    // overlay's screen position — producing phantom shapes behind the
    // toolbar when switching tools. Bail before touching any state.
    const overlayEl = (e.target as HTMLElement).closest(
      ".canvas-toolbar, .canvas-hud, .canvas-zoom-chip, .canvas-export-menu, .canvas-toolbar-dock-menu",
    );
    if (overlayEl) return;

    const wantsPan =
      e.button === 1 ||
      (e.button === 0 && spaceDown) ||
      (e.button === 0 && tool === "hand");
    if (wantsPan) {
      e.preventDefault();
      gestureRef.current = {
        kind: "pan",
        startX: e.clientX,
        startY: e.clientY,
        vp: viewport,
      };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;

    const targetEl = e.target as HTMLElement;
    const w = screenToWorld(e.clientX, e.clientY);

    // ===== Priority: existing-element interactions ===================
    // Skipped for the eraser tool (which wants to hit-test along its
    // own path).
    if (tool !== "eraser") {
      const resizeAttr = targetEl.getAttribute("data-resize");
      const cardEl = targetEl.closest<HTMLElement>("[data-node-id]");

      if (resizeAttr && cardEl) {
        const id = cardEl.dataset.nodeId!;
        const node = doc.nodes.find((n) => n.id === id);
        if (!node) return;
        gestureRef.current = {
          kind: "resize-node",
          id,
          handle: resizeAttr as ResizeHandle,
          startX: e.clientX,
          startY: e.clientY,
          orig: {
            x: node.x,
            y: node.y,
            width: node.width,
            height: node.height,
          },
        };
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        return;
      }

      const connectorSide = targetEl.getAttribute("data-connector");
      if (connectorSide && cardEl) {
        const id = cardEl.dataset.nodeId!;
        gestureRef.current = {
          kind: "draw-edge",
          fromId: id,
          fromSide: connectorSide as CanvasSide,
          curWorldX: w.x,
          curWorldY: w.y,
          hoverNodeId: null,
        };
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        return;
      }

      if (cardEl) {
        const id = cardEl.dataset.nodeId!;
        // Shift-toggle selection is a select-tool affordance only. For
        // other tools, just select-this-and-move (Figma/Excalidraw
        // semantics).
        if (tool === "select" && e.shiftKey) {
          toggleInSelection(id);
        } else if (!isSelected(id)) {
          selectOnly(id);
        }
        const ids = new Set(selection);
        if (!e.shiftKey || !isSelected(id)) ids.add(id);
        const expanded = expandWithGroupMembers(ids);
        const origins = new Map<
          string,
          { x: number; y: number; points?: number[] }
        >();
        for (const n of doc.nodes) {
          if (expanded.has(n.id)) {
            origins.set(n.id, {
              x: n.x,
              y: n.y,
              points:
                n.type === "draw"
                  ? [...(n as CanvasDrawNode).points]
                  : undefined,
            });
          }
        }
        gestureRef.current = {
          kind: "move-nodes",
          startX: e.clientX,
          startY: e.clientY,
          ids: Array.from(expanded),
          origins,
          guides: [],
        };
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        return;
      }

      // Draw strokes have no DOM card (they live inside the SVG layer),
      // so the closest() lookup above can never match them. Hit-test
      // them here against their sample points so click-select + drag
      // still work. Iterate top-down so the most recently drawn stroke
      // wins overlaps.
      {
        const bboxPad = 8 / viewport.zoom;
        let drawHit: CanvasDrawNode | null = null;
        for (let i = doc.nodes.length - 1; i >= 0; i--) {
          const n = doc.nodes[i];
          if (n.type !== "draw") continue;
          if (!pointInNode(n, w.x, w.y, bboxPad)) continue;
          const dn = n as CanvasDrawNode;
          const strokeTol =
            ((dn.strokeWidth ?? PEN_DEFAULT_STROKE_WIDTH) / 2 + 4) /
            viewport.zoom;
          if (pointNearStroke(dn.points, w.x, w.y, strokeTol)) {
            drawHit = dn;
            break;
          }
        }
        if (drawHit) {
          const id = drawHit.id;
          if (tool === "select" && e.shiftKey) toggleInSelection(id);
          else if (!isSelected(id)) selectOnly(id);
          const ids = new Set(selection);
          if (!e.shiftKey || !isSelected(id)) ids.add(id);
          const expanded = expandWithGroupMembers(ids);
          const origins = new Map<
            string,
            { x: number; y: number; points?: number[] }
          >();
          for (const n of doc.nodes) {
            if (expanded.has(n.id)) {
              origins.set(n.id, {
                x: n.x,
                y: n.y,
                points:
                  n.type === "draw"
                    ? [...(n as CanvasDrawNode).points]
                    : undefined,
              });
            }
          }
          gestureRef.current = {
            kind: "move-nodes",
            startX: e.clientX,
            startY: e.clientY,
            ids: Array.from(expanded),
            origins,
            guides: [],
          };
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          return;
        }
      }
    }

    // ===== Tool-specific empty-space gestures ========================
    if (tool === "pen") {
      gestureRef.current = { kind: "pen", points: [w.x, w.y] };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      bump();
      return;
    }
    if (tool === "eraser") {
      gestureRef.current = { kind: "erase", lastX: w.x, lastY: w.y };
      eraseAt(w.x, w.y);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }
    if (tool === "rect" || tool === "ellipse" || tool === "diamond") {
      gestureRef.current = {
        kind: "shape",
        shape: tool,
        startWorldX: w.x,
        startWorldY: w.y,
        curWorldX: w.x,
        curWorldY: w.y,
      };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      bump();
      return;
    }
    if (tool === "arrow") {
      // The from-node check is redundant now (the priority block above
      // already started a draw-edge gesture if the click landed on a
      // connector dot), but a click on truly empty space still needs
      // an arrow-tool gesture so we can drag out a free-standing line.
      const fromHit = doc.nodes.find((n) => pointInNode(n, w.x, w.y));
      gestureRef.current = {
        kind: "arrow-tool",
        startWorldX: w.x,
        startWorldY: w.y,
        curWorldX: w.x,
        curWorldY: w.y,
        fromNodeId: fromHit?.id ?? null,
        hoverNodeId: null,
      };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      bump();
      return;
    }
    if (tool === "text") {
      addTextNodeAt(w.x, w.y);
      setTool("select");
      return;
    }

    // ===== Select tool fallback: empty space starts a marquee. =======
    if (!e.shiftKey) clearSelection();
    gestureRef.current = {
      kind: "marquee",
      startWorldX: w.x,
      startWorldY: w.y,
      curWorldX: w.x,
      curWorldY: w.y,
      additive: e.shiftKey,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    if (!g) return;
    if (g.kind === "pan") {
      setViewport({
        x: g.vp.x + (e.clientX - g.startX),
        y: g.vp.y + (e.clientY - g.startY),
        zoom: g.vp.zoom,
      });
      return;
    }
    if (g.kind === "move-nodes") {
      const proposedDx = (e.clientX - g.startX) / viewport.zoom;
      const proposedDy = (e.clientY - g.startY) / viewport.zoom;

      // Alignment snap — only consider nodes NOT being moved as
      // alignment targets, and only the FIRST member of the moving set
      // as the candidate edges (multi-move snaps relative to one anchor
      // so the group stays rigid).
      const movingIds = new Set(g.ids);
      const movingOriginal = doc.nodes.filter((n) => movingIds.has(n.id));
      const others = doc.nodes.filter(
        (n) => !movingIds.has(n.id) && n.type !== "group",
      );
      const snap = computeAlignSnap(
        proposedDx,
        proposedDy,
        movingOriginal,
        others,
        SNAP_PX / viewport.zoom,
      );
      g.guides = snap.guides;

      setDoc((prev) => ({
        ...prev,
        nodes: prev.nodes.map((n) => {
          const o = g.origins.get(n.id);
          if (!o) return n;
          const nx = Math.round(o.x + snap.dx);
          const ny = Math.round(o.y + snap.dy);
          // Draw nodes carry their stroke samples in world coords, so
          // we must translate every point by the same delta as the
          // bbox or the visible stroke would lag behind the move.
          if (n.type === "draw" && o.points) {
            const tx = nx - o.x;
            const ty = ny - o.y;
            const shifted = new Array<number>(o.points.length);
            for (let i = 0; i < o.points.length; i += 2) {
              shifted[i] = o.points[i] + tx;
              shifted[i + 1] = o.points[i + 1] + ty;
            }
            return { ...n, x: nx, y: ny, points: shifted };
          }
          return { ...n, x: nx, y: ny };
        }),
      }));
      return;
    }
    if (g.kind === "resize-node") {
      const dx = (e.clientX - g.startX) / viewport.zoom;
      const dy = (e.clientY - g.startY) / viewport.zoom;
      const { handle, orig } = g;
      let { x, y, width, height } = orig;
      const MIN = 60;
      if (handle.includes("e")) width = Math.max(MIN, orig.width + dx);
      if (handle.includes("s")) height = Math.max(MIN, orig.height + dy);
      if (handle.includes("w")) {
        const w2 = Math.max(MIN, orig.width - dx);
        x = orig.x + (orig.width - w2);
        width = w2;
      }
      if (handle.includes("n")) {
        const h2 = Math.max(MIN, orig.height - dy);
        y = orig.y + (orig.height - h2);
        height = h2;
      }
      setDoc((prev) => ({
        ...prev,
        nodes: prev.nodes.map((n) =>
          n.id === g.id
            ? {
                ...n,
                x: Math.round(x),
                y: Math.round(y),
                width: Math.round(width),
                height: Math.round(height),
              }
            : n,
        ),
      }));
      return;
    }
    if (g.kind === "marquee") {
      const w = screenToWorld(e.clientX, e.clientY);
      g.curWorldX = w.x;
      g.curWorldY = w.y;
      bump();
      return;
    }
    if (g.kind === "draw-edge") {
      const w = screenToWorld(e.clientX, e.clientY);
      g.curWorldX = w.x;
      g.curWorldY = w.y;
      let hit: string | null = null;
      for (const n of doc.nodes) {
        if (n.id === g.fromId || n.type === "group" || n.type === "draw") {
          continue;
        }
        if (pointInNode(n, w.x, w.y)) {
          hit = n.id;
          break;
        }
      }
      g.hoverNodeId = hit;
      bump();
      return;
    }
    if (g.kind === "pen") {
      const w = screenToWorld(e.clientX, e.clientY);
      const lastX = g.points[g.points.length - 2];
      const lastY = g.points[g.points.length - 1];
      if (Math.hypot(w.x - lastX, w.y - lastY) >= PEN_MIN_DIST) {
        g.points.push(w.x, w.y);
        bump();
      }
      return;
    }
    if (g.kind === "shape") {
      const w = screenToWorld(e.clientX, e.clientY);
      g.curWorldX = w.x;
      g.curWorldY = w.y;
      bump();
      return;
    }
    if (g.kind === "arrow-tool") {
      const w = screenToWorld(e.clientX, e.clientY);
      g.curWorldX = w.x;
      g.curWorldY = w.y;
      let hit: string | null = null;
      for (const n of doc.nodes) {
        if (n.id === g.fromNodeId) continue;
        if (n.type === "group" || n.type === "draw") continue;
        if (pointInNode(n, w.x, w.y)) {
          hit = n.id;
          break;
        }
      }
      g.hoverNodeId = hit;
      bump();
      return;
    }
    if (g.kind === "erase") {
      const w = screenToWorld(e.clientX, e.clientY);
      // Sample along the segment from last → current so a fast drag
      // doesn't skip over thin strokes between samples.
      const segments = Math.max(
        1,
        Math.ceil(Math.hypot(w.x - g.lastX, w.y - g.lastY) / 6),
      );
      for (let i = 1; i <= segments; i++) {
        const t = i / segments;
        eraseAt(
          g.lastX + (w.x - g.lastX) * t,
          g.lastY + (w.y - g.lastY) * t,
        );
      }
      g.lastX = w.x;
      g.lastY = w.y;
      return;
    }
  };

  const onPointerUp = (_e: React.PointerEvent) => {
    const g = gestureRef.current;
    gestureRef.current = null;
    if (!g) return;
    if (g.kind === "move-nodes" || g.kind === "resize-node") {
      // Mutation already applied via setDoc; persist the final state.
      onChange(serializeCanvas(doc));
      bump();
      return;
    }
    if (g.kind === "marquee") {
      const x0 = Math.min(g.startWorldX, g.curWorldX);
      const y0 = Math.min(g.startWorldY, g.curWorldY);
      const x1 = Math.max(g.startWorldX, g.curWorldX);
      const y1 = Math.max(g.startWorldY, g.curWorldY);
      const tiny = Math.abs(x1 - x0) < 3 && Math.abs(y1 - y0) < 3;
      if (tiny) {
        bump();
        return;
      }
      setSelection((prev) => {
        const next = g.additive ? new Set(prev) : new Set<string>();
        for (const n of doc.nodes) {
          if (rectsOverlap(n, x0, y0, x1, y1)) next.add(n.id);
        }
        return next;
      });
      bump();
      return;
    }
    if (g.kind === "draw-edge") {
      const targetId = g.hoverNodeId;
      if (targetId && targetId !== g.fromId) {
        const target = doc.nodes.find((n) => n.id === targetId);
        if (target) {
          const fromNode = doc.nodes.find((n) => n.id === g.fromId);
          const tp = fromNode
            ? sidePoint(fromNode, g.fromSide)
            : { x: 0, y: 0 };
          const toSide = inferSide(target, tp.x, tp.y);
          const newEdge: CanvasEdge = {
            id: newId("e"),
            fromNode: g.fromId,
            fromSide: g.fromSide,
            toNode: targetId,
            toSide,
            toEnd: "arrow",
          };
          commit((prev) => ({
            ...prev,
            edges: [...prev.edges, newEdge],
          }));
        }
      }
      bump();
      return;
    }
    if (g.kind === "pen") {
      if (g.points.length >= 4) {
        const b = pointsBounds(g.points, 4);
        const draw: CanvasDrawNode = {
          id: newId("d"),
          type: "draw",
          x: Math.round(b.x),
          y: Math.round(b.y),
          width: Math.max(1, Math.round(b.width)),
          height: Math.max(1, Math.round(b.height)),
          points: g.points.map((v) => Math.round(v * 100) / 100),
          strokeWidth: PEN_DEFAULT_STROKE_WIDTH,
        };
        commit((prev) => ({ ...prev, nodes: [...prev.nodes, draw] }));
      }
      bump();
      return;
    }
    if (g.kind === "shape") {
      const x = Math.min(g.startWorldX, g.curWorldX);
      const y = Math.min(g.startWorldY, g.curWorldY);
      const w = Math.abs(g.curWorldX - g.startWorldX);
      const h = Math.abs(g.curWorldY - g.startWorldY);
      let newShape: CanvasShapeNode;
      if (w < 6 || h < 6) {
        // Treat tiny drags as click-to-default-shape so the user can
        // tap a tool + click to drop a baseline rect/ellipse.
        const dw = 160;
        const dh = 100;
        newShape = {
          id: newId("s"),
          type: "shape",
          shape: g.shape,
          x: Math.round(g.startWorldX - dw / 2),
          y: Math.round(g.startWorldY - dh / 2),
          width: dw,
          height: dh,
          strokeWidth: SHAPE_DEFAULT_STROKE_WIDTH,
        };
      } else {
        newShape = {
          id: newId("s"),
          type: "shape",
          shape: g.shape,
          x: Math.round(x),
          y: Math.round(y),
          width: Math.round(w),
          height: Math.round(h),
          strokeWidth: SHAPE_DEFAULT_STROKE_WIDTH,
        };
      }
      commit((prev) => ({ ...prev, nodes: [...prev.nodes, newShape] }));
      // Shape tool stays active so the user can draw several rects/
      // ellipses/diamonds in a row (Excalidraw / Figma behaviour).
      // To move what was just drawn, press V or Escape to switch to
      // the select tool. We don't auto-select the new node either —
      // a stale selection would just be cleared on the next click.
      bump();
      return;
    }
    if (g.kind === "arrow-tool") {
      // Only create an edge if BOTH endpoints land on nodes. Free-
      // floating arrows would need their own node type; keep scope
      // tight for v2.
      const fromHit = g.fromNodeId
        ? doc.nodes.find((n) => n.id === g.fromNodeId)
        : null;
      const toHit = g.hoverNodeId
        ? doc.nodes.find((n) => n.id === g.hoverNodeId)
        : null;
      if (fromHit && toHit && fromHit.id !== toHit.id) {
        const fromSide = inferSide(
          fromHit,
          toHit.x + toHit.width / 2,
          toHit.y + toHit.height / 2,
        );
        const toSide = inferSide(
          toHit,
          fromHit.x + fromHit.width / 2,
          fromHit.y + fromHit.height / 2,
        );
        const newEdge: CanvasEdge = {
          id: newId("e"),
          fromNode: fromHit.id,
          fromSide,
          toNode: toHit.id,
          toSide,
          toEnd: "arrow",
        };
        commit((prev) => ({ ...prev, edges: [...prev.edges, newEdge] }));
      }
      // Arrow tool stays active so the user can chain edges between
      // nodes without re-selecting the toolbar each time. Switch back
      // to select manually (V / Escape) when done.
      bump();
      return;
    }
    if (g.kind === "erase") {
      bump();
      return;
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (tool !== "select") return; // tool-mode owns the canvas
    const targetEl = e.target as HTMLElement;
    // Skip double-clicks on floating chrome — those buttons own their
    // own onClick semantics and must never spawn a text card behind
    // the toolbar.
    if (
      targetEl.closest(
        ".canvas-toolbar, .canvas-hud, .canvas-zoom-chip, .canvas-export-menu, .canvas-toolbar-dock-menu",
      )
    ) {
      return;
    }
    if (targetEl.closest("[data-node-id]")) return;
    const w = screenToWorld(e.clientX, e.clientY);
    addTextNodeAt(w.x, w.y);
  };

  // ----- precomputed visuals derived from the live gesture -----------
  // `tick` is intentionally read so React re-evaluates these on bump().
  void tick;

  const marqueeRect = (() => {
    const g = gestureRef.current;
    if (!g || g.kind !== "marquee") return null;
    const x0 = Math.min(g.startWorldX, g.curWorldX);
    const y0 = Math.min(g.startWorldY, g.curWorldY);
    const x1 = Math.max(g.startWorldX, g.curWorldX);
    const y1 = Math.max(g.startWorldY, g.curWorldY);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  })();

  const drawingEdge = (() => {
    const g = gestureRef.current;
    if (!g || g.kind !== "draw-edge") return null;
    const fromNode = doc.nodes.find((n) => n.id === g.fromId);
    if (!fromNode) return null;
    const from = sidePoint(fromNode, g.fromSide);
    let to = { x: g.curWorldX, y: g.curWorldY };
    let toSide: CanvasSide =
      inferSide(fromNode, to.x, to.y) === "left" ? "right" : "left";
    if (g.hoverNodeId) {
      const target = doc.nodes.find((n) => n.id === g.hoverNodeId);
      if (target) {
        toSide = inferSide(target, from.x, from.y);
        to = sidePoint(target, toSide);
      }
    }
    return { d: edgePath(from, g.fromSide, to, toSide), to };
  })();

  const drawingArrow = (() => {
    const g = gestureRef.current;
    if (!g || g.kind !== "arrow-tool") return null;
    return {
      d: `M ${g.startWorldX} ${g.startWorldY} L ${g.curWorldX} ${g.curWorldY}`,
    };
  })();

  const drawingShape = (() => {
    const g = gestureRef.current;
    if (!g || g.kind !== "shape") return null;
    return {
      shape: g.shape,
      x: Math.min(g.startWorldX, g.curWorldX),
      y: Math.min(g.startWorldY, g.curWorldY),
      w: Math.abs(g.curWorldX - g.startWorldX),
      h: Math.abs(g.curWorldY - g.startWorldY),
    };
  })();

  const drawingPenPath = (() => {
    const g = gestureRef.current;
    if (!g || g.kind !== "pen") return null;
    return strokeToPath(g.points);
  })();

  const activeGuides: AlignGuide[] = (() => {
    const g = gestureRef.current;
    if (!g || g.kind !== "move-nodes") return [];
    return g.guides;
  })();

  // ----- world bounds for the SVG layer -------------------------------
  const worldBounds = useMemo(() => {
    let x0 = -2000;
    let y0 = -2000;
    let x1 = 2000;
    let y1 = 2000;
    for (const n of doc.nodes) {
      x0 = Math.min(x0, n.x - 500);
      y0 = Math.min(y0, n.y - 500);
      x1 = Math.max(x1, n.x + n.width + 500);
      y1 = Math.max(y1, n.y + n.height + 500);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }, [doc.nodes]);

  // ----- render -------------------------------------------------------
  const worldTransform = `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`;
  const cursorClass =
    gestureRef.current?.kind === "pan"
      ? " panning"
      : spaceDown || tool === "hand"
        ? " can-pan"
        : tool === "pen"
          ? " can-draw"
          : tool === "eraser"
            ? " can-erase"
            : tool === "text"
              ? " can-text"
              : tool === "rect" ||
                  tool === "ellipse" ||
                  tool === "diamond" ||
                  tool === "arrow"
                ? " can-shape"
                : "";

  return (
    <div
      ref={rootRef}
      className={`canvas-root${cursorClass}`}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={onDoubleClick}
    >
      {/* Dotted grid */}
      <div
        className="canvas-grid"
        style={{
          backgroundSize: `${GRID_PX * viewport.zoom}px ${GRID_PX * viewport.zoom}px`,
          backgroundPosition: `${viewport.x}px ${viewport.y}px`,
        }}
      />

      {/* World layer */}
      <div className="canvas-world" style={{ transform: worldTransform }}>
        {/* SVG layer holds edges, freehand strokes, in-flight previews,
            and alignment guides — everything that's better expressed as
            vector geometry than as positioned divs. */}
        <svg
          className="canvas-edges"
          viewBox={`${worldBounds.x} ${worldBounds.y} ${worldBounds.w} ${worldBounds.h}`}
          style={{
            left: worldBounds.x,
            top: worldBounds.y,
            width: worldBounds.w,
            height: worldBounds.h,
          }}
        >
          <defs>
            <marker
              id="canvas-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
            </marker>
          </defs>

          {/* Persisted edges */}
          {doc.edges.map((edge) => {
            const fromNode = doc.nodes.find((n) => n.id === edge.fromNode);
            const toNode = doc.nodes.find((n) => n.id === edge.toNode);
            if (!fromNode || !toNode) return null;
            const fromSide =
              edge.fromSide ??
              inferSide(
                fromNode,
                toNode.x + toNode.width / 2,
                toNode.y + toNode.height / 2,
              );
            const toSide =
              edge.toSide ??
              inferSide(
                toNode,
                fromNode.x + fromNode.width / 2,
                fromNode.y + fromNode.height / 2,
              );
            const from = sidePoint(fromNode, fromSide);
            const to = sidePoint(toNode, toSide);
            const d = edgePath(from, fromSide, to, toSide);
            const color =
              resolveCanvasColor(edge.color) ??
              "var(--canvas-edge, var(--text-muted))";
            const arrow = (edge.toEnd ?? "arrow") === "arrow";
            const sel = isSelected(edge.id);
            return (
              <g
                key={edge.id}
                className={`canvas-edge${sel ? " selected" : ""}`}
                onPointerDown={(ev) => {
                  // Only the select tool owns edge selection; with any
                  // other tool active (eraser, shape, pen, …) we let
                  // the canvas root handle the gesture so e.g. the
                  // eraser still bites through the edge.
                  if (tool !== "select") return;
                  ev.stopPropagation();
                  if (ev.shiftKey) {
                    setSelection((prev) => {
                      const next = new Set(prev);
                      if (next.has(edge.id)) next.delete(edge.id);
                      else next.add(edge.id);
                      return next;
                    });
                  } else {
                    setSelection(new Set([edge.id]));
                  }
                  setEditingId(null);
                }}
              >
                <path d={d} className="canvas-edge-hit" />
                <path
                  d={d}
                  className="canvas-edge-line"
                  style={{ color }}
                  markerEnd={arrow ? "url(#canvas-arrow)" : undefined}
                />
                {edge.label && (
                  <text
                    x={(from.x + to.x) / 2}
                    y={(from.y + to.y) / 2}
                    className="canvas-edge-label"
                  >
                    {edge.label}
                  </text>
                )}
              </g>
            );
          })}

          {/* Freehand strokes */}
          {doc.nodes
            .filter((n): n is CanvasDrawNode => n.type === "draw")
            .map((n) => {
              const sel = isSelected(n.id);
              const color =
                resolveCanvasColor(n.stroke) ??
                n.stroke ??
                "var(--text-normal)";
              return (
                <path
                  key={n.id}
                  d={strokeToPath(n.points)}
                  className={`canvas-stroke${sel ? " selected" : ""}`}
                  style={{
                    stroke: color,
                    strokeWidth: n.strokeWidth ?? PEN_DEFAULT_STROKE_WIDTH,
                  }}
                />
              );
            })}

          {/* In-flight previews */}
          {drawingEdge && (
            <path
              d={drawingEdge.d}
              className="canvas-edge-line drawing"
              markerEnd="url(#canvas-arrow)"
            />
          )}
          {drawingArrow && (
            <path
              d={drawingArrow.d}
              className="canvas-edge-line drawing"
              markerEnd="url(#canvas-arrow)"
            />
          )}
          {drawingPenPath && (
            <path
              d={drawingPenPath}
              className="canvas-stroke drawing"
              style={{ strokeWidth: PEN_DEFAULT_STROKE_WIDTH }}
            />
          )}
          {drawingShape && (
            <ShapePreview
              shape={drawingShape.shape}
              x={drawingShape.x}
              y={drawingShape.y}
              w={drawingShape.w}
              h={drawingShape.h}
            />
          )}

          {/* Alignment guides — short dashed segment between the moving
              node and the reference it's snapping to (Figma-style),
              with a small world-unit pad on each end so the line
              visually exceeds both edges. */}
          {activeGuides.map((g, i) => {
            const pad = 12;
            const [a, b] = g.span;
            const lo = Math.min(a, b) - pad;
            const hi = Math.max(a, b) + pad;
            return g.axis === "x" ? (
              <line
                key={`gx-${i}`}
                x1={g.at}
                y1={lo}
                x2={g.at}
                y2={hi}
                className="canvas-guide"
              />
            ) : (
              <line
                key={`gy-${i}`}
                x1={lo}
                y1={g.at}
                x2={hi}
                y2={g.at}
                className="canvas-guide"
              />
            );
          })}
        </svg>

        {/* Nodes (text / shape / group / file / link). Draw nodes are
            rendered inside the SVG above so they get vector crispness
            independent of zoom. */}
        {doc.nodes
          .filter((n) => n.type !== "draw")
          .map((node) => (
            <NodeCard
              key={node.id}
              node={node}
              selected={isSelected(node.id)}
              editing={editingId === node.id}
              hovered={hoverNodeId === node.id}
              onMouseEnter={() => setHoverNodeId(node.id)}
              onMouseLeave={() =>
                setHoverNodeId((id) => (id === node.id ? null : id))
              }
              onDoubleClick={() => {
                if (
                  node.type === "text" ||
                  node.type === "shape" ||
                  node.type === "group"
                ) {
                  setEditingId(node.id);
                }
              }}
              onCommitText={(t) => setNodeText(node.id, t)}
              onCommitGroupLabel={(t) => {
                commit((prev) => ({
                  ...prev,
                  nodes: prev.nodes.map((n) =>
                    n.id === node.id && n.type === "group"
                      ? { ...n, label: t }
                      : n,
                  ),
                }));
              }}
              onEndEdit={() => setEditingId(null)}
            />
          ))}

        {marqueeRect && (
          <div
            className="canvas-marquee"
            style={{
              left: marqueeRect.x,
              top: marqueeRect.y,
              width: marqueeRect.w,
              height: marqueeRect.h,
            }}
          />
        )}
      </div>

      {/* ===================================================================
       *  Tool palette — Excalidraw-style. Pinned to screen space
       *  (outside .canvas-world) so it doesn't pan/zoom with the doc.
       *  The dock position (left/right/top/bottom/float) is driven by
       *  `toolbarPos` and is user-draggable via the grip handle.
       * =================================================================== */}
      {(() => {
        const dragging = toolbarDrag !== null;
        const horizontal =
          toolbarPos.dock === "top" || toolbarPos.dock === "bottom";
        const style: React.CSSProperties = dragging
          ? // While dragging, lock position to the live pointer coords.
            { left: toolbarDrag!.x, top: toolbarDrag!.y, transform: "none" }
          : toolbarPos.dock === "left"
            ? { left: 12, top: "50%", transform: "translateY(-50%)" }
            : toolbarPos.dock === "right"
              ? { right: 12, top: "50%", transform: "translateY(-50%)" }
              : toolbarPos.dock === "top"
                ? { top: 12, left: "50%", transform: "translateX(-50%)" }
                : toolbarPos.dock === "bottom"
                  ? {
                      bottom: 12,
                      left: "50%",
                      transform: "translateX(-50%)",
                    }
                  : {
                      left: toolbarPos.x ?? 12,
                      top: toolbarPos.y ?? 60,
                      transform: "none",
                    };
        return (
          <div
            className={`canvas-toolbar ${horizontal ? "horizontal" : "vertical"}${
              dragging ? " dragging" : ""
            }`}
            style={style}
          >
            <div className="canvas-toolbar-handle">
              <button
                type="button"
                className="canvas-toolbar-grip"
                title="Drag to move • Click ▾ to dock"
                onPointerDown={onToolbarGripPointerDown}
              >
                <IcGrip />
              </button>
              <button
                type="button"
                className="canvas-toolbar-dock-btn"
                title="Dock toolbar…"
                onClick={() => setToolbarMenuOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={toolbarMenuOpen}
              >
                ▾
              </button>
              {toolbarMenuOpen && (
                <div
                  className={`canvas-toolbar-dock-menu dock-${toolbarPos.dock}`}
                  role="menu"
                  onMouseLeave={() => setToolbarMenuOpen(false)}
                >
                  {(
                    [
                      ["left", "Dock left"],
                      ["right", "Dock right"],
                      ["top", "Dock top"],
                      ["bottom", "Dock bottom"],
                      ["float", "Float"],
                    ] as Array<[ToolbarDock, string]>
                  ).map(([dock, label]) => (
                    <button
                      key={dock}
                      type="button"
                      className={
                        toolbarPos.dock === dock ? "active" : undefined
                      }
                      onClick={() => {
                        setToolbarMenuOpen(false);
                        if (dock === "float") {
                          // When choosing Float from a docked state,
                          // park it near the top-left of the canvas.
                          setToolbarPos({ dock: "float", x: 24, y: 60 });
                        } else {
                          setToolbarPos({ dock });
                        }
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="canvas-toolbar-sep" />
            <ToolButton
              active={tool === "select"}
              title="Select (V)"
              onClick={() => setTool("select")}
            >
              <IcCursor />
            </ToolButton>
            <ToolButton
              active={tool === "hand"}
              title="Hand / pan (H)"
              onClick={() => setTool("hand")}
            >
              <IcHand />
            </ToolButton>
            <div className="canvas-toolbar-sep" />
            <ToolButton
              active={tool === "pen"}
              title="Pen (P)"
              onClick={() => setTool("pen")}
            >
              <IcPencil />
            </ToolButton>
            <ToolButton
              active={tool === "eraser"}
              title="Eraser (E)"
              onClick={() => setTool("eraser")}
            >
              <IcEraser />
            </ToolButton>
            <div className="canvas-toolbar-sep" />
            <ToolButton
              active={tool === "rect"}
              title="Rectangle (R)"
              onClick={() => setTool("rect")}
            >
              <IcSquare />
            </ToolButton>
            <ToolButton
              active={tool === "ellipse"}
              title="Ellipse (O)"
              onClick={() => setTool("ellipse")}
            >
              <IcCircle />
            </ToolButton>
            <ToolButton
              active={tool === "diamond"}
              title="Diamond (D)"
              onClick={() => setTool("diamond")}
            >
              <IcDiamond />
            </ToolButton>
            <ToolButton
              active={tool === "arrow"}
              title="Arrow (A)"
              onClick={() => setTool("arrow")}
            >
              <IcArrowTool />
            </ToolButton>
            <ToolButton
              active={tool === "text"}
              title="Text (T)"
              onClick={() => setTool("text")}
            >
              <IcTextTool />
            </ToolButton>
            <div className="canvas-toolbar-sep" />
            <ToolButton
              active={false}
              title="Group selection (G)"
              disabled={selection.size === 0}
              onClick={groupSelection}
            >
              <IcGroup />
            </ToolButton>
          </div>
        );
      })()}

      {/* HUD: zoom + export (top-right) */}
      <div className="canvas-hud right">
        <button
          className="canvas-hud-btn"
          title="Zoom in (Ctrl+Wheel)"
          onClick={() => zoomBy(1.2)}
        >
          <IcPlus />
        </button>
        <button
          className="canvas-hud-btn"
          title="Zoom out (Ctrl+Wheel)"
          onClick={() => zoomBy(1 / 1.2)}
        >
          <IcMinus />
        </button>
        <button
          className="canvas-hud-btn"
          title="Zoom to fit (Shift+1)"
          onClick={fitToContent}
        >
          <IcExpand />
        </button>
        <button
          className="canvas-hud-btn"
          title="Reset zoom (0)"
          onClick={() => setViewport((vp) => ({ ...vp, zoom: 1 }))}
        >
          <IcSwap />
        </button>
        <div className="canvas-hud-sep" />
        <div className="canvas-export-wrap">
          <button
            className="canvas-hud-btn"
            title="Export…"
            onClick={() => setExportOpen((v) => !v)}
          >
            <IcExport />
          </button>
          {exportOpen && (
            <div
              className="canvas-export-menu"
              onMouseLeave={() => setExportOpen(false)}
            >
              <button
                onClick={() => {
                  setExportOpen(false);
                  exportPng();
                }}
              >
                Export as PNG
              </button>
              <button
                onClick={() => {
                  setExportOpen(false);
                  exportSvg();
                }}
              >
                Export as SVG
              </button>
              <button
                onClick={() => {
                  setExportOpen(false);
                  exportJson();
                }}
              >
                Export as JSON
              </button>
            </div>
          )}
        </div>
      </div>

      {/* HUD: card / delete (bottom-center) */}
      <div className="canvas-hud bottom">
        <button
          className="canvas-hud-btn"
          title="Add text card (double-click canvas)"
          onClick={() => {
            const r = rootRef.current?.getBoundingClientRect();
            if (!r) return;
            const w = screenToWorld(r.left + r.width / 2, r.top + r.height / 2);
            addTextNodeAt(w.x, w.y);
          }}
        >
          <IcStickyNote />
        </button>
        <button
          className="canvas-hud-btn"
          title="Delete selection (Del)"
          disabled={selection.size === 0}
          onClick={deleteSelection}
        >
          <IcTrash />
        </button>
      </div>

      {/* Standalone zoom chip (bottom-left) — click to reset to 100%. */}
      <button
        className="canvas-zoom-chip"
        title="Current zoom · click to reset"
        onClick={() => setViewport((vp) => ({ ...vp, zoom: 1 }))}
      >
        {Math.round(viewport.zoom * 100)}%
      </button>
    </div>
  );
}

// =====================================================================
// ToolButton — small wrapper for the left palette so styling stays
// consistent and the active/disabled visuals are centralized.
// =====================================================================
function ToolButton({
  active,
  disabled,
  title,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`canvas-tool-btn${active ? " active" : ""}`}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

// =====================================================================
// ShapePreview — in-flight rectangle/ellipse/diamond outline rendered
// inside the same SVG layer used for edges so it picks up the world
// transform automatically.
// =====================================================================
function ShapePreview({
  shape,
  x,
  y,
  w,
  h,
}: {
  shape: CanvasShapeKind;
  x: number;
  y: number;
  w: number;
  h: number;
}) {
  if (shape === "ellipse") {
    return (
      <ellipse
        cx={x + w / 2}
        cy={y + h / 2}
        rx={w / 2}
        ry={h / 2}
        className="canvas-shape-preview"
      />
    );
  }
  if (shape === "diamond") {
    const cx = x + w / 2;
    const cy = y + h / 2;
    return (
      <polygon
        points={`${cx},${y} ${x + w},${cy} ${cx},${y + h} ${x},${cy}`}
        className="canvas-shape-preview"
      />
    );
  }
  return (
    <rect
      x={x}
      y={y}
      width={w}
      height={h}
      className="canvas-shape-preview"
    />
  );
}

// =====================================================================
// NodeCard — text / shape / group / file / link. (Draw nodes render
// directly inside the SVG layer.)
// =====================================================================
function NodeCard({
  node,
  selected,
  editing,
  hovered,
  onMouseEnter,
  onMouseLeave,
  onDoubleClick,
  onCommitText,
  onCommitGroupLabel,
  onEndEdit,
}: {
  node: CanvasNode;
  selected: boolean;
  editing: boolean;
  hovered: boolean;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onDoubleClick: () => void;
  onCommitText: (text: string) => void;
  onCommitGroupLabel: (label: string) => void;
  onEndEdit: () => void;
}) {
  const color = resolveCanvasColor(node.color);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!editing) return;
    if (node.type === "group" && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    } else if (taRef.current) {
      taRef.current.focus();
      taRef.current.setSelectionRange(
        taRef.current.value.length,
        taRef.current.value.length,
      );
    }
  }, [editing, node.type]);

  const sides: CanvasSide[] = ["top", "right", "bottom", "left"];
  const handles: ResizeHandle[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];
  const showConnectors =
    (hovered || selected) && !editing && node.type !== "group";

  // Wrapper class encodes the node type so CSS can apply shape-specific
  // visuals (rounded vs. ellipse mask vs. group's translucent fill).
  const typeClass = `canvas-node-${node.type}`;
  const shapeClass =
    node.type === "shape"
      ? ` shape-${(node as CanvasShapeNode).shape}`
      : "";

  return (
    <div
      className={`canvas-node ${typeClass}${shapeClass}${selected ? " selected" : ""}${editing ? " editing" : ""}`}
      data-node-id={node.id}
      style={{
        left: node.x,
        top: node.y,
        width: node.width,
        height: node.height,
        ...(color
          ? ({ ["--node-accent"]: color } as React.CSSProperties)
          : null),
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onDoubleClick();
      }}
    >
      {/* ---- Body, per node type ---- */}
      {node.type === "text" ? (
        editing ? (
          <textarea
            ref={taRef}
            className="canvas-node-textarea"
            defaultValue={(node as CanvasTextNode).text}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => onCommitText(e.currentTarget.value)}
            onBlur={onEndEdit}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onEndEdit();
              }
            }}
          />
        ) : (
          <div className="canvas-node-text">
            {(node as CanvasTextNode).text || (
              <span className="canvas-node-placeholder">Empty card</span>
            )}
          </div>
        )
      ) : node.type === "shape" ? (
        <ShapeBody
          shape={(node as CanvasShapeNode).shape}
          width={node.width}
          height={node.height}
          stroke={(node as CanvasShapeNode).stroke}
          fill={(node as CanvasShapeNode).fill}
          strokeWidth={(node as CanvasShapeNode).strokeWidth}
        >
          {editing ? (
            <textarea
              ref={taRef}
              className="canvas-node-textarea center"
              defaultValue={(node as CanvasShapeNode).text ?? ""}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => onCommitText(e.currentTarget.value)}
              onBlur={onEndEdit}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  onEndEdit();
                }
              }}
            />
          ) : (node as CanvasShapeNode).text ? (
            <div className="canvas-shape-text">
              {(node as CanvasShapeNode).text}
            </div>
          ) : null}
        </ShapeBody>
      ) : node.type === "group" ? (
        <>
          {editing ? (
            <input
              ref={inputRef}
              className="canvas-group-label-input"
              defaultValue={(node as CanvasGroupNode).label ?? ""}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => onCommitGroupLabel(e.currentTarget.value)}
              onBlur={onEndEdit}
              onKeyDown={(e) => {
                if (e.key === "Escape" || e.key === "Enter") {
                  e.preventDefault();
                  onEndEdit();
                }
              }}
            />
          ) : (
            <div className="canvas-group-label">
              {(node as CanvasGroupNode).label || "Group"}
            </div>
          )}
        </>
      ) : (
        // file / link fallback (preserved on round-trip, rendered as a
        // labelled stub until v3 ships a proper renderer for each).
        <div className="canvas-node-stub">
          <span className="canvas-node-stub-type">{node.type}</span>
          <span className="canvas-node-stub-hint">
            {node.type === "file"
              ? (node as { file?: string }).file ?? "file"
              : (node as { url?: string }).url ?? "link"}
          </span>
        </div>
      )}

      {/* Side connector dots */}
      {showConnectors &&
        sides.map((s) => (
          <span
            key={s}
            className={`canvas-connector ${s}`}
            data-connector={s}
            title="Drag to connect"
          />
        ))}

      {/* Resize handles */}
      {selected && !editing &&
        handles.map((h) => (
          <span
            key={h}
            className={`canvas-resize ${h}`}
            data-resize={h}
            style={handleOffset(h, HANDLE_HIT)}
          />
        ))}
    </div>
  );
}

function handleOffset(
  _h: ResizeHandle,
  _hit: number,
): React.CSSProperties {
  return {};
}

// =====================================================================
// ShapeBody — renders the filled geometric primitive for a shape node.
// SVG sits behind the optional center text so text stays selectable
// and the stroke renders crisply at any zoom.
// =====================================================================
function ShapeBody({
  shape,
  width,
  height,
  stroke,
  fill,
  strokeWidth,
  children,
}: {
  shape: CanvasShapeKind;
  width: number;
  height: number;
  stroke?: string;
  fill?: string;
  strokeWidth?: number;
  children?: React.ReactNode;
}) {
  const sw = strokeWidth ?? SHAPE_DEFAULT_STROKE_WIDTH;
  const strokeColor =
    resolveCanvasColor(stroke) ?? stroke ?? "var(--text-normal)";
  const fillColor =
    resolveCanvasColor(fill) ?? fill ?? "transparent";
  // Inset by half stroke width so the outline doesn't get clipped at
  // the node bbox edges.
  const inset = sw / 2;
  return (
    <div className="canvas-shape-wrap">
      <svg
        className="canvas-shape-svg"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
      >
        {shape === "ellipse" ? (
          <ellipse
            cx={width / 2}
            cy={height / 2}
            rx={Math.max(1, width / 2 - inset)}
            ry={Math.max(1, height / 2 - inset)}
            fill={fillColor}
            stroke={strokeColor}
            strokeWidth={sw}
          />
        ) : shape === "diamond" ? (
          <polygon
            points={`${width / 2},${inset} ${width - inset},${height / 2} ${width / 2},${height - inset} ${inset},${height / 2}`}
            fill={fillColor}
            stroke={strokeColor}
            strokeWidth={sw}
          />
        ) : (
          <rect
            x={inset}
            y={inset}
            width={Math.max(1, width - sw)}
            height={Math.max(1, height - sw)}
            rx={4}
            ry={4}
            fill={fillColor}
            stroke={strokeColor}
            strokeWidth={sw}
          />
        )}
      </svg>
      {children}
    </div>
  );
}

// =====================================================================
// Export helpers
// =====================================================================

/** Trigger a browser download of a blob via a hidden <a> + objectURL. */
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Defer revoke so Firefox / Safari finish the download.
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/**
 * Render the current doc as a standalone SVG string. We DON'T use the
 * live React-rendered SVG because it lives inside the world transform
 * (which would bake the user's pan/zoom into the export). Instead we
 * re-emit clean geometry at world origin with an exact bbox viewBox.
 */
function renderDocAsSvg(doc: CanvasDoc): string {
  const b = nodesBounds(doc.nodes) ?? { x: 0, y: 0, width: 400, height: 400 };
  const PAD = 40;
  const vbX = b.x - PAD;
  const vbY = b.y - PAD;
  const vbW = b.width + PAD * 2;
  const vbH = b.height + PAD * 2;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vbX} ${vbY} ${vbW} ${vbH}" width="${vbW}" height="${vbH}">`,
  );
  // Dark background so the export looks the same regardless of where
  // the user opens it (image viewers usually default to a checker).
  parts.push(
    `<rect x="${vbX}" y="${vbY}" width="${vbW}" height="${vbH}" fill="#1f2024"/>`,
  );
  parts.push(
    `<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#a0a4ac"/></marker></defs>`,
  );

  // Groups first (behind everything).
  for (const n of doc.nodes) {
    if (n.type === "group") {
      parts.push(
        `<rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" fill="rgba(140,140,160,0.08)" stroke="#8a8e98" stroke-dasharray="6 4" rx="8" ry="8"/>`,
      );
      if (n.label) {
        parts.push(
          `<text x="${n.x + 12}" y="${n.y + 20}" font-family="sans-serif" font-size="13" fill="#cbcbd0">${escapeXml(n.label)}</text>`,
        );
      }
    }
  }

  // Edges next.
  for (const e of doc.edges) {
    const fromNode = doc.nodes.find((n) => n.id === e.fromNode);
    const toNode = doc.nodes.find((n) => n.id === e.toNode);
    if (!fromNode || !toNode) continue;
    const fromSide =
      e.fromSide ??
      inferSide(
        fromNode,
        toNode.x + toNode.width / 2,
        toNode.y + toNode.height / 2,
      );
    const toSide =
      e.toSide ??
      inferSide(
        toNode,
        fromNode.x + fromNode.width / 2,
        fromNode.y + fromNode.height / 2,
      );
    const from = sidePoint(fromNode, fromSide);
    const to = sidePoint(toNode, toSide);
    const d = edgePath(from, fromSide, to, toSide);
    const arrow = (e.toEnd ?? "arrow") === "arrow";
    parts.push(
      `<path d="${d}" fill="none" stroke="#a0a4ac" stroke-width="2" ${arrow ? 'marker-end="url(#arr)"' : ""}/>`,
    );
  }

  // Nodes (skip groups — already drawn behind).
  for (const n of doc.nodes) {
    if (n.type === "group") continue;
    if (n.type === "text") {
      parts.push(
        `<rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" fill="#2a2c33" stroke="#3a3d45" rx="8" ry="8"/>`,
      );
      const lines = ((n as CanvasTextNode).text ?? "").split("\n");
      lines.forEach((line, i) => {
        parts.push(
          `<text x="${n.x + 12}" y="${n.y + 22 + i * 16}" font-family="sans-serif" font-size="13" fill="#e6e6ea">${escapeXml(
            line,
          )}</text>`,
        );
      });
    } else if (n.type === "shape") {
      const sn = n as CanvasShapeNode;
      const fill = resolveCanvasColor(sn.fill) ?? sn.fill ?? "transparent";
      const stroke =
        resolveCanvasColor(sn.stroke) ?? sn.stroke ?? "#e6e6ea";
      const sw = sn.strokeWidth ?? SHAPE_DEFAULT_STROKE_WIDTH;
      const inset = sw / 2;
      if (sn.shape === "ellipse") {
        parts.push(
          `<ellipse cx="${n.x + n.width / 2}" cy="${n.y + n.height / 2}" rx="${Math.max(1, n.width / 2 - inset)}" ry="${Math.max(1, n.height / 2 - inset)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`,
        );
      } else if (sn.shape === "diamond") {
        const cx = n.x + n.width / 2;
        const cy = n.y + n.height / 2;
        parts.push(
          `<polygon points="${cx},${n.y + inset} ${n.x + n.width - inset},${cy} ${cx},${n.y + n.height - inset} ${n.x + inset},${cy}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`,
        );
      } else {
        parts.push(
          `<rect x="${n.x + inset}" y="${n.y + inset}" width="${Math.max(1, n.width - sw)}" height="${Math.max(1, n.height - sw)}" rx="4" ry="4" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`,
        );
      }
      if (sn.text) {
        parts.push(
          `<text x="${n.x + n.width / 2}" y="${n.y + n.height / 2 + 4}" font-family="sans-serif" font-size="13" fill="#e6e6ea" text-anchor="middle">${escapeXml(sn.text)}</text>`,
        );
      }
    } else if (n.type === "draw") {
      const dn = n as CanvasDrawNode;
      const stroke =
        resolveCanvasColor(dn.stroke) ?? dn.stroke ?? "#e6e6ea";
      parts.push(
        `<path d="${strokeToPath(dn.points)}" fill="none" stroke="${stroke}" stroke-width="${dn.strokeWidth ?? 2}" stroke-linecap="round" stroke-linejoin="round"/>`,
      );
    } else {
      // file / link — render as a labelled card
      const label =
        n.type === "file"
          ? (n as { file?: string }).file ?? "file"
          : (n as { url?: string }).url ?? "link";
      parts.push(
        `<rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" fill="#2a2c33" stroke="#3a3d45" rx="8" ry="8"/>`,
      );
      parts.push(
        `<text x="${n.x + 12}" y="${n.y + 22}" font-family="sans-serif" font-size="13" fill="#cbcbd0">${escapeXml(label)}</text>`,
      );
    }
  }

  parts.push(`</svg>`);
  return parts.join("");
}

/** Minimal XML escaping for text content embedded inside <text>. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Rasterize an SVG string to a PNG blob via an offscreen <canvas>. */
async function svgToPngBlob(svg: string, scale = 1): Promise<Blob> {
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = (e) => reject(e);
      i.src = url;
    });
    // Parse the SVG's viewBox to figure out export dimensions.
    const m = svg.match(/viewBox="([\d.\-\s]+)"/);
    let w = img.naturalWidth || 1024;
    let h = img.naturalHeight || 768;
    if (m) {
      const parts = m[1].split(/\s+/).map(parseFloat);
      if (parts.length === 4) {
        w = parts[2];
        h = parts[3];
      }
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D context unavailable");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))),
        "image/png",
      );
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
