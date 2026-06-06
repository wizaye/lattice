import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import ForceGraph from "force-graph";

/**
 * GraphCanvas
 * -----------
 * Isolated, dependency-free graph viewer. Owns ONLY the force-graph
 * instance and its host `<div>`. No data fetching, no overlay chrome,
 * no editor coupling — the parent passes `{nodes, links}` and a click
 * handler, and we render.
 *
 * Why this exists:
 * The previous GraphView intercepted `wheel` events with a custom
 * capture-phase handler that called `e.stopImmediatePropagation()` on
 * BOTH the canvas AND its container. The trackpad-vs-mouse heuristic
 * misclassified small-delta mouse wheels (deltaY ≈ ±33) as "trackpad
 * swipe" and translated the camera instead of zooming — so users
 * reported "zoom in/out is blocked". It also never set a `cursor`,
 * so the canvas always showed the default arrow even while panning.
 *
 * The fix here is simpler: let force-graph's bundled d3-zoom handle
 * wheel-zoom and drag-pan natively (its default behavior is exactly
 * what we want), and only own the cursor state ourselves. We DO keep
 * `touch-action: none` on the host div so WebView2 / Chromium don't
 * eat trackpad pinches at the platform level.
 */

export type GraphCanvasHandle = {
  /** Smoothly zoom to fit all nodes in view. */
  zoomToFit: (durationMs?: number, paddingPx?: number) => void;
  /** Clear pinned positions, re-randomize, and reheat the simulation. */
  reseedLayout: () => void;
};

type Node = {
  id: string;
  name?: string;
  path?: string;
  val?: number;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number;
  fy?: number;
};

type Link = { source: string | Node; target: string | Node };

type GraphCanvasProps = {
  nodes: Node[];
  links: Link[];
  onNodeClick?: (node: Node) => void;
};

/**
 * Read the active theme. App.tsx stores it on `<html data-theme="...">`.
 */
function readThemeColors() {
  const light = document.documentElement.dataset.theme === "light";
  return {
    node: light ? "#222222" : "#ffffff",
    nodeMuted: light ? "#555555" : "#cccccc",
    link: light ? "#cfcfcf" : "#3a3a3a",
  };
}

