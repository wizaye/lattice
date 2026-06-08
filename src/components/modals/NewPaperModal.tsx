import { useCallback, useEffect, useMemo, useState } from "react";
import { IcClose, IcMinus, IcPlus } from "../common/Icons";
import { usePaperStore } from "../../state/paperStore";
import type { NewPaperAuthor, TemplateInfo } from "../../lib/paper";
import "./NewPaperModal.css";

/**
 * NewPaperModal — Slice C (phase C1) wizard.
 *
 * Mounts the **real** `paper_list_templates` + `paper_create` IPCs.
 * Auto-refreshes the template list when the dialog opens; renders
 * the result card after a successful create with paths + an "Open
 * file" CTA that calls `onOpenPath(openRelPath)`.
 *
 * Mock vault is rejected at the UI level — the dialog body shows
 * a hint inviting the user to open a real folder.  This matches
 * `ChangesPanel`'s mock-vault handling and means the create button
 * never silently no-ops (which was the BYOC mock-vault bug we hit
 * during slice B).
 */
type Props = {
  open: boolean;
  /** Absolute vault path or `null` / `"__mock__"` (disabled state). */
  vaultPath: string | null;
  vaultName: string;
  onClose: () => void;
  /**
   * Fired after a successful create with the vault-relative path the
   * editor should open.  App wires this to its existing
   * `onOpenFileByPath` opener so the new paper lands in a tab.
   */
  onOpenPath?: (vaultRelPath: string) => void;
};

const MOCK_VAULT = "__mock__";

const blankAuthor = (): NewPaperAuthor => ({ name: "" });

export function NewPaperModal({ open, vaultPath, vaultName, onClose, onOpenPath }: Props) {
  const templates = usePaperStore((s) => s.templates);
  const refreshTemplates = usePaperStore((s) => s.refreshTemplates);
  const createPaper = usePaperStore((s) => s.createPaper);

  const isMockVault = vaultPath === MOCK_VAULT || !vaultPath;

  // ── Form state ────────────────────────────────────────────────────────
  const [title, setTitle] = useState("");
  const [parentRel, setParentRel] = useState("");
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [authors, setAuthors] = useState<NewPaperAuthor[]>([blankAuthor()]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{
    paperAbsPath: string;
    paperRelPath: string;
    openRelPath: string;
  } | null>(null);

  // ── Reset on close ────────────────────────────────────────────────────
  useEffect(() => {
    if (open) return;
    setTitle("");
    setParentRel("");
    setAuthors([blankAuthor()]);
    setError(null);
    setCreated(null);
    setSubmitting(false);
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

  const canCreate =
    !isMockVault &&
    !submitting &&
    !created &&
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
    try {
      const cleanedAuthors = authors
        .map((a) => ({
          name: a.name.trim(),
          email: a.email?.trim() || null,
          affiliation: a.affiliation?.trim() || null,
          orcid: a.orcid?.trim() || null,
        }))
        .filter((a) => a.name.length > 0);

      const result = await createPaper({
        vault: vaultPath,
        parentRel: parentRel.trim() || undefined,
        title: title.trim(),
        templateId,
        authors: cleanedAuthors.length > 0 ? cleanedAuthors : undefined,
      });
      setCreated(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [canCreate, vaultPath, templateId, authors, parentRel, title, createPaper]);

  const onOpenCreated = useCallback(() => {
    if (!created) return;
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
            {isMockVault
              ? "Open a real vault folder to scaffold a paper."
              : `Scaffold a paper folder in “${vaultName}” using a built-in template.`}
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
                  <strong>Created.</strong> Paper scaffolded successfully.
                </div>
                <div className="np-result-path">{created.paperAbsPath}</div>
                <div className="np-hint">
                  Open relative path:{" "}
                  <span style={{ fontFamily: "var(--font-mono)" }}>
                    {created.openRelPath}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <div className="np-form">
              <div className="np-field">
                <label htmlFor="np-title">Title</label>
                <input
                  id="np-title"
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="On the Asymptotic Behaviour of Lattice Vaults"
                  disabled={isMockVault || submitting}
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
                  disabled={isMockVault || submitting}
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
                        disabled={isMockVault || submitting}
                      />
                      <input
                        type="text"
                        value={a.email ?? ""}
                        onChange={(e) => updateAuthor(i, { email: e.target.value })}
                        placeholder="email@example.com"
                        disabled={isMockVault || submitting}
                      />
                      <button
                        type="button"
                        className="np-author-remove"
                        title="Remove author"
                        aria-label="Remove author"
                        onClick={() => removeAuthor(i)}
                        disabled={isMockVault || submitting || authors.length === 1}
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
                  disabled={isMockVault || submitting}
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
            </div>
          )}
        </div>

        <div className="np-footer">
          <div className="np-footer-error">{error ?? ""}</div>
          <div className="np-footer-buttons">
            <button type="button" className="np-btn" onClick={onClose}>
              {created ? "Close" : "Cancel"}
            </button>
            {created ? (
              <button
                type="button"
                className="np-btn primary"
                onClick={onOpenCreated}
                disabled={!onOpenPath}
              >
                Open file
              </button>
            ) : (
              <button
                type="button"
                className="np-btn primary"
                onClick={onSubmit}
                disabled={!canCreate}
              >
                {submitting ? "Creating…" : "Create paper"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
