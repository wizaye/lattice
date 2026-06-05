/**
 * JSON Canvas 1.0 — types + (de)serialization helpers.
 *
 * Spec: https://jsoncanvas.org/spec/1.0/
 *
 * Lattice persists canvas documents using the same on-disk format that
 * Obsidian uses, so `.canvas` files round-trip with Obsidian, Kinopio,
 * and any other JSON Canvas-aware editor without a transform step.
 *
 * NOTE on scope: v1 of the lattice canvas only RENDERS and EDITS text
 * nodes + edges. file/link/group nodes are kept in the type union (and
 * round-trip through save/load untouched) so that documents authored
 * elsewhere don't get silently corrupted when opened in lattice. A
 * later pass will wire interactive renderers for the other three node
 * types.
 */

/** Six preset colors (`"1"`..`"6"`) OR any hex color (`"#RRGGBB"`). */
export type CanvasColor = string;

export type CanvasNodeBase = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: CanvasColor;
};

export type CanvasTextNode = CanvasNodeBase & {
  type: "text";
  text: string;
};

export type CanvasFileNode = CanvasNodeBase & {
  type: "file";
  /** Vault-relative path to the referenced file. */
  file: string;
  /** Optional `#heading` or `#^block` anchor inside the file. */
  subpath?: string;
};

export type CanvasLinkNode = CanvasNodeBase & {
  type: "link";
  url: string;
};

export type CanvasGroupNode = CanvasNodeBase & {
  type: "group";
  label?: string;
  background?: string;
  backgroundStyle?: "cover" | "ratio" | "repeat";
  /** Lattice extension: explicit list of child node ids that belong to
   *  this group. Vanilla JSON Canvas leaves containment implicit
   *  (anything geometrically inside the group's bbox), but storing it
   *  explicitly survives reflow and lets us move a group + its members
   *  together without doing a per-frame hit-test. Round-trips through
   *  Obsidian because unknown properties are preserved by JSON.parse/
   *  stringify. */
  children?: string[];
};

/** Lattice extension: freehand pen stroke. Stored as a flat number
 *  array so the on-disk JSON stays compact ([x0,y0,x1,y1,...] is half
 *  the byte count of [{x,y},...]). `points` are WORLD coordinates
 *  relative to the document origin (NOT relative to the node's x/y),
 *  matching how Excalidraw stores strokes. The node's x/y/width/height
 *  still mirror the bounding box so selection/marquee work uniformly. */
export type CanvasDrawNode = CanvasNodeBase & {
  type: "draw";
  points: number[];
  stroke?: string;
  strokeWidth?: number;
};

/** Lattice extension: simple geometric primitives. */
export type CanvasShapeKind = "rect" | "ellipse" | "diamond";
export type CanvasShapeNode = CanvasNodeBase & {
  type: "shape";
  shape: CanvasShapeKind;
  stroke?: string;
  strokeWidth?: number;
  fill?: string;
  /** Optional center label so a shape can also be a labelled box. */
  text?: string;
};

export type CanvasNode =
  | CanvasTextNode
  | CanvasFileNode
  | CanvasLinkNode
  | CanvasGroupNode
  | CanvasDrawNode
  | CanvasShapeNode;

export type CanvasSide = "top" | "right" | "bottom" | "left";
export type CanvasEndShape = "none" | "arrow";

export type CanvasEdge = {
  id: string;
  fromNode: string;
  /** Spec default is `"none"`. We always read explicitly; never assume. */
  fromSide?: CanvasSide;
  fromEnd?: CanvasEndShape;
  toNode: string;
  toSide?: CanvasSide;
  /** Spec default is `"arrow"`. */
  toEnd?: CanvasEndShape;
  color?: CanvasColor;
  label?: string;
};

export type CanvasDoc = {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
};

export function emptyCanvasDoc(): CanvasDoc {
  return { nodes: [], edges: [] };
}

