// Declarative persona presets — the only thing Step 2's "Persona pick"
// controls. Every value here is a *default*, not a gate; the user
// can change anything in Settings afterward (see §2 of
// `docs/onboarding-journey.md`).

import type { Persona } from "./onboardingStore";

export type PersonaPreset = {
  id: Persona;
  label: string;
  tagline: string;
  /** Suggested vault location relative to the user's home. */
  defaultVaultHint: string;
  /** Sync provider id pre-selected on Step 5 (null = skip by default). */
  defaultSyncProvider: string | null;
  /** Whether E2EE toggle defaults on. */
  defaultE2EE: boolean;
  /** Templates auto-enabled on first vault create. */
  defaultTemplates: string[];
};

export const PERSONA_PRESETS: PersonaPreset[] = [
  {
    id: "student",
    label: "Student / Personal",
    tagline:
      "Daily notes, papers, reading lists. Local-first, sync optional.",
    defaultVaultHint: "~/Documents/Lattice Vault",
    defaultSyncProvider: "google_drive",
    defaultE2EE: false,
    defaultTemplates: ["paper", "daily-note", "reading-list"],
  },
  {
    id: "dev",
    label: "OSS Developer",
    tagline: "Code snippets, ADRs, project logs. GitHub-flavoured.",
    defaultVaultHint: "~/lattice-vault",
    defaultSyncProvider: "github",
    defaultE2EE: false,
    defaultTemplates: ["code-snippet", "project-log", "adr"],
  },
  {
    id: "enterprise",
    label: "Enterprise / M365",
    tagline:
      "Meeting notes, OKRs, 1:1s. OneDrive, E2EE on by default, AI opt-in.",
    defaultVaultHint: "%USERPROFILE%\\OneDrive\\Lattice Vault",
    defaultSyncProvider: "onedrive",
    defaultE2EE: true,
    defaultTemplates: ["meeting-notes", "okr", "one-on-one"],
  },
];

export function getPreset(id: Persona): PersonaPreset {
  // Non-null guaranteed because PERSONA_PRESETS covers every Persona.
  return PERSONA_PRESETS.find((p) => p.id === id) ?? PERSONA_PRESETS[0];
}
