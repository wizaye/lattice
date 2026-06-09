import { useCallback, useEffect, useMemo, useRef } from "react";
import { usePaperStore } from "../../state/paperStore";
import "./PaperToolbar.css";

/**
 * PaperToolbar — slim strip rendered above the markdown editor for
 * files that live inside a paper project.  Owns the Compile / Open /
 * Export-zip / Send-to-Overleaf actions plus the status pill and a
 * sticky error banner.
 *
 * Inputs:
 *   - `paperAbsPath` — absolute path to the paper root (the directory
 *     containing `.lattice/paper.toml`).  Used as the key into
 *     `paperStore.rows`.
 *
 * Behaviour:
 *   - On mount (and whenever `paperAbsPath` changes), kicks off a
 *     status refresh so the toolbar reflects on-disk state without
 *     waiting for the user to click Compile.
 *   - Compile delegates to `paperStore.compile(paperAbsPath)`.  On
 *     success we fire `lattice-open-paper-pdf` (window CustomEvent)
 *     so `App.tsx` can open the freshly-built PDF inline in the
 *     editor tab strip — same pattern as `lattice-open-new-paper`.
 *   - Export-zip delegates to `paperStore.emitBundle` and reveals the
 *     resulting zip in the OS file manager.
 *   - Send-to-Overleaf delegates to `paperStore.openOverleaf`, which
 *     re-emits the zip AND opens https://www.overleaf.com/project +
 *     reveals the zip so the user can drag-drop into Overleaf's
 *     upload dialog.
 *   - When `lastError` contains "No LaTeX engine", we render an
 *     inline tip pointing the user at Send-to-Overleaf — without
 *     this the no-local-TeX-install case looks like a hard failure
 *     when really there's a one-click no-install path.
 *   - Shell-out goes through `@tauri-apps/plugin-opener` via dynamic
 *     import (same pattern as `confirmDiscardDirty` in
 *     `EditorArea.tsx`), so the browser preview build doesn't try
 *     to statically resolve the Tauri-only module.
 */
type Props = {
  paperAbsPath: string;
};

const fmtTime = (iso: string | null): string | null => {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return null;
  }
};

/**
 * Heuristic: does the last-error string look like the user simply
 * doesn't have a LaTeX engine installed?  We match on the marker the
 * Rust side prints in `compile.rs` so we don't have to thread a
 * structured error kind through the IPC just for this UX bit.
 */
const isNoEngineError = (msg: string | null): boolean => {
  if (!msg) return false;
  const lower = msg.toLowerCase();
  return (
    lower.includes("no latex engine") ||
    lower.includes("no tex engine") ||
    (lower.includes("tectonic") &&
      lower.includes("latexmk") &&
      lower.includes("pdflatex"))
  );
};

