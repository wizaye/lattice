// Step 2 — Persona pick. Defaults-only; never a feature gate.
// Spec: docs/onboarding-journey.md §3 Step 2.

import { useOnboardingStore } from "../state/onboardingStore";
import { PERSONA_PRESETS } from "../state/personaPresets";

export function Step2Persona() {
  const persona = useOnboardingStore((s) => s.persona);
  const setPersona = useOnboardingStore((s) => s.setPersona);
  const next = useOnboardingStore((s) => s.next);

  return (
    <div>
      <h1 className="ob-h1">Pick what fits today.</h1>
      <p className="ob-p">
        This only sets up <strong>defaults</strong> for the rest of the
        wizard — every feature is available to every persona afterward.
      </p>

      <div className="ob-persona-grid">
        {PERSONA_PRESETS.map((p) => (
          <button
            key={p.id}
            className={`ob-persona-card${persona === p.id ? " selected" : ""}`}
            onClick={() => setPersona(p.id)}
            type="button"
          >
            <div className="ob-persona-label">{p.label}</div>
            <div className="ob-persona-tag">{p.tagline}</div>
            <div className="ob-persona-defaults">
              <span>Vault: {p.defaultVaultHint}</span>
              <span>Sync: {p.defaultSyncProvider ?? "skip"}</span>
              <span>E2EE: {p.defaultE2EE ? "on" : "off"}</span>
            </div>
          </button>
        ))}
      </div>

      <p className="ob-p" style={{ fontSize: 11, opacity: 0.8 }}>
        You can change every one of these settings later in
        <strong> Settings → Preferences</strong>.
      </p>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button
          className="ob-btn primary"
          onClick={() => next()}
          disabled={persona === null}
        >
          Next →
        </button>
      </div>
    </div>
  );
}
