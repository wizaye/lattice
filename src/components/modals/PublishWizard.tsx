import { useCallback, useEffect, useMemo, useState } from "react";
import { IcClose, IcLinkExternal, IcRefresh } from "../common/Icons";
import { DEFAULT_QUARTZ_THEME, usePublishStore } from "../../state/publishStore";
import type { HostId, QuartzTheme } from "../../lib/publish";
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

type Step = 0 | 1 | 2 | 3 | 4 | 5;
const STEPS: { label: string }[] = [
  { label: "Environment" },
  { label: "Host" },
  { label: "Template" },
  { label: "Connect" },
  { label: "Customise" },
  { label: "Preview" },
];
const LAST_STEP: Step = 5;

/**
 * Palette presets surfaced in the Customise step.  Hex values mirror
 * `palette_colors()` in `src-tauri/src/publish/quartz.rs` — keep in
 * sync.  The two-swatch preview (`secondary` + `tertiary`) maps to
 * Quartz's link colour + graph hover colour.
 */
const PALETTE_PRESETS: { id: string; label: string; secondary: string; tertiary: string }[] = [
  { id: "default", label: "Default (Quartz)", secondary: "#284b63", tertiary: "#84a59d" },
  { id: "ocean", label: "Ocean", secondary: "#1f6feb", tertiary: "#388bfd" },
  { id: "forest", label: "Forest", secondary: "#2f7d32", tertiary: "#66bb6a" },
  { id: "sunset", label: "Sunset", secondary: "#d84315", tertiary: "#ff7043" },
  { id: "berry", label: "Berry", secondary: "#8e24aa", tertiary: "#ba68c8" },
  { id: "mono", label: "Mono", secondary: "#333333", tertiary: "#777777" },
];

/**
 * Typography presets surfaced in the Customise step.  Font triples
 * mirror `typography_fonts()` in `quartz.rs` — keep in sync.
 */
