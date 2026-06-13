// Zustand store backing the onboarding wizard. Mirrors the
// `onboarding.json` schema documented in
// `docs/onboarding-journey.md` §5.1.
//
// Persistence: this is a frontend-only scaffold for now — values
// live in localStorage. The schema is a strict subset of the
// schema documented in the journey doc, so when the Rust IPC lands
// (`onboarding_get_state` / `onboarding_set_*` in
// `src-tauri/src/commands.rs`) the only change is swapping the
// localStorage hydrator for the IPC call. Component code never
// touches storage directly — it goes through `useOnboardingStore`.

import { create } from "zustand";

export type Persona = "student" | "dev" | "enterprise";

export type OnboardingState = {
  // Step 0
  eulaAcceptedAt: string | null;
  // Step 2
  persona: Persona | null;
  // Step 3 (stubbed for now)
  vaultPath: string | null;
  vaultOrigin: "created" | "opened" | "imported" | null;
  // Step 4 (stubbed)
  theme: "system" | "light" | "dark";
  density: "comfortable" | "compact" | "cozy";
  // Step 9
  completedAt: string | null;
  // Wizard runtime
  step: number; // 0..9
};

const STORAGE_KEY = "lattice.onboarding.v0";

function load(): OnboardingState {
  try {
    const raw =
      typeof window !== "undefined"
        ? window.localStorage.getItem(STORAGE_KEY)
        : null;
    if (!raw) return defaults();
    const parsed = JSON.parse(raw) as Partial<OnboardingState>;
    return { ...defaults(), ...parsed };
  } catch {
    return defaults();
  }
}

function defaults(): OnboardingState {
  return {
    eulaAcceptedAt: null,
    persona: null,
    vaultPath: null,
    vaultOrigin: null,
    theme: "system",
    density: "comfortable",
    completedAt: null,
    step: 0,
  };
}

const DATA_KEYS: Array<keyof OnboardingState> = [
  "eulaAcceptedAt",
  "persona",
  "vaultPath",
  "vaultOrigin",
  "theme",
  "density",
  "completedAt",
  "step",
];

function extractData(state: OnboardingState & Actions): OnboardingState {
  const out = {} as OnboardingState;
  for (const k of DATA_KEYS) {
    (out as Record<string, unknown>)[k] = (state as Record<string, unknown>)[k];
  }
  return out;
}

function persist(state: OnboardingState & Actions) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(extractData(state)));
  } catch {
    /* best-effort */
  }
}

type Actions = {
  acceptEula: () => void;
  setPersona: (p: Persona) => void;
  setVault: (path: string, origin: "created" | "opened" | "imported") => void;
  setTheme: (t: OnboardingState["theme"]) => void;
  setDensity: (d: OnboardingState["density"]) => void;
  goto: (step: number) => void;
  next: () => void;
  back: () => void;
  complete: () => void;
  reset: () => void;
};

export const TOTAL_STEPS = 10; // 0..9

export const useOnboardingStore = create<OnboardingState & Actions>(
  (set, get) => ({
    ...load(),

    acceptEula: () => {
      const next = { ...get(), eulaAcceptedAt: new Date().toISOString() };
      persist(next);
      set(next);
    },
    setPersona: (p) => {
      const next = { ...get(), persona: p };
      persist(next);
      set(next);
    },
    setVault: (path, origin) => {
      const next = { ...get(), vaultPath: path, vaultOrigin: origin };
      persist(next);
      set(next);
    },
    setTheme: (t) => {
      const next = { ...get(), theme: t };
      persist(next);
      set(next);
    },
    setDensity: (d) => {
      const next = { ...get(), density: d };
      persist(next);
      set(next);
    },
    goto: (step) => {
      const clamped = Math.max(0, Math.min(TOTAL_STEPS - 1, step));
      const next = { ...get(), step: clamped };
      persist(next);
      set(next);
    },
    next: () => {
      const s = get().step;
      const clamped = Math.min(TOTAL_STEPS - 1, s + 1);
      const updated = { ...get(), step: clamped };
      persist(updated);
      set(updated);
    },
    back: () => {
      const s = get().step;
      const clamped = Math.max(0, s - 1);
      const updated = { ...get(), step: clamped };
      persist(updated);
      set(updated);
    },
    complete: () => {
      const next = {
        ...get(),
        completedAt: new Date().toISOString(),
        step: TOTAL_STEPS - 1,
      };
      persist(next);
      set(next);
    },
    reset: () => {
      const next = { ...get(), ...defaults() };
      persist(next);
      set(next);
    },
  }),
);

/**
 * Stable selector — returns true while the wizard should be visible.
 * Checks for a truthy completedAt so null / undefined / "" all show onboarding.
 */
export function shouldShowOnboarding(s: OnboardingState): boolean {
  return !s.completedAt;
}

/**
 * Per-step gate for the footer "Next" button.
 * Returns false only on steps that require the user to take an explicit
 * action before they may advance.
 */
export function canGoNext(s: OnboardingState): boolean {
  switch (s.step) {
    case 0:
      // EULA must be accepted
      return !!s.eulaAcceptedAt;
    case 2:
      // Persona must be selected
      return s.persona !== null;
    default:
      return true;
  }
}
