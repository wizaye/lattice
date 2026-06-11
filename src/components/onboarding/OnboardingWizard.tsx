/**
 * OnboardingWizard — 9-step first-run experience
 * 
 * Implements impl-v2 §10: Complete onboarding journey
 * 
 * Steps:
 * 1. Welcome + persona selection (Student / Enterprise / OSS Dev)
 * 2. Vault location picker
 * 3. BYOC sync provider setup
 * 4. AI provider configuration (BYOM)
 * 5. Calendar integration
 * 6. Publishing setup (optional)
 * 7. Templates selection
 * 8. Import existing notes (optional)
 * 9. Done + launch vault
 */

import { useState } from "react";
import "./OnboardingWizard.css";

type Persona = "student" | "enterprise" | "developer";

type OnboardingStep =
  | "welcome"
  | "vault"
  | "sync"
  | "ai"
  | "calendar"
  | "publishing"
  | "templates"
  | "import"
  | "done";

interface OnboardingState {
  step: OnboardingStep;
  persona: Persona | null;
  vaultPath: string;
  syncProvider: string | null;
  aiProvider: string | null;
  calendarProvider: string | null;
  publishHost: string | null;
  selectedTemplates: string[];
  importSource: string | null;
}

export function OnboardingWizard(props: { onComplete: (config: OnboardingState) => void }) {
  const [state, setState] = useState<OnboardingState>({
    step: "welcome",
    persona: null,
    vaultPath: "",
    syncProvider: null,
    aiProvider: null,
    calendarProvider: null,
    publishHost: null,
    selectedTemplates: [],
    importSource: null,
  });

  const nextStep = () => {
    const steps: OnboardingStep[] = [
      "welcome",
      "vault",
      "sync",
      "ai",
      "calendar",
      "publishing",
      "templates",
      "import",
      "done",
    ];
    const currentIndex = steps.indexOf(state.step);
    if (currentIndex < steps.length - 1) {
      setState({ ...state, step: steps[currentIndex + 1] });
    }
  };

  const prevStep = () => {
    const steps: OnboardingStep[] = [
      "welcome",
      "vault",
      "sync",
      "ai",
      "calendar",
      "publishing",
      "templates",
      "import",
      "done",
    ];
    const currentIndex = steps.indexOf(state.step);
    if (currentIndex > 0) {
      setState({ ...state, step: steps[currentIndex - 1] });
    }
  };

  const skip = () => {
    nextStep();
  };

  const finish = () => {
    props.onComplete(state);
  };

  return (
    <div className="onboarding-wizard">
      <div className="wizard-progress">
        <ProgressIndicator current={getStepIndex(state.step)} total={9} />
      </div>

      <div className="wizard-content">
        {state.step === "welcome" && (
          <WelcomeStep
            onSelectPersona={(persona) => {
              setState({ ...state, persona });
              nextStep();
            }}
          />
        )}

        {state.step === "vault" && (
          <VaultStep
            currentPath={state.vaultPath}
            onSelectPath={(path) => {
              setState({ ...state, vaultPath: path });
              nextStep();
            }}
            onBack={prevStep}
          />
        )}

        {state.step === "sync" && (
          <SyncStep
            persona={state.persona!}
            currentProvider={state.syncProvider}
            onSelectProvider={(provider) => {
              setState({ ...state, syncProvider: provider });
              nextStep();
            }}
            onSkip={skip}
            onBack={prevStep}
          />
        )}

        {state.step === "ai" && (
          <AIStep
            persona={state.persona!}
            currentProvider={state.aiProvider}
            onSelectProvider={(provider) => {
              setState({ ...state, aiProvider: provider });
              nextStep();
            }}
            onSkip={skip}
            onBack={prevStep}
          />
        )}

        {state.step === "calendar" && (
          <CalendarStep
            persona={state.persona!}
            currentProvider={state.calendarProvider}
            onSelectProvider={(provider) => {
              setState({ ...state, calendarProvider: provider });
              nextStep();
            }}
            onSkip={skip}
            onBack={prevStep}
          />
        )}

        {state.step === "publishing" && (
          <PublishingStep
            currentHost={state.publishHost}
            onSelectHost={(host) => {
              setState({ ...state, publishHost: host });
              nextStep();
            }}
            onSkip={skip}
            onBack={prevStep}
          />
        )}

        {state.step === "templates" && (
          <TemplatesStep
            persona={state.persona!}
            selectedTemplates={state.selectedTemplates}
            onSelectTemplates={(templates) => {
              setState({ ...state, selectedTemplates: templates });
              nextStep();
            }}
            onBack={prevStep}
          />
        )}

        {state.step === "import" && (
          <ImportStep
            currentSource={state.importSource}
            onSelectSource={(source) => {
              setState({ ...state, importSource: source });
              nextStep();
            }}
            onSkip={skip}
            onBack={prevStep}
          />
        )}

        {state.step === "done" && (
          <DoneStep
            config={state}
            onFinish={finish}
            onBack={prevStep}
          />
        )}
      </div>
    </div>
  );
}

