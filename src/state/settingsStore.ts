// Zustand store backing all user-facing settings in the Settings modal.
// Persisted to localStorage under `lattice.settings.v0`.
//
// Settings that have immediate UI effects (fontSize, density, accentColor)
// are read reactively by the components that need them. Others are saved
// here and will be wired to their features as they ship.

import { create } from "zustand";

// ── Types ──

export type Density = "comfortable" | "compact" | "cozy";

export interface SettingsState {
  // ── General ──
  language: string;
  autoRestoreVault: boolean;
  telemetryOptIn: boolean;

  // ── Editor ──
  fontSize: number; // px
  lineNumbers: boolean;
  wordWrap: boolean;
  spellCheck: boolean;
  autoSaveDelay: number; // ms, 0 = manual
  vimMode: boolean;

  // ── Collaboration — removed (was Loro CRDT, not in Obsidian tech stack)

  // ── Files and links ──
  showFileExtensions: boolean;
  deleteBehavior: "system" | "local" | "permanent";
  attachmentFolder: string;

  // ── Appearance ──
  // theme lives in App.tsx already — we don't duplicate it here
  accentColor: string; // hex
  fontFamily: string;
  density: Density;

  // ── Core plugins ──
  corePlugins: Record<string, boolean>;
}

const STORAGE_KEY = "lattice.settings.v0";

function defaults(): SettingsState {
  return {
    language: "en",
    autoRestoreVault: true,
    telemetryOptIn: false,

    fontSize: 15,
    lineNumbers: true,
    wordWrap: true,
    spellCheck: false,
    autoSaveDelay: 1000,
    vimMode: false,

    showFileExtensions: true,
    deleteBehavior: "local",
    attachmentFolder: "attachments",

    accentColor: "#7c5bf0",
    fontFamily: "Inter",
    density: "comfortable",

    corePlugins: {
      backlinks: true,
      canvas: true,
      "command-palette": true,
      "daily-notes": false,
      "file-recovery": true,
      "note-composer": true,
      "page-preview": true,
      "quick-switcher": true,
      sync: true,
      templates: false,
    },
  };
}

function load(): SettingsState {
  try {
    const raw =
      typeof window !== "undefined"
        ? window.localStorage.getItem(STORAGE_KEY)
        : null;
    if (!raw) return defaults();
    const parsed = JSON.parse(raw) as Partial<SettingsState>;
    return { ...defaults(), ...parsed };
  } catch {
    return defaults();
  }
}

function persist(state: SettingsState) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* best-effort */
  }
}

type Actions = {
  set: <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => void;
  toggleCorePlugin: (id: string) => void;
  resetToDefaults: () => void;
};

export const useSettingsStore = create<SettingsState & Actions>(
  (set, get) => ({
    ...load(),

    set: (key, value) => {
      const next = { ...get(), [key]: value };
      persist(next);
      set(next);
    },

    toggleCorePlugin: (id) => {
      const plugins = { ...get().corePlugins };
      plugins[id] = !plugins[id];
      const next = { ...get(), corePlugins: plugins };
      persist(next);
      set(next);
    },

    resetToDefaults: () => {
      const next = defaults();
      persist(next);
      set(next);
    },
  }),
);
