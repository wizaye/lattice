import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import ForceGraph from "force-graph";
import { forceCollide, forceX, forceY } from "d3-force";

/**
 * GraphCanvas
 * -----------
 * Isolated, dependency-free graph viewer. Owns ONLY the force-graph
 * instance and its host `<div>`. No data fetching, no overlay chrome,
 * no editor coupling — the parent passes `{nodes, links}` and a click
 * handler, and we render.
 *
 * Gesture handling (Chromium / WebView2 on Windows + macOS):
 *   - Mouse wheel (deltaX = 0, ctrlKey = false)  → zoom (d3-zoom default)
 *   - Trackpad PINCH (ctrlKey = true, synthetic) → zoom (d3-zoom default)
 *   - Trackpad two-finger swipe (deltaX ≠ 0)     → PAN the camera
 *     (we intercept and translate via centerAt — d3-zoom would otherwise
 *      misinterpret a two-finger scroll as zoom)
 *
 * We previously avoided ANY custom wheel handler because an earlier
 * heuristic used `Math.abs(deltaY) < 50 || !Number.isInteger(deltaY)`
 * which misclassified modern Windows mouse wheels (fractional deltaY
 * ≈ ±33) as trackpad swipes and broke zoom. The new heuristic uses
 * ctrlKey + deltaX only — both are reliable platform signals.
 *
 * Interaction model:
 *   - Click node → highlight node + 1-hop neighbors, dim everything
 *     else. Parent's onNodeClick (file-open) still fires.
 *   - Click background → clear highlight.
 *   - Drag node → standard d3-force grab.
 *   - Wand button → calls growLayout() which clears the graph then
 *     re-adds nodes one-at-a-time in BFS order from the highest-
 *     degree seed, so the user watches the network build itself.
 */