// ── Progress Indicator ──────────────────────────────────────────────────

function ProgressIndicator(props: { current: number; total: number }) {
  return (
    <div className="progress-bar">
      {Array.from({ length: props.total }, (_, i) => (
        <div
          key={i}
          className={`progress-dot ${i <= props.current ? "active" : ""}`}
        />
      ))}
    </div>
  );
}

function getStepIndex(step: OnboardingStep): number {
  const steps: OnboardingStep[] = [
    "welcome",
    "vault",
    "sync",
    "ai",
    "calendar",
    "publishing",
    "templates",
    "import",
    "done",
  ];
  return steps.indexOf(step);
}

// ── Step Components ─────────────────────────────────────────────────────

function WelcomeStep(props: { onSelectPersona: (persona: Persona) => void }) {
  return (
    <div className="wizard-step welcome-step">
      <h1>Welcome to Lattice</h1>
      <p className="subtitle">
        One offline-first PKM that is delightful for students, trustworthy for
        enterprises, and hackable for senior engineers.
      </p>

      <div className="persona-grid">
        <PersonaCard
          persona="student"
          title="Student / Personal"
          description="Notes + journaling + Google Calendar + canvas + paper scaffolding"
          features={[
            "Daily notes & outliner mode",
            "Google Calendar sync",
            "Academic paper export (IEEE, APA)",
            "Canvas for diagrams",
          ]}
          onClick={() => props.onSelectPersona("student")}
        />

        <PersonaCard
          persona="enterprise"
          title="Enterprise / M365"
          description="Notes + Outlook/Teams + secure vault + E2E encryption"
          features={[
            "Outlook + Teams integration",
            "Meeting transcripts & AI insights",
            "End-to-end encryption",
            "OneDrive sync",
          ]}
          onClick={() => props.onSelectPersona("enterprise")}
        />

        <PersonaCard
          persona="developer"
          title="OSS Dev / Engineer"
          description="Same vault from CLI, BYOM AI in Ollama, Cal.com integration"
          features={[
            "lattice CLI (ratatui TUI)",
            "Local Ollama AI (BYOM)",
            "GitHub sync with git",
            "Cal.com integration",
          ]}
          onClick={() => props.onSelectPersona("developer")}
        />
      </div>

      <p className="note">
        Don't worry — this only sets defaults. Every feature is available to all
        personas.
      </p>
    </div>
  );
}

function PersonaCard(props: {
  persona: Persona;
  title: string;
  description: string;
  features: string[];
  onClick: () => void;
}) {
  return (
    <button className={`persona-card persona-${props.persona}`} onClick={props.onClick}>
      <h3>{props.title}</h3>
      <p>{props.description}</p>
      <ul>
        {props.features.map((feature, i) => (
          <li key={i}>{feature}</li>
        ))}
      </ul>
      <div className="select-button">Select →</div>
    </button>
  );
}

