import { useCallback, useEffect, useMemo } from "react";
import { usePaperStore } from "../../state/paperStore";
import "./PaperToolbar.css";

/**
 * PaperToolbar — slim strip rendered above the markdown editor for
 * files that live inside a paper project.  Owns the "Compile PDF"
 * action + status display + "Open compiled PDF" affordance.
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
 *   - Compile delegates to `paperStore.compile(paperAbsPath)`, which
 *     handles busy/error transitions and persists the PDF path into
 *     the row on success.
 *   - "Open PDF" routes through the `@tauri-apps/plugin-opener`
 *     dynamic import (same pattern as `confirmDiscardDirty` in
 *     `EditorArea.tsx`), so the browser preview build doesn't try to
 *     statically resolve the Tauri-only module.
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

export function PaperToolbar({ paperAbsPath }: Props) {
  const row = usePaperStore((s) => s.rows[paperAbsPath]);
  const refreshStatus = usePaperStore((s) => s.refreshStatus);
  const compile = usePaperStore((s) => s.compile);

  useEffect(() => {
    if (!paperAbsPath) return;
    void refreshStatus(paperAbsPath);
  }, [paperAbsPath, refreshStatus]);

  const onCompile = useCallback(() => {
    void compile(paperAbsPath);
  }, [paperAbsPath, compile]);

  const onOpenPdf = useCallback(async () => {
    const pdfPath = row?.lastPdfPath;
    if (!pdfPath) return;
    try {
      // Tauri 2 — plugin-opener exposes `openPath` for OS-default
      // file handlers.  Dynamic import so the browser dev build
      // (where the plugin isn't bundled) doesn't choke at module
      // resolution time.
      const mod = await import("@tauri-apps/plugin-opener");
      await mod.openPath(pdfPath);
    } catch (err) {
      // Fallback for the plain `vite dev` browser preview: open a
      // file:// URL in a new tab.  Most browsers block this by
      // default but it's the best we can do off-shell.
      const url = `file:///${pdfPath.replace(/\\/g, "/")}`;
      window.open(url, "_blank", "noreferrer");
      console.warn("openPath failed, falling back to file:// URL:", err);
    }
  }, [row?.lastPdfPath]);

  const busy = row?.busy ?? false;
  const lastError = row?.lastError ?? null;
  const lastPdfPath = row?.lastPdfPath ?? null;
  const lastCompiledAt = row?.lastCompiledAt ?? null;
  const title = row?.title ?? null;

  const status = useMemo(() => {
    if (busy) return "Compiling…";
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
          {busy ? "Compiling…" : "Compile PDF"}
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
        </div>
      )}
    </>
  );
}
