import { useCallback, useEffect, useRef } from "react";

/**
 * Hook for drag-to-resize splitters. Returns a callback to attach to
 * the splitter handle's onPointerDown. While dragging, calls `onDelta`
 * with the cumulative pixel delta from the drag-start point.
 */
export function useDragResize(
  axis: "x" | "y",
  onDelta: (delta: number) => void,
  onEnd?: () => void,
) {
  const startRef = useRef<number>(0);
  const draggingRef = useRef(false);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      startRef.current = axis === "x" ? e.clientX : e.clientY;
      (e.target as Element).setPointerCapture?.(e.pointerId);
      document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
    },
    [axis],
  );

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!draggingRef.current) return;
      const current = axis === "x" ? e.clientX : e.clientY;
      onDelta(current - startRef.current);
    };
    const up = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      onEnd?.();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [axis, onDelta, onEnd]);

  return handlePointerDown;
}