/**
 * Parse a raw `.canvas` file body into a CanvasDoc. Returns an empty
 * doc when the input is empty, missing, or malformed — callers don't
 * need to defend against `null`/`undefined`/`""`. This is deliberately
 * lenient: a corrupt save shouldn't crash the editor, just present a
 * blank canvas that the user can re-populate.
 */
export function parseCanvas(raw: string | undefined | null): CanvasDoc {
  if (!raw || raw.trim() === "") return emptyCanvasDoc();
  try {
    const v = JSON.parse(raw);
    return {
      nodes: Array.isArray(v?.nodes) ? (v.nodes as CanvasNode[]) : [],
      edges: Array.isArray(v?.edges) ? (v.edges as CanvasEdge[]) : [],
    };
  } catch {
    return emptyCanvasDoc();
  }
}

/**
 * Serialize a CanvasDoc for on-disk storage. Pretty-printed with tabs
 * to match Obsidian's output (keeps git diffs sane when both editors
 * touch the same file).
 */
export function serializeCanvas(doc: CanvasDoc): string {
  return JSON.stringify(doc, null, "\t");
}

/**
 * Map an Obsidian preset color number (`"1"`..`"6"`) to a CSS color
 * string. Hex inputs pass through. Unknown inputs return `undefined`
 * so the caller can fall back to its theme default.
 *
 * Specific RGB values for the presets are intentionally unspecified
 * by the JSON Canvas spec ("applications can tailor the presets to
 * their specific brand colors") — lattice picks slightly desaturated
 * tones that read well on the dark theme background.
 */
export function resolveCanvasColor(c?: CanvasColor): string | undefined {
  if (!c) return undefined;
  if (c.startsWith("#")) return c;
  switch (c) {
    case "1":
      return "var(--canvas-red, #e36464)";
    case "2":
      return "var(--canvas-orange, #d99846)";
    case "3":
      return "var(--canvas-yellow, #d4c25e)";
    case "4":
      return "var(--canvas-green, #6ec46e)";
    case "5":
      return "var(--canvas-cyan, #5db1c8)";
    case "6":
      return "var(--canvas-purple, #a37bd0)";
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------
// Stroke geometry helpers (used by draw nodes)
// ---------------------------------------------------------------------

/** Convert a flat [x0,y0,x1,y1,...] point list to an SVG path. Uses
 *  quadratic Bezier midpoint smoothing so freehand pen strokes feel
 *  inkier than a polyline without paying for full Catmull-Rom. */
export function strokeToPath(points: number[]): string {
  if (points.length < 4) {
    if (points.length === 2) {
      // Single point — draw a tiny dot via two coincident commands so
      // stroke-linecap:round renders a filled circle.
      const x = points[0];
      const y = points[1];
      return `M ${x} ${y} L ${x} ${y}`;
    }
    return "";
  }
  let d = `M ${points[0]} ${points[1]}`;
  for (let i = 2; i < points.length - 2; i += 2) {
    const mx = (points[i] + points[i + 2]) / 2;
    const my = (points[i + 1] + points[i + 3]) / 2;
    d += ` Q ${points[i]} ${points[i + 1]} ${mx} ${my}`;
  }
  // Final segment — straight line to the last sampled point so the
  // stroke ends exactly where the user released the pointer.
  d += ` L ${points[points.length - 2]} ${points[points.length - 1]}`;
  return d;
}

/** Compute the axis-aligned bounding box of a flat point list, padded
 *  by `pad` on each side. Used to size a draw node after the stroke is
 *  committed so marquee/selection rectangles wrap the visible ink. */
export function pointsBounds(
  points: number[],
  pad = 0,
): { x: number; y: number; width: number; height: number } {
  if (points.length < 2) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < points.length; i += 2) {
    const x = points[i];
    const y = points[i + 1];
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return {
    x: x0 - pad,
    y: y0 - pad,
    width: x1 - x0 + pad * 2,
    height: y1 - y0 + pad * 2,
  };
}