function VaultStep(props: {
  currentPath: string;
  onSelectPath: (path: string) => void;
  onBack: () => void;
}) {
  const [path, setPath] = useState(props.currentPath || "");

  const browse = async () => {
    // TODO: Use Tauri dialog plugin to browse folders
    const selected = "C:\\Users\\user\\Documents\\MyVault"; // Stub
    setPath(selected);
  };

  return (
    <div className="wizard-step vault-step">
      <h2>Choose Vault Location</h2>
      <p>Where should Lattice store your notes?</p>

      <div className="path-input">
        <input
          type="text"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="e.g. C:\Users\user\Documents\MyVault"
        />
        <button onClick={browse}>Browse...</button>
      </div>

      <div className="recommendations">
        <h4>Recommended locations:</h4>
        <ul>
          <li>
            <strong>OneDrive/Documents/MyVault</strong> — auto-backs up with OneDrive
          </li>
          <li>
            <strong>~/Documents/MyVault</strong> — standard user documents folder
          </li>
          <li>
            <strong>~/Dropbox/MyVault</strong> — syncs with Dropbox automatically
          </li>
        </ul>
      </div>

      <div className="wizard-actions">
        <button onClick={props.onBack}>← Back</button>
        <button
          className="primary"
          onClick={() => props.onSelectPath(path)}
          disabled={!path}
        >
          Continue →
        </button>
      </div>
    </div>
  );
}

function SyncStep(props: {
  persona: Persona;
  currentProvider: string | null;
  onSelectProvider: (provider: string) => void;
  onSkip: () => void;
  onBack: () => void;
}) {
  const recommendedProvider =
    props.persona === "developer"
      ? "github"
      : props.persona === "enterprise"
      ? "onedrive"
      : "gdrive";

  return (
    <div className="wizard-step sync-step">
      <h2>Sync Provider (BYOC)</h2>
      <p>Choose where to back up your vault. You can change this later.</p>

      <div className="provider-grid">
        <ProviderCard
          id="github"
          name="GitHub"
          description="Private repo sync for developers"
          recommended={recommendedProvider === "github"}
          onClick={() => props.onSelectProvider("github")}
        />
        <ProviderCard
          id="gdrive"
          name="Google Drive"
          description="15 GB free tier"
          recommended={recommendedProvider === "gdrive"}
          onClick={() => props.onSelectProvider("gdrive")}
        />
        <ProviderCard
          id="onedrive"
          name="OneDrive"
          description="Microsoft 365 integration"
          recommended={recommendedProvider === "onedrive"}
          onClick={() => props.onSelectProvider("onedrive")}
        />
        <ProviderCard
          id="dropbox"
          name="Dropbox"
          description="2 GB free tier"
          recommended={false}
          onClick={() => props.onSelectProvider("dropbox")}
        />
      </div>

      <div className="wizard-actions">
        <button onClick={props.onBack}>← Back</button>
        <button onClick={props.onSkip}>Skip for now</button>
      </div>
    </div>
  );
}

function ProviderCard(props: {
  id: string;
  name: string;
  description: string;
  recommended: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`provider-card ${props.recommended ? "recommended" : ""}`} onClick={props.onClick}>
      {props.recommended && <span className="badge">Recommended</span>}
      <h4>{props.name}</h4>
      <p>{props.description}</p>
    </button>
  );
}

function AIStep(props: {
  persona: Persona;
  currentProvider: string | null;
  onSelectProvider: (provider: string) => void;
  onSkip: () => void;
  onBack: () => void;
}) {
  const recommendedProvider = props.persona === "developer" ? "ollama" : "openai";

  return (
    <div className="wizard-step ai-step">
      <h2>AI Provider (BYOM)</h2>
      <p>Enable AI features like smart links, commit messages, and canvas completion.</p>

      <div className="provider-grid">
        <ProviderCard
          id="ollama"
          name="Ollama (Local)"
          description="100% private, runs on your machine"
          recommended={recommendedProvider === "ollama"}
          onClick={() => props.onSelectProvider("ollama")}
        />
        <ProviderCard
          id="openai"
          name="OpenAI"
          description="GPT-4, requires API key"
          recommended={recommendedProvider === "openai"}
          onClick={() => props.onSelectProvider("openai")}
        />
        <ProviderCard
          id="anthropic"
          name="Anthropic Claude"
          description="Claude 3.5, requires API key"
          recommended={false}
          onClick={() => props.onSelectProvider("anthropic")}
        />
        <ProviderCard
          id="gemini"
          name="Google Gemini"
          description="Gemini Pro, requires API key"
          recommended={false}
          onClick={() => props.onSelectProvider("gemini")}
        />
      </div>

      <div className="wizard-actions">
        <button onClick={props.onBack}>← Back</button>
        <button onClick={props.onSkip}>Skip for now</button>
      </div>
    </div>
  );
}

