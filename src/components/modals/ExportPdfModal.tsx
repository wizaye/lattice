import { useState, useCallback } from "react";
import "./ExportPdfModal.css";

// ── Types ──────────────────────────────────────────────────────────────────

type PageSize = "A4" | "Letter" | "Legal" | "A3" | "A5";
type MarginPreset = "Default" | "None" | "Small" | "Large";

const PAGE_SIZES: PageSize[] = ["A4", "Letter", "Legal", "A3", "A5"];
const MARGIN_PRESETS: MarginPreset[] = ["Default", "None", "Small", "Large"];

// Matches Obsidian's actual margin presets
const MARGIN_CSS: Record<MarginPreset, string> = {
  Default: "1.27cm",  // 0.5 inch — Obsidian default
  None: "0",
  Small: "0.635cm",   // 0.25 inch
  Large: "2.54cm",    // 1 inch
};

// ── Toggle ──────────────────────────────────────────────────────────────────

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="epdf-toggle">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="epdf-toggle-track">
        <span className="epdf-toggle-thumb" />
      </span>
    </label>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

interface Props {
  /** File name (with or without .md extension) to show in the subtitle. */
  fileName: string;
  onClose: () => void;
}

export function ExportPdfModal({ fileName, onClose }: Props) {
  const displayName = fileName.replace(/\.md$/i, "") || "Untitled";

  const [includeTitle, setIncludeTitle] = useState(true);
  const [pageSize, setPageSize] = useState<PageSize>("Letter");
  const [landscape, setLandscape] = useState(false);
  const [margin, setMargin] = useState<MarginPreset>("Default");
  const [downscale, setDownscale] = useState(100);

  const onExport = useCallback(() => {
    // 1. Inject @page CSS so the browser print dialog picks up our settings
    let styleEl = document.getElementById(
      "lattice-pdf-page-style",
    ) as HTMLStyleElement | null;
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = "lattice-pdf-page-style";
      document.head.appendChild(styleEl);
    }
    const orientation = landscape ? "landscape" : "portrait";
    styleEl.textContent = `@page { size: ${pageSize} ${orientation}; margin: ${MARGIN_CSS[margin]}; }`;

    // 2. Optionally inject an H1 title above the printed content
    let titleEl: HTMLElement | null = null;
    if (includeTitle) {
      titleEl = document.createElement("div");
      titleEl.id = "lattice-pdf-title-inject";
      titleEl.style.cssText =
        "display:none;margin:0 0 1.2em;font-size:1.8em;font-weight:700;";
      titleEl.textContent = displayName;
      // Prepend into the markdown preview host so it's the first print item
      const host =
        document.querySelector(".markdown-preview-host") ??
        document.querySelector(".pane-body");
      if (host) host.prepend(titleEl);
    }

    // 3. Apply downscale zoom on the content area
    const contentEl = document.querySelector(
      ".markdown-preview-host",
    ) as HTMLElement | null;
    const origZoom = contentEl?.style.zoom ?? "";
    if (contentEl && downscale !== 100) {
      contentEl.style.zoom = `${downscale / 100}`;
    }

    // 4. Close the modal first so it doesn't appear in the print output,
    //    then trigger the browser print dialog.
    onClose();
    setTimeout(() => {
      window.print();
      // Cleanup after the print dialog closes
      const cleanup = () => {
        titleEl?.remove();
        styleEl?.remove();
        if (contentEl) contentEl.style.zoom = origZoom;
        window.removeEventListener("afterprint", cleanup);
      };
      window.addEventListener("afterprint", cleanup);
      // Belt-and-suspenders: also clean up after 5s in case afterprint
      // doesn't fire (some Chromium builds + Tauri WebView2)
      setTimeout(cleanup, 5000);
    }, 80);
  }, [displayName, includeTitle, pageSize, landscape, margin, downscale, onClose]);

  return (
    <div
      className="epdf-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Export to PDF"
      onClick={onClose}
    >
      <div className="epdf-dialog" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="epdf-header">
          <span className="epdf-title">Export to PDF</span>
          <button
            className="epdf-close-btn"
            title="Close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Subtitle */}
        <p className="epdf-subtitle">
          Export "{displayName}" to PDF with the settings below.
        </p>

        {/* Settings rows */}
        <div className="epdf-rows">
          {/* Include file name as title */}
          <div className="epdf-row">
            <span className="epdf-row-label">Include file name as title</span>
            <Toggle checked={includeTitle} onChange={setIncludeTitle} />
          </div>

          {/* Page size */}
          <div className="epdf-row">
            <span className="epdf-row-label">Page size</span>
            <select
              className="epdf-select"
              value={pageSize}
              onChange={(e) => setPageSize(e.target.value as PageSize)}
            >
              {PAGE_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>

          {/* Landscape */}
          <div className="epdf-row">
            <span className="epdf-row-label">Landscape</span>
            <Toggle checked={landscape} onChange={setLandscape} />
          </div>

          {/* Margin */}
          <div className="epdf-row">
            <span className="epdf-row-label">Margin</span>
            <select
              className="epdf-select"
              value={margin}
              onChange={(e) => setMargin(e.target.value as MarginPreset)}
            >
              {MARGIN_PRESETS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>

          {/* Downscale */}
          <div className="epdf-row epdf-row--slider">
            <span className="epdf-row-label">Downscale percent</span>
            <div className="epdf-slider-wrap">
              <input
                type="range"
                className="epdf-slider"
                min={50}
                max={100}
                step={5}
                value={downscale}
                onChange={(e) => setDownscale(Number(e.target.value))}
              />
              <span className="epdf-slider-val">{downscale}%</span>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="epdf-footer">
          <button className="epdf-btn-export" onClick={onExport}>
            Export to PDF
          </button>
          <button className="epdf-btn-cancel" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
