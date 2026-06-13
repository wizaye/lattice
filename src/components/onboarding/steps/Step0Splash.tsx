// Step 0 — Splash + EULA acceptance.
// Spec: docs/onboarding-journey.md §3 Step 0.
//
// In v1 of this scaffold we skip the auto-detect background scan
// (Obsidian/Logseq/Ollama) — it lands when the Rust IPC commands in
// §5.3 of the journey doc are implemented. The EULA acknowledgement
// is the only thing this step *must* gate, and we treat it as a true
// blocker: `Continue` is disabled until the checkbox is ticked.

import { useState } from "react";
import { useOnboardingStore } from "../state/onboardingStore";

export function Step0Splash() {
  const acceptEula = useOnboardingStore((s) => s.acceptEula);
  const eulaAcceptedAt = useOnboardingStore((s) => s.eulaAcceptedAt);
  const [checked, setChecked] = useState<boolean>(eulaAcceptedAt !== null);

  return (
    <div>
      <h1 className="ob-h1">Welcome to Lattice</h1>
      <p className="ob-p">
        <strong>Your second brain, on your terms.</strong>
      </p>
      <p className="ob-p">
        Lattice keeps every note as a plain markdown file on your own
        disk. Nothing leaves your machine unless you connect a sync
        provider — and even then, you choose which provider, with your
        own account.
      </p>
      <p className="ob-p">
        The next nine steps set up sensible defaults. You can skip
        almost every step and change anything later in Settings.
      </p>

      <label className="ob-checkbox-row">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => {
            setChecked(e.target.checked);
            if (e.target.checked) acceptEula();
          }}
        />
        I&rsquo;ve read the <a href="#">end-user license agreement</a> and
        agree to its terms.
      </label>

      <div className="ob-stub">
        <strong>Scaffold note:</strong> the background scan for existing
        Obsidian / Logseq vaults + local Ollama detection lives in
        <code>docs/onboarding-journey.md</code> §3 Step 0. It runs as
        soon as the IPC commands from §5.3 land
        (<code>onboarding_import_detect</code>,
        <code>onboarding_ai_detect_ollama</code>).
      </div>
    </div>
  );
}
