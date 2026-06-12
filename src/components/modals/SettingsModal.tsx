import React, { useEffect, useMemo, useState } from "react";
import { HelpShortcutsPanel } from "../common/HelpShortcutsPanel";
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
import { useVaultStore } from "../../state/vaultStore";
import {
  journalGetSettings,
  journalSetSettings,
  type JournalSettings,
} from "../../lib/journalApi";
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
  { id: "ai-privacy", label: "AI & Privacy", Icon: IcKey },
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
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const [journalSettings, setJournalSettings] = useState<JournalSettings | null>(null);
  const [journalBusy, setJournalBusy] = useState(false);
  const [journalError, setJournalError] = useState<string | null>(null);

  // Hoisted here (not inside the ai-privacy branch) to satisfy Rules of Hooks —
  // hooks must not be called conditionally.
  const [modelConfigs, setModelConfigs] = useState([
    { id: "ollama",    provider: "Ollama (Local)",    enabled: true,  apiKey: "" },
    { id: "openai",    provider: "OpenAI",            enabled: false, apiKey: "" },
    { id: "anthropic", provider: "Anthropic",         enabled: false, apiKey: "" },
    { id: "gemini",    provider: "Google Gemini",     enabled: false, apiKey: "" },
    { id: "azure",     provider: "Azure OpenAI",      enabled: false, apiKey: "" },
  ]);
  const [featureScopes, setFeatureScopes] = useState<Record<string, boolean>>({
    "vcs-commits":        true,
    "smart-links":        true,
    "meeting-summaries":  true,
    "canvas-completion":  true,
    "chat":               true,
  });

  useEffect(() => {
    if (section.id !== "daily-notes") return;
    if (!vaultPath || vaultPath === "__mock__") {
      setJournalSettings(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      setJournalBusy(true);
      setJournalError(null);
      try {
        const settings = await journalGetSettings(vaultPath);
        if (!cancelled) setJournalSettings(settings);
      } catch (err) {
        if (!cancelled) {
          setJournalError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setJournalBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [section.id, vaultPath]);

  const patchJournalSettings = async (
    patch: Partial<JournalSettings>,
  ): Promise<void> => {
    if (!vaultPath || vaultPath === "__mock__" || !journalSettings) return;
    const next: JournalSettings = { ...journalSettings, ...patch };
    setJournalSettings(next);
    setJournalBusy(true);
    setJournalError(null);
    try {
      await journalSetSettings(vaultPath, next);
    } catch (err) {
      setJournalError(err instanceof Error ? err.message : String(err));
    } finally {
      setJournalBusy(false);
    }
  };

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

        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-title">Vim mode</div>
            <div className="settings-row-desc">
              Enable Vim keybindings in the editor. Once active, the status bar shows
              the current mode (<strong>NORMAL</strong> / <strong>INSERT</strong> / <strong>VISUAL</strong>).
              Press <code>i</code> to enter insert, <code>Esc</code> to return to normal.
            </div>
          </div>
          <label className="settings-switch">
            <input
              type="checkbox"
              checked={store.vimMode}
              onChange={(e) => store.set("vimMode", e.target.checked)}
            />
            <span className="settings-slider"></span>
          </label>
        </div>

        {store.vimMode && (
          <div style={{
            marginTop: 12,
            padding: "12px 16px",
            background: "var(--bg-header)",
            borderRadius: 8,
            border: "1px solid var(--border-weak, var(--border))",
            fontSize: 13,
          }}>
            <div style={{ fontWeight: 600, marginBottom: 8, color: "var(--accent)" }}>
              ⌨ Vim mode is ON — quick reference
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 24px", fontFamily: "var(--font-mono)", fontSize: 12 }}>
              <span><code>i</code> — insert before cursor</span>
              <span><code>a</code> — append after cursor</span>
              <span><code>o</code> — new line below</span>
              <span><code>O</code> — new line above</span>
              <span><code>Esc</code> — normal mode</span>
              <span><code>v / V</code> — visual / line select</span>
              <span><code>h j k l</code> — move</span>
              <span><code>w / b</code> — word forward / back</span>
              <span><code>0 / $</code> — line start / end</span>
              <span><code>gg / G</code> — file top / bottom</span>
              <span><code>dd</code> — delete line</span>
              <span><code>yy / p</code> — yank / paste line</span>
              <span><code>u / Ctrl-r</code> — undo / redo</span>
              <span><code>/pattern</code> — search forward</span>
              <span><code>n / N</code> — next / prev match</span>
              <span><code>ciw / diw</code> — change / delete word</span>
            </div>
            <div style={{ marginTop: 8, color: "var(--text-faint)", fontSize: 11 }}>
              Full reference: open the Keybindings panel (Settings → Hotkeys) or press <code>?</code> in normal mode.
            </div>
          </div>
        )}

        <div className="settings-row" style={{ marginTop: 16 }}>
          <div className="settings-row-text">
            <div className="settings-row-title">Collaboration (Loro CRDT) <span style={{ fontSize: 10, background: "var(--accent)", color: "#fff", borderRadius: 4, padding: "1px 6px", marginLeft: 6, verticalAlign: "middle" }}>BETA</span></div>
            <div className="settings-row-desc">
              Backs the editor with a <strong>Loro CRDT</strong> (Conflict-free Replicated Data Type) document.
              Phase 1: local-only — richer undo history + full edit history.
              Phase 2 (coming): real-time multi-user sync via WebSocket.
              Uses the <strong>Fugue algorithm</strong> — best-in-class merge semantics.
            </div>
          </div>
          <label className="settings-switch">
            <input
              type="checkbox"
              checked={store.collabEnabled}
              onChange={(e) => store.set("collabEnabled", e.target.checked)}
            />
            <span className="settings-slider"></span>
          </label>
        </div>

        {store.collabEnabled && (
          <div style={{
            marginTop: 8,
            padding: "10px 14px",
            background: "var(--bg-header)",
            borderRadius: 8,
            border: "1px solid color-mix(in srgb, var(--accent) 40%, var(--border))",
            fontSize: 12,
            color: "var(--text-muted)",
            lineHeight: 1.6,
          }}>
            <strong style={{ color: "var(--accent)" }}>✓ CRDT active</strong> — every keystroke is tracked in a Loro document.
            Your <code>.md</code> file is still written normally on save.
            Full history is available via time-travel (coming in the next release).
          </div>
        )}
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

  if (section.id === "ai-privacy") {
    return (
      <div className="settings-body">
        <h2 className="settings-body-title">AI & Privacy</h2>
        
        <p style={{ marginBottom: '20px', opacity: 0.8, fontSize: '14px' }}>
          Configure which AI providers are available and where they can be used.
          Local providers (Ollama) never send data to the cloud.
        </p>

        <h3 style={{ fontSize: '18px', marginTop: '24px', marginBottom: '12px' }}>AI Providers</h3>

        {modelConfigs.map((config) => (
          <div key={config.id} className="settings-row" style={{ borderLeft: config.enabled ? '3px solid var(--accent, #7c5bf0)' : 'none', paddingLeft: config.enabled ? '12px' : '0' }}>
            <div className="settings-row-text">
              <div className="settings-row-title">{config.provider}</div>
              <div className="settings-row-desc">
                {config.id === "ollama" ? "Local AI running on your machine (port 11434)" :
                 config.id === "openai" ? "OpenAI GPT-4, GPT-4o, GPT-3.5-turbo" :
                 config.id === "anthropic" ? "Claude 3.5 Sonnet, Claude 3 Opus/Haiku" :
                 config.id === "gemini" ? "Gemini 1.5 Pro, Gemini 1.5 Flash" :
                 "Azure-hosted OpenAI models"}
              </div>
              {config.enabled && config.id !== "ollama" && (
                <input
                  type="password"
                  className="settings-input"
                  placeholder="API Key"
                  value={config.apiKey}
                  onChange={(e) => {
                    const next = modelConfigs.map((c) =>
                      c.id === config.id ? { ...c, apiKey: e.target.value } : c
                    );
                    setModelConfigs(next);
                  }}
                  style={{ marginTop: '8px', maxWidth: '300px' }}
                />
              )}
            </div>
            <label className="settings-switch">
              <input
                type="checkbox"
                checked={config.enabled}
                onChange={(e) => {
                  const next = modelConfigs.map((c) =>
                    c.id === config.id ? { ...c, enabled: e.target.checked } : c
                  );
                  setModelConfigs(next);
                }}
              />
              <span className="settings-slider"></span>
            </label>
          </div>
        ))}

        <h3 style={{ fontSize: '18px', marginTop: '32px', marginBottom: '12px' }}>AI Feature Scopes</h3>
        <p style={{ marginBottom: '16px', opacity: 0.8, fontSize: '14px' }}>
          Control where AI can be invoked. Disabling a scope prevents AI from being used in that feature,
          regardless of which providers are enabled above.
        </p>

        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-title">VCS commit messages</div>
            <div className="settings-row-desc">
              Generate commit messages from staged changes
            </div>
          </div>
          <label className="settings-switch">
            <input
              type="checkbox"
              checked={featureScopes["vcs-commits"]}
              onChange={(e) => setFeatureScopes({ ...featureScopes, "vcs-commits": e.target.checked })}
            />
            <span className="settings-slider"></span>
          </label>
        </div>

        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-title">Smart link suggestions</div>
            <div className="settings-row-desc">
              Suggest wikilinks while writing based on vault content
            </div>
          </div>
          <label className="settings-switch">
            <input
              type="checkbox"
              checked={featureScopes["smart-links"]}
              onChange={(e) => setFeatureScopes({ ...featureScopes, "smart-links": e.target.checked })}
            />
            <span className="settings-slider"></span>
          </label>
        </div>

        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-title">Meeting summaries</div>
            <div className="settings-row-desc">
              Generate summaries and action items from meeting transcripts
            </div>
          </div>
          <label className="settings-switch">
            <input
              type="checkbox"
              checked={featureScopes["meeting-summaries"]}
              onChange={(e) => setFeatureScopes({ ...featureScopes, "meeting-summaries": e.target.checked })}
            />
            <span className="settings-slider"></span>
          </label>
        </div>

        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-title">Canvas text completion</div>
            <div className="settings-row-desc">
              Auto-complete text nodes in canvas view
            </div>
          </div>
          <label className="settings-switch">
            <input
              type="checkbox"
              checked={featureScopes["canvas-completion"]}
              onChange={(e) => setFeatureScopes({ ...featureScopes, "canvas-completion": e.target.checked })}
            />
            <span className="settings-slider"></span>
          </label>
        </div>

        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-title">Chat / Ask AI</div>
            <div className="settings-row-desc">
              Direct chat with AI about your notes
            </div>
          </div>
          <label className="settings-switch">
            <input
              type="checkbox"
              checked={featureScopes["chat"]}
              onChange={(e) => setFeatureScopes({ ...featureScopes, "chat": e.target.checked })}
            />
            <span className="settings-slider"></span>
          </label>
        </div>

        <div style={{ marginTop: '32px', padding: '12px', background: 'var(--background-modifier-form-field)', borderRadius: '4px' }}>
          <p style={{ fontSize: '13px', opacity: 0.9, margin: 0 }}>
            <strong>Privacy note:</strong> Ollama runs locally and never sends data to the cloud.
            Other providers (OpenAI, Anthropic, Gemini, Azure) send your text to their APIs.
            API keys are stored securely in your OS keychain.
          </p>
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

  if (section.id === "daily-notes") {
    const noVault = !vaultPath || vaultPath === "__mock__";
    return (
      <div className="settings-body">
        <h2 className="settings-body-title">Daily notes</h2>

        {noVault ? (
          <p className="settings-body-empty">Open a vault to configure daily-note settings.</p>
        ) : (
          <>
            {journalError && (
              <p className="settings-body-empty" style={{ color: "var(--danger, #ef4444)" }}>
                {journalError}
              </p>
            )}
            <div className="settings-row">
              <div className="settings-row-text">
                <div className="settings-row-title">Enable daily notes</div>
                <div className="settings-row-desc">
                  Controls auto daily-note behavior. Manual open/create still works.
                </div>
              </div>
              <label className="settings-switch">
                <input
                  type="checkbox"
                  checked={journalSettings?.enabled ?? true}
                  disabled={!journalSettings || journalBusy}
                  onChange={(e) => void patchJournalSettings({ enabled: e.target.checked })}
                />
                <span className="settings-slider"></span>
              </label>
            </div>

            <div className="settings-row">
              <div className="settings-row-text">
                <div className="settings-row-title">Weekly rollup</div>
                <div className="settings-row-desc">
                  Create `YYYY-Www.md` when opening a daily note.
                </div>
              </div>
              <label className="settings-switch">
                <input
                  type="checkbox"
                  checked={journalSettings?.weekly_rollup ?? false}
                  disabled={!journalSettings || journalBusy}
                  onChange={(e) =>
                    void patchJournalSettings({ weekly_rollup: e.target.checked })
                  }
                />
                <span className="settings-slider"></span>
              </label>
            </div>

            <div className="settings-row">
              <div className="settings-row-text">
                <div className="settings-row-title">Monthly rollup</div>
                <div className="settings-row-desc">
                  Create `YYYY-MM.md` when opening a daily note.
                </div>
              </div>
              <label className="settings-switch">
                <input
                  type="checkbox"
                  checked={journalSettings?.monthly_rollup ?? false}
                  disabled={!journalSettings || journalBusy}
                  onChange={(e) =>
                    void patchJournalSettings({ monthly_rollup: e.target.checked })
                  }
                />
                <span className="settings-slider"></span>
              </label>
            </div>

            <div className="settings-row">
              <div className="settings-row-text">
                <div className="settings-row-title">Journal folder</div>
                <div className="settings-row-desc">
                  Vault-relative folder where daily notes are created.
                </div>
              </div>
              <input
                type="text"
                className="settings-input"
                value={journalSettings?.folder ?? "journals"}
                disabled={!journalSettings || journalBusy}
                onChange={(e) => void patchJournalSettings({ folder: e.target.value })}
              />
            </div>
          </>
        )}
      </div>
    );
  }

  // ── Hotkeys / keybindings reference ──────────────────────────────
  if (section.id === "hotkeys") {
    return (
      <div className="settings-body">
        <HelpShortcutsPanel inline />
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