function CalendarStep(props: {
  persona: Persona;
  currentProvider: string | null;
  onSelectProvider: (provider: string) => void;
  onSkip: () => void;
  onBack: () => void;
}) {
  const recommendedProvider =
    props.persona === "enterprise"
      ? "outlook"
      : props.persona === "developer"
      ? "calcom"
      : "google";

  return (
    <div className="wizard-step calendar-step">
      <h2>Calendar Integration</h2>
      <p>Sync your calendar to create meeting notes automatically.</p>

      <div className="provider-grid">
        <ProviderCard
          id="outlook"
          name="Outlook + Teams"
          description="M365, meeting transcripts, AI insights"
          recommended={recommendedProvider === "outlook"}
          onClick={() => props.onSelectProvider("outlook")}
        />
        <ProviderCard
          id="google"
          name="Google Calendar"
          description="Free tier, widely used"
          recommended={recommendedProvider === "google"}
          onClick={() => props.onSelectProvider("google")}
        />
        <ProviderCard
          id="calcom"
          name="Cal.com"
          description="Open-source scheduling for developers"
          recommended={recommendedProvider === "calcom"}
          onClick={() => props.onSelectProvider("calcom")}
        />
        <ProviderCard
          id="apple"
          name="Apple Calendar"
          description="iCloud CalDAV sync"
          recommended={false}
          onClick={() => props.onSelectProvider("apple")}
        />
      </div>

      <div className="wizard-actions">
        <button onClick={props.onBack}>← Back</button>
        <button onClick={props.onSkip}>Skip for now</button>
      </div>
    </div>
  );
}

function PublishingStep(props: {
  currentHost: string | null;
  onSelectHost: (host: string) => void;
  onSkip: () => void;
  onBack: () => void;
}) {
  return (
    <div className="wizard-step publishing-step">
      <h2>Publishing (Optional)</h2>
      <p>Publish your vault as a website with Quartz.</p>

      <div className="provider-grid">
        <ProviderCard
          id="github-pages"
          name="GitHub Pages"
          description="Free hosting for public repos"
          recommended={true}
          onClick={() => props.onSelectHost("github-pages")}
        />
        <ProviderCard
          id="vercel"
          name="Vercel"
          description="Fast CDN, free tier"
          recommended={false}
          onClick={() => props.onSelectHost("vercel")}
        />
        <ProviderCard
          id="cloudflare"
          name="Cloudflare Pages"
          description="Global edge network"
          recommended={false}
          onClick={() => props.onSelectHost("cloudflare")}
        />
      </div>

      <div className="wizard-actions">
        <button onClick={props.onBack}>← Back</button>
        <button className="primary" onClick={props.onSkip}>
          Skip for now
        </button>
      </div>
    </div>
  );
}

function TemplatesStep(props: {
  persona: Persona;
  selectedTemplates: string[];
  onSelectTemplates: (templates: string[]) => void;
  onBack: () => void;
}) {
  const [selected, setSelected] = useState<string[]>(props.selectedTemplates);

  const templates = getRecommendedTemplates(props.persona);

  const toggle = (id: string) => {
    if (selected.includes(id)) {
      setSelected(selected.filter((t) => t !== id));
    } else {
      setSelected([...selected, id]);
    }
  };

  return (
    <div className="wizard-step templates-step">
      <h2>Install Templates</h2>
      <p>Pre-built templates to get you started quickly.</p>

      <div className="templates-list">
        {templates.map((template) => (
          <div key={template.id} className="template-item">
            <label>
              <input
                type="checkbox"
                checked={selected.includes(template.id)}
                onChange={() => toggle(template.id)}
              />
              <div className="template-info">
                <h4>{template.name}</h4>
                <p>{template.description}</p>
              </div>
            </label>
          </div>
        ))}
      </div>

      <div className="wizard-actions">
        <button onClick={props.onBack}>← Back</button>
        <button className="primary" onClick={() => props.onSelectTemplates(selected)}>
          Continue →
        </button>
      </div>
    </div>
  );
}