const TYPOGRAPHY_PRESETS: { id: string; label: string; hint: string }[] = [
  { id: "default", label: "Default (Quartz)", hint: "Schibsted Grotesk · Source Sans Pro · IBM Plex Mono" },
  { id: "modern-serif", label: "Modern serif", hint: "Crimson Pro · Inter · JetBrains Mono" },
  { id: "geometric-sans", label: "Geometric sans", hint: "Inter · Inter · JetBrains Mono" },
  { id: "brutalist", label: "Brutalist", hint: "Space Grotesk · Space Grotesk · Space Mono" },
  { id: "elegant", label: "Elegant", hint: "Cormorant Garamond · Libre Franklin · IBM Plex Mono" },
];

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
  const setThemeAction = usePublishStore((s) => s.setTheme);

  const isMockVault = vaultPath === MOCK_VAULT || !vaultPath;

  const [step, setStep] = useState<Step>(0);
  const [probing, setProbing] = useState(false);
  const [hostId, setHostId] = useState<HostId | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  // Customise-step form state.  Hydrated lazily from `row.theme` when
  // the user lands on step 4 (rather than every row update) so the
  // input cursor doesn't jump on background refreshes.
  const [theme, setLocalTheme] = useState<QuartzTheme>(DEFAULT_QUARTZ_THEME);
  const [themeHydrated, setThemeHydrated] = useState(false);
  const [applyingTheme, setApplyingTheme] = useState(false);
  const [themeSavedAt, setThemeSavedAt] = useState<number | null>(null);

  // ── Reset on close ────────────────────────────────────────────────────
  useEffect(() => {
    if (open) return;
    setStep(0);
    setHostId(null);
    setTemplateId(null);
    setError(null);
    setProbing(false);
    setConnecting(false);    setLocalTheme(DEFAULT_QUARTZ_THEME);
    setThemeHydrated(false);
    setApplyingTheme(false);
    setThemeSavedAt(null);  }, [open]);

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

  // ── Hydrate the Customise form when the user lands on step 4 ────────
  //
  //   Pull from `row.theme` if it exists (vault was connected on a
  //   previous run) or fall back to the empty-string defaults with a
  //   sensible auto-derived `pageTitle = vaultName`.  Done only once
  //   per modal-open so background refreshes don't reset the form
  //   while the user is typing.
  useEffect(() => {
    if (step !== 4 || themeHydrated) return;
    const seed: QuartzTheme = row?.theme ?? {
      ...DEFAULT_QUARTZ_THEME,
      pageTitle: vaultName ?? "",
    };
    setLocalTheme(seed);
    setThemeHydrated(true);
  }, [step, themeHydrated, row?.theme, vaultName]);

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
    // Step 4 (Customise) — advance is always allowed once connected;
    // the Apply button is independent (the user can skip without
    // pressing it and the saved-on-disk theme stays untouched).
    if (step === 4) return row?.exists === true;
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
      // Advance into the Customise step — the user picks site title,
      // palette, typography, etc. before getting to the preview.
      setStep(4);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  }, [isMockVault, vaultPath, hostId, templateId, refreshStatus]);

  const onApplyTheme = useCallback(async () => {
    if (!vaultPath || isMockVault) return;
    setApplyingTheme(true);
    setError(null);
    try {
      await setThemeAction(vaultPath, theme);
      setThemeSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplyingTheme(false);
    }
  }, [vaultPath, isMockVault, setThemeAction, theme]);

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
              <div className="pw-section-title">Step 5 · Customise the site</div>
              <div className="pw-hint">
                These changes are written to <code>publish.toml</code> and
                merged into <code>quartz.config.yaml</code> on every build.
                Skip this step to keep the bundled defaults.
              </div>

              <div className="pw-form">
                <label className="pw-form-row">
                  <span className="pw-form-label">Site title</span>
                  <input
                    type="text"
                    className="pw-input"
                    placeholder="My digital garden"
                    value={theme.pageTitle}
                    onChange={(e) =>
                      setLocalTheme((t) => ({ ...t, pageTitle: e.target.value }))
                    }
                    disabled={applyingTheme || isMockVault}
                  />
                </label>

                <label className="pw-form-row">
                  <span className="pw-form-label">Title suffix</span>
                  <input
                    type="text"
                    className="pw-input"
                    placeholder="— a Lattice garden"
                    value={theme.pageTitleSuffix}
                    onChange={(e) =>
                      setLocalTheme((t) => ({ ...t, pageTitleSuffix: e.target.value }))
                    }
                    disabled={applyingTheme || isMockVault}
                  />
                </label>

                <div className="pw-form-row">
                  <span className="pw-form-label">Palette</span>
                  <div className="pw-swatch-grid">
                    {PALETTE_PRESETS.map((p) => {
                      const active = theme.palette === p.id;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          className={`pw-swatch${active ? " active" : ""}`}
                          onClick={() =>
                            setLocalTheme((t) => ({ ...t, palette: p.id }))
                          }
                          aria-pressed={active}
                          disabled={applyingTheme || isMockVault}
                          title={`${p.label} (${p.secondary} / ${p.tertiary})`}
                        >
                          <span className="pw-swatch-dots">
                            <span
                              className="pw-swatch-dot"
                              style={{ background: p.secondary }}
                            />
                            <span
                              className="pw-swatch-dot"
                              style={{ background: p.tertiary }}
                            />
                          </span>
                          <span className="pw-swatch-label">{p.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <label className="pw-form-row">
                  <span className="pw-form-label">Typography</span>
                  <select
                    className="pw-input"
                    value={theme.typography}
                    onChange={(e) =>
                      setLocalTheme((t) => ({ ...t, typography: e.target.value }))
                    }
                    disabled={applyingTheme || isMockVault}
                  >
                    {TYPOGRAPHY_PRESETS.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label} — {t.hint}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="pw-form-row pw-form-row-check">
                  <input
                    type="checkbox"
                    checked={theme.popovers}
                    onChange={(e) =>
                      setLocalTheme((t) => ({ ...t, popovers: e.target.checked }))
                    }
                    disabled={applyingTheme || isMockVault}
                  />
                  <span>
                    <strong>Hover-card popovers</strong>
                    <br />
                    <span className="pw-hint pw-hint-inline">
                      Preview internal links on hover. Off for cleaner mobile UX.
                    </span>
                  </span>
                </label>

                <label className="pw-form-row pw-form-row-check">
                  <input
                    type="checkbox"
                    checked={theme.spa}
                    onChange={(e) =>
                      setLocalTheme((t) => ({ ...t, spa: e.target.checked }))
                    }
                    disabled={applyingTheme || isMockVault}
                  />
                  <span>
                    <strong>Single-page navigation</strong>
                    <br />
                    <span className="pw-hint pw-hint-inline">
                      Smooth client-side routing. Off forces full page loads.
                    </span>
                  </span>
                </label>

                <div
                  style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
                >
                  <button
                    type="button"
                    className="pw-btn primary"
                    onClick={onApplyTheme}
                    disabled={applyingTheme || isMockVault}
                  >
                    {applyingTheme ? "Saving…" : "Apply customisations"}
                  </button>
                  {themeSavedAt && !applyingTheme && (
                    <span className="pw-hint pw-hint-inline">Saved.</span>
                  )}
                </div>
              </div>
            </>
          )}

          {step === 5 && (
            <>
              <div className="pw-section-title">Step 6 · Build &amp; preview</div>
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
            ) : step === 4 ? (
              <button
                type="button"
                className="pw-btn primary"
                onClick={onNext}
                disabled={!canAdvance || applyingTheme}
              >
                Next
              </button>
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