const GraphCanvas = forwardRef<GraphCanvasHandle, GraphCanvasProps>(
  function GraphCanvas({ nodes, links, onNodeClick }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const instanceRef = useRef<any>(null);
    // Track the last data payload we pushed so we don't restart the
    // simulation / recenter when the parent re-renders with the same
    // structural data.
    const lastDataRef = useRef<{ nodes: Node[]; links: Link[] } | null>(null);
    // Latest click handler, exposed via ref so the init effect can stay
    // dep-free (init runs exactly once for the lifetime of the canvas).
    const onNodeClickRef = useRef(onNodeClick);
    useEffect(() => {
      onNodeClickRef.current = onNodeClick;
    }, [onNodeClick]);
    // True while the user is mid-drag (either panning the background
    // or moving a node). Suppresses hover-cursor flips during drag.
    const draggingRef = useRef(false);

    // ── Init the force-graph instance exactly once ─────────────────
    useEffect(() => {
      if (!containerRef.current || instanceRef.current) return;
      const el = containerRef.current;
      const FG = ForceGraph as any;
      const inst = FG()(el);
      instanceRef.current = inst;

      inst
        .backgroundColor("transparent")
        .nodeLabel("name")
        .nodeRelSize(4)
        .nodeColor(() => readThemeColors().node)
        .linkColor(() => readThemeColors().link)
        .linkWidth(0.6)
        .minZoom(0.2)
        .maxZoom(8)
        // Explicit re-enable on every property — some force-graph
        // builds toggle interactions off when other accessors fire
        // on init under WebView2. Cheap and idempotent.
        .enableZoomInteraction(true)
        .enablePointerInteraction(true)
        .enableNodeDrag(true)
        .nodeCanvasObject(
          (node: any, ctx: CanvasRenderingContext2D, scale: number) => {
            const c = readThemeColors();
            const radius = node.val ?? 2;
            ctx.beginPath();
            ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI, false);
            ctx.fillStyle = c.node;
            ctx.fill();

            if (scale > 1.5) {
              const fontSize = 12 / scale;
              ctx.font = `${fontSize}px Inter, sans-serif`;
              ctx.textAlign = "center";
              ctx.textBaseline = "middle";
              ctx.fillStyle = c.nodeMuted;
              ctx.fillText(
                node.name ?? "",
                node.x,
                node.y + radius + fontSize * 1.5,
              );
            }
          },
        )
        .onNodeClick((node: any) => onNodeClickRef.current?.(node))
        // Hover swaps the cursor between grab (background) and
        // pointer (node) — but ONLY when not actively dragging so
        // we don't flicker mid-pan.
        .onNodeHover((node: any) => {
          if (draggingRef.current) return;
          el.style.cursor = node ? "pointer" : "grab";
        })
        .onNodeDrag(() => {
          draggingRef.current = true;
          el.style.cursor = "grabbing";
        })
        .onNodeDragEnd(() => {
          draggingRef.current = false;
          el.style.cursor = "grab";
        });

      // Pan-on-drag cursor: force-graph's bundled d3-zoom handles
      // the actual pan logic, but it doesn't update CSS cursor. We
      // listen on the host div so empty-area drags flip to grabbing.
      const onPointerDown = (e: PointerEvent) => {
        if (e.button !== 0) return;
        draggingRef.current = true;
        el.style.cursor = "grabbing";
      };
      const onPointerUp = () => {
        draggingRef.current = false;
        el.style.cursor = "grab";
      };
      el.addEventListener("pointerdown", onPointerDown);
      // Listen on window for pointerup so a release outside the
      // canvas still resets the cursor.
      window.addEventListener("pointerup", onPointerUp);

      // Initial size (ResizeObserver below handles subsequent changes).
      if (el.clientWidth && el.clientHeight) {
        inst.width(el.clientWidth).height(el.clientHeight);
      }
      const ro = new ResizeObserver(() => {
        if (!instanceRef.current) return;
        const { clientWidth, clientHeight } = el;
        if (clientWidth && clientHeight) {
          instanceRef.current.width(clientWidth).height(clientHeight);
        }
      });
      ro.observe(el);

      // Re-evaluate accessor colors when the user toggles theme.
      const themeObs = new MutationObserver(() => {
        if (!instanceRef.current) return;
        instanceRef.current
          .nodeColor(() => readThemeColors().node)
          .linkColor(() => readThemeColors().link);
      });
      themeObs.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
      });

      // Resting cursor on first paint.
      el.style.cursor = "grab";

      return () => {
        ro.disconnect();
        themeObs.disconnect();
        el.removeEventListener("pointerdown", onPointerDown);
        window.removeEventListener("pointerup", onPointerUp);
        if (instanceRef.current?._destructor) {
          instanceRef.current._destructor();
        }
        instanceRef.current = null;
        lastDataRef.current = null;
      };
    }, []);

    // ── Push data only when structurally different ─────────────────
    useEffect(() => {
      if (!instanceRef.current) return;
      const last = lastDataRef.current;
      const same =
        last &&
        last.nodes.length === nodes.length &&
        last.links.length === links.length;
      if (same) return;
      instanceRef.current.graphData({ nodes, links });
      lastDataRef.current = { nodes, links };
    }, [nodes, links]);

    useImperativeHandle(
      ref,
      () => ({
        zoomToFit: (duration = 400, padding = 40) => {
          instanceRef.current?.zoomToFit?.(duration, padding);
        },
        reseedLayout: () => {
          const g = instanceRef.current;
          if (!g) return;
          const data = g.graphData();
          if (data && Array.isArray(data.nodes)) {
            for (const n of data.nodes) {
              // Seed each node with random coords near origin so the
              // simulation doesn't start from a degenerate single point
              // (force-graph treats undefined as origin which collapses
              // every node together).
              n.x = (Math.random() - 0.5) * 200;
              n.y = (Math.random() - 0.5) * 200;
              n.vx = 0;
              n.vy = 0;
              n.fx = undefined;
              n.fy = undefined;
            }
          }
          if (typeof g.d3ReheatSimulation === "function") {
            g.d3ReheatSimulation();
          }
          // Recenter on the new layout once the sim settles.
          if (typeof g.zoomToFit === "function") {
            setTimeout(() => g.zoomToFit(600, 40), 800);
          }
        },
      }),
      [],
    );

    return (
      <div
        ref={containerRef}
        // Hard-set absolute fill + `touch-action: none` so WebView2 /
        // Chromium don't intercept trackpad gestures as page-level
        // pan/pinch BEFORE force-graph's d3-zoom sees them.
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          touchAction: "none",
          overscrollBehavior: "contain",
          cursor: "grab",
        }}
      />
    );
  },
);

export default GraphCanvas;
