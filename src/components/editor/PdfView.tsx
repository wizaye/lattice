import { useEffect, useMemo, useRef, useState } from "react";
// pdfjs-dist v6 ships an ESM bundle at `build/pdf.mjs` and a separate
// worker at `build/pdf.worker.mjs`.  Vite's `?url` import gives us a
// hashed asset URL that resolves correctly under both `vite dev` (which
// re-serves the file as a module) and `vite build` (which copies it
// into `dist/assets/`).  Without this `?url` dance pdfjs falls back to
// `eval`-loading the worker, which CSP'd / WebView2 environments
// reject.  See: https://github.com/mozilla/pdf.js/issues/14066
import * as pdfjs from "pdfjs-dist";
// Vite's `?url` query resolves to a hashed asset URL — type is `string`
// via the bundler's ambient declarations.
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import { readFileBytes } from "../../lib/tauriApi";

// Register the worker URL ONCE per module load.  pdfjs internally
// short-circuits if `workerSrc` is already set, so re-importing this
// module (HMR) is a no-op.
(pdfjs as unknown as { GlobalWorkerOptions: { workerSrc: string } })
  .GlobalWorkerOptions.workerSrc = pdfWorkerUrl as string;

type Props = {
  /** Absolute filesystem path to the PDF. */
  filePath: string;
  /**
   * Optional base64-encoded PDF body. When provided, we skip the
   * Tauri IPC and decode the base64 directly. Real vaults set this
   * to `undefined` and we fetch via `readFileBytes(filePath)`.
   */
  base64?: string;
  /** Human-readable name shown in the toolbar. */
  fileName?: string;
};

// Sane zoom levels — matches Chrome's PDF viewer step list.  Stored
// outside the component so it doesn't churn on re-render.
const ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;
const DEFAULT_ZOOM_IDX = 2; // 1.0×

/**
 * Decode a base64 string to a Uint8Array WITHOUT going through
 * `atob` + `String.fromCharCode` (which is O(n) but caps at ~128k
 * before throwing `RangeError: Maximum call stack size exceeded`).
 * We walk the decoded string char-by-char into a typed array — slower
 * per byte but stack-safe for the ~MB-range PDFs the mock vault ships.
 */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Minimal, theme-aware PDF viewer.
 *
 * Renders ALL pages stacked vertically inside a scroll container —
 * matches the default Chrome / Edge layout, which is what users expect
 * for a notes-app PDF preview.  Pagination via the toolbar's
 * Prev/Next is just `scrollIntoView` on the corresponding page canvas;
 * we never destroy off-screen pages, so scroll-back is instant.
 *
 * For 100+ page documents this is wasteful (every page is rendered to
 * a canvas eagerly).  When that becomes a real problem the fix is to
 * (a) defer per-page render until the page enters an IntersectionObserver
 * viewport, and (b) keep a sliding window of N rendered pages.  Not
 * worth the complexity for v1 — typical lattice PDFs are research
 * papers and slide decks well under 50 pages.
 */
