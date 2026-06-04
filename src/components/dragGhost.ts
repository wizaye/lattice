/**
 * Custom HTML5 drag-image helper.
 *
 * The default DataTransfer drag image is the source element itself
 * (faded), which for a small icon-ful row looks like a washed-out
 * copy of the row sitting awkwardly on top of the cursor. Obsidian
 * instead shows a small floating pill BELOW + RIGHT of the cursor.
 *
 * Strategy:
 *  1. Build an off-screen wrapper containing a styled chip.
 *  2. The wrapper has top/left padding equal to the desired cursor
 *     gap (the cursor anchor is at element 0,0 — see setDragImage
 *     contract — so padding pushes the visible chip past the anchor
 *     and the chip ends up below-right of the cursor).
 *  3. Browser snapshots the wrapper as the drag image, then we
 *     remove it from the DOM next animation frame.
 *
 * Falls back silently if setDragImage is unsupported (older Safari).
 */
export function setDragImageBelowCursor(
  e: React.DragEvent,
  label: string,
): void {
  const ghost = document.createElement("div");
  ghost.className = "lattice-drag-ghost";
  ghost.style.position = "fixed";
  ghost.style.top = "-1000px";
  ghost.style.left = "-1000px";
  ghost.style.pointerEvents = "none";

  const chip = document.createElement("div");
  chip.className = "lattice-drag-ghost-chip";
  chip.textContent = label;
  ghost.appendChild(chip);

  document.body.appendChild(ghost);

  try {
    // (0, 0) anchors the cursor at the ghost's top-left corner; the
    // chip's padding-driven offset makes it visibly trail BELOW-RIGHT
    // of the cursor.
    e.dataTransfer.setDragImage(ghost, 0, 0);
  } catch {
    /* setDragImage unsupported — keep browser default */
  }

  // The browser snapshots the element during the drag-start tick;
  // remove on the NEXT animation frame so we don't leave a stray
  // node parked off-screen.
  requestAnimationFrame(() => {
    ghost.remove();
  });
}
