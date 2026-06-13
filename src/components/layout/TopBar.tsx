import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Window control cluster (minimize / maximize / close).
 * Absolutely positioned at the top-right of the app, always visible
 * regardless of which column lies beneath. Tauri 2 borderless window.
 *
 * Browser-safe: when the Tauri runtime is absent (e.g. plain
 * `vite dev` preview at localhost:1420), `getCurrentWindow()` throws
 * because `window.__TAURI_INTERNALS__` is undefined. Wrapped in
 * `safeWindow()` so the controls render as inert no-ops and the rest
 * of the app stays usable for visual inspection.
 *
 * Glyphs are inline SVGs sized to a 10x10 viewBox and rendered with a
 * 1px hairline stroke \u2014 the exact metrics Windows 11 Mica chrome ships
 * for caption controls (Segoe Fluent Icons). Stays crisp at all DPI
 * because the parent `.win-btn` constrains them to 14x14 px.
 */
function safeWindow() {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

// Stock Windows 11 chrome glyphs. `shape-rendering: crispEdges` keeps
// the 1px strokes pixel-aligned so they read as the same flat lines the
// native title-bar draws.
const svgProps = {
  viewBox: "0 0 10 10",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1,
  shapeRendering: "crispEdges" as const,
};

function GlyphMinimize() {
  return (
    <svg {...svgProps}>
      <line x1="0" y1="5" x2="10" y2="5" />
    </svg>
  );
}

function GlyphMaximize() {
  return (
    <svg {...svgProps}>
      <rect x="0.5" y="0.5" width="9" height="9" />
    </svg>
  );
}

function GlyphRestore() {
  // Two overlapping squares: the back one shifted up-right by 2px,
  // matching the Segoe Fluent "ChromeRestore" glyph (E923).
  return (
    <svg {...svgProps}>
      <rect x="0.5" y="2.5" width="7" height="7" />
      <path d="M2.5 2.5 V 0.5 H 9.5 V 7.5 H 7.5" />
    </svg>
  );
}

function GlyphClose() {
  return (
    <svg {...svgProps}>
      <line x1="0.5" y1="0.5" x2="9.5" y2="9.5" />
      <line x1="9.5" y1="0.5" x2="0.5" y2="9.5" />
    </svg>
  );
}

export function WindowControls() {
  const isMac = typeof window !== "undefined" && navigator.userAgent.includes("Mac");
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const w = safeWindow();
    if (!w) return;
    w.isMaximized().then(setMaximized).catch(() => {});
    const p = w.onResized(() => {
      w.isMaximized().then(setMaximized).catch(() => {});
    });
    return () => {
      p.then((u) => u()).catch(() => {});
    };
  }, []);

  const w = () => safeWindow();

  if (isMac) return null;

  return (
    <div className="win-controls">
      <button
        className="win-btn"
        title="Minimize"
        onClick={() => w()?.minimize().catch(() => {})}
      >
        <GlyphMinimize />
      </button>
      <button
        className="win-btn"
        title={maximized ? "Restore" : "Maximize"}
        onClick={() => w()?.toggleMaximize().catch(() => {})}
      >
        {maximized ? <GlyphRestore /> : <GlyphMaximize />}
      </button>
      <button
        className="win-btn close"
        title="Close"
        onClick={() => w()?.close().catch(() => {})}
      >
        <GlyphClose />
      </button>
    </div>
  );
}
