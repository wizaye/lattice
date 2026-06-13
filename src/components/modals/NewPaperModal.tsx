import { useCallback, useEffect, useMemo, useState } from "react";
import { IcClose, IcMinus, IcPlus } from "../common/Icons";
import { usePaperStore } from "../../state/paperStore";
import {
  paperEngineInstall,
  paperEngineProbe,
  paperQuickPdf,
  type EngineInstaller,
  type EngineProbe,
  type NewPaperAuthor,
  type TemplateInfo,
} from "../../lib/paper";
import "./NewPaperModal.css";

/**
 * NewPaperModal — Slice C (phase C1) wizard.
 *
 * Mounts the **real** `paper_list_templates` + `paper_create` IPCs.
 * Auto-refreshes the template list when the dialog opens; renders
 * the result card after a successful create with paths + an "Open
 * file" CTA that calls `onOpenPath(openRelPath)`.
 *
 * Output format select (PDF / LaTeX project .zip / Both / Folder
 * only):  the modal scaffolds the paper folder first, then — if
 * the user chose anything other than "folder only" — IMMEDIATELY
 * runs the chosen pipeline.  This is the difference between
 * "created a folder, you figure out the rest" and "created a paper
 * AND handed you the PDF / zip you wanted".
 *
 * Mock vault is rejected at the UI level — the dialog body shows
 * a hint inviting the user to open a real folder.  This matches
 * `ChangesPanel`'s mock-vault handling and means the create button
 * never silently no-ops (which was the BYOC mock-vault bug we hit
 * during slice B).
 */
type Props = {
  open: boolean;
  /** Absolute vault path or `null` (disabled state). */
  vaultPath: string | null;
  vaultName: string;
  onClose: () => void;
  /**
   * Fired after a successful create with the vault-relative path the
   * editor should open.  App wires this to its existing
   * `onOpenFileByPath` opener so the new paper lands in a tab.
   */
  onOpenPath?: (vaultRelPath: string) => void;
  /**
   * Currently-active markdown file in the editor, if any.  When the
   * user picks "PDF (local)" output, the wizard uses this as the
   * source content for the produced PDF (instead of compiling the
   * template's dummy example text into the user's vault).  Pass
   * `null` when no markdown file is open — the wizard falls back to
   * the template's example content in that case.
   */
  activeMarkdown?: { name: string; body: string } | null;
};



const blankAuthor = (): NewPaperAuthor => ({ name: "" });

/**
 * What Create should produce after scaffolding the paper folder.
 * Mirrors `PaperToolbar`'s `OutputMode` plus a `"folder"` no-op
 * for users who explicitly want only the folder structure (e.g.
 * they plan to edit before compiling).
 */
type OutputMode = "pdf" | "zip" | "both" | "folder";

const OUTPUT_OPTIONS: ReadonlyArray<{
  value: OutputMode;
  label: string;
  hint: string;
}> = [
  {
    value: "pdf",
    label: "PDF only",
    hint:
      "Render to a single PDF in the chosen folder. No project files are added to your vault. " +
      "If a markdown note is open, its content is rendered; otherwise the template's example content is used.",
  },
  {
    value: "zip",
    label: "LaTeX project (.zip)",
    hint: "Bundle main.tex + references.bib + assets/ as an Overleaf-ready zip. No local LaTeX install needed.",
  },
  {
    value: "both",
    label: "Project folder + PDF + .zip",
    hint:
      "Scaffold the full paper project (sections/, figures/, bibliography.bib, …) in your vault AND compile PDF + emit the Overleaf zip.",
  },
  {
    value: "folder",
    label: "Project folder only",
    hint: "Scaffold the full paper project in your vault. Compile later from the toolbar above the editor.",
  },
];

