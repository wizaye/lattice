import { useCallback, useEffect, useMemo, useState } from "react";
import { IcClose, IcLinkExternal, IcRefresh } from "../common/Icons";
import { usePublishStore } from "../../state/publishStore";
import type { HostId } from "../../lib/publish";
import { publishInit } from "../../lib/publish";
import "./PublishWizard.css";

/**
 * PublishWizard — Slice D (phase D1) wizard.
 *
 * Drives the **real** four D1 IPCs (`publish_probe`,
 * `publish_list_hosts`, `publish_list_templates`, `publish_status`)
 * and exposes a final "Connect" step that calls the still-stub
 * `publish_init` — by design that surfaces a "phase D2 — not yet
 * implemented" error into the footer, which is the correct demo
 * behaviour for the current slice.
 *
 * The mock vault is short-circuited in the modal body with an
 * explicit empty state, mirroring NewPaperModal's approach.  This
 * avoids silently no-op'ing buttons after the user clicks (the BYOC
 * mock-vault bug from slice B).
 */
type Props = {
  open: boolean;
  vaultPath: string | null;
  vaultName: string;
  onClose: () => void;
};

const MOCK_VAULT = "__mock__";

type Step = 0 | 1 | 2 | 3 | 4;
const STEPS: { label: string }[] = [
  { label: "Environment" },
  { label: "Host" },
  { label: "Template" },
  { label: "Connect" },
  { label: "Preview" },
];
const LAST_STEP: Step = 4;

