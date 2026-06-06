import type { SplitTree, Tab } from "./types";

let _id = 0;
export const uid = (prefix = "n") => `${prefix}-${++_id}-${Date.now().toString(36)}`;

/** Find a leaf by id. */
export function findLeaf(tree: SplitTree, id: string): Extract<SplitTree, { kind: "leaf" }> | null {
  if (tree.kind === "leaf") return tree.id === id ? tree : null;
  return findLeaf(tree.a, id) ?? findLeaf(tree.b, id);
}

/** All leaves, in order. */
export function leaves(tree: SplitTree): Extract<SplitTree, { kind: "leaf" }>[] {
  if (tree.kind === "leaf") return [tree];
  return [...leaves(tree.a), ...leaves(tree.b)];
}

/**
 * Topmost-rightmost leaf — the pane that visually owns the top-right
 * corner of the editor area (where Windows window controls float and
 * where the right-sidebar toggle should appear).
 *
 *   horizontal split (a | b)  → rightmost is in `b`
 *   vertical split   (a / b)  → topmost is in `a`
 */
export function topRightLeaf(tree: SplitTree): Extract<SplitTree, { kind: "leaf" }> {
  if (tree.kind === "leaf") return tree;
  if (tree.direction === "horizontal") return topRightLeaf(tree.b);
  return topRightLeaf(tree.a);
}

/** Map every leaf through `fn`. Splits with a child that becomes empty collapse to the other child. */
export function mapLeaves(
  tree: SplitTree,
  fn: (leaf: Extract<SplitTree, { kind: "leaf" }>) => SplitTree | null,
): SplitTree | null {
  if (tree.kind === "leaf") return fn(tree);
  const a = mapLeaves(tree.a, fn);
  const b = mapLeaves(tree.b, fn);
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  return { ...tree, a, b };
}

/** Replace one specific leaf. If `replacement` is null, the leaf is removed. */
export function replaceLeaf(
  tree: SplitTree,
  id: string,
  replacement: SplitTree | null,
): SplitTree | null {
  return mapLeaves(tree, (leaf) => (leaf.id === id ? replacement : leaf));
}

/** Insert / activate a tab in the given leaf. If a tab for fileId already exists, focus it. */
export function openTabInLeaf(
  leaf: Extract<SplitTree, { kind: "leaf" }>,
  tab: Tab,
): Extract<SplitTree, { kind: "leaf" }> {
  if (tab.fileId) {
    const existing = leaf.tabs.find((t) => t.fileId === tab.fileId);
    if (existing) return { ...leaf, activeTabId: existing.id };
  }
  return { ...leaf, tabs: [...leaf.tabs, tab], activeTabId: tab.id };
}

/**
 * Insert a tab at a specific index (clamped to [0, tabs.length]).
 * Used when a drop lands BETWEEN two tabs in the tabbar.
 *
 * Same-fileId rule: if the file is already open in this leaf, don't
 * duplicate it — instead MOVE the existing tab to `index` (using the
 * same shift logic as moveTabWithinLeaf) and focus it. This matches
 * how Obsidian / VS Code behave when you drag an already-open file
 * from the explorer onto a different slot in the tab strip.
 */
export function insertTabAt(
  leaf: Extract<SplitTree, { kind: "leaf" }>,
  tab: Tab,
  index: number,
): Extract<SplitTree, { kind: "leaf" }> {
  if (tab.fileId) {
    const existing = leaf.tabs.find((t) => t.fileId === tab.fileId);
    if (existing) {
      const moved = moveTabWithinLeaf(leaf, existing.id, index);
      // Always focus the existing tab, even if the position didn't
      // change (moveTabWithinLeaf returns the same leaf reference in
      // that case, so we have to clone to update activeTabId).
      return moved.activeTabId === existing.id
        ? moved
        : { ...moved, activeTabId: existing.id };
    }
  }
  const i = Math.max(0, Math.min(leaf.tabs.length, index));
  const tabs = [...leaf.tabs.slice(0, i), tab, ...leaf.tabs.slice(i)];
  return { ...leaf, tabs, activeTabId: tab.id };
}

/**
 * Reorder an existing tab within the SAME leaf so it ends up at
 * `targetIndex` — the insertion slot computed from a drop's cursor
 * position (i.e. relative to the array BEFORE removing the dragged
 * tab). When `targetIndex > currentIndex`, removal shifts everything
 * after it left by one, so the effective destination is
 * `targetIndex - 1`. No-op (returns the original leaf reference)
 * when the move would land the tab back in its current slot.
 */
export function moveTabWithinLeaf(
  leaf: Extract<SplitTree, { kind: "leaf" }>,
  tabId: string,
  targetIndex: number,
): Extract<SplitTree, { kind: "leaf" }> {
  const curIdx = leaf.tabs.findIndex((t) => t.id === tabId);
  if (curIdx < 0) return leaf;
  const adjusted = targetIndex > curIdx ? targetIndex - 1 : targetIndex;
  const finalIdx = Math.max(0, Math.min(leaf.tabs.length - 1, adjusted));
  if (finalIdx === curIdx) return leaf;
  const tabs = [...leaf.tabs];
  const [moved] = tabs.splice(curIdx, 1);
  tabs.splice(finalIdx, 0, moved);
  return { ...leaf, tabs };
}

/** Remove a tab from a leaf. Returns null if the leaf becomes empty. */
export function removeTabFromLeaf(
  leaf: Extract<SplitTree, { kind: "leaf" }>,
  tabId: string,
): Extract<SplitTree, { kind: "leaf" }> | null {
  const idx = leaf.tabs.findIndex((t) => t.id === tabId);
  if (idx < 0) return leaf;
  const tabs = leaf.tabs.filter((t) => t.id !== tabId);
  if (tabs.length === 0) return null;
  const wasActive = leaf.activeTabId === tabId;
  const activeTabId = wasActive ? tabs[Math.max(0, idx - 1)].id : leaf.activeTabId;
  return { ...leaf, tabs, activeTabId };
}

/** Split a leaf along `direction`, putting `newLeaf` on the side determined by `placeAfter`. */
export function splitLeaf(
  tree: SplitTree,
  leafId: string,
  direction: "horizontal" | "vertical",
  newLeaf: Extract<SplitTree, { kind: "leaf" }>,
  placeAfter: boolean,
): SplitTree {
  const result = mapLeaves(tree, (leaf) => {
    if (leaf.id !== leafId) return leaf;
    const split: SplitTree = {
      kind: "split",
      id: uid("split"),
      direction,
      ratio: 0.5,
      a: placeAfter ? leaf : newLeaf,
      b: placeAfter ? newLeaf : leaf,
    };
    return split;
  });
  return result ?? tree;
}

/**
 * Update the ratio of a single split node identified by `splitId`.
 * Ratio is clamped to [0.05, 0.95] so a child never collapses to zero.
 * Returns the original tree when the id isn't found (no allocation).
 */
export function setSplitRatio(
  tree: SplitTree,
  splitId: string,
  ratio: number,
): SplitTree {
  if (tree.kind === "leaf") return tree;
  const clamped = Math.max(0.05, Math.min(0.95, ratio));
  if (tree.id === splitId) {
    return tree.ratio === clamped ? tree : { ...tree, ratio: clamped };
  }
  const a = setSplitRatio(tree.a, splitId, ratio);
  const b = setSplitRatio(tree.b, splitId, ratio);
  if (a === tree.a && b === tree.b) return tree;
  return { ...tree, a, b };
}
