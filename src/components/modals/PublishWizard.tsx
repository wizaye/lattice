import { useCallback, useEffect, useMemo, useState } from "react";
import { IcClose, IcRefresh } from "../common/Icons";
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

type Step = 0 | 1 | 2 | 3;
const STEPS: { label: string }[] = [
  { label: "Environment" },
  { label: "Host" },
  { label: "Template" },
  { label: "Connect" },
];

export function PublishWizard({ open, vaultPath, vaultName, onClose }: Props) {
  const probe = usePublishStore((s) => s.probe);
  const hosts = usePublishStore((s) => s.hosts);
  const templates = usePublishStore((s) => s.templates);
  const refreshProbe = usePublishStore((s) => s.refreshProbe);
  const refreshRegistries = usePublishStore((s) => s.refreshRegistries);
  const refreshStatus = usePublishStore((s) => s.refreshStatus);

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
    return false;
  }, [step, probe, hostId, templateId, isMockVault]);

  const onNext = useCallback(() => {
    if (!canAdvance) return;
    setError(null);
    setStep((s) => (s < 3 ? ((s + 1) as Step) : s));
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
      // Real path would close here; D1 stub throws and the catch surfaces it.
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  }, [isMockVault, vaultPath, hostId, templateId, onClose]);

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
              <div className="pw-banner">
                <span>
                  <strong>Heads up.</strong> Host adapters (auth, build, deploy)
                  ship in phase D2 +. Clicking <em>Connect</em> below will call
                  the real <code>publish_init</code> IPC; today it surfaces a
                  “phase D2 — not yet implemented” error into the footer so the
                  wiring is end-to-end testable.
                </span>
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
            ) : (
              <button
                type="button"
                className="pw-btn primary"
                onClick={onConnect}
                disabled={connecting || isMockVault || !hostId || !templateId}
              >
                {connecting ? "Connecting…" : "Connect"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