export type GraphCanvasHandle = {
  /** Smoothly zoom to fit all nodes in view. */
  zoomToFit: (durationMs?: number, paddingPx?: number) => void;
  /** Clear pinned positions, re-randomize, and reheat the simulation. */
  reseedLayout: () => void;
  /** Re-render the graph by progressively adding nodes one-at-a-time
   *  starting from the highest-degree seed (BFS order). Gives the
   *  user a "growing network" animation instead of a single jarring
   *  re-randomize. */
  growLayout: () => void;
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

// World-unit scale factor for node radius in the custom renderer.
// `nodeRelSize()` only affects force-graph's BUILT-IN circle renderer.
// Once we install a `nodeCanvasObject`, we own sizing ourselves — so
// every radius must be multiplied by this constant or nodes appear as
// 1–10 world-unit dots that look like dust on screen.
//
// We use AREA-based (sqrt) scaling, not linear: with linear scaling and
// val ∈ [1,10], hubs ended up ~10× the radius of leaves and visually
// dominated the canvas (80 px diameter blobs that overlap their
// neighbours). Area scaling keeps the visual weight proportional to
// degree without ballooning hubs out of proportion. With NODE_SIZE=3,
// val=1 → r≈3, val=10 → r≈9.5 — a 3× radius ratio, ~10× area.
const NODE_SIZE = 3;

// Gaussian blur radius (in canvas pixels) applied to the COMPOSITED
// dimmed-layer image when the focus effect is active. The whole layer
// (every dimmed node + dimmed link drawn to an offscreen canvas) is
// blurred ONCE via `ctx.filter = "blur(Npx)"` during the
// drawImage(offscreen → main) composite — so overlapping dimmed shapes
// merge into a single coherent soft cloud. (An earlier version blurred
// each shape individually inside its own save/restore; that produced
// discrete blurry dots, not a continuous out-of-focus backdrop, and
// looked visibly "forced".)
//
// 3px is a sweet spot: small enough that individual dimmed nodes
// remain visible as soft dots (so the network silhouette still
// reads), large enough that overlapping shapes merge into a single
// out-of-focus cloud. Higher values (6+) dilute small shapes below
// visibility against a dark background.
// 8px provides a much stronger blur effect, so the out-of-focus
// elements are visibly blurred even on high-DPI (Retina) screens.
const DIM_BLUR_PX = 8;

// Lowered to 0.35 so that the dimmed cloud actually fades out,
// making the highlighted nodes stand out much more clearly.
const DIM_LAYER_ALPHA = 0.35;

/**
 * Read the active theme. App.tsx stores it on `<html data-theme="...">`.
 *
 * Returns the full palette the canvas needs for normal/dim/highlight
 * states (used by the click-to-focus behavior). Dimmed colors are
 * intentionally low-alpha versions of the normal color so unrelated
 * nodes recede visually without disappearing.
 */
function readThemeColors() {
  const light = document.documentElement.dataset.theme === "light";
  return {
    node: light ? "#222222" : "#ffffff",
    nodeMuted: light ? "#555555" : "#cccccc",
    // Pre-blur alpha is intentionally higher than it used to be
    // (was 0.14 → now 0.30): the gaussian blur already does most of
    // the "out of focus" work, so the underlying color needs to be
    // visible enough that the blurred silhouette still reads.
    nodeDim: light ? "rgba(34,34,34,0.30)" : "rgba(255,255,255,0.30)",
    nodeHighlight: "#8b5cf6",
    // Bumped from #cfcfcf / #3a3a3a — old values were so close to the
    // canvas background that links were nearly invisible. New values
    // give a clear edge contrast in both themes without overpowering
    // the nodes themselves.
    link: light ? "#b3b3b3" : "#555555",
    linkDim: light ? "rgba(154,154,154,0.25)" : "rgba(106,106,106,0.35)",
    linkHighlight: "#8b5cf6",
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
    // True once we've framed the network with the first zoomToFit
    // after data arrives — subsequent data pushes don't re-frame
    // (would yank the camera mid-edit).
    const framedRef = useRef(false);
    // Latest click handler, exposed via ref so the init effect can stay
    // dep-free (init runs exactly once for the lifetime of the canvas).
    const onNodeClickRef = useRef(onNodeClick);
    useEffect(() => {
      onNodeClickRef.current = onNodeClick;
    }, [onNodeClick]);
    // True while the user is mid-drag (either panning the background
    // or moving a node). Suppresses hover-cursor flips during drag.
    const draggingRef = useRef(false);
    // Snapshot of `selectedNodeIdRef.current` taken at drag-start so
    // we can restore the click-selection (or clear focus) when the
    // user releases the node. Without this, dragging would either
    // wipe the user's prior click-focus or leak a transient drag-
    // focus into the post-drag UI.
    const dragPriorSelectionRef = useRef<string | null>(null);
    // Selection state for click-to-focus. We use refs (not state) so
    // the force-graph accessors — which run every frame inside the
    // canvas render loop — read the latest value without forcing a
    // React re-render. `connectedNodeIdsRef` is the 1-hop neighborhood
    // of the selected node (plus the selected node itself).
    const lockedNodeIdRef = useRef<string | null>(null);
    const selectedNodeIdRef = useRef<string | null>(null);
    const connectedNodeIdsRef = useRef<Set<string>>(new Set());
    // Offscreen canvas used to compose the dimmed ("out of focus")
    // layer during focus mode. We draw every dimmed node + link to
    // this buffer with the same transform as the main canvas, then
    // composite the WHOLE buffer onto main inside one
    // `ctx.filter = "blur(Npx)"` drawImage call. This is what gives
    // the true Obsidian look — overlapping dimmed shapes blur INTO
    // each other, producing one continuous soft cloud rather than
    // N independent blurred sprites. See DIM_BLUR_PX docs above.
    const dimLayerCanvasRef = useRef<HTMLCanvasElement | null>(null);
    // True while the wand's progressive-grow animation is running.
    // Suppresses the parent-data useEffect so a mid-animation render
    // doesn't snap straight to the full graph and abort the build-up.
    const animatingRef = useRef(false);
    const animationTimerRef = useRef<number | null>(null);

    /**
     * Update the selection refs and nudge the simulation so the next
     * frame redraws with the new highlight state. We use a tiny alpha
     * bump (not a full reheat) — enough to wake the render loop without
     * making nodes jump around.
     */
    const applySelection = (selectedId: string | null) => {
      const connected = new Set<string>();
      if (selectedId && lastDataRef.current) {
        connected.add(selectedId);
        for (const link of lastDataRef.current.links) {
          const sId = typeof link.source === "object"
            ? (link.source as any).id
            : link.source;
          const tId = typeof link.target === "object"
            ? (link.target as any).id
            : link.target;
          if (sId === selectedId) connected.add(tId as string);
          else if (tId === selectedId) connected.add(sId as string);
        }
      }
      selectedNodeIdRef.current = selectedId;
      connectedNodeIdsRef.current = connected;
      const g = instanceRef.current;
      if (!g) return;
      // Wake the render loop just enough to repaint with the new
      // highlight; particles on highlighted links also need an active
      // sim to animate.
      if (typeof g.d3AlphaTarget === "function") {
        g.d3AlphaTarget(0.05);
      }
      if (typeof g.d3ReheatSimulation === "function") {
        g.d3ReheatSimulation();
      }
      // Cool down again shortly — we don't want the sim running forever.
      window.setTimeout(() => {
        if (typeof instanceRef.current?.d3AlphaTarget === "function") {
          instanceRef.current.d3AlphaTarget(0);
        }
      }, 600);
    };

    // ── Init the force-graph instance exactly once ─────────────────
    useEffect(() => {
      if (!containerRef.current || instanceRef.current) return;
      const el = containerRef.current;
      const FG = ForceGraph as any;
      const inst = FG()(el);
      instanceRef.current = inst;
      // DEV-only: expose the live force-graph instance + applySelection
      // so the in-browser smoke test can drive focus precisely from
      // Playwright (real mouse clicks miss the tiny hit-radius reliably
      // under DPR/zoom). No-op in production.
      if (import.meta.env.DEV) {
        (window as any).__latticeGraphInst = inst;
        (window as any).__latticeApplySelection = (id: string | null) => {
          lockedNodeIdRef.current = id;
          applySelection(id);
        };
      }

      inst
        .backgroundColor("transparent")
        .nodeLabel("name")
        // Must match NODE_SIZE so force-graph's BUILT-IN pointer
        // hit-test (which uses sqrt(val) * nodeRelSize) lines up with
        // the visual radius we draw in `nodeCanvasObject`. If these
        // diverge, clicks miss or register on empty space.
        .nodeRelSize(NODE_SIZE)
        .minZoom(0.2)
        .maxZoom(8)
        // Explicit re-enable on every property — some force-graph
        // builds toggle interactions off when other accessors fire
        // on init under WebView2. Cheap and idempotent.
        .enableZoomInteraction(true)
        .enablePointerInteraction(true)
        .enableNodeDrag(true)
        // Fluid feel: lower velocity decay (default 0.4) makes nodes
        // glide and bounce elastically instead of snapping into place; 
        // lower alpha decay lets the sim breathe longer.
        .d3VelocityDecay(0.15)
        .d3AlphaDecay(0.01)
        // Custom link renderer. When focus is active we ONLY draw
        // the incident (focused-neighborhood) links here — every
        // dimmed link is rendered into the offscreen blur layer by
        // `onRenderFramePre` below. This split is what makes the
        // out-of-focus look continuous: blurring per-shape produces
        // discrete halos; blurring one composited layer produces a
        // single soft cloud (Obsidian behavior).
        // Mode "replace" means force-graph skips its built-in line
        // draw and uses ours.
        .linkCanvasObjectMode(() => "replace")
        .linkCanvasObject((link: any, ctx: CanvasRenderingContext2D) => {
          const c = readThemeColors();
          const selectedId = selectedNodeIdRef.current;
          const s = link.source;
          const t = link.target;
          // After force-graph's first graphData() call it mutates
          // string ids into node refs; both shapes need to work.
          if (typeof s !== "object" || typeof t !== "object") return;
          if (s.x == null || s.y == null || t.x == null || t.y == null) return;
          const sId = s.id;
          const tId = t.id;
          const incident = selectedId
            ? sId === selectedId || tId === selectedId
            : false;
          // Dimmed links already drew into the offscreen blur layer
          // during onRenderFramePre — skip them here.
          if (selectedId && !incident) return;
          if (incident) {
            ctx.strokeStyle = c.linkHighlight;
            ctx.lineWidth = 1.5;
          } else {
            ctx.strokeStyle = c.link;
            ctx.lineWidth = 0.8;
          }
          ctx.beginPath();
          ctx.moveTo(s.x, s.y);
          ctx.lineTo(t.x, t.y);
          ctx.stroke();
        })
        .linkDirectionalParticles((link: any) => {
          // Particles ONLY on the selected node's edges — gives a
          // subtle "flowing" effect that draws the eye to the focus
          // neighborhood without bogging down the whole canvas.
          const selectedId = selectedNodeIdRef.current;
          if (!selectedId) return 0;
          const sId = typeof link.source === "object" ? link.source.id : link.source;
          const tId = typeof link.target === "object" ? link.target.id : link.target;
          return sId === selectedId || tId === selectedId ? 2 : 0;
        })
        .linkDirectionalParticleSpeed(0.006)
        .linkDirectionalParticleWidth(1.5)
        .linkDirectionalParticleColor(() => readThemeColors().linkHighlight)
        // ── Two-pass focus blur (the Obsidian look) ──────────────
        // When a node is selected, draw every DIMMED node + link to
        // a hidden offscreen canvas, then composite the whole layer
        // back onto the main canvas inside a SINGLE blur filter call.
        // Because the filter is applied during drawImage, the blur
        // smears across the entire layer at once — overlapping
        // shapes merge into one continuous soft cloud. This is the
        // key difference from a per-shape blur (which produces
        // discrete blurry sprites with no inter-shape merging) and
        // is why this finally matches Obsidian's soft-focus look.
        //
        // onRenderFramePre fires AFTER the main canvas is cleared
        // and the world→pixel transform is set, but BEFORE any
        // node/link draws — so anything we composite here lands at
        // the bottom of the frame, ready for the crisp focused
        // subgraph (drawn by linkCanvasObject + nodeCanvasObject)
        // to overlay it on top.
        .onRenderFramePre(
          (mainCtx: CanvasRenderingContext2D, _globalScale: number) => {
            const selectedId = selectedNodeIdRef.current;
            if (!selectedId) return;
            const inst2 = instanceRef.current;
            if (!inst2) return;
            const data = inst2.graphData?.();
            if (!data) return;
            const connected = connectedNodeIdsRef.current;
            const c = readThemeColors();
            const mainCanvas = mainCtx.canvas;

            // Lazily create + size the offscreen buffer to match the
            // main canvas's device-pixel dimensions. We re-check size
            // every frame because force-graph resizes the main canvas
            // on container resize / DPR change.
            let off = dimLayerCanvasRef.current;
            if (!off) {
              off = document.createElement("canvas");
              dimLayerCanvasRef.current = off;
            }
            if (
              off.width !== mainCanvas.width ||
              off.height !== mainCanvas.height
            ) {
              off.width = mainCanvas.width;
              off.height = mainCanvas.height;
            }
            const offCtx = off.getContext("2d");
            if (!offCtx) return;

            // Copy the main canvas's CURRENT transform (zoom + pan +
            // DPR baked in by force-graph) to the offscreen so we
            // can pass world coordinates directly to offCtx — no
            // manual world→screen math needed.
            offCtx.setTransform(1, 0, 0, 1, 0, 0);
            offCtx.clearRect(0, 0, off.width, off.height);
            const m = mainCtx.getTransform();
            offCtx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);

            // 1) All DIMMED links into the offscreen layer.
            offCtx.strokeStyle = c.link;
            offCtx.lineWidth = 0.8;
            for (const link of data.links as any[]) {
              const s = link.source;
              const t = link.target;
              if (typeof s !== "object" || typeof t !== "object") continue;
              if (s.x == null || s.y == null || t.x == null || t.y == null) {
                continue;
              }
              if (s.id === selectedId || t.id === selectedId) continue;
              offCtx.beginPath();
              offCtx.moveTo(s.x, s.y);
              offCtx.lineTo(t.x, t.y);
              offCtx.stroke();
            }

            // 2) All DIMMED nodes into the offscreen layer.
            offCtx.fillStyle = c.node;
            for (const node of data.nodes as any[]) {
              if (node.x == null || node.y == null) continue;
              if (node.id === selectedId || connected.has(node.id)) continue;
              const radius = Math.sqrt(node.val ?? 1) * NODE_SIZE;
              offCtx.beginPath();
              offCtx.arc(node.x, node.y, radius, 0, 2 * Math.PI, false);
              offCtx.fill();
            }

            // 3) Composite the WHOLE offscreen layer back onto the
            // main canvas with a single gaussian-blur filter. Reset
            // main's transform to identity first so drawImage uses
            // pixel coordinates (the offscreen already has the same
            // pixel content as a non-blurred main render would).
            mainCtx.save();
            mainCtx.setTransform(1, 0, 0, 1, 0, 0);
            mainCtx.filter = `blur(${DIM_BLUR_PX}px)`;
            mainCtx.globalAlpha = DIM_LAYER_ALPHA;
            mainCtx.drawImage(off, 0, 0);
            mainCtx.restore();
          },
        )
        .nodeCanvasObject(
          (node: any, ctx: CanvasRenderingContext2D, scale: number) => {
            const c = readThemeColors();
            const selectedId = selectedNodeIdRef.current;
            const connected = connectedNodeIdsRef.current;

            // Dimmed nodes are drawn into the offscreen blur layer
            // by onRenderFramePre — skip them here entirely so we
            // don't double-paint a crisp version on top of the soft
            // backdrop.
            if (selectedId && node.id !== selectedId && !connected.has(node.id)) {
              return;
            }

            // Resolve fill + label colors:
            //   - no selection         → normal
            //   - this is the selected → highlight + always show label
            //   - this is a neighbor   → normal + always show label
            let fillColor: string;
            let labelColor: string;
            let forceLabel = false;
            if (!selectedId) {
              fillColor = c.node;
              labelColor = c.nodeMuted;
            } else if (node.id === selectedId) {
              fillColor = c.nodeHighlight;
              labelColor = c.nodeHighlight;
              forceLabel = true;
            } else {
              // 1-hop neighbor of the selected node.
              fillColor = c.node;
              labelColor = c.nodeMuted;
              forceLabel = true;
            }

            const radius = Math.sqrt(node.val ?? 1) * NODE_SIZE;
            ctx.beginPath();
            ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI, false);
            ctx.fillStyle = fillColor;
            ctx.fill();

            // Outline the selected node so it pops even more.
            if (node.id === selectedId) {
              ctx.lineWidth = 2 / scale;
              ctx.strokeStyle = c.nodeHighlight;
              ctx.stroke();
            }

            if (scale > 1.2 || forceLabel) {
              // Font scales inversely with zoom so labels stay a
              // consistent on-screen size.
              const fontSize = Math.max(10, 14 / scale);
              ctx.font = `${fontSize}px Inter, sans-serif`;
              ctx.textAlign = "center";
              ctx.textBaseline = "middle";
              ctx.fillStyle = labelColor;
              ctx.fillText(
                node.name ?? "",
                node.x,
                node.y + radius + fontSize * 0.9,
              );
            }
          },
        )
        .onNodeClick((node: any) => {
          // Toggle: clicking the already-selected node clears focus.
          const same = lockedNodeIdRef.current === node?.id;
          const nextLock = same ? null : (node?.id ?? null);
          lockedNodeIdRef.current = nextLock;
          applySelection(nextLock);
          // Still fire the parent's open-file handler so the editor
          // navigates as usual.
          if (!same) onNodeClickRef.current?.(node);
        })
        .onBackgroundClick(() => {
          lockedNodeIdRef.current = null;
          applySelection(null);
        })
        // Hover swaps the cursor between grab (background) and
        // pointer (node) — but ONLY when not actively dragging so
        // we don't flicker mid-pan.
        .onNodeHover((node: any) => {
          if (draggingRef.current) return;
          el.style.cursor = node ? "pointer" : "grab";
          if (!lockedNodeIdRef.current) {
            applySelection(node?.id ?? null);
          }
        })
        .onNodeDrag((node: any) => {
          // First tick of a drag: latch focus onto the grabbed node
          // so its 1-hop neighborhood lights up while the user drags
          // it around. `dragHadPriorSelectionRef` remembers whether
          // there was already a click-selection so we know whether
          // to restore it (or clear focus) on drag end.
          if (!draggingRef.current) {
            draggingRef.current = true;
            el.style.cursor = "grabbing";
            dragPriorSelectionRef.current = lockedNodeIdRef.current;
            lockedNodeIdRef.current = node?.id ?? null;
            if (selectedNodeIdRef.current !== node?.id) {
              applySelection(node?.id ?? null);
            }
          }
        })
        .onNodeDragEnd(() => {
          draggingRef.current = false;
          el.style.cursor = "grab";
          // Restore whatever focus state existed before the drag —
          // if the user had nothing selected, clear focus; if they
          // had a click-selection on a different node, put it back.
          // This keeps drag's highlight strictly transient so it
          // doesn't compete with the existing click-to-focus model.
          const prior = dragPriorSelectionRef.current;
          dragPriorSelectionRef.current = null;
          lockedNodeIdRef.current = prior;
          if (prior !== selectedNodeIdRef.current) {
            applySelection(prior);
          }
        });

      // ── Force tuning ───────────────────────────────────────────
      // The default d3-force config fans the network across the
      // entire pane, leaving huge empty borders and tiny clusters in
      // the middle. We tighten three forces so the layout stays
      // compact and readable:
      //   • charge: weaker repulsion. d3's default is ~-30 (NEGATIVE
      //     is repulsion). We use -120 with a distanceMax so the
      //     repulsion doesn't grow unboundedly across the canvas —
      //     this keeps disconnected nodes from flying off to the
      //     edges while still letting the local cluster breathe.
      //   • link distance: longer springs (60) since nodes are now
      //     much larger; 26 would jam edges through node centers.
      //   • center: strong pull toward (0,0) so disconnected nodes
      //     and isolated components don't drift off-camera.
      //   • collide: prevent nodes from overlapping (space constraint)
      inst.d3VelocityDecay(0.15); // lowered for elasticity
      inst.d3AlphaDecay(0.01);
      const charge = inst.d3Force?.("charge");
      if (charge?.strength) charge.strength(-160);
      if (charge?.distanceMax) charge.distanceMax(500);
      const link = inst.d3Force?.("link");
      if (link?.distance) link.distance(70);
      const center = inst.d3Force?.("center");
      if (center?.strength) center.strength(0.3);
      if (inst.d3Force) {
        // Add weak X/Y forces to pull orphans toward the center
        // since forceCenter only moves the center of mass.
        inst.d3Force("x", forceX(0).strength(0.015));
        inst.d3Force("y", forceY(0).strength(0.015));
        inst.d3Force("collide", forceCollide((node: any) => Math.sqrt(node.val ?? 1) * NODE_SIZE + 10).iterations(2));
      }

      // ── Custom wheel routing ───────────────────────────────────
      // Three input devices generate `wheel` events and we route each
      // to a different action:
      //
      //   1. MOUSE WHEEL    → zoom (let d3-zoom handle).
      //      Signal: deltaMode 1 (LINE) on most Chromium builds, OR
      //      deltaMode 0 with INTEGER deltaY in large discrete steps
      //      (~80–120 px per click). Always ctrlKey=false, deltaX=0.
      //
      //   2. TRACKPAD PINCH → zoom (let d3-zoom handle).
      //      Signal: ctrlKey === true (Chromium synthesizes this for
      //      pinch gestures on every platform).
      //
      //   3. TRACKPAD TWO-FINGER SWIPE → PAN (we handle).
      //      Signal: deltaMode 0 with FRACTIONAL deltaY (continuous
      //      gesture → sub-pixel deltas), OR any deltaX !== 0. We
      //      intercept these and pan the camera ourselves — otherwise
      //      d3-zoom would zoom in response to vertical swipes too.
      //
      // Why this works where the old `!Number.isInteger(deltaY)` test
      // failed: we also gate on `|deltaY| < 25` AND `deltaMode === 0`.
      // Trackpad swipes emit small high-frequency deltas (~5–20 px per
      // event); Windows hi-dpi mouse wheels emit fractional deltaY in
      // the ~33 px range (per past regression). The 25 px ceiling keeps
      // mouse wheels above the trackpad threshold so zoom still works
      // on mice that emit non-integer deltaY.
      const isTrackpadSwipe = (e: WheelEvent) => {
        if (e.ctrlKey) return false; // pinch — always zoom
        if (e.deltaX !== 0) return true; // any horizontal component
        if (e.deltaMode !== 0) return false; // line/page mode = real mouse
        if (Math.abs(e.deltaY) < 25 && e.deltaY !== Math.trunc(e.deltaY)) {
          return true;
        }
        return false;
      };
      const onWheel = (e: WheelEvent) => {
        if (!isTrackpadSwipe(e)) return; // mouse wheel or pinch → zoom
        // Trackpad two-finger swipe → pan the camera.
        e.preventDefault();
        e.stopImmediatePropagation();
        const g = instanceRef.current;
        if (!g) return;
        const c = g.centerAt?.() ?? { x: 0, y: 0 };
        const k = g.zoom?.() ?? 1;
        // Divide by zoom so a 100px swipe always moves the camera the
        // same visual distance regardless of zoom level.
        g.centerAt(c.x + e.deltaX / k, c.y + e.deltaY / k);
      };
      // Capture phase so we beat d3-zoom's listener.
      el.addEventListener("wheel", onWheel, { passive: false, capture: true });

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
      // We bump alpha briefly so the next render frame picks up the
      // new palette (force-graph caches paint output between frames
      // when the sim is cold).
      const themeObs = new MutationObserver(() => {
        const g = instanceRef.current;
        if (!g) return;
        if (typeof g.d3AlphaTarget === "function") g.d3AlphaTarget(0.02);
        if (typeof g.d3ReheatSimulation === "function") g.d3ReheatSimulation();
        window.setTimeout(() => {
          if (typeof instanceRef.current?.d3AlphaTarget === "function") {
            instanceRef.current.d3AlphaTarget(0);
          }
        }, 400);
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
        el.removeEventListener("wheel", onWheel, { capture: true } as any);
        el.removeEventListener("pointerdown", onPointerDown);
        window.removeEventListener("pointerup", onPointerUp);
        if (animationTimerRef.current !== null) {
          window.clearInterval(animationTimerRef.current);
          animationTimerRef.current = null;
        }
        if (instanceRef.current?._destructor) {
          instanceRef.current._destructor();
        }
        instanceRef.current = null;
        lastDataRef.current = null;
        framedRef.current = false;
      };
    }, []);

    // ── Push data only when structurally different ─────────────────
    useEffect(() => {
      if (!instanceRef.current) return;
      // Don't trample the wand's progressive-grow animation. The
      // animation manages graphData itself frame-by-frame; when it
      // finishes it sets lastDataRef to the full set so the next
      // parent push (with the same length) becomes a no-op.
      if (animatingRef.current) return;
      const last = lastDataRef.current;
      const same =
        last &&
        last.nodes.length === nodes.length &&
        last.links.length === links.length;
      if (same) return;
      // New parent data invalidates any focus that was on a now-stale id.
      if (selectedNodeIdRef.current) {
        const stillThere = nodes.some((n) => n.id === selectedNodeIdRef.current);
        if (!stillThere) {
          lockedNodeIdRef.current = null;
          selectedNodeIdRef.current = null;
          connectedNodeIdsRef.current = new Set();
        }
      }
      instanceRef.current.graphData({ nodes, links });
      lastDataRef.current = { nodes, links };
      // First data push for this canvas instance: let the simulation
      // settle for ~1 s, then frame the network so the user lands on a
      // sensible view instead of either (a) the default zoom-1 where
      // most of the graph is off-screen, or (b) a zoomed-out auto-fit
      // showing nodes as 2-pixel dots. We zoomToFit with a generous
      // padding so the framed network has breathing room.
      if (!framedRef.current) {
        framedRef.current = true;
        window.setTimeout(() => {
          instanceRef.current?.zoomToFit?.(800, 80);
        }, 1000);
      }
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
        growLayout: () => {
          const g = instanceRef.current;
          if (!g || !lastDataRef.current) return;
          // Cancel any in-progress grow animation first.
          if (animationTimerRef.current !== null) {
            window.clearInterval(animationTimerRef.current);
            animationTimerRef.current = null;
          }

          // Snapshot the FULL graph (the parent's source of truth)
          // before we tear down. We rebuild from this snapshot.
          const fullNodes: any[] = lastDataRef.current.nodes.map((n: any) => ({
            id: n.id,
            name: n.name,
            path: n.path,
            val: n.val,
          }));
          const fullLinks: any[] = lastDataRef.current.links.map((l: any) => ({
            source: typeof l.source === "object" ? l.source.id : l.source,
            target: typeof l.target === "object" ? l.target.id : l.target,
          }));
          if (fullNodes.length === 0) return;

          // Build adjacency for BFS + degree calc.
          const adjacency = new Map<string, Set<string>>();
          for (const n of fullNodes) adjacency.set(n.id, new Set());
          for (const l of fullLinks) {
            adjacency.get(l.source)?.add(l.target);
            adjacency.get(l.target)?.add(l.source);
          }

          // Seed = highest-degree node so the network grows from its
          // densest hub outward (visually most satisfying).
          let seed = fullNodes[0];
          let maxDeg = -1;
          for (const n of fullNodes) {
            const d = adjacency.get(n.id)?.size ?? 0;
            if (d > maxDeg) {
              maxDeg = d;
              seed = n;
            }
          }

          // BFS order from the seed. Disconnected components are
          // appended at the end so every node eventually shows up.
          const order: any[] = [];
          const seen = new Set<string>();
          const queue: string[] = [seed.id];
          seen.add(seed.id);
          order.push(seed);
          while (queue.length > 0) {
            const cur = queue.shift()!;
            for (const next of adjacency.get(cur) ?? []) {
              if (seen.has(next)) continue;
              seen.add(next);
              const nextNode = fullNodes.find((n) => n.id === next);
              if (nextNode) {
                order.push(nextNode);
                queue.push(next);
              }
            }
          }
          for (const n of fullNodes) {
            if (!seen.has(n.id)) order.push(n);
          }

          // Clear focus before animating; otherwise the dimmer kicks
          // in mid-grow and the build is confusing to watch.
          lockedNodeIdRef.current = null;
          selectedNodeIdRef.current = null;
          connectedNodeIdsRef.current = new Set();

          // Start fresh with just the seed at origin.
          animatingRef.current = true;
          const seedNode = { ...order[0], x: 0, y: 0, vx: 0, vy: 0 };
          let live: any[] = [seedNode];
          let liveLinks: any[] = [];
          g.graphData({ nodes: live, links: liveLinks });
          lastDataRef.current = { nodes: live, links: liveLinks };
          // Don't zoomToFit on a single node — that yields a near-
          // infinite zoom-in. We rely on the periodic re-fit during
          // the animation (every few ticks below) to keep the camera
          // tracking the growing layout.

          // Throttle add-rate so users actually see the build-up. Big
          // graphs would otherwise complete in a single frame.
          let i = 1;
          animationTimerRef.current = window.setInterval(() => {
            const inst = instanceRef.current;
            if (!inst || i >= order.length) {
              if (animationTimerRef.current !== null) {
                window.clearInterval(animationTimerRef.current);
                animationTimerRef.current = null;
              }
              animatingRef.current = false;
              setTimeout(() => instanceRef.current?.zoomToFit?.(600, 80), 200);
              return;
            }
            const nextRaw = order[i];
            // Spawn each new node near one of its already-placed
            // neighbors so the camera doesn't have to chase nodes
            // flying in from random corners.
            const neighborIds = adjacency.get(nextRaw.id) ?? new Set();
            const anchor = live.find((n) => neighborIds.has(n.id));
            const ax = anchor?.x ?? 0;
            const ay = anchor?.y ?? 0;
            const spawn = {
              ...nextRaw,
              x: ax + (Math.random() - 0.5) * 30,
              y: ay + (Math.random() - 0.5) * 30,
              vx: 0,
              vy: 0,
            };
            live = [...live, spawn];
            const liveIds = new Set(live.map((n) => n.id));
            // CRITICAL: force-graph MUTATES link objects in place,
            // replacing the string `source`/`target` IDs with node
            // object references after the first graphData() call.
            // If we filter `fullLinks` directly and pass those same
            // objects back in, by tick 2 every link's source/target
            // is an object — `liveIds.has(objectRef)` is always false
            // and we end up rendering nodes with no edges between
            // them. Clone each surviving link into a fresh object
            // every tick so force-graph mutates the copies and our
            // master list stays pristine.
            liveLinks = fullLinks
              .filter((l) => liveIds.has(l.source) && liveIds.has(l.target))
              .map((l) => ({ source: l.source, target: l.target }));
            inst.graphData({ nodes: live, links: liveLinks });
            lastDataRef.current = { nodes: live, links: liveLinks };
            if (typeof inst.d3ReheatSimulation === "function") {
              inst.d3ReheatSimulation();
            }
            // Periodically re-fit so the user sees the growing
            // network rather than a static frame around the seed.
            if (i % 6 === 0 && typeof inst.zoomToFit === "function") {
              inst.zoomToFit(400, 80);
            }
            i++;
          }, 90);
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