export function PublishWizard({ open, vaultPath, vaultName, onClose }: Props) {
  const probe = usePublishStore((s) => s.probe);
  const hosts = usePublishStore((s) => s.hosts);
  const templates = usePublishStore((s) => s.templates);
  const refreshProbe = usePublishStore((s) => s.refreshProbe);
  const refreshRegistries = usePublishStore((s) => s.refreshRegistries);
  const refreshStatus = usePublishStore((s) => s.refreshStatus);
  // Subscribe to the per-vault row directly so step 4 re-renders on
  // `busy`/`lastError`/`previewUrl` changes driven by the store.
  // `__mock__` is fine as a key — `rowFor` returns the empty row and
  // the build/preview buttons stay disabled.
  const row = usePublishStore((s) => (vaultPath ? s.rows[vaultPath] : undefined));
  const buildAction = usePublishStore((s) => s.build);
  const previewAction = usePublishStore((s) => s.preview);
  const previewStopAction = usePublishStore((s) => s.previewStop);

  const isMockVault = vaultPath === MOCK_VAULT || !vaultPath;

  const [step, setStep] = useState<Step>(0);
  const [probing, setProbing] = useState(false);
  const [hostId, setHostId] = useState<HostId | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  // ── Reset on close ────────────────────────────────────────────────────
  useEffect(() => {
    if (open) return;
    setStep(0);
    setHostId(null);
    setTemplateId(null);
    setError(null);
    setProbing(false);
    setConnecting(false);
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

  // ── Hydrate registries + probe on open ───────────────────────────────
  useEffect(() => {
    if (!open) return;
    refreshRegistries().catch(() => {
      /* registries are static; error caught silently */
    });
    setProbing(true);
    refreshProbe()
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setProbing(false));
    if (!isMockVault && vaultPath) {
      refreshStatus(vaultPath).catch(() => {
        /* per-vault row error caught into row.lastError by the store */
      });
    }
  }, [open, vaultPath, isMockVault, refreshRegistries, refreshProbe, refreshStatus]);

  // ── Default-select first ready/template once they arrive ─────────────
  useEffect(() => {
    if (templateId || templates.length === 0) return;
    setTemplateId(templates[0]?.id ?? null);
  }, [templates, templateId]);

  const reProbe = useCallback(async () => {
    setProbing(true);
    setError(null);
    try {
      await refreshProbe();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProbing(false);
    }
  }, [refreshProbe]);

  const canAdvance = useMemo(() => {
    if (isMockVault) return false;
    if (step === 0) return probe?.ok === true;
    if (step === 1) return hostId !== null;
    if (step === 2) return templateId !== null;
    // Step 3 → advance only after Connect succeeds (row.exists).
    if (step === 3) return row?.exists === true;
    return false;
  }, [step, probe, hostId, templateId, isMockVault, row]);

  const onNext = useCallback(() => {
    if (!canAdvance) return;
    setError(null);
    setStep((s) => (s < LAST_STEP ? ((s + 1) as Step) : s));
  }, [canAdvance]);

  const onBack = useCallback(() => {
    setError(null);
    setStep((s) => (s > 0 ? ((s - 1) as Step) : s));
  }, []);

  const onConnect = useCallback(async () => {
    if (isMockVault || !vaultPath || !hostId || !templateId) return;
    setConnecting(true);
    setError(null);
    try {
      await publishInit(vaultPath, hostId, templateId);
      // Refresh row so canAdvance sees `exists: true` and so the
      // preview step shows the connected host/template.
      await refreshStatus(vaultPath);
      setStep(LAST_STEP);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  }, [isMockVault, vaultPath, hostId, templateId, refreshStatus]);

  const onBuild = useCallback(async () => {
    if (!vaultPath) return;
    setError(null);
    await buildAction(vaultPath);
  }, [vaultPath, buildAction]);

  const onPreview = useCallback(async () => {
    if (!vaultPath) return;
    setError(null);
    await previewAction(vaultPath);
  }, [vaultPath, previewAction]);

  const onPreviewStop = useCallback(async () => {
    if (!vaultPath) return;
    setError(null);
    await previewStopAction(vaultPath);
  }, [vaultPath, previewStopAction]);

  const onOpenPreview = useCallback(async () => {
    const url = row?.previewUrl;
    if (!url) return;
    try {
      // Tauri 2: route through plugin-opener so the OS default
      // browser opens, not a child WebView.  Dynamic import keeps
      // the browser dev build working when the plugin isn't bundled.
      const mod = await import("@tauri-apps/plugin-opener");
      await mod.openUrl(url);
    } catch {
      window.open(url, "_blank", "noreferrer");
    }
  }, [row?.previewUrl]);

  if (!open) return null;

  return (
    <div
      className="pw-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Set up publishing"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="pw-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="pw-close"
          title="Close"
          aria-label="Close publish wizard"
          onClick={onClose}
        >
          <IcClose />
        </button>

        <div className="pw-header">
          <div className="pw-title">Set up publishing</div>
          <div className="pw-subtitle">
            {isMockVault
              ? "Open a real vault folder to configure publishing."
              : `Publish “${vaultName}” to a static host using a bundled Quartz template.`}
          </div>
        </div>

        {/* Stepper */}
        <div className="pw-steps" role="tablist" aria-label="Wizard steps">
          {STEPS.map((s, i) => {
            const active = i === step;
            const done = i < step;
            return (
              <div key={s.label} className="pw-step-wrap" style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div
                  className={`pw-step${active ? " active" : ""}${done ? " done" : ""}`}
                  role="tab"
                  aria-selected={active}
                >
                  <span className="pw-step-n">{i + 1}</span>
                  <span>{s.label}</span>
                </div>
                {i < STEPS.length - 1 && <span className="pw-step-arrow">›</span>}
              </div>
            );
          })}
        </div>

        <div className="pw-body">
          {isMockVault && (
            <div className="pw-banner">
              <span>
                <strong>Mock vault.</strong> Open a real folder via the vault
                picker in the bottom-left to set up publishing.
              </span>
            </div>
          )}

          {step === 0 && (
            <>
              <div className="pw-section-title">Step 1 · Check environment</div>
              <div className="pw-hint">
                Lattice uses Quartz under the hood, which needs Node 22+ and
                npm 10.9.2+ available on your PATH.
              </div>
              {probing ? (
                <div className="pw-probe-card">
                  <div className="pw-probe-line">
                    <span>Probing…</span>
                  </div>
                </div>
              ) : probe ? (
                <div className={`pw-probe-card${probe.ok ? " ok" : " bad"}`}>
                  <div className="pw-probe-line">
                    <span>node</span>
                    <span className="pw-probe-val">{probe.node || "not found"}</span>
                  </div>
                  <div className="pw-probe-line">
                    <span>npm</span>
                    <span className="pw-probe-val">{probe.npm || "not found"}</span>
                  </div>
                  <div className="pw-probe-line">
                    <span>npx</span>
                    <span className="pw-probe-val">{probe.npx ? "present" : "missing"}</span>
                  </div>
                  {probe.reason && (
                    <div className="pw-hint" style={{ marginTop: 4 }}>
                      {probe.reason}
                    </div>
                  )}
                </div>
              ) : (
                <div className="pw-probe-card">
                  <div className="pw-probe-line">
                    <span>No probe data yet.</span>
                  </div>
                </div>
              )}
              <div>
                <button type="button" className="pw-btn" onClick={reProbe} disabled={probing}>
                  <IcRefresh /> Re-probe
                </button>
              </div>
              {probe && !probe.ok && (
                <div className="pw-hint">
                  Install or upgrade Node.js from{" "}
                  <a
                    href="https://nodejs.org/"
                    target="_blank"
                    rel="noreferrer noopener"
                    style={{ color: "var(--accent)" }}
                  >
                    nodejs.org
                  </a>
                  , then re-probe.
                </div>
              )}
            </>
          )}

          {step === 1 && (
            <>
              <div className="pw-section-title">Step 2 · Pick a host</div>
              <div className="pw-hint">
                Where should your published site live? Hosts marked “Coming
                soon” will be enabled in later releases.
              </div>
              <div className="pw-card-grid">
                {hosts.map((h) => {
                  const disabled = !h.adapterReady;
                  return (
                    <button
                      key={h.id}
                      type="button"
                      className={`pw-card${hostId === h.id ? " active" : ""}${disabled ? " disabled" : ""}`}
                      onClick={() => !disabled && setHostId(h.id)}
                      aria-pressed={hostId === h.id}
                    >
                      <div className="pw-card-head">
                        <span className="pw-card-label">{h.label}</span>
                        <span className={`pw-card-badge${h.adapterReady ? " ready" : ""}`}>
                          {h.adapterReady ? "Ready" : "Soon"}
                        </span>
                      </div>
                      <div className="pw-card-desc">{h.description}</div>
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div className="pw-section-title">Step 3 · Pick a template</div>
              <div className="pw-hint">
                Bundled Quartz v5 templates (more soon). Template bundles ship
                in a later release; selection is recorded so it picks up the
                local bundle automatically.
              </div>
              <div className="pw-card-grid">
                {templates.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`pw-card${templateId === t.id ? " active" : ""}`}
                    onClick={() => setTemplateId(t.id)}
                    aria-pressed={templateId === t.id}
                  >
                    <div className="pw-card-head">
                      <span className="pw-card-label">{t.label}</span>
                      <span className={`pw-card-badge${t.bundleReady ? " ready" : ""}`}>
                        Quartz v{t.quartzVersion}
                      </span>
                    </div>
                    <div className="pw-card-desc">{t.description}</div>
                  </button>
                ))}
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div className="pw-section-title">Step 4 · Connect</div>
              <div className="pw-hint">
                Lattice will write <code>.lattice/publish.json</code> into your
                vault and stage the chosen template bundle so the next step can
                build a static site locally.
              </div>
              <div className="pw-hint">
                Selected host:{" "}
                <strong>{hosts.find((h) => h.id === hostId)?.label ?? "—"}</strong>
                <br />
                Selected template:{" "}
                <strong>
                  {templates.find((t) => t.id === templateId)?.label ?? "—"}
                </strong>
              </div>
              {row?.exists && (
                <div className="pw-banner">
                  <span>Already connected. Click <em>Connect</em> again to refresh, or hit <em>Next</em> to build a local preview.</span>
                </div>
              )}
            </>
          )}

          {step === 4 && (
            <>
              <div className="pw-section-title">Step 5 · Build &amp; preview</div>
              <div className="pw-hint">
                Build the Quartz site from your vault and serve it on a
                throw-away local port. Use this to spot-check the layout
                before wiring a real deploy in a later release.
              </div>
              <div className="pw-card-grid" style={{ gridTemplateColumns: "1fr" }}>
                <div className="pw-card" style={{ cursor: "default" }}>
                  <div className="pw-card-head">
                    <span className="pw-card-label">Local build</span>
                    <span className={`pw-card-badge${row?.lastBuildAt ? " ready" : ""}`}>
                      {row?.lastBuildAt ? "Built" : "Not built"}
                    </span>
                  </div>
                  <div className="pw-card-desc">
                    Runs <code>npx quartz build</code> against this vault.
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <button
                      type="button"
                      className="pw-btn primary"
                      onClick={onBuild}
                      disabled={!!row?.busy || isMockVault}
                    >
                      {row?.busy ? "Working…" : "Build"}
                    </button>
                  </div>
                </div>
                <div className="pw-card" style={{ cursor: "default" }}>
                  <div className="pw-card-head">
                    <span className="pw-card-label">Local preview</span>
                    <span className={`pw-card-badge${row?.previewUrl ? " ready" : ""}`}>
                      {row?.previewUrl ? "Running" : "Stopped"}
                    </span>
                  </div>
                  <div className="pw-card-desc">
                    {row?.previewUrl ? (
                      <>Serving at <code>{row.previewUrl}</code></>
                    ) : (
                      <>Serves the last build on <code>http://127.0.0.1:&lt;auto&gt;</code>.</>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                    {!row?.previewUrl ? (
                      <button
                        type="button"
                        className="pw-btn primary"
                        onClick={onPreview}
                        disabled={!!row?.busy || isMockVault}
                      >
                        {row?.busy ? "Working…" : "Start preview"}
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="pw-btn primary"
                          onClick={onOpenPreview}
                          disabled={!!row?.busy}
                        >
                          <IcLinkExternal /> Open in browser
                        </button>
                        <button
                          type="button"
                          className="pw-btn"
                          onClick={onPreviewStop}
                          disabled={!!row?.busy}
                        >
                          Stop preview
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
              {row?.lastError && (
                <div
                  className="pw-hint"
                  style={{
                    color: "var(--text-error, #e57373)",
                    whiteSpace: "pre-wrap",
                    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
                    fontSize: 11.5,
                  }}
                >
                  {row.lastError}
                </div>
              )}
            </>
          )}
        </div>

        <div className="pw-footer">
          <div className="pw-footer-error">{error ?? ""}</div>
          <div className="pw-footer-buttons">
            <button type="button" className="pw-btn" onClick={step === 0 ? onClose : onBack}>
              {step === 0 ? "Cancel" : "Back"}
            </button>
            {step < 3 ? (
              <button
                type="button"
                className="pw-btn primary"
                onClick={onNext}
                disabled={!canAdvance}
              >
                Next
              </button>
            ) : step === 3 ? (
              <>
                <button
                  type="button"
                  className="pw-btn primary"
                  onClick={onConnect}
                  disabled={connecting || isMockVault || !hostId || !templateId}
                >
                  {connecting ? "Connecting…" : row?.exists ? "Reconnect" : "Connect"}
                </button>
                {row?.exists && (
                  <button
                    type="button"
                    className="pw-btn primary"
                    onClick={onNext}
                    disabled={!canAdvance}
                  >
                    Next
                  </button>
                )}
              </>
            ) : (
              <button
                type="button"
                className="pw-btn primary"
                onClick={onClose}
              >
                Done
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
