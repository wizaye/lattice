// Step 3 — Vault picker. Three paths:
//   1. Open existing folder as a vault
//   2. Create a new folder (name + parent picker)
//   3. Re-open a known vault from `lattice.knownVaults` (the same
//      localStorage key App.tsx writes to, so the recents list stays
//      in sync with the workspace's Manage Vaults modal).
//
// Reuses existing IPC: `pickVaultFolder`, `createFolder`, `openVault`.
// Once vault management lands a real backend (docs/onboarding-journey.md
// §5.3), the only swap is the storage layer behind `loadRecents` /
// `saveRecent`; the rest of the component is IPC-agnostic.

import { useEffect, useMemo, useState } from "react";
import { useOnboardingStore } from "../state/onboardingStore";
import { getPreset } from "../state/personaPresets";
import { pickVaultFolder, createFolder, isTauri } from "../../../lib/tauriApi";
import { useVaultStore } from "../../../state/vaultStore";

type KnownVault = { id: string; name: string; path: string };

const RECENTS_KEY = "lattice.knownVaults";

function loadRecents(): KnownVault[] {
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is KnownVault =>
        v && typeof v.id === "string" && typeof v.name === "string" && typeof v.path === "string",
    );
  } catch {
    return [];
  }
}

function saveRecent(path: string): void {
  try {
    const current = loadRecents();
    if (current.some((v) => v.path === path)) return;
    const name = path.split(/[/\\]/).filter(Boolean).pop() ?? "Vault";
    const next = [...current, { id: `vault-${Date.now()}`, name, path }];
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* best-effort */
  }
}

/** Join a parent dir + child name using whichever separator the parent already uses. */
function joinPath(parent: string, child: string): string {
  const trimmed = parent.replace(/[/\\]+$/, "");
  const sep = trimmed.includes("\\") && !trimmed.includes("/") ? "\\" : "/";
  return `${trimmed}${sep}${child}`;
}

/** Default vault name from persona hint, e.g. "~/Documents/Lattice Vault" → "Lattice Vault". */
function defaultVaultName(persona: ReturnType<typeof useOnboardingStore.getState>["persona"]): string {
  if (!persona) return "Lattice Vault";
  const hint = getPreset(persona).defaultVaultHint;
  return hint.split(/[/\\]/).filter(Boolean).pop() ?? "Lattice Vault";
}