export function NewPaperModal({
  open,
  vaultPath,
  vaultName,
  onClose,
  onOpenPath,
  activeMarkdown,
}: Props) {
  const templates = usePaperStore((s) => s.templates);
  const refreshTemplates = usePaperStore((s) => s.refreshTemplates);
  const createPaper = usePaperStore((s) => s.createPaper);
  const compile = usePaperStore((s) => s.compile);
  const emitBundle = usePaperStore((s) => s.emitBundle);

  const isMockVault = !vaultPath;

  // ── Form state ────────────────────────────────────────────────────────
  const [title, setTitle] = useState("");
  const [parentRel, setParentRel] = useState("");
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [authors, setAuthors] = useState<NewPaperAuthor[]>([blankAuthor()]);
  const [outputMode, setOutputMode] = useState<OutputMode>("pdf");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Status line shown under the form while we run the post-scaffold
  // compile / bundle step.  Lets the user see progress instead of
  // staring at a frozen "Creating…" button.
  const [postStatus, setPostStatus] = useState<string | null>(null);
  const [created, setCreated] = useState<{
    /** Absolute path of the scaffolded paper folder. `null` for quick-PDF mode. */
    paperAbsPath: string | null;
    /** Vault-relative path of the paper folder. `null` for quick-PDF mode. */
    paperRelPath: string | null;
    /** Relative path the editor should open after create. `null` for quick-PDF mode. */
    openRelPath: string | null;
    /** Absolute PDF path if compile ran AND succeeded. */
    pdfPath: string | null;
    /** Absolute zip path if emit-bundle ran AND succeeded. */
    zipPath: string | null;
    /** Mode the user picked (for the result card copy). */
    mode: OutputMode;
    /** True when the user's open note was used as the source (vs template content). */
    seededFromActive: boolean;
  } | null>(null);

  // ── LaTeX-engine preflight ────────────────────────────────────────────
  // Auto-runs when the modal opens so we can warn the user BEFORE they
  // pick "pdf" as the output and dead-end on a no-engine machine.
  // `enginePreflightBusy` covers both the initial probe AND the
  // one-click install — both block the Create button while running.
  const [enginePreflight, setEnginePreflight] = useState<EngineProbe | null>(null);
  const [enginePreflightBusy, setEnginePreflightBusy] = useState<
    "probing" | "installing" | null
  >(null);
  const [enginePreflightError, setEnginePreflightError] = useState<string | null>(
    null,
  );

  // ── Reset on close ────────────────────────────────────────────────────
  useEffect(() => {
    if (open) return;
    setTitle("");
    setParentRel("");
    setAuthors([blankAuthor()]);
    setOutputMode("pdf");
    setError(null);
    setPostStatus(null);
    setCreated(null);
    setSubmitting(false);
    setEnginePreflight(null);
    setEnginePreflightBusy(null);
    setEnginePreflightError(null);
  }, [open]);

  // ── Esc closes ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // ── Load templates on open ────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    refreshTemplates(isMockVault ? null : vaultPath).catch(() => {
      /* errors are surfaced into per-row state by the store */
    });
  }, [open, vaultPath, isMockVault, refreshTemplates]);

  // ── Engine preflight on open ──────────────────────────────────────────
  // Runs the LaTeX-engine probe BEFORE the user picks an output
  // format.  If no engine is on PATH, we render an inline banner with
  // a one-click "Install Tectonic" button — the user can install
  // without leaving the modal, then pick "PDF" with confidence.
  // The probe is cheap (~50 ms when an engine exists, ~5 s worst case
  // on a no-engine box) and idempotent, so running it on every open
  // is safe and means "user just installed an engine in another window"
  // gets reflected without a reload.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setEnginePreflightBusy("probing");
    setEnginePreflightError(null);
    paperEngineProbe()
      .then((p) => {
        if (cancelled) return;
        setEnginePreflight(p);
      })
      .catch((e) => {
        if (cancelled) return;
        // Probe failure is non-fatal — surface as a banner but let
        // the user proceed (their machine may have an engine the
        // probe missed; the compile step will surface the real
        // error if so).
        setEnginePreflightError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (cancelled) return;
        setEnginePreflightBusy(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const onInstallEngine = useCallback(async () => {
    setEnginePreflightBusy("installing");
    setEnginePreflightError(null);
    try {
      const after = await paperEngineInstall();
      setEnginePreflight(after);
    } catch (e) {
      setEnginePreflightError(e instanceof Error ? e.message : String(e));
    } finally {
      setEnginePreflightBusy(null);
    }
  }, []);

  const onRecheckEngine = useCallback(async () => {
    setEnginePreflightBusy("probing");
    setEnginePreflightError(null);
    try {
      const p = await paperEngineProbe();
      setEnginePreflight(p);
    } catch (e) {
      setEnginePreflightError(e instanceof Error ? e.message : String(e));
    } finally {
      setEnginePreflightBusy(null);
    }
  }, []);

  // ── Default-select first template once they arrive ───────────────────
  useEffect(() => {
    if (templateId) return;
    if (templates.length === 0) return;
    setTemplateId(templates[0]?.id ?? null);
  }, [templates, templateId]);

  const selected = useMemo<TemplateInfo | null>(
    () => templates.find((t) => t.id === templateId) ?? null,
    [templates, templateId],
  );

  // Output modes that REQUIRE a local LaTeX engine.  "both" is
  // included even though it can degrade to "zip-only" — we want the
  // banner to prompt the user to install upfront rather than after
  // the compile fails halfway through Create.
  const outputNeedsEngine =
    outputMode === "pdf" || outputMode === "both";
  const engineMissing =
    enginePreflight !== null && !enginePreflight.anyEngine;
  /**
   * Show the preflight banner when:
   *   - probe says no engine AND
   *   - the current output mode needs one (pdf / both).
   * "zip" / "folder" never need an engine, so the banner stays
   * hidden to avoid pointless noise.
   */
  const showEngineBanner =
    !created && !isMockVault && engineMissing && outputNeedsEngine;

  const canCreate =
    !isMockVault &&
    !submitting &&
    !created &&
    enginePreflightBusy !== "installing" &&
    title.trim().length > 0 &&
    templateId !== null;

  const updateAuthor = useCallback(
    (idx: number, patch: Partial<NewPaperAuthor>) => {
      setAuthors((cur) =>
        cur.map((a, i) => (i === idx ? { ...a, ...patch } : a)),
      );
    },
    [],
  );

  const addAuthor = useCallback(() => {
    setAuthors((cur) => [...cur, blankAuthor()]);
  }, []);
  const removeAuthor = useCallback((idx: number) => {
    setAuthors((cur) => (cur.length === 1 ? cur : cur.filter((_, i) => i !== idx)));
  }, []);

  const onSubmit = useCallback(async () => {
    if (!canCreate || !vaultPath || !templateId) return;
    setSubmitting(true);
    setError(null);
    setPostStatus(null);
    try {
      const cleanedAuthors = authors
        .map((a) => ({
          name: a.name.trim(),
          email: a.email?.trim() || null,
          affiliation: a.affiliation?.trim() || null,
          orcid: a.orcid?.trim() || null,
        }))
        .filter((a) => a.name.length > 0);

      // ─── Quick PDF path ────────────────────────────────────────────
      // When the user picks "PDF only", we deliberately AVOID writing
      // a project scaffold into their vault.  The Rust IPC scaffolds
      // into the OS temp dir, optionally seeds the section content
      // with the currently-open note's body, compiles, copies just
      // the PDF into the chosen folder, then cleans up the temp dir.
      // This addresses the user complaint that picking "PDF" was
      // dumping dozens of template example files into their vault.
      if (outputMode === "pdf") {
        const seed =
          activeMarkdown && activeMarkdown.body.trim().length > 0
            ? activeMarkdown.body
            : null;
        setPostStatus(
          seed
            ? `Compiling “${activeMarkdown!.name}” to PDF…`
            : "Compiling PDF from template content…",
        );
        try {
          const quick = await paperQuickPdf({
            vault: vaultPath,
            parentRel: parentRel.trim() || undefined,
            title: title.trim(),
            templateId,
            authors: cleanedAuthors.length > 0 ? cleanedAuthors : undefined,
            seedMarkdown: seed,
          });
          setCreated({
            paperAbsPath: null,
            paperRelPath: null,
            openRelPath: null,
            pdfPath: quick.pdfAbsPath,
            zipPath: null,
            mode: "pdf",
            seededFromActive: seed !== null,
          });
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
        return;
      }

      // ─── Project-scaffold path (zip / both / folder) ───────────────
      // Same flow as before: write the full §12 scaffold to the vault,
      // then optionally compile and/or emit the Overleaf zip.
      const result = await createPaper({
        vault: vaultPath,
        parentRel: parentRel.trim() || undefined,
        title: title.trim(),
        templateId,
        authors: cleanedAuthors.length > 0 ? cleanedAuthors : undefined,
      });

      // ── Post-scaffold pipeline ─────────────────────────────────────
      // Honour the Output-format select.  We run the steps inline
      // (rather than just bouncing the user to the toolbar) so the
      // result card can show real PDF / zip paths.  Compile errors
      // (e.g. no LaTeX engine on PATH) trigger an automatic zip
      // fallback in "pdf" mode — because zipping needs zero
      // external tooling and Overleaf can compile it for the user.
      // The user always leaves the modal with at least one usable
      // artefact (folder, PDF, or zip).
      let pdfPath: string | null = null;
      let zipPath: string | null = null;
      let pdfError: string | null = null;
      let zipError: string | null = null;

      if (outputMode === "both") {
        setPostStatus("Compiling PDF…");
        try {
          await compile(result.paperAbsPath);
          // paperStore.compile swallows errors into the row's
          // `lastError`; we look it up to detect failure.  Re-read
          // via `usePaperStore.getState()` so we see the just-set
          // post-compile state, not the snapshot from React render.
          const row = usePaperStore.getState().rows[result.paperAbsPath];
          if (row?.lastError) {
            pdfError = row.lastError;
          } else {
            pdfPath = row?.lastPdfPath ?? null;
          }
        } catch (e) {
          pdfError = e instanceof Error ? e.message : String(e);
        }
      }

      const runZip = outputMode === "zip" || outputMode === "both";

      if (runZip) {
        setPostStatus("Building LaTeX project (.zip)…");
        try {
          zipPath = await emitBundle(result.paperAbsPath);
        } catch (e) {
          zipError = e instanceof Error ? e.message : String(e);
        }
      }

      // emitBundle clears `lastError` on success.  Restore the
      // compile failure into row.lastError so the toolbar / status
      // pill stay honest about the PDF state (e.g. "PDF failed,
      // zip succeeded" — user needs to know PDF didn't render).
      if (pdfError && zipPath) {
        const errMsg = pdfError;
        const absPath = result.paperAbsPath;
        usePaperStore.setState((s) => {
          const cur = s.rows[absPath];
          if (!cur) return s;
          return {
            rows: { ...s.rows, [absPath]: { ...cur, lastError: errMsg } },
          };
        });
      }

      setCreated({
        ...result,
        pdfPath,
        zipPath,
        mode: outputMode,
        seededFromActive: false,
      });

      // Build a single user-facing error string that captures
      // whatever went wrong.  Prefer the most actionable line
      // (zip failure > pdf failure) so the footer hint points at
      // the first thing the user should fix.
      if (zipError) {
        setError(zipError);
      } else if (pdfError && !zipPath) {
        setError(pdfError);
      } else if (pdfError && zipPath) {
        // PDF failed but we successfully emitted the zip — hint
        // the user toward the working artefact rather than the
        // failure.  Keeps the modal friendly on no-engine machines.
        setError(
          `PDF compile failed (${pdfError.split("\n")[0]}). Built the LaTeX project (.zip) instead — upload it to Overleaf to render.`,
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
      setPostStatus(null);
    }
  }, [
    canCreate,
    vaultPath,
    templateId,
    authors,
    parentRel,
    title,
    outputMode,
    activeMarkdown,
    createPaper,
    compile,
    emitBundle,
  ]);

  const onOpenPdf = useCallback(async () => {
    const p = created?.pdfPath;
    if (!p) return;
    try {
      const mod = await import("@tauri-apps/plugin-opener");
      await mod.openPath(p);
    } catch (err) {
      const url = `file:///${p.replace(/\\/g, "/")}`;
      window.open(url, "_blank", "noreferrer");
      console.warn("openPath failed, falling back to file:// URL:", err);
    }
  }, [created]);

  const onRevealZip = useCallback(async () => {
    const z = created?.zipPath;
    if (!z) return;
    try {
      const mod = await import("@tauri-apps/plugin-opener");
      await mod.revealItemInDir(z);
    } catch (err) {
      console.warn("revealItemInDir failed:", err);
    }
  }, [created]);

  // ── Retry actions for the result card ──────────────────────────────────────
  // Lets the user re-attempt the missing artefact (zip OR pdf)
  // without closing the dialog and re-running the whole flow.
  // Useful when (a) PDF compile failed and user wants the zip
  // fallback explicitly, or (b) PDF succeeded but they realised
  // they also wanted the Overleaf-ready zip.
  const [retryBusy, setRetryBusy] = useState<"pdf" | "zip" | null>(null);

  const onRetryZip = useCallback(async () => {
    if (!created?.paperAbsPath) return;
    setRetryBusy("zip");
    setError(null);
    try {
      const z = await emitBundle(created.paperAbsPath);
      setCreated({ ...created, zipPath: z });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRetryBusy(null);
    }
  }, [created, emitBundle]);

  const onRetryPdf = useCallback(async () => {
    if (!created?.paperAbsPath) return;
    setRetryBusy("pdf");
    setError(null);
    try {
      await compile(created.paperAbsPath);
      const row = usePaperStore.getState().rows[created.paperAbsPath];
      if (row?.lastError) {
        setError(row.lastError);
      } else if (row?.lastPdfPath) {
        setCreated({ ...created, pdfPath: row.lastPdfPath });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRetryBusy(null);
    }
  }, [created, compile]);

  const onOpenCreated = useCallback(() => {
    if (!created?.openRelPath) return;
    onOpenPath?.(created.openRelPath);
    onClose();
  }, [created, onOpenPath, onClose]);

  if (!open) return null;

  return (
    <div
      className="np-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="New paper"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="np-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="np-close"
          title="Close"
          aria-label="Close New paper"
          onClick={onClose}
        >
          <IcClose />
        </button>

        <div className="np-header">
          <div className="np-title">New paper</div>
          <div className="np-subtitle">
            {!vaultPath
              ? "Open a vault folder to scaffold a paper."
              : `Scaffold a paper folder in "${vaultName}" using a built-in template.`}
          </div>
        </div>

        <div className="np-body">
          {/* Left rail — templates */}
          <div className="np-templates" role="listbox" aria-label="Templates">
            {templates.length === 0 && (
              <div className="np-hint" style={{ padding: "10px" }}>
                Loading templates…
              </div>
            )}
            {templates.map((t) => (
              <button
                key={t.id}
                type="button"
                role="option"
                aria-selected={t.id === templateId}
                className={`np-template${t.id === templateId ? " active" : ""}`}
                onClick={() => setTemplateId(t.id)}
              >
                <div className="np-template-label">
                  <span>{t.label}</span>
                  <span
                    className={`np-template-badge${t.source === "byof" ? " byof" : ""}`}
                  >
                    {t.source === "byof" ? "BYOF" : t.defaultEngine}
                  </span>
                </div>
                <div className="np-template-desc">{t.description}</div>
              </button>
            ))}
          </div>

          {/* Right column — form OR result card */}
          {created ? (
            <div className="np-form">
              <div className="np-result">
                <div>
                  <strong>
                    {created.mode === "pdf"
                      ? created.seededFromActive
                        ? "PDF created from your note."
                        : "PDF created from template content."
                      : "Created. Paper scaffolded successfully."}
                  </strong>
                </div>
                {created.paperAbsPath && (
                  <div className="np-result-path">{created.paperAbsPath}</div>
                )}
                {created.mode === "pdf" && (
                  <div className="np-hint">
                    No project files were added to your vault — only the PDF.
                  </div>
                )}
                {created.pdfPath && (
                  <div className="np-result-row">
                    <span className="np-result-row-label">PDF</span>
                    <span className="np-result-row-path" title={created.pdfPath}>
                      {created.pdfPath}
                    </span>
                    <button
                      type="button"
                      className="np-btn np-result-row-btn"
                      onClick={onOpenPdf}
                    >
                      Open PDF
                    </button>
                  </div>
                )}
                {created.zipPath && (
                  <div className="np-result-row">
                    <span className="np-result-row-label">.zip</span>
                    <span className="np-result-row-path" title={created.zipPath}>
                      {created.zipPath}
                    </span>
                    <button
                      type="button"
                      className="np-btn np-result-row-btn"
                      onClick={onRevealZip}
                    >
                      Reveal zip
                    </button>
                  </div>
                )}
                {/* Retry row — always show whichever artefact is still
                    missing.  Lets the user recover from a PDF compile
                    failure (no engine on PATH) by building the zip on
                    demand without reopening the wizard.  Only meaningful
                    for project-scaffold modes — quick-PDF has nothing to
                    retry against (no paper folder exists). */}
                {created.paperAbsPath && (!created.pdfPath || !created.zipPath) && (
                  <div
                    className="np-result-retry"
                    role="group"
                    aria-label="Retry missing artefacts"
                  >
                    {!created.zipPath && (
                      <button
                        type="button"
                        className="np-btn"
                        onClick={onRetryZip}
                        disabled={retryBusy !== null}
                      >
                        {retryBusy === "zip"
                          ? "Building …"
                          : "Build LaTeX project (.zip)"}
                      </button>
                    )}
                    {!created.pdfPath && (
                      <button
                        type="button"
                        className="np-btn"
                        onClick={onRetryPdf}
                        disabled={retryBusy !== null}
                      >
                        {retryBusy === "pdf" ? "Compiling …" : "Retry PDF compile"}
                      </button>
                    )}
                  </div>
                )}
                {created.openRelPath && (
                  <div className="np-hint">
                    Open relative path:{" "}
                    <span style={{ fontFamily: "var(--font-mono)" }}>
                      {created.openRelPath}
                    </span>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="np-form">
              {showEngineBanner && (
                <EnginePreflightBanner
                  probe={enginePreflight!}
                  busy={enginePreflightBusy}
                  error={enginePreflightError}
                  onInstall={onInstallEngine}
                  onRecheck={onRecheckEngine}
                  onSwitchToZip={() => setOutputMode("zip")}
                />
              )}

              <div className="np-field">
                <label htmlFor="np-title">Title</label>
                <input
                  id="np-title"
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="On the Asymptotic Behaviour of Lattice Vaults"
                  disabled={submitting}
                  autoFocus
                />
              </div>

              <div className="np-field">
                <label htmlFor="np-parent">Folder (vault-relative, optional)</label>
                <input
                  id="np-parent"
                  type="text"
                  value={parentRel}
                  onChange={(e) => setParentRel(e.target.value)}
                  placeholder="research/papers"
                  disabled={submitting}
                />
                <div className="np-hint">
                  Leave empty to scaffold at the vault root. A subfolder is created
                  automatically from the slugged title.
                </div>
              </div>

              <div className="np-field">
                <label>Authors</label>
                <div className="np-authors-list">
                  {authors.map((a, i) => (
                    <div className="np-author-row" key={i}>
                      <input
                        type="text"
                        value={a.name}
                        onChange={(e) => updateAuthor(i, { name: e.target.value })}
                        placeholder="Name"
                        disabled={submitting}
                      />
                      <input
                        type="text"
                        value={a.email ?? ""}
                        onChange={(e) => updateAuthor(i, { email: e.target.value })}
                        placeholder="email@example.com"
                        disabled={submitting}
                      />
                      <button
                        type="button"
                        className="np-author-remove"
                        title="Remove author"
                        aria-label="Remove author"
                        onClick={() => removeAuthor(i)}
                        disabled={submitting || authors.length === 1}
                      >
                        <IcMinus />
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  className="np-author-add"
                  onClick={addAuthor}
                  disabled={submitting}
                >
                  <IcPlus /> Add author
                </button>
              </div>

              {selected && (
                <div className="np-hint">
                  Default engine for <strong>{selected.label}</strong>:{" "}
                  <span style={{ fontFamily: "var(--font-mono)" }}>
                    {selected.defaultEngine}
                  </span>
                  . You can switch engines from the paper toolbar after creation.
                </div>
              )}

              {/* Output format — picks what Create produces AFTER the
                  folder scaffold.  Defaults to "pdf" (the friendliest
                  for a user with a working LaTeX install); "zip" is
                  the no-engine fallback that uploads to Overleaf;
                  "both" hedges the bet; "folder" is the old
                  scaffold-only behaviour for users who plan to edit
                  before compiling. */}
              <div className="np-field">
                <label>Output format</label>
                <div
                  className="np-output-grid"
                  role="radiogroup"
                  aria-label="Output format"
                >
                  {OUTPUT_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      role="radio"
                      aria-checked={opt.value === outputMode}
                      className={`np-output-option${
                        opt.value === outputMode ? " active" : ""
                      }`}
                      onClick={() => setOutputMode(opt.value)}
                      disabled={submitting}
                      data-testid={`np-output-${opt.value}`}
                      title={opt.hint}
                    >
                      <span className="np-output-option-label">{opt.label}</span>
                      <span className="np-output-option-hint">{opt.hint}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="np-footer">
          <div className="np-footer-error">{error ?? postStatus ?? ""}</div>
          <div className="np-footer-buttons">
            <button type="button" className="np-btn" onClick={onClose}>
              {created ? "Close" : "Cancel"}
            </button>
            {created ? (
              <button
                type="button"
                className="np-btn primary"
                onClick={created.openRelPath ? onOpenCreated : onOpenPdf}
                disabled={
                  created.openRelPath
                    ? !onOpenPath
                    : !created.pdfPath
                }
              >
                {created.openRelPath ? "Open file" : "Open PDF"}
              </button>
            ) : (
              <button
                type="button"
                className="np-btn primary"
                onClick={onSubmit}
                disabled={!canCreate}
              >
                {submitting
                  ? postStatus ?? "Creating…"
                  : outputMode === "folder"
                    ? "Create paper"
                    : outputMode === "pdf"
                      ? "Render PDF"
                      : outputMode === "zip"
                        ? "Create + Build .zip"
                        : "Create + Compile both"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Engine preflight banner ──────────────────────────────────────────────
//
// Rendered inside the form when the local LaTeX-engine probe came back
// empty AND the selected output mode needs one.  Lets the user install
// Tectonic via the platform-appropriate installer (direct GitHub-
// release download on Windows; brew / apt-get / cargo elsewhere)
// without leaving the modal — the moment install succeeds the
// banner self-dismisses and "Create + Compile PDF" becomes safe again.
//
// Falls back to a friendly "no installer found — switch to .zip or
// install manually" copy when the probe reports no installer at all
// (e.g. minimal Linux boxes without brew or apt-get).  The user can
// still escape via the secondary "Use LaTeX project (.zip) instead"
// button so we never dead-end them.

const INSTALLER_LABEL: Record<EngineInstaller, string> = {
  direct: "direct download",
  homebrew: "Homebrew",
  apt: "apt-get",
  cargo: "cargo",
};

function EnginePreflightBanner(props: {
  probe: EngineProbe;
  busy: "probing" | "installing" | null;
  error: string | null;
  onInstall: () => void;
  onRecheck: () => void;
  onSwitchToZip: () => void;
}) {
  const { probe, busy, error, onInstall, onRecheck, onSwitchToZip } = props;
  const installerLabel = probe.installer ? INSTALLER_LABEL[probe.installer] : null;
  const installing = busy === "installing";
  const hasInstaller = probe.installer !== null;
  return (
    <div className="np-engine-banner" role="status">
      <div className="np-engine-banner-title">
        <span className="np-engine-banner-icon" aria-hidden="true">⚠</span>
        No LaTeX engine detected on this machine.
      </div>
      <div className="np-engine-banner-body">
        Compiling to PDF needs <code>tectonic</code>, <code>latexmk</code>, or{" "}
        <code>pdflatex</code> on <code>PATH</code>.{" "}
        {installerLabel ? (
          <>
            Lattice can install <strong>Tectonic</strong> for you via{" "}
            <strong>{installerLabel}</strong> — a single self-contained binary,
            ~30 MB.
          </>
        ) : (
          <>
            No supported installer available (no winget Tectonic package,
            no brew / apt-get / cargo on PATH). Install Tectonic from{" "}
            <code>tectonic-typesetting.github.io/install</code> or use the
            LaTeX project (.zip) output and let Overleaf compile it for you.
          </>
        )}
      </div>
      {error && <div className="np-engine-banner-error">{error}</div>}
      <div className="np-engine-banner-actions">
        {hasInstaller && installerLabel && (
          <button
            type="button"
            className="np-btn primary"
            onClick={onInstall}
            disabled={installing}
          >
            {installing
              ? `Installing via ${installerLabel}…`
              : `Install Tectonic via ${installerLabel}`}
          </button>
        )}
        <button
          type="button"
          className="np-btn"
          onClick={onRecheck}
          disabled={busy !== null}
        >
          {busy === "probing" ? "Re-checking…" : "Re-check engine"}
        </button>
        <button type="button" className="np-btn" onClick={onSwitchToZip}>
          Use LaTeX project (.zip) instead
        </button>
      </div>
    </div>
  );
}
