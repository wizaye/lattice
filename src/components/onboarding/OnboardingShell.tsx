// OnboardingShell — fullscreen wizard overlay.
//
// Responsibilities:
//  - Renders the persistent header (title + step counter), progress
//    bar, the current step body, and the footer (Back / Skip / Next /
//    Finish).
//  - Routes to the right step component based on `step` in
//    `useOnboardingStore`.
//  - Handles the terminal action: `Finish` marks `completedAt`, which
//    flips `shouldShowOnboarding()` to false and the host (App.tsx)
//    unmounts the shell.
//
// What this file deliberately does NOT do:
//  - It does not own any feature state (theme, vault, AI...). Each
//    step writes its own slice via the store. Once the IPC commands
//    in docs/onboarding-journey.md §5.3 land, the store action
//    implementations get redirected from localStorage to the IPC
//    layer — no changes here.
//  - It does not auto-advance. Every step decides its own gating; the
//    shell just renders the footer buttons and the store does the
//    bookkeeping.

import "./OnboardingShell.css";
import {
  TOTAL_STEPS,
  useOnboardingStore,
} from "./state/onboardingStore";
import { Step0Splash } from "./steps/Step0Splash";
import { Step1Welcome } from "./steps/Step1Welcome";
import { Step2Persona } from "./steps/Step2Persona";
import { Step3Vault } from "./steps/Step3Vault";
import {
  Step4Theme,
  Step5Sync,
  Step6Encryption,
  Step7AI,
  Step8Extras,
  Step9Done,
} from "./steps/StubSteps";

const STEP_TITLES = [
  "Welcome",
  "What to expect",
  "Persona",
  "Vault",
  "Look & feel",
  "Sync",
  "Encryption",
  "AI",
  "Extras",
  "All set",
];

export function OnboardingShell() {
  const step = useOnboardingStore((s) => s.step);
  const next = useOnboardingStore((s) => s.next);
  const back = useOnboardingStore((s) => s.back);
  const complete = useOnboardingStore((s) => s.complete);
  // Step 0 (EULA) and Step 1 (welcome) intentionally aren't skippable
  // per §2 of the onboarding journey doc — Skip is hidden there.
  const canSkip = step >= 2 && step < TOTAL_STEPS - 1;
  const isLast = step === TOTAL_STEPS - 1;
  const progressPct = ((step + 1) / TOTAL_STEPS) * 100;

  return (
    <div className="ob-overlay" role="dialog" aria-modal="true">
      <div className="ob-card">
        <div className="ob-header">
          <div className="ob-header-title">
            Set up Lattice — {STEP_TITLES[step]}
          </div>
          <div className="ob-header-step">
            Step {step + 1} of {TOTAL_STEPS}
          </div>
        </div>

        <div className="ob-progress" aria-hidden="true">
          <div
            className="ob-progress-bar"
            style={{ width: `${progressPct}%` }}
          />
        </div>

        <div className="ob-content">
          {step === 0 && <Step0Splash />}
          {step === 1 && <Step1Welcome />}
          {step === 2 && <Step2Persona />}
          {step === 3 && <Step3Vault />}
          {step === 4 && <Step4Theme />}
          {step === 5 && <Step5Sync />}
          {step === 6 && <Step6Encryption />}
          {step === 7 && <Step7AI />}
          {step === 8 && <Step8Extras />}
          {step === 9 && <Step9Done />}
        </div>

        <div className="ob-footer">
          <button
            className="ob-btn ghost"
            onClick={() => back()}
            disabled={step === 0}
            aria-label="Back"
          >
            ← Back
          </button>
          <span className="ob-footer-step">
            {STEP_TITLES[step]}
          </span>
          <div className="ob-footer-spacer" />
          {canSkip && (
            <button className="ob-btn ghost" onClick={() => next()}>
              Skip — set this up later
            </button>
          )}
          {isLast ? (
            <button
              className="ob-btn primary"
              onClick={() => complete()}
            >
              Finish
            </button>
          ) : (
            <button className="ob-btn primary" onClick={() => next()}>
              Next →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
