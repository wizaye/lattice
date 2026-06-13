/**
 * HoverPreview — Obsidian-style Ctrl+hover popover.
 *
 * Mount this component ONCE near the root (App.tsx). It attaches
 * window-level `mousemove`/`keydown`/`keyup` listeners and shows a
 * floating Markdown preview when the user hovers any element marked
 * with `data-file-id="<vault path>"` while Control (Cmd on macOS) is
 * held down. The popover disappears on Ctrl release, pointer leave,
 * Escape, click, or scroll.
 *
 * Contract for triggers
 * ---------------------
 * Any element with `data-file-id="<id>"` becomes a hover target.
 * - File tree rows already set this on `.tree-row.file`.
 * - Tab buttons set it on the `.tab` wrapper.
 * - Wikilinks in markdown could opt in by adding the same attribute
 *   if we want hover previews in the body too (future).
 *
 * Why a singleton + delegated mousemove (instead of per-row listeners)?
 * ---------------------------------------------------------------------
 * 1. Tabs come and go constantly — wiring per-component listeners means
 *    we re-attach handlers on every render.
 * 2. The Ctrl modifier is global state, not per-element. A singleton
 *    keeps that state in one place.
 * 3. mousemove + elementFromPoint is cheap (single event/render frame)
 *    and lets us track Ctrl-down-then-hover AND hover-then-Ctrl-down
 *    transitions uniformly.
 *
 * Positioning
 * -----------
 * Anchored at the CURSOR TAIL (down-right of where the user paused),
 * NOT at the row's bounding rect. We capture `e.clientX/clientY` on
 * every mousemove and read that snapshot when the show-delay timer
 * fires. Default offset is `(cursor.x + 14, cursor.y + 18)` — the
 * native OS-tooltip convention. After first paint we measure the
 * rendered card with `useLayoutEffect` and re-clamp using the ACTUAL
 * height (so short popovers don't get pushed above the cursor on a
 * narrow viewport). Flips horizontally if it would overflow the right
 * edge, and only flips above the cursor when the cursor is in the
 * bottom half of the viewport. Fixed positioning via `createPortal`
 * to document.body so it escapes any parent `overflow: hidden`
 * (sidebar clipping).
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEditorStore } from "../../state/editorStore";
import { useVaultStore } from "../../state/vaultStore";
import { MarkdownPreview } from "../editor/MarkdownPreview";
import { IcExpand } from "./Icons";
import "./HoverPreview.css";

/** ms delay between Ctrl+hover and showing the popover. Matches
 *  Obsidian roughly (they use ~300 ms). Long enough to avoid flicker
 *  while the cursor is just passing through. */
const HOVER_DELAY_MS = 220;

/** Pixel offsets from the cursor when the popover first appears.
 *  Mirrors a native OS tooltip's down-right tail position. */
const CURSOR_OFFSET_X = 14;
const CURSOR_OFFSET_Y = 18;

type CursorPoint = { x: number; y: number };

