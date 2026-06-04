import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { IcClose, IcMaximize, IcMinimize } from "./Icons";

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
 */
function safeWindow() {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

export function WindowControls() {
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

  return (
    <div className="win-controls">
      <button
        className="win-btn"
        title="Minimize"
        onClick={() => w()?.minimize().catch(() => {})}
      >
        <IcMinimize />
      </button>
      <button
        className="win-btn"
        title={maximized ? "Restore" : "Maximize"}
        onClick={() => w()?.toggleMaximize().catch(() => {})}
      >
        <IcMaximize />
      </button>
      <button
        className="win-btn close"
        title="Close"
        onClick={() => w()?.close().catch(() => {})}
      >
        <IcClose />
      </button>
    </div>
  );
}