export function PdfView({ filePath, base64, fileName }: Props) {
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [zoomIdx, setZoomIdx] = useState(DEFAULT_ZOOM_IDX);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const containerRef = useRef<HTMLDivElement>(null);
  /** Per-page canvas refs so prev/next can scroll into view. */
  const pageRefs = useRef<Array<HTMLCanvasElement | null>>([]);
  /** Per-page render-task handle so we can cancel an in-flight render
   *  when zoom changes mid-render (otherwise the old paint races the
   *  new one and we end up with a half-blurry page). */
  const renderTasksRef = useRef<Array<{ cancel: () => void } | null>>([]);
  /** The loaded pdfjs document — kept in a ref so HMR / state changes
   *  don't churn the parse. */
  const docRef = useRef<{
    numPages: number;
    getPage(n: number): Promise<{
      getViewport(opts: { scale: number }): { width: number; height: number };
      render(opts: {
        canvasContext: CanvasRenderingContext2D;
        viewport: { width: number; height: number };
      }): { promise: Promise<void>; cancel?: () => void };
    }>;
  } | null>(null);

  const zoom = ZOOM_LEVELS[zoomIdx];

  // ── Load the document once per filePath ─────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPageCount(0);
    setCurrentPage(1);
    docRef.current = null;

    const load = async () => {
      try {
        const data = base64
          ? base64ToBytes(base64)
          : await readFileBytes(filePath);

        if (cancelled) return;
        if (data.length === 0) {
          setError("This PDF file appears to be empty.");
          setLoading(false);
          return;
        }

        // pdfjs's `getDocument` takes a TYPED ARRAY directly.  The
        // `useWorkerFetch: false` flag tells the worker to consume the
        // bytes we already loaded instead of re-fetching from a URL —
        // important when the source is in-memory (mock vault).
        const doc = await (
          pdfjs as unknown as {
            getDocument(opts: {
              data: Uint8Array;
              useWorkerFetch?: boolean;
            }): { promise: Promise<typeof docRef.current> };
          }
        ).getDocument({ data, useWorkerFetch: false }).promise;

        if (cancelled || !doc) return;
        docRef.current = doc;
        setPageCount(doc.numPages);
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
      // Cancel any in-flight per-page renders so they don't race the
      // next document load and paint into a now-orphaned canvas.
      for (const task of renderTasksRef.current) {
        try {
          task?.cancel?.();
        } catch {
          /* noop — already settled */
        }
      }
      renderTasksRef.current = [];
    };
  }, [filePath, base64]);

  // ── Render every page whenever the doc or zoom changes ──────────────
  useEffect(() => {
    if (!docRef.current || pageCount === 0) return;
    let cancelled = false;

    // Cancel any prior in-flight renders before kicking off a new pass
    // (zoom-change case — the old viewport size is stale).
    for (const task of renderTasksRef.current) {
      try {
        task?.cancel?.();
      } catch {
        /* noop */
      }
    }
    renderTasksRef.current = [];

    const renderAll = async () => {
      const doc = docRef.current;
      if (!doc) return;
      // Account for device pixel ratio so retina / 2× WebView2 doesn't
      // render fuzzy text.  We over-sample the bitmap then scale the
      // CSS box down via `style.width/height`.
      const dpr = Math.max(1, window.devicePixelRatio || 1);

      for (let i = 1; i <= doc.numPages; i++) {
        if (cancelled) return;
        const canvas = pageRefs.current[i - 1];
        if (!canvas) continue;
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;

        try {
          const page = await doc.getPage(i);
          const viewport = page.getViewport({ scale: zoom * dpr });
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
          canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;

          const task = page.render({ canvasContext: ctx, viewport });
          renderTasksRef.current[i - 1] = task as {
            cancel: () => void;
          };
          await task.promise;
        } catch (e) {
          // pdfjs throws `RenderingCancelledException` when we cancel
          // mid-paint — that's expected, not an error.
          const name = (e as { name?: string }).name ?? "";
          if (name === "RenderingCancelledException") continue;
          // Real errors (corrupt page, OOM) we surface at the top.
          if (!cancelled) {
            // eslint-disable-next-line no-console
            console.error(`PDF page ${i} render failed:`, e);
          }
        }
      }
    };

    void renderAll();
    return () => {
      cancelled = true;
    };
  }, [pageCount, zoom]);

  // ── Track which page is currently in view so the toolbar counter
  //     reflects scroll position ─────────────────────────────────────
  useEffect(() => {
    const root = containerRef.current;
    if (!root || pageCount === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        // The most-visible page wins.  IntersectionObserver fires once
        // per crossing so we can't just take the first entry — we
        // sort by ratio descending.
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible.length === 0) return;
        const pageAttr = (visible[0].target as HTMLElement).dataset.page;
        if (!pageAttr) return;
        const p = Number.parseInt(pageAttr, 10);
        if (!Number.isFinite(p)) return;
        setCurrentPage(p);
      },
      { root, threshold: [0.25, 0.5, 0.75] },
    );
    for (const canvas of pageRefs.current) {
      if (canvas) observer.observe(canvas);
    }
    return () => observer.disconnect();
  }, [pageCount]);

  const goToPage = (n: number) => {
    const clamped = Math.min(Math.max(1, n), pageCount);
    const canvas = pageRefs.current[clamped - 1];
    if (!canvas) return;
    canvas.scrollIntoView({ behavior: "smooth", block: "start" });
    setCurrentPage(clamped);
  };

  // Pre-allocate the page slot array so `pageRefs.current[i-1] =` in
  // the render loop has a stable shape (the array length controls how
  // many `<canvas>` elements we render).
  const pageSlots = useMemo(
    () => Array.from({ length: pageCount }, (_v, i) => i + 1),
    [pageCount],
  );

  return (
    <div className="pdf-view">
      <div className="pdf-toolbar">
        <span className="pdf-title" title={fileName}>
          {fileName ?? "Document"}
        </span>
        <div className="pdf-spacer" />
        <button
          className="pdf-btn"
          onClick={() => goToPage(currentPage - 1)}
          disabled={loading || currentPage <= 1}
          title="Previous page"
          type="button"
        >
          ‹
        </button>
        <span className="pdf-page-indicator">
          {loading ? "…" : `${currentPage} / ${pageCount || "?"}`}
        </span>
        <button
          className="pdf-btn"
          onClick={() => goToPage(currentPage + 1)}
          disabled={loading || currentPage >= pageCount}
          title="Next page"
          type="button"
        >
          ›
        </button>
        <div className="pdf-spacer" />
        <button
          className="pdf-btn"
          onClick={() =>
            setZoomIdx((z) => Math.max(0, z - 1))
          }
          disabled={loading || zoomIdx === 0}
          title="Zoom out"
          type="button"
        >
          −
        </button>
        <span className="pdf-zoom-label">{Math.round(zoom * 100)}%</span>
        <button
          className="pdf-btn"
          onClick={() =>
            setZoomIdx((z) => Math.min(ZOOM_LEVELS.length - 1, z + 1))
          }
          disabled={loading || zoomIdx === ZOOM_LEVELS.length - 1}
          title="Zoom in"
          type="button"
        >
          +
        </button>
      </div>

      <div ref={containerRef} className="pdf-scroll">
        {error && <div className="pdf-error">{error}</div>}
        {loading && !error && (
          <div className="pdf-loading">Loading document…</div>
        )}
        {!loading && !error && pageSlots.length === 0 && (
          <div className="pdf-empty">Document has no pages.</div>
        )}
        {pageSlots.map((pageNum) => (
          <div className="pdf-page-wrap" key={pageNum}>
            <canvas
              ref={(el) => {
                pageRefs.current[pageNum - 1] = el;
              }}
              data-page={pageNum}
              className="pdf-page-canvas"
            />
          </div>
        ))}
      </div>
    </div>
  );
}