function getRecommendedTemplates(persona: Persona) {
  const common = [
    {
      id: "daily-note",
      name: "Daily Note Template",
      description: "Logseq-style daily note with morning/evening sections",
    },
    {
      id: "meeting-note",
      name: "Meeting Note Template",
      description: "Structured meeting notes with action items",
    },
  ];

  if (persona === "student") {
    return [
      ...common,
      {
        id: "ieee-paper",
        name: "IEEE Conference Paper",
        description: "Complete IEEE paper scaffold with Typst compiler",
      },
      {
        id: "lab-notebook",
        name: "Lab Notebook",
        description: "Scientific lab notebook template",
      },
    ];
  } else if (persona === "enterprise") {
    return [
      ...common,
      {
        id: "project-brief",
        name: "Project Brief",
        description: "Enterprise project documentation template",
      },
      {
        id: "status-report",
        name: "Status Report",
        description: "Weekly status report template",
      },
    ];
  } else {
    return [
      ...common,
      {
        id: "rfc",
        name: "RFC Template",
        description: "Request for Comments / design doc",
      },
      {
        id: "bug-report",
        name: "Bug Report",
        description: "Structured bug report template",
      },
    ];
  }
}

function ImportStep(props: {
  currentSource: string | null;
  onSelectSource: (source: string) => void;
  onSkip: () => void;
  onBack: () => void;
}) {
  return (
    <div className="wizard-step import-step">
      <h2>Import Existing Notes (Optional)</h2>
      <p>Migrate notes from another tool.</p>

      <div className="import-options">
        <button
          className="import-option"
          onClick={() => props.onSelectSource("obsidian")}
        >
          <h4>Obsidian</h4>
          <p>Copy vault, migrate plugins, preserve wikilinks</p>
        </button>
        <button
          className="import-option"
          onClick={() => props.onSelectSource("logseq")}
        >
          <h4>Logseq</h4>
          <p>Import journals, convert block refs, migrate graph</p>
        </button>
        <button
          className="import-option"
          onClick={() => props.onSelectSource("notion")}
        >
          <h4>Notion</h4>
          <p>Import Notion export zip, convert blocks to markdown</p>
        </button>
      </div>

      <div className="wizard-actions">
        <button onClick={props.onBack}>← Back</button>
        <button className="primary" onClick={props.onSkip}>
          Skip for now
        </button>
      </div>
    </div>
  );
}

function DoneStep(props: {
  config: OnboardingState;
  onFinish: () => void;
  onBack: () => void;
}) {
  return (
    <div className="wizard-step done-step">
      <h2>✨ You're all set!</h2>
      <p>Lattice is configured and ready to use.</p>

      <div className="config-summary">
        <h4>Your configuration:</h4>
        <ul>
          <li>
            <strong>Persona:</strong> {props.config.persona}
          </li>
          <li>
            <strong>Vault:</strong> {props.config.vaultPath}
          </li>
          {props.config.syncProvider && (
            <li>
              <strong>Sync:</strong> {props.config.syncProvider}
            </li>
          )}
          {props.config.aiProvider && (
            <li>
              <strong>AI:</strong> {props.config.aiProvider}
            </li>
          )}
          {props.config.calendarProvider && (
            <li>
              <strong>Calendar:</strong> {props.config.calendarProvider}
            </li>
          )}
          {props.config.selectedTemplates.length > 0 && (
            <li>
              <strong>Templates:</strong> {props.config.selectedTemplates.length}{" "}
              installed
            </li>
          )}
        </ul>
      </div>

      <div className="next-steps">
        <h4>Next steps:</h4>
        <ul>
          <li>Create your first note (Cmd/Ctrl + N)</li>
          <li>Open today's journal (Cmd/Ctrl + Shift + D)</li>
          <li>Explore the graph view (Cmd/Ctrl + G)</li>
          <li>Read the quick start guide</li>
        </ul>
      </div>

      <div className="wizard-actions">
        <button onClick={props.onBack}>← Back</button>
        <button className="primary large" onClick={props.onFinish}>
          Launch Lattice 🚀
        </button>
      </div>
    </div>
  );
}