export function Step3Vault() {
  const vaultPath = useOnboardingStore((s) => s.vaultPath);
  const persona = useOnboardingStore((s) => s.persona);
  const setVault = useOnboardingStore((s) => s.setVault);
  const next = useOnboardingStore((s) => s.next);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recents, setRecents] = useState<KnownVault[]>([]);
  const [newVaultName, setNewVaultName] = useState<string>(() => defaultVaultName(persona));
  const [parentDir, setParentDir] = useState<string | null>(null);

  useEffect(() => {
    setRecents(loadRecents());
  }, []);

  const canCreate = useMemo(
    () => parentDir !== null && newVaultName.trim().length > 0 && !loading,
    [parentDir, newVaultName, loading],
  );

  async function finalize(path: string, origin: "created" | "opened"): Promise<void> {
    await useVaultStore.getState().openVault(path);
    saveRecent(path);
    setVault(path, origin);
    next();
  }

  async function handleOpenExisting(): Promise<void> {
    setError(null);
    const selected = await pickVaultFolder();
    if (!selected) return;
    setLoading(true);
    try {
      await finalize(selected, "opened");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handlePickParent(): Promise<void> {
    setError(null);
    const selected = await pickVaultFolder();
    if (selected) setParentDir(selected);
  }

  async function handleCreate(): Promise<void> {
    if (!parentDir) return;
    setError(null);
    const trimmedName = newVaultName.trim();
    if (!trimmedName) {
      setError("Folder name can't be empty.");
      return;
    }
    if (/[\\/:*?"<>|]/.test(trimmedName)) {
      setError('Folder name can\'t contain \\ / : * ? " < > |');
      return;
    }
    const target = joinPath(parentDir, trimmedName);
    setLoading(true);
    try {
      try {
        await createFolder(target);
      } catch {
        /* already-exists is fine — we'll just open it */
      }
      await finalize(target, "created");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleOpenRecent(path: string): Promise<void> {
    setError(null);
    setLoading(true);
    try {
      await finalize(path, "opened");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <h1 className="ob-h1">Pick a folder for your notes.</h1>
      <p className="ob-p">
        Your vault is just a folder on disk — every note is a plain
        Markdown file. You can move it, back it up, or open it with any
        other editor.
      </p>

      {!isTauri() && (
        <div className="ob-stub" style={{ marginBottom: 12 }}>
          <strong>Browser / dev-server mode:</strong> folder picker and vault
          creation require the desktop app. Click <strong>Skip — set this up
          later</strong> below to continue, then open a vault once you launch
          the full Tauri build.
        </div>
      )}

      {vaultPath && (
        <div className="ob-vault-current" title={vaultPath}>
          <span className="ob-vault-current-label">Current:</span>
          <code className="ob-vault-current-path">{vaultPath}</code>
        </div>
      )}

      {/* Option 1 — Open existing */}
      <section className="ob-vault-section">
        <div className="ob-vault-section-head">
          <h2 className="ob-h2">Open an existing folder</h2>
          <p className="ob-p">Point Lattice at a folder you already use for notes.</p>
        </div>
        <button
          className="ob-btn primary"
          onClick={handleOpenExisting}
          disabled={loading}
          type="button"
        >
          Open folder…
        </button>
      </section>

      {/* Option 2 — Create new */}
      <section className="ob-vault-section">
        <div className="ob-vault-section-head">
          <h2 className="ob-h2">Create a new vault</h2>
          <p className="ob-p">
            We&rsquo;ll create a fresh folder inside the parent you pick.
          </p>
        </div>
        <div className="ob-vault-create-row">
          <input
            className="ob-vault-input"
            type="text"
            value={newVaultName}
            onChange={(e) => setNewVaultName(e.target.value)}
            placeholder="Vault folder name"
            spellCheck={false}
            disabled={loading}
          />
          <button
            className="ob-btn"
            onClick={handlePickParent}
            disabled={loading}
            type="button"
          >
            {parentDir ? "Change parent…" : "Pick parent…"}
          </button>
          <button
            className="ob-btn primary"
            onClick={handleCreate}
            disabled={!canCreate}
            type="button"
          >
            Create
          </button>
        </div>
        {parentDir && (
          <div className="ob-vault-preview" title={joinPath(parentDir, newVaultName.trim() || "…")}>
            <span className="ob-vault-preview-label">Will create:</span>
            <code className="ob-vault-preview-path">
              {joinPath(parentDir, newVaultName.trim() || "…")}
            </code>
          </div>
        )}
      </section>

      {/* Option 3 — Recents */}
      {recents.length > 0 && (
        <section className="ob-vault-section">
          <div className="ob-vault-section-head">
            <h2 className="ob-h2">Recent vaults</h2>
            <p className="ob-p">Re-open a folder you&rsquo;ve already opened in Lattice.</p>
          </div>
          <ul className="ob-vault-recents">
            {recents.map((v) => (
              <li key={v.id}>
                <button
                  className="ob-vault-recent-row"
                  onClick={() => handleOpenRecent(v.path)}
                  disabled={loading}
                  type="button"
                >
                  <span className="ob-vault-recent-name">{v.name}</span>
                  <span className="ob-vault-recent-path">{v.path}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {loading && <div className="ob-vault-loading">Opening vault…</div>}
      {error && <div className="ob-vault-error" role="alert">{error}</div>}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
        <button
          className="ob-btn primary"
          onClick={() => next()}
          disabled={vaultPath === null}
        >
          Next →
        </button>
      </div>
    </div>
  );
}