export function HoverPreview() {
  const [fileId, setFileId] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<CursorPoint | null>(null);
  const [content, setContent] = useState<string | null>(null);

  // Live refs so the global listeners always see fresh values without
  // re-binding.
  const ctrlDownRef = useRef(false);
  const currentTargetRef = useRef<HTMLElement | null>(null);
  const delayTimerRef = useRef<number | null>(null);
  const currentFileIdRef = useRef<string | null>(null);
  /** Most recent cursor position. Captured on every mousemove and read
   *  when the show-delay timer fires so the popover lands at where the
   *  cursor was paused, not at where the row follows. */
  const cursorRef = useRef<CursorPoint>({ x: 0, y: 0 });

  const clearDelay = () => {
    if (delayTimerRef.current !== null) {
      window.clearTimeout(delayTimerRef.current);
      delayTimerRef.current = null;
    }
  };

  const hide = () => {
    clearDelay();
    currentTargetRef.current = null;
    currentFileIdRef.current = null;
    setFileId(null);
    setAnchor(null);
    setContent(null);
  };

  const scheduleShow = (target: HTMLElement, id: string) => {
    // Already showing this exact file from this exact target → no-op.
    if (currentFileIdRef.current === id && currentTargetRef.current === target) {
      return;
    }
    clearDelay();
    currentTargetRef.current = target;
    delayTimerRef.current = window.setTimeout(() => {
      if (!ctrlDownRef.current) return;
      if (currentTargetRef.current !== target) return;
      currentFileIdRef.current = id;
      setFileId(id);
      // Anchor at the cursor's current position ("cursor tail"),
      // not the row's bounding rect — the popover follows where the
      // user actually paused, regardless of how wide the row is.
      setAnchor({ x: cursorRef.current.x, y: cursorRef.current.y });
    }, HOVER_DELAY_MS);
  };

  useEffect(() => {
    const isCtrl = (e: KeyboardEvent | MouseEvent) =>
      e.ctrlKey || e.metaKey;

    const onMouseMove = (e: MouseEvent) => {
      // Keep the latest cursor coords so scheduleShow's timer (and the
      // initial render) can anchor at exactly where the user paused.
      cursorRef.current = { x: e.clientX, y: e.clientY };
      ctrlDownRef.current = isCtrl(e);
      if (!ctrlDownRef.current) {
        // If we're already showing and Ctrl was released mid-hover,
        // dismiss. (Pointermove with no ctrl is the common case.)
        if (currentFileIdRef.current !== null) hide();
        return;
      }
      const target = e.target as HTMLElement | null;
      // Cursor over the popover itself → keep it open. (User is
      // moving toward the expand button.) Don't re-schedule.
      if (target?.closest(".hover-preview")) return;
      // Find the closest ancestor with data-file-id.
      const hit = target?.closest("[data-file-id]") as HTMLElement | null;
      if (!hit) {
        // Cursor moved off any tagged row → hide.
        if (currentFileIdRef.current !== null) hide();
        clearDelay();
        currentTargetRef.current = null;
        return;
      }
      const id = hit.getAttribute("data-file-id");
      if (!id) return;
      scheduleShow(hit, id);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && currentFileIdRef.current !== null) {
        e.preventDefault();
        hide();
        return;
      }
      if (e.key === "Control" || e.key === "Meta") {
        ctrlDownRef.current = true;
        // Hover-then-Ctrl path: the cursor is already parked over a
        // row but no mousemove will fire while it's stationary, so
        // scheduleShow would never get called from onMouseMove. Look
        // up the element under the last-known cursor position and
        // trigger the show from here.
        const { x, y } = cursorRef.current;
        const el = document.elementFromPoint(x, y) as HTMLElement | null;
        if (!el) return;
        if (el.closest(".hover-preview")) return;
        const hit = el.closest("[data-file-id]") as HTMLElement | null;
        if (!hit) return;
        const id = hit.getAttribute("data-file-id");
        if (!id) return;
        scheduleShow(hit, id);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Control" || e.key === "Meta") {
        ctrlDownRef.current = false;
        hide();
      }
    };

    // Any click outside the popover dismisses (matches Obsidian:
    // clicking opens the file and closes the hover). Clicks INSIDE
    // the popover are handled by the popover's own buttons.
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(".hover-preview")) return;
      if (currentFileIdRef.current !== null) hide();
    };

    // Scrolling shifts the anchor; cheapest fix is to dismiss.
    const onScroll = () => {
      if (currentFileIdRef.current !== null) hide();
    };

    // Lose focus → kill any pending or showing popover.
    const onBlur = () => hide();

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("blur", onBlur);
      clearDelay();
    };
  }, []);

  // Fetch content whenever the active file changes. The editor store
  // is cache-first (loadFile returns the cached body immediately for
  // anything already opened or pre-seeded by the mock vault).
  useEffect(() => {
    if (!fileId) {
      setContent(null);
      return;
    }
    let cancelled = false;
    const run = async () => {
      try {
        const text = await useEditorStore.getState().loadFile(fileId);
        if (!cancelled) setContent(text);
      } catch (err) {
        if (!cancelled) {
          console.warn("HoverPreview: failed to load", fileId, err);
          setContent("");
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [fileId]);

  if (!fileId || !anchor) return null;

  return (
    <HoverPreviewPopover
      fileId={fileId}
      anchor={anchor}
      content={content}
      onDismiss={hide}
    />
  );
}

// ---------------------------------------------------------------------------
// Popover
// ---------------------------------------------------------------------------
// Split into its own component so it can use `useLayoutEffect` to
// measure the rendered card AFTER first paint and clamp it into the
// viewport using the ACTUAL height — critical for short popovers on
// narrow windows, otherwise the worst-case (max-height) clamp pushes
// them above the cursor for no reason.

const POPOVER_W = 380;
const POPOVER_MAX_H = 320;
const MARGIN = 8;

function HoverPreviewPopover({
  fileId,
  anchor,
  content,
  onDismiss,
}: {
  fileId: string;
  anchor: CursorPoint;
  content: string | null;
  onDismiss: () => void;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; visible: boolean }>(() => ({
    // Initial guess: down-right of cursor (native-tooltip convention).
    // visibility:hidden until useLayoutEffect refines using real size.
    left: anchor.x + CURSOR_OFFSET_X,
    top: anchor.y + CURSOR_OFFSET_Y,
    visible: false,
  }));

  // Re-clamp on first paint AND whenever the content height grows
  // (loading → rendered markdown). Reads the live element rect so we
  // can keep the popover tight to the cursor when content is short.
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const h = Math.min(rect.height, POPOVER_MAX_H);
    const w = Math.min(rect.width, POPOVER_W);

    // Horizontal: down-right of cursor by default; flip LEFT if it
    // would overflow the right edge.
    let left = anchor.x + CURSOR_OFFSET_X;
    if (left + w + MARGIN > vw) {
      left = anchor.x - w - CURSOR_OFFSET_X;
    }
    if (left < MARGIN) left = MARGIN;

    // Vertical: stay below the cursor whenever possible. Only flip
    // ABOVE when the cursor is in the bottom half AND the rendered
    // height truly won't fit below.
    let top = anchor.y + CURSOR_OFFSET_Y;
    if (anchor.y > vh / 2 && top + h + MARGIN > vh) {
      top = anchor.y - h - CURSOR_OFFSET_Y;
    }
    // Final clamp uses REAL height, not the max-height cap.
    if (top + h + MARGIN > vh) top = Math.max(MARGIN, vh - h - MARGIN);
    if (top < MARGIN) top = MARGIN;

    setPos({ left, top, visible: true });
  }, [anchor.x, anchor.y, content, fileId]);

  // Resolve a friendly title for the header. For real vaults the
  // fileId is the absolute path; the flat vault map gives us the
  // node's display name.
  const node = useVaultStore.getState().flatVault.get(fileId);
  const title = node?.name ?? fileId.split(/[/\\]/).pop() ?? fileId;

  // Open the previewed file in the editor. Dispatches a window
  // CustomEvent so we don't have to prop-drill an opener callback
  // down into the singleton — App.tsx owns the actual `openFile`.
  const openInEditor = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const idToOpen = fileId;
    onDismiss();
    window.dispatchEvent(
      new CustomEvent("lattice-open-file-by-id", {
        detail: { fileId: idToOpen },
      }),
    );
  };

  const style: React.CSSProperties = {
    position: "fixed",
    left: pos.left,
    top: pos.top,
    width: POPOVER_W,
    maxHeight: POPOVER_MAX_H,
    visibility: pos.visible ? "visible" : "hidden",
  };

  return createPortal(
    <div ref={cardRef} className="hover-preview" style={style} role="tooltip">
      <div className="hover-preview-header">
        <span className="hover-preview-title" title={fileId}>
          {title}
        </span>
        <button
          type="button"
          className="hover-preview-expand"
          title="Open in editor"
          aria-label="Open in editor"
          onClick={openInEditor}
        >
          <IcExpand />
        </button>
      </div>
      <div className="hover-preview-body">
        {content === null ? (
          <div className="hover-preview-loading">Loading…</div>
        ) : content === "" ? (
          <div className="hover-preview-empty">Empty file</div>
        ) : (
          <MarkdownPreview source={content} fileId={fileId} />
        )}
      </div>
    </div>,
    document.body,
  );
}
