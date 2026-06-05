import React, { useEffect, useMemo, useState } from "react";
import {
  IcArchive,
  IcBook,
  IcBookmark,
  IcCalendar,
  IcClose,
  IcEdit,
  IcExtensions,
  IcFileLink,
  IcGear,
  IcHistory,
  IcKey,
  IcKeyboard,
  IcLinkOff,
  IcMerge,
  IcMoon,
  IcPaint,
  IcPreview,
  IcSun,
  IcSwap,
  IcSync,
  IcTerminal,
} from "../common/Icons";
import "./SettingsModal.css";

type Props = {
  open: boolean;
  onClose: () => void;
  theme: "dark" | "light";
  onToggleTheme: () => void;
};

type Section = {
  id: string;
  label: string;
  Icon: React.FC<React.HTMLAttributes<HTMLSpanElement>>;
};

const OPTION_SECTIONS: Section[] = [
  { id: "general", label: "General", Icon: IcGear },
  { id: "editor", label: "Editor", Icon: IcEdit },
  { id: "files", label: "Files and links", Icon: IcFileLink },
  { id: "appearance", label: "Appearance", Icon: IcPaint },
  { id: "hotkeys", label: "Hotkeys", Icon: IcKeyboard },
  { id: "keychain", label: "Keychain", Icon: IcKey },
  { id: "core-plugins", label: "Core plugins", Icon: IcArchive },
  { id: "community-plugins", label: "Community plugins", Icon: IcExtensions },
];

const CORE_PLUGIN_SECTIONS: Section[] = [
  { id: "backlinks", label: "Backlinks", Icon: IcLinkOff },
  { id: "canvas", label: "Canvas", Icon: IcBookmark },
  { id: "command-palette", label: "Command palette", Icon: IcTerminal },
  { id: "daily-notes", label: "Daily notes", Icon: IcCalendar },
  { id: "file-recovery", label: "File recovery", Icon: IcHistory },
  { id: "note-composer", label: "Note composer", Icon: IcMerge },
  { id: "page-preview", label: "Page preview", Icon: IcPreview },
  { id: "quick-switcher", label: "Quick switcher", Icon: IcSwap },
  { id: "sync", label: "Sync", Icon: IcSync },
  { id: "templates", label: "Templates", Icon: IcBook },
];

/**
 * SettingsModal — an Obsidian-style overlay dialog with a left section
 * list (Options + Core plugins) and a right content pane. The current
 * implementation is mostly visual: each section renders a short
 * placeholder so the layout, scrolling, and selection states can be
 * verified end-to-end. Sections can grow real bodies later without
 * touching the shell.
 */
export function SettingsModal({ open, onClose, theme, onToggleTheme }: Props) {
  const [active, setActive] = useState<string>("sync");

  // Close on Esc
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

  const activeSection = useMemo(() => {
    return (
      OPTION_SECTIONS.find((s) => s.id === active) ??
      CORE_PLUGIN_SECTIONS.find((s) => s.id === active) ??
      OPTION_SECTIONS[0]
    );
  }, [active]);

  if (!open) return null;

  return (
    <div
      className="settings-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onMouseDown={(e) => {
        // backdrop click closes; clicks on the dialog itself are stopped
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="settings-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Left list */}
        <aside className="settings-sidebar">
          <div className="settings-group-label">Options</div>
          <ul className="settings-list">
            {OPTION_SECTIONS.map((s) => (
              <SectionItem
                key={s.id}
                section={s}
                active={active === s.id}
                onClick={() => setActive(s.id)}
              />
            ))}
          </ul>

          <div className="settings-group-label">Core plugins</div>
          <ul className="settings-list">
            {CORE_PLUGIN_SECTIONS.map((s) => (
              <SectionItem
                key={s.id}
                section={s}
                active={active === s.id}
                onClick={() => setActive(s.id)}
              />
            ))}
          </ul>
        </aside>

        {/* Right content pane */}
        <main className="settings-content">
          <button
            className="settings-close"
            title="Close settings"
            aria-label="Close settings"
            onClick={onClose}
          >
            <IcClose />
          </button>

          <SectionBody
            section={activeSection}
            theme={theme}
            onToggleTheme={onToggleTheme}
          />
        </main>
      </div>
    </div>
  );
}

function SectionItem({
  section,
  active,
  onClick,
}: {
  section: Section;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        className={`settings-item${active ? " active" : ""}`}
        onClick={onClick}
      >
        <section.Icon className="settings-item-icon" />
        <span className="settings-item-label">{section.label}</span>
      </button>
    </li>
  );
}

function SectionBody({
  section,
  theme,
  onToggleTheme,
}: {
  section: Section;
  theme: "dark" | "light";
  onToggleTheme: () => void;
}) {
  if (section.id === "sync") {
    return (
      <div className="settings-body">
        <p>
          Obsidian Sync is Obsidian's add-on sync service with end-to-end
          encryption and version history.
        </p>
        <p>
          To start syncing, please log in or create a new Obsidian account.
        </p>
        <div className="settings-actions">
          <button className="settings-btn primary">Sign up</button>
          <button className="settings-btn">Log in</button>
        </div>
      </div>
    );
  }

  if (section.id === "appearance") {
    return (
      <div className="settings-body">
        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-title">Theme</div>
            <div className="settings-row-desc">
              Choose between light and dark color schemes.
            </div>
          </div>
          <button
            className="settings-btn"
            onClick={onToggleTheme}
            title="Toggle theme"
          >
            {theme === "dark" ? <IcSun /> : <IcMoon />}
            <span>{theme === "dark" ? "Light" : "Dark"}</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-body">
      <h2 className="settings-body-title">{section.label}</h2>
      <p className="settings-body-empty">
        Settings for <strong>{section.label}</strong> will appear here.
      </p>
    </div>
  );
}
