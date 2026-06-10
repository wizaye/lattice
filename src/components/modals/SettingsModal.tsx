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
import { useSettingsStore } from "../../state/settingsStore";
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
  const store = useSettingsStore();

  if (section.id === "general") {
    return (
      <div className="settings-body">
        <h2 className="settings-body-title">General</h2>
        
        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-title">Language</div>
            <div className="settings-row-desc">
              Choose the language for the app interface.
            </div>
          </div>
          <select 
            className="settings-input"
            value={store.language}
            onChange={(e) => store.set("language", e.target.value)}
          >
            <option value="en">English</option>
            <option value="es">Español</option>
            <option value="fr">Français</option>
            <option value="de">Deutsch</option>
            <option value="ja">日本語</option>
            <option value="zh">中文</option>
          </select>
        </div>

        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-title">Auto-restore vault</div>
            <div className="settings-row-desc">
              Automatically open your last active vault when starting the app.
            </div>
          </div>
          <label className="settings-switch">
            <input 
              type="checkbox" 
              checked={store.autoRestoreVault} 
              onChange={(e) => store.set("autoRestoreVault", e.target.checked)} 
            />
            <span className="settings-slider"></span>
          </label>
        </div>

        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-title">Telemetry</div>
            <div className="settings-row-desc">
              Help improve Lattice by sending anonymous usage data.
            </div>
          </div>
          <label className="settings-switch">
            <input 
              type="checkbox" 
              checked={store.telemetryOptIn} 
              onChange={(e) => store.set("telemetryOptIn", e.target.checked)} 
            />
            <span className="settings-slider"></span>
          </label>
        </div>
      </div>
    );
  }

  if (section.id === "editor") {
    return (
      <div className="settings-body">
        <h2 className="settings-body-title">Editor</h2>
        
        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-title">Font size</div>
            <div className="settings-row-desc">
              The font size in pixels for the editor text.
            </div>
          </div>
          <div style={{display: 'flex', gap: '8px', alignItems: 'center'}}>
            <input 
              type="range" 
              min="10" max="32" 
              value={store.fontSize}
              onChange={(e) => store.set("fontSize", parseInt(e.target.value))}
            />
            <span style={{minWidth: '3ch', textAlign: 'right'}}>{store.fontSize}</span>
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-title">Show line numbers</div>
            <div className="settings-row-desc">
              Show line numbers in the gutter.
            </div>
          </div>
          <label className="settings-switch">
            <input 
              type="checkbox" 
              checked={store.lineNumbers} 
              onChange={(e) => store.set("lineNumbers", e.target.checked)} 
            />
            <span className="settings-slider"></span>
          </label>
        </div>

        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-title">Word wrap</div>
            <div className="settings-row-desc">
              Wrap long lines instead of scrolling horizontally.
            </div>
          </div>
          <label className="settings-switch">
            <input 
              type="checkbox" 
              checked={store.wordWrap} 
              onChange={(e) => store.set("wordWrap", e.target.checked)} 
            />
            <span className="settings-slider"></span>
          </label>
        </div>
      </div>
    );
  }

  if (section.id === "files") {
    return (
      <div className="settings-body">
        <h2 className="settings-body-title">Files and links</h2>
        
        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-title">Show file extensions</div>
            <div className="settings-row-desc">
              Show '.md' extension on files in the sidebar.
            </div>
          </div>
          <label className="settings-switch">
            <input 
              type="checkbox" 
              checked={store.showFileExtensions} 
              onChange={(e) => store.set("showFileExtensions", e.target.checked)} 
            />
            <span className="settings-slider"></span>
          </label>
        </div>

        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-title">Deleted files</div>
            <div className="settings-row-desc">
              Where to put deleted files.
            </div>
          </div>
          <select 
            className="settings-input"
            value={store.deleteBehavior}
            onChange={(e) => store.set("deleteBehavior", e.target.value as any)}
          >
            <option value="trash">Move to system trash</option>
            <option value="permanent">Permanently delete</option>
          </select>
        </div>

        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-title">Attachment folder path</div>
            <div className="settings-row-desc">
              Where to save newly added attachments.
            </div>
          </div>
          <input 
            type="text" 
            className="settings-input" 
            value={store.attachmentFolder}
            onChange={(e) => store.set("attachmentFolder", e.target.value)}
          />
        </div>
      </div>
    );
  }

  if (section.id === "appearance") {
    return (
      <div className="settings-body">
        <h2 className="settings-body-title">Appearance</h2>
        
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

        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-title">Accent color</div>
            <div className="settings-row-desc">
              The primary color used for highlights and buttons.
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <input 
              type="color" 
              value={store.accentColor} 
              onChange={(e) => store.set("accentColor", e.target.value)}
              style={{ padding: 0, width: 32, height: 32, border: 'none', background: 'none', cursor: 'pointer' }}
            />
            <button className="settings-btn" onClick={() => store.set("accentColor", "#7c5bf0")}>Reset</button>
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-title">Font family</div>
            <div className="settings-row-desc">
              The font family to use for the interface.
            </div>
          </div>
          <select 
            className="settings-input"
            value={store.fontFamily}
            onChange={(e) => store.set("fontFamily", e.target.value)}
          >
            <option value="Inter">Inter</option>
            <option value="Roboto">Roboto</option>
            <option value="System">System Default</option>
          </select>
        </div>

        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-title">UI Density</div>
            <div className="settings-row-desc">
              How compact the interface elements should be.
            </div>
          </div>
          <select 
            className="settings-input"
            value={store.density}
            onChange={(e) => store.set("density", e.target.value as any)}
          >
            <option value="comfortable">Comfortable</option>
            <option value="compact">Compact</option>
            <option value="cozy">Cozy</option>
          </select>
        </div>
      </div>
    );
  }

  // Handle core plugins list
  const isCorePlugin = CORE_PLUGIN_SECTIONS.some(p => p.id === section.id);
  if (isCorePlugin) {
    const isEnabled = store.corePlugins[section.id] ?? false;
    return (
      <div className="settings-body">
        <h2 className="settings-body-title">{section.label}</h2>
        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-title">Enable {section.label}</div>
            <div className="settings-row-desc">
              Toggle this core plugin on or off.
            </div>
          </div>
          <label className="settings-switch">
            <input 
              type="checkbox" 
              checked={isEnabled} 
              onChange={() => store.toggleCorePlugin(section.id)} 
            />
            <span className="settings-slider"></span>
          </label>
        </div>
        
        {section.id === "sync" && isEnabled && (
          <div style={{marginTop: '20px'}}>
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
        )}
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
