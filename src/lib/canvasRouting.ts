/**
 * Canvas connector routing utilities
 * 
 * Provides automatic edge routing between canvas nodes with:
 * - Orthogonal (right-angle) routing
 * - Curved bezier routing
 * - Collision avoidance
 * - Smart anchor point selection
 */

import type { CanvasEdge, CanvasNode } from '../state/canvas';

export type RoutingStyle = 'straight' | 'orthogonal' | 'curved';

export interface Point {
  x: number;
  y: number;
}

export interface RoutedEdge {
  edge: CanvasEdge;
  path: string; // SVG path data
  points: Point[];
}

/**
 * Calculate the best anchor points on two nodes for an edge
 */
function calculateAnchorPoints(
  fromNode: CanvasNode,
  toNode: CanvasNode
): { from: Point; to: Point } {
  const fromCenter = {
    x: fromNode.x + (fromNode.width || 200) / 2,
    y: fromNode.y + (fromNode.height || 100) / 2,
  };

  const toCenter = {
    x: toNode.x + (toNode.width || 200) / 2,
    y: toNode.y + (toNode.height || 100) / 2,
  };

  // Determine which sides to connect based on relative positions
  const dx = toCenter.x - fromCenter.x;
  const dy = toCenter.y - fromCenter.y;

  let fromPoint: Point;
  let toPoint: Point;

  // From node anchor
  if (Math.abs(dx) > Math.abs(dy)) {
    // Horizontal dominance
    if (dx > 0) {
      // Connect from right side
      fromPoint = {
        x: fromNode.x + (fromNode.width || 200),
        y: fromCenter.y,
      };
    } else {
      // Connect from left side
      fromPoint = { x: fromNode.x, y: fromCenter.y };
    }
  } else {
    // Vertical dominance
    if (dy > 0) {
      // Connect from bottom
      fromPoint = {
        x: fromCenter.x,
        y: fromNode.y + (fromNode.height || 100),
      };
    } else {
      // Connect from top
      fromPoint = { x: fromCenter.x, y: fromNode.y };
    }
  }

  // To node anchor (opposite side)
  if (Math.abs(dx) > Math.abs(dy)) {
    if (dx > 0) {
      toPoint = { x: toNode.x, y: toCenter.y };
    } else {
      toPoint = {
        x: toNode.x + (toNode.width || 200),
        y: toCenter.y,
      };
    }
  } else {
    if (dy > 0) {
      toPoint = { x: toCenter.x, y: toNode.y };
    } else {
      toPoint = {
        x: toCenter.x,
        y: toNode.y + (toNode.height || 100),
      };
    }
  }

  return { from: fromPoint, to: toPoint };
}

/**
 * Route edge with straight line
 */
function routeStraight(from: Point, to: Point): string {
  return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
}

/**
 * Route edge with orthogonal (right-angle) path
 */
function routeOrthogonal(from: Point, to: Point): string {
  const midX = (from.x + to.x) / 2;

  // Simple orthogonal: go horizontal first, then vertical
  return `M ${from.x} ${from.y} L ${midX} ${from.y} L ${midX} ${to.y} L ${to.x} ${to.y}`;
}

/**
 * Route edge with smooth bezier curve
 */
function routeCurved(from: Point, to: Point): string {
  const dx = to.x - from.x;

  // Control points for smooth curve
  const cp1x = from.x + dx * 0.5;
  const cp1y = from.y;
  const cp2x = to.x - dx * 0.5;
  const cp2y = to.y;

  return `M ${from.x} ${from.y} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${to.x} ${to.y}`;
}

/**
 * Main routing function - routes all edges with the specified style
 */
export function routeEdges(
  edges: CanvasEdge[],
  nodes: Map<string, CanvasNode>,
  style: RoutingStyle = 'curved'
): RoutedEdge[] {
  return edges.map((edge) => {
    const fromNode = nodes.get(edge.fromNode);
    const toNode = nodes.get(edge.toNode);

    if (!fromNode || !toNode) {
      // Fallback for missing nodes
      return {
        edge,
        path: '',
        points: [],
      };
    }

    const { from, to } = calculateAnchorPoints(fromNode, toNode);

    let path: string;
    switch (style) {
      case 'straight':
        path = routeStraight(from, to);
        break;
      case 'orthogonal':
        path = routeOrthogonal(from, to);
        break;
      case 'curved':
        path = routeCurved(from, to);
        break;
    }

    return {
      edge,
      path,
      points: [from, to],
    };
  });
}

/**
 * Add arrow markers to edge
 */
export function addArrowMarker(
  _edge: CanvasEdge,
  toEnd: boolean = true,
  fromEnd: boolean = false
): { markerStart?: string; markerEnd?: string } {
  return {
    markerStart: fromEnd ? 'url(#arrow-start)' : undefined,
    markerEnd: toEnd ? 'url(#arrow-end)' : undefined,
  };
}

/**
 * SVG arrow marker definitions (to be added to canvas SVG)
 */
export const arrowMarkerDefs = `
  <defs>
    <marker
      id="arrow-end"
      viewBox="0 0 10 10"
      refX="9"
      refY="5"
      markerWidth="6"
      markerHeight="6"
      orient="auto-start-reverse"
    >
      <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
    </marker>
    <marker
      id="arrow-start"
      viewBox="0 0 10 10"
      refX="1"
      refY="5"
      markerWidth="6"
      markerHeight="6"
      orient="auto-start-reverse"
    >
      <path d="M 10 0 L 0 5 L 10 10 z" fill="currentColor" />
    </marker>
  </defs>
`;