export function PaperToolbar({ paperAbsPath }: Props) {
  const row = usePaperStore((s) => s.rows[paperAbsPath]);
  const refreshStatus = usePaperStore((s) => s.refreshStatus);
  const compile = usePaperStore((s) => s.compile);
  const emitBundle = usePaperStore((s) => s.emitBundle);
  const openOverleaf = usePaperStore((s) => s.openOverleaf);

  useEffect(() => {
    if (!paperAbsPath) return;
    void refreshStatus(paperAbsPath);
  }, [paperAbsPath, refreshStatus]);

  // Auto-open the compiled PDF inline once compile succeeds.  We
  // dedupe via a ref so re-renders triggered by other row updates
  // (e.g. emitBundle setting lastBundlePath) don't re-fire the
  // open-event for the same already-opened PDF.
  const lastOpenedPdf = useRef<string | null>(null);
  const lastPdfPath = row?.lastPdfPath ?? null;
  useEffect(() => {
    if (!lastPdfPath) return;
    if (lastOpenedPdf.current === lastPdfPath) return;
    lastOpenedPdf.current = lastPdfPath;
    // Fire-and-forget — App.tsx listens for this and routes it
    // through the vault store + `onOpenFileByPath` so the PDF
    // opens as a real editor tab using `PdfView`.
    window.dispatchEvent(
      new CustomEvent("lattice-open-paper-pdf", {
        detail: { absPath: lastPdfPath, paperAbsPath },
      }),
    );
  }, [lastPdfPath, paperAbsPath]);

  const onCompile = useCallback(() => {
    void compile(paperAbsPath);
  }, [paperAbsPath, compile]);

  const onOpenPdf = useCallback(async () => {
    if (!lastPdfPath) return;
    try {
      const mod = await import("@tauri-apps/plugin-opener");
      await mod.openPath(lastPdfPath);
    } catch (err) {
      const url = `file:///${lastPdfPath.replace(/\\/g, "/")}`;
      window.open(url, "_blank", "noreferrer");
      console.warn("openPath failed, falling back to file:// URL:", err);
    }
  }, [lastPdfPath]);

  const onExportZip = useCallback(async () => {
    try {
      const zipPath = await emitBundle(paperAbsPath);
      // Reveal the zip in the OS file manager so the user can grab
      // it.  Non-fatal if it fails (the path is still in the
      // toolbar's hint text below).
      try {
        const mod = await import("@tauri-apps/plugin-opener");
        await mod.revealItemInDir(zipPath);
      } catch (err) {
        console.warn("revealItemInDir failed:", err);
      }
    } catch {
      // emitBundle already populated `lastError`; nothing to do here.
    }
  }, [emitBundle, paperAbsPath]);

  const onOpenOverleaf = useCallback(() => {
    void openOverleaf(paperAbsPath);
  }, [openOverleaf, paperAbsPath]);

  const busy = row?.busy ?? false;
  const lastError = row?.lastError ?? null;
  const lastCompiledAt = row?.lastCompiledAt ?? null;
  const lastBundlePath = row?.lastBundlePath ?? null;
  const title = row?.title ?? null;
  const noEngine = isNoEngineError(lastError);

  const status = useMemo(() => {
    if (busy) return "Working…";
    if (lastError) return null; // error rendered separately
    const t = fmtTime(lastCompiledAt);
    if (t) return `Compiled ${t}`;
    return "Not yet compiled";
  }, [busy, lastError, lastCompiledAt]);

  return (
    <>
      <div className="paper-toolbar" data-testid="paper-toolbar">
        <span className="paper-toolbar-title">{title ?? "Paper"}</span>
        <button
          type="button"
          className="paper-toolbar-btn primary"
          onClick={onCompile}
          disabled={busy}
          title="Compile this paper to PDF via tectonic / latexmk / pdflatex"
        >
          {busy ? "Working…" : "Compile PDF"}
        </button>
        <button
          type="button"
          className="paper-toolbar-btn"
          onClick={onOpenPdf}
          disabled={!lastPdfPath || busy}
          title={lastPdfPath ?? "Compile first to enable Open"}
        >
          Open PDF
        </button>
        <button
          type="button"
          className="paper-toolbar-btn"
          onClick={onExportZip}
          disabled={busy}
          title={
            lastBundlePath
              ? `Last zip: ${lastBundlePath}`
              : "Build an Overleaf-ready zip with main.tex, references.bib, and assets/"
          }
        >
          Export .zip
        </button>
        <button
          type="button"
          className="paper-toolbar-btn"
          onClick={onOpenOverleaf}
          disabled={busy}
          title="Build the zip and open Overleaf — drag-drop to compile in the cloud (no local LaTeX install needed)"
        >
          Send to Overleaf
        </button>
        {status && (
          <span className={`paper-toolbar-status${busy ? "" : lastPdfPath ? " ok" : ""}`}>
            {status}
          </span>
        )}
        <div className="paper-toolbar-spacer" />
      </div>
      {lastError && (
        <div className="paper-toolbar-error" role="alert">
          {lastError}
          {noEngine && (
            <div className="paper-toolbar-error-hint">
              No local LaTeX engine on your PATH (tectonic / latexmk / pdflatex /
              xelatex). Click <strong>Send to Overleaf</strong> above to compile
              in the cloud — no install needed.
            </div>
          )}
        </div>
      )}
    </>
  );
}
