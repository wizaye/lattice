// Stubbed onboarding steps 3-9. Each renders a TODO panel linking back
// to the design doc; the Next/Back footer in OnboardingShell drives
// the wizard forward without requiring real input. As the underlying
// features (vault management, theming, BYOC, E2EE, BYOM, journaling)
// ship, each stub gets promoted to a real screen — the wizard wiring
// in OnboardingShell stays unchanged.

import type { ReactNode } from "react";

function Stub({ title, section, children }: {
  title: string;
  section: string;
  children?: ReactNode;
}) {
  return (
    <div>
      <h1 className="ob-h1">{title}</h1>
      <div className="ob-stub">
        Real screen lands when the underlying feature ships. Design
        spec lives in <code>docs/onboarding-journey.md</code> §{section}.
        {children ? <div style={{ marginTop: 8 }}>{children}</div> : null}
      </div>
    </div>
  );
}

export function Step3Vault() {
  return (
    <Stub title="Pick a folder for your notes." section="3 Step 3">
      Will offer: create new, open existing, import from detected
      Obsidian / Logseq / Joplin / Siyuan.
    </Stub>
  );
}

export function Step4Theme() {
  return (
    <Stub title="Pick a look." section="3 Step 4">
      Live preview: theme (system / light / dark / high contrast) +
      density + font.
    </Stub>
  );
}

export function Step5Sync() {
  return (
    <Stub title="Sync (optional)." section="3 Step 5">
      Connect Google Drive / OneDrive / GitHub / iCloud / Dropbox / WebDAV
      using your own account. Plumbing arrives with BYOC (impl-v2 §5.1).
    </Stub>
  );
}

export function Step6Encryption() {
  return (
    <Stub title="End-to-end encryption (optional)." section="3 Step 6">
      Passphrase-derived key, recovery code on screen. Lands with E2EE
      phase 1 (impl-v2 §9).
    </Stub>
  );
}

export function Step7AI() {
  return (
    <Stub title="AI (optional)." section="3 Step 7">
      Local Ollama detected? One click to enable. Otherwise: BYOM
      providers list, all opt-in (impl-v2 §5.3).
    </Stub>
  );
}

export function Step8Extras() {
  return (
    <Stub title="Optional extras." section="3 Step 8">
      Daily journal toggle, calendar connector, telemetry opt-in (off
      by default).
    </Stub>
  );
}

export function Step9Done() {
  return (
    <div>
      <h1 className="ob-h1">You&rsquo;re set.</h1>
      <p className="ob-p">
        We&rsquo;ve dropped a <strong>Welcome.md</strong> in your vault
        with a five-minute tour. Press <code>Finish</code> to start
        writing.
      </p>
      <div className="ob-stub">
        Welcome.md generation + tour highlights land alongside the real
        Step 3 (vault create) — see
        <code>docs/onboarding-journey.md</code> §3 Step 9 + §5.2.
      </div>
    </div>
  );
}
