// Step 1 — Welcome (the 45-second-path off-ramp).
// Spec: docs/onboarding-journey.md §3 Step 1.

import { useOnboardingStore, TOTAL_STEPS } from "../state/onboardingStore";

export function Step1Welcome() {
  const next = useOnboardingStore((s) => s.next);
  const goto = useOnboardingStore((s) => s.goto);
  const setPersona = useOnboardingStore((s) => s.setPersona);

  // "Skip all" jumps straight to Step 9 using Student defaults. See
  // §3 Step 1 — the "45-second path" promise. We seed the persona
  // here so persona-derived defaults still apply when the user
  // re-opens the wizard later.
  const skipAll = () => {
    setPersona("student");
    goto(TOTAL_STEPS - 1);
  };

  return (
    <div>
      <h1 className="ob-h1">A few honest promises.</h1>
      <ul className="ob-bullets">
        <li>Your notes live in a plain folder on your disk.</li>
        <li>Nothing is sent to us. Ever.</li>
        <li>
          Sync, AI, and calendar are opt-in and use accounts you already
          own.
        </li>
      </ul>
      <p className="ob-p">
        The next eight steps set up your defaults. You can skip any of
        them.
      </p>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button className="ob-btn ghost" onClick={skipAll}>
          Skip all →
        </button>
        <button className="ob-btn primary" onClick={() => next()}>
          Next →
        </button>
      </div>
    </div>
  );
}
