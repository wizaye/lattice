/**
 * Canvas multi-select and group operations
 * 
 * Provides:
 * - Multi-node selection
 * - Group transform (move, resize, rotate)
 * - Group styling
 * - Selection rectangle
 */

import type { CanvasNode } from '../state/canvas';

export interface SelectionBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SelectionState {
  selectedIds: Set<string>;
  bounds: SelectionBounds | null;
  isDragging: boolean;
  dragStart: { x: number; y: number } | null;
}

/**
 * Calculate bounding box for multiple nodes
 */
export function calculateSelectionBounds(
  nodes: CanvasNode[]
): SelectionBounds | null {
  if (nodes.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const node of nodes) {
    const width = node.width || 200;
    const height = node.height || 100;

    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + width);
    maxY = Math.max(maxY, node.y + height);
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

/**
 * Move all selected nodes by delta
 */
export function moveSelection(
  nodes: CanvasNode[],
  dx: number,
  dy: number
): CanvasNode[] {
  return nodes.map((node) => ({
    ...node,
    x: node.x + dx,
    y: node.y + dy,
  }));
}

/**
 * Scale selection from center point
 */
export function scaleSelection(
  nodes: CanvasNode[],
  scale: number,
  center: { x: number; y: number }
): CanvasNode[] {
  return nodes.map((node) => {
    const width = node.width || 200;
    const height = node.height || 100;
    const nodeCenter = {
      x: node.x + width / 2,
      y: node.y + height / 2,
    };

    // Scale position relative to group center
    const dx = nodeCenter.x - center.x;
    const dy = nodeCenter.y - center.y;
    const newCenter = {
      x: center.x + dx * scale,
      y: center.y + dy * scale,
    };

    // Scale size
    const newWidth = width * scale;
    const newHeight = height * scale;

    return {
      ...node,
      x: newCenter.x - newWidth / 2,
      y: newCenter.y - newHeight / 2,
      width: newWidth,
      height: newHeight,
    };
  });
}

/**
 * Check if point is inside selection bounds
 */
export function isPointInBounds(
  point: { x: number; y: number },
  bounds: SelectionBounds
): boolean {
  return (
    point.x >= bounds.x &&
    point.x <= bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y <= bounds.y + bounds.height
  );
}

/**
 * Get nodes within selection rectangle
 */
export function getNodesInRect(
  nodes: CanvasNode[],
  rect: SelectionBounds
): CanvasNode[] {
  return nodes.filter((node) => {
    const width = node.width || 200;
    const height = node.height || 100;

    // Check if node intersects with selection rect
    return !(
      node.x + width < rect.x ||
      node.x > rect.x + rect.width ||
      node.y + height < rect.y ||
      node.y > rect.y + rect.height
    );
  });
}

/**
 * Create a group node from selected nodes
 */
export function createGroupFromSelection(
  nodes: CanvasNode[],
  groupId: string
): CanvasNode | null {
  const bounds = calculateSelectionBounds(nodes);
  if (!bounds) return null;

  // Add some padding
  const padding = 20;

  return {
    id: groupId,
    type: 'group',
    x: bounds.x - padding,
    y: bounds.y - padding,
    width: bounds.width + padding * 2,
    height: bounds.height + padding * 2,
    color: '#e0e0e0',
  };
}

/**
 * Align selected nodes
 */
export type AlignmentType = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';

export function alignSelection(
  nodes: CanvasNode[],
  alignment: AlignmentType
): CanvasNode[] {
  const bounds = calculateSelectionBounds(nodes);
  if (!bounds) return nodes;

  return nodes.map((node) => {
    const width = node.width || 200;
    const height = node.height || 100;
    let newX = node.x;
    let newY = node.y;

    switch (alignment) {
      case 'left':
        newX = bounds.x;
        break;
      case 'center':
        newX = bounds.x + bounds.width / 2 - width / 2;
        break;
      case 'right':
        newX = bounds.x + bounds.width - width;
        break;
      case 'top':
        newY = bounds.y;
        break;
      case 'middle':
        newY = bounds.y + bounds.height / 2 - height / 2;
        break;
      case 'bottom':
        newY = bounds.y + bounds.height - height;
        break;
    }

    return { ...node, x: newX, y: newY };
  });
}

/**
 * Distribute selected nodes evenly
 */
export function distributeSelection(
  nodes: CanvasNode[],
  direction: 'horizontal' | 'vertical'
): CanvasNode[] {
  if (nodes.length < 3) return nodes; // Need at least 3 nodes

  const sorted = [...nodes].sort((a, b) =>
    direction === 'horizontal' ? a.x - b.x : a.y - b.y
  );

  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  const firstPos = direction === 'horizontal' ? first.x : first.y;
  const lastPos =
    direction === 'horizontal'
      ? last.x + (last.width || 200)
      : last.y + (last.height || 100);

  const totalGap = lastPos - firstPos;
  const gapSize = totalGap / (nodes.length - 1);

  return sorted.map((node, i) => {
    if (i === 0 || i === sorted.length - 1) return node;

    if (direction === 'horizontal') {
      return { ...node, x: firstPos + gapSize * i };
    } else {
      return { ...node, y: firstPos + gapSize * i };
    }
  });
}
