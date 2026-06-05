import { useDragResize } from "../../hooks/useDragResize";
import "./Splitter.css";

type Props = {
  axis: "x" | "y";
  /** Called on every move with the cumulative pixel delta from drag start. */
  onDelta: (delta: number) => void;
  onEnd?: () => void;
};

/** A thin, hover-highlighted divider used between sidebars and editor panes. */
export function Splitter({ axis, onDelta, onEnd }: Props) {
  const onPointerDown = useDragResize(axis, onDelta, onEnd);
  return (
    <div
      className={`splitter ${axis === "x" ? "vertical" : "horizontal"}`}
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
    >
      <div className="splitter-hit" />
    </div>
  );
}
