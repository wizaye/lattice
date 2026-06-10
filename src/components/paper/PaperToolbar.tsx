import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePaperStore } from "../../state/paperStore";
import {
  paperEngineInstall,
  paperEngineProbe,
  type EngineInstaller,
  type EngineProbe,
} from "../../lib/paper";
import "./PaperToolbar.css";

/**
 * PaperToolbar — slim strip rendered above the markdown editor for
 * files that live inside a paper project.  Owns the Compile / Open /
 * Send-to-Overleaf actions plus an output-format select, the status
 * pill and a sticky error banner.
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
 *   - Compile honours the output-format select:
 *       * "pdf"  → `paperStore.compile(paperAbsPath)` only (the local
 *                  tectonic / latexmk / pdflatex pipeline).  On
 *                  success we fire `lattice-open-paper-pdf` (window
 *                  CustomEvent) so `App.tsx` opens the freshly-built
 *                  PDF inline in the editor tab strip.
 *       * "zip"  → `paperStore.emitBundle(paperAbsPath)` only — never
 *                  invokes LaTeX, never requires a local engine.
 *                  Reveals the resulting zip in the OS file manager
 *                  so the user can drag-drop into Overleaf.
 *       * "both" → runs PDF then zip sequentially.  If PDF compile
 *                  fails (no engine on PATH), the zip is still
 *                  emitted — the user can fall back to Overleaf for
 *                  the cloud render without a second click.
 *   - Send-to-Overleaf is the one-click cloud path: builds the zip
 *     AND opens https://www.overleaf.com/project + reveals the zip.
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

type OutputMode = "pdf" | "zip" | "both";

const OUTPUT_OPTIONS: ReadonlyArray<{
  value: OutputMode;
  label: string;
  title: string;
}> = [
  {
    value: "pdf",
    label: "PDF (local)",
    title: "Compile to PDF using the local LaTeX engine (tectonic / latexmk / pdflatex)",
  },
  {
    value: "zip",
    label: "LaTeX project (.zip)",
    title: "Bundle main.tex + references.bib + assets/ into an Overleaf-ready zip — no local LaTeX needed",
  },
  {
    value: "both",
    label: "Both (PDF + .zip)",
    title: "Compile the PDF AND emit the Overleaf zip in one click",
  },
];

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

  // Output-format select: PDF (local), LaTeX zip (Overleaf-ready),
  // or both.  Kept as local state — the choice is per-toolbar-session
  // and intentionally does not persist across vault opens (defaults
  // are friendlier than a stale "zip only" sticky setting on a fresh
  // machine).
  const [outputMode, setOutputMode] = useState<OutputMode>("pdf");

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

  const onCompile = useCallback(async () => {
    // Honour the output-format select.  We intentionally do not
    // early-return on PDF failure when mode === "both" — the zip is
    // a useful fallback (the most common "compile failed" cause on a
    // fresh machine is "no LaTeX engine on PATH", and the zip is
    // exactly the workaround for that).  `compile`/`emitBundle`
    // already populate `lastError` on the row when they throw, so we
    // just swallow here.
    if (outputMode === "pdf") {
      void compile(paperAbsPath);
      return;
    }
    if (outputMode === "zip") {
      try {
        const zipPath = await emitBundle(paperAbsPath);
        try {
          const mod = await import("@tauri-apps/plugin-opener");
          await mod.revealItemInDir(zipPath);
        } catch (err) {
          console.warn("revealItemInDir failed:", err);
        }
      } catch {
        /* lastError already set */
      }
      return;
    }
    // mode === "both"
    try {
      await compile(paperAbsPath);
    } catch {
      /* lastError already set — continue to zip anyway */
    }
    try {
      const zipPath = await emitBundle(paperAbsPath);
      try {
        const mod = await import("@tauri-apps/plugin-opener");
        await mod.revealItemInDir(zipPath);
      } catch (err) {
        console.warn("revealItemInDir failed:", err);
      }
    } catch {
      /* lastError already set */
    }
  }, [outputMode, paperAbsPath, compile, emitBundle]);

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

  const onOpenOverleaf = useCallback(() => {
    void openOverleaf(paperAbsPath);
  }, [openOverleaf, paperAbsPath]);

  const busy = row?.busy ?? false;
  const lastError = row?.lastError ?? null;
  const lastCompiledAt = row?.lastCompiledAt ?? null;
  const lastBundlePath = row?.lastBundlePath ?? null;
  const title = row?.title ?? null;
  const noEngine = isNoEngineError(lastError);

  // ── Engine install affordance ────────────────────────────────────────
  // When the user hits the "No LaTeX engine" wall we offer a
  // one-click install via the platform-appropriate installer (direct
  // GitHub-release download on Windows; brew / apt-get / cargo
  // elsewhere).  The probe runs lazily ONLY when noEngine is
  // true so the toolbar stays cheap for the happy path.
  const [enginePreflight, setEnginePreflight] = useState<EngineProbe | null>(null);
  const [engineInstalling, setEngineInstalling] = useState(false);
  const [engineInstallError, setEngineInstallError] = useState<string | null>(null);
  useEffect(() => {
    if (!noEngine) {
      // Reset so a future no-engine error re-probes a fresh state
      // (e.g. user installed Tectonic externally, hit compile,
      // expects the toolbar to know).
      setEnginePreflight(null);
      setEngineInstallError(null);
      return;
    }
    let cancelled = false;
    paperEngineProbe()
      .then((p) => {
        if (cancelled) return;
        setEnginePreflight(p);
      })
      .catch(() => {
        /* swallow — banner falls back to "manual install" copy */
      });
    return () => {
      cancelled = true;
    };
  }, [noEngine]);

  const onInstallEngine = useCallback(async () => {
    setEngineInstalling(true);
    setEngineInstallError(null);
    try {
      const after = await paperEngineInstall();
      setEnginePreflight(after);
      // Engine is now on PATH — clear the row's lastError so the
      // banner self-dismisses and the user can hit Compile again
      // without a stale "no engine" error sitting there.
      if (after.anyEngine) {
        usePaperStore.setState((s) => {
          const cur = s.rows[paperAbsPath];
          if (!cur) return s;
          return {
            rows: { ...s.rows, [paperAbsPath]: { ...cur, lastError: null } },
          };
        });
      }
    } catch (e) {
      setEngineInstallError(e instanceof Error ? e.message : String(e));
    } finally {
      setEngineInstalling(false);
    }
  }, [paperAbsPath]);

  const status = useMemo(() => {
    if (busy) return "Working…";
    if (lastError) return null; // error rendered separately
    const t = fmtTime(lastCompiledAt);
    if (t) return `Compiled ${t}`;
    return "Not yet compiled";
  }, [busy, lastError, lastCompiledAt]);

  // Compile-button label tracks the select so the primary action is
  // self-describing.  "Compile" alone reads ambiguous now that the
  // button can produce a zip with no LaTeX run.
  const compileLabel = useMemo(() => {
    if (busy) return "Working…";
    if (outputMode === "zip") return "Build .zip";
    if (outputMode === "both") return "Compile both";
    return "Compile PDF";
  }, [busy, outputMode]);

  const activeOption = OUTPUT_OPTIONS.find((o) => o.value === outputMode);
  const compileTitle = activeOption?.title ?? "";

  return (
    <>
      <div className="paper-toolbar" data-testid="paper-toolbar">
        <span className="paper-toolbar-title">{title ?? "Paper"}</span>
        <label className="paper-toolbar-select-wrap" title="Choose what Compile produces">
          <span className="paper-toolbar-select-label">Output</span>
          <select
            className="paper-toolbar-select"
            value={outputMode}
            onChange={(e) => setOutputMode(e.target.value as OutputMode)}
            disabled={busy}
            data-testid="paper-toolbar-output-select"
          >
            {OUTPUT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value} title={opt.title}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="paper-toolbar-btn primary"
          onClick={onCompile}
          disabled={busy}
          title={compileTitle}
        >
          {compileLabel}
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
          onClick={onOpenOverleaf}
          disabled={busy}
          title={
            lastBundlePath
              ? `Last zip: ${lastBundlePath} — opens Overleaf and reveals the zip`
              : "Build the zip and open Overleaf — drag-drop to compile in the cloud (no local LaTeX install needed)"
          }
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
              xelatex). Switch <strong>Output</strong> to <strong>LaTeX project
              (.zip)</strong> and click Build, or use <strong>Send to
              Overleaf</strong> to compile in the cloud — no install needed.
              {enginePreflight?.installer && (
                <div className="paper-toolbar-engine-install">
                  <button
                    type="button"
                    className="paper-toolbar-btn primary"
                    onClick={onInstallEngine}
                    disabled={engineInstalling}
                    title={`Install Tectonic via ${INSTALLER_LABEL[enginePreflight.installer]}`}
                  >
                    {engineInstalling
                      ? `Installing via ${INSTALLER_LABEL[enginePreflight.installer]}…`
                      : `Install Tectonic via ${INSTALLER_LABEL[enginePreflight.installer]}`}
                  </button>
                  {engineInstallError && (
                    <div className="paper-toolbar-engine-install-error">
                      {engineInstallError}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}

const INSTALLER_LABEL: Record<EngineInstaller, string> = {
  direct: "direct download",
  homebrew: "Homebrew",
  apt: "apt-get",
  cargo: "cargo",
};
