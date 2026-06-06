/**
 * Custom HTML5 drag-image helper.
 *
 * The default DataTransfer drag image is the source element itself
 * (faded), which for a small icon-ful row looks like a washed-out
 * copy of the row sitting awkwardly on top of the cursor. Obsidian
 * instead shows a small floating pill BELOW + RIGHT of the cursor.
 *
 * Why this is finicky on Windows WebView2:
 *  - The browser snapshots the element synchronously during the
 *    `dragstart` tick. If the element has zero layout size (because
 *    it's still being laid out, or because it's anchored at extreme
 *    negative coordinates and never paints), Chromium-based WebViews
 *    silently fall back to the system "not-allowed" (dotted-box)
 *    cursor — which is exactly the missing-icon bug users report.
 *  - Removing the ghost on `requestAnimationFrame` can also fire
 *    BEFORE the snapshot is captured under load, leaving the cursor
 *    blank.
 *
 * Strategy that works reliably across Edge WebView2 + Chrome + Safari:
 *  1. Append the chip to the DOM at viewport coordinates (0, 0) but
 *     translated off-screen with `transform: translateX(-9999px)`.
 *     `transform` doesn't affect layout so the element still has a
 *     real width/height and gets painted into the layer that
 *     setDragImage snapshots.
 *  2. Force a synchronous layout/paint pass before setDragImage by
 *     reading `offsetWidth`. This guarantees the browser has rendered
 *     the chip before it tries to capture it.
 *  3. Remove the ghost on a `setTimeout(0)` — runs after the snapshot
 *     is captured but before the next paint, so the user never sees
 *     a stray chip flash on screen.
 *
 * Falls back silently if setDragImage is unsupported (very old Safari).
 */
export function setDragImageBelowCursor(
  e: React.DragEvent,
  label: string,
): void {
  const ghost = document.createElement("div");
  ghost.className = "lattice-drag-ghost";
  ghost.style.position = "fixed";
  ghost.style.top = "0";
  ghost.style.left = "0";
  // Use transform (not top/left negative offsets) so the element
  // still has layout + paints into the compositor layer that
  // setDragImage snapshots. Negative top/left can yield an empty
  // snapshot on WebView2, which surfaces as the "dotted box" cursor.
  ghost.style.transform = "translateX(-9999px)";
  ghost.style.pointerEvents = "none";
  ghost.style.zIndex = "999999";

  const chip = document.createElement("div");
  chip.className = "lattice-drag-ghost-chip";
  chip.textContent = label;
  ghost.appendChild(chip);

  document.body.appendChild(ghost);

  // Force a synchronous layout + paint so the browser has actual
  // pixels to snapshot when we call setDragImage below. Without this
  // forced reflow, WebView2 sometimes captures an empty bitmap and
  // shows the system "not-allowed" cursor instead of our chip.
  void ghost.offsetWidth;

  try {
    // (0, 0) anchors the cursor at the ghost's top-left corner; the
    // chip's padding-driven offset makes it visibly trail BELOW-RIGHT
    // of the cursor.
    e.dataTransfer.setDragImage(ghost, 0, 0);
  } catch {
    /* setDragImage unsupported — keep browser default */
  }

  // setTimeout(0) is more reliable than requestAnimationFrame on
  // Windows: rAF can fire DURING the snapshot capture for very fast
  // drags, removing the ghost before the browser has captured it.
  // A 0-ms timeout runs after the current task (which includes the
  // snapshot) completes.
  setTimeout(() => {
    ghost.remove();
  }, 0);
}
