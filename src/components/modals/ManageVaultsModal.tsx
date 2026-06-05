import { useEffect, useMemo, useState } from "react";
import { IcClose, IcMore, IcFolderOpened, IcTrash } from "../common/Icons";
import "./ManageVaultsModal.css";

export type Vault = {
  id: string;
  name: string;
  /** Display path — the absolute folder containing the vault. */
  path: string;
  /** Marks the vault currently open in the workspace. */
  active?: boolean;
};

type Props = {
  open: boolean;
  vaults: Vault[];
  activeVaultName: string;
  onOpenVault: (id: string) => void;
  onRemoveFromList: (id: string) => void;
  onCreateNewVault: () => void;
  onOpenFolderAsVault: () => void;
  /** "Open vault from Obsidian Sync" — kept as a stub callback so the
   *  Sign-in button has somewhere to call into when sync arrives. */
  onOpenExistingVault: () => void;
  onClose: () => void;
};

/**
 * ManageVaultsModal — modeled on Obsidian's launcher / "Manage vaults"
 * window (logo intentionally omitted).
 *
 * Layout is a two-pane card:
 *
 *   ┌──────────────┬───────────────────────────────┐
 *   │  Vault list  │        Actions card           │
 *   │  (scrolls)   │  - Create new vault   [Create]│
 *   │              │  - Open folder as v.  [Open]  │
 *   │              │  - Open from Sync     [Sign in]│
 *   └──────────────┴───────────────────────────────┘
 *
 * The dialog is large (820x560) to mirror Obsidian's proportions —
 * close button floats top-right so we don't waste vertical space on a
 * header bar. The list pane has its own scroll context so the action
 * card stays put even with a huge vault list.
 */
export function ManageVaultsModal({
  open,
  vaults,
  activeVaultName,
  onOpenVault,
  onRemoveFromList,
  onCreateNewVault,
  onOpenFolderAsVault,
  onOpenExistingVault,
  onClose,
}: Props) {
  // Esc closes — matches SettingsModal's contract so all modals dismiss
  // with the same keystroke.
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

  // Mark whichever row matches the active vault so the list shows the
  // selected highlight without forcing the parent to pre-set `active`.
  const decoratedVaults = useMemo(
    () =>
      vaults.map((v) => ({
        ...v,
        active: v.active ?? v.name === activeVaultName,
      })),
    [vaults, activeVaultName],
  );

  if (!open) return null;

  // When there are no vaults the left list pane has nothing to say,
  // so we drop it entirely and let the actions card center across the
  // full dialog — the empty list shouldn't waste a third of the
  // window on a "No vaults yet" placeholder.
  const hasVaults = decoratedVaults.length > 0;

  return (
    <div
      className="vaults-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Manage vaults"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`vaults-dialog${hasVaults ? "" : " empty"}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Close button floats absolutely in the top-right corner so it
            sits above both panes without claiming layout space. */}
        <button
          type="button"
          className="vaults-close"
          title="Close"
          aria-label="Close manage vaults"
          onClick={onClose}
        >
          <IcClose />
        </button>

        {/* ===== Left pane: vault list (only when we have any) ====== */}
        {hasVaults && (
          <aside className="vaults-list-pane">
            <ul className="vaults-list" role="list">
              {decoratedVaults.map((v) => (
                <VaultRow
                  key={v.id}
                  vault={v}
                  onOpen={() => onOpenVault(v.id)}
                  onRemove={() => onRemoveFromList(v.id)}
                />
              ))}
            </ul>
          </aside>
        )}

        {/* ===== Right pane: action card ============================== */}
        <main className="vaults-actions-pane">
          {!hasVaults && (
            <div className="vaults-empty-hero">
              <div className="vaults-empty-title">No vaults yet</div>
              <div className="vaults-empty-desc">
                Create a new vault or open an existing folder to get
                started.
              </div>
            </div>
          )}
          <div className="vaults-actions-card">
            <ActionRow
              title="Create new vault"
              description="Create a new vault under a folder."
              cta="Create"
              primary
              onClick={onCreateNewVault}
            />
            <ActionRow
              title="Open folder as vault"
              description="Choose an existing folder of Markdown files."
              cta="Open"
              onClick={onOpenFolderAsVault}
            />
            <ActionRow
              title="Open vault from Obsidian Sync"
              description="Set up a synced vault with existing remote vault."
              cta="Sign in"
              onClick={onOpenExistingVault}
            />
          </div>
        </main>
      </div>
    </div>
  );
}

function VaultRow({
  vault,
  onOpen,
  onRemove,
}: {
  vault: Vault;
  onOpen: () => void;
  onRemove: () => void;
}) {
  // Per-row overflow menu — local state because only one row's menu is
  // open at a time in practice, and per-row booleans are simpler than
  // threading an open-id through parent props.
  const [menuOpen, setMenuOpen] = useState(false);

  // Outside-click / Esc to close the menu. Scoped via `data-row` so the
  // single global pointerdown listener can tell "click inside my row"
  // from "click anywhere else".
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(`[data-row="${vault.id}"]`)) return;
      setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen, vault.id]);

  return (
    <li
      className={`vault-row${vault.active ? " active" : ""}`}
      data-row={vault.id}
    >
      <button
        type="button"
        className="vault-row-main"
        onClick={onOpen}
        title={`Open ${vault.name}`}
      >
        <span className="vault-row-name">{vault.name}</span>
        <span className="vault-row-path">{vault.path}</span>
      </button>

      <div className="vault-row-more" data-row={vault.id}>
        <button
          type="button"
          className="vault-row-kebab"
          title="More options"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((o) => !o);
          }}
        >
          {/* Rotate the horizontal ellipsis 90deg via CSS so we get a
              vertical kebab without adding another codicon import. */}
          <IcMore />
        </button>
        {menuOpen && (
          <div className="vault-row-menu" role="menu" data-row={vault.id}>
            <button
              type="button"
              role="menuitem"
              className="vault-row-menu-item"
              onClick={() => {
                setMenuOpen(false);
                onOpen();
              }}
            >
              <IcFolderOpened />
              <span>Open vault</span>
            </button>
            <div className="vault-row-menu-divider" role="separator" />
            <button
              type="button"
              role="menuitem"
              className="vault-row-menu-item danger"
              onClick={() => {
                setMenuOpen(false);
                onRemove();
              }}
            >
              <IcTrash />
              <span>Remove from list</span>
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

function ActionRow({
  title,
  description,
  cta,
  primary,
  onClick,
}: {
  title: string;
  description: string;
  cta: string;
  /** When true, render the CTA in the accent color (used for "Create"
   *  — matches Obsidian's purple Create button). */
  primary?: boolean;
  onClick: () => void;
}) {
  return (
    <div className="vault-action">
      <div className="vault-action-text">
        <div className="vault-action-title">{title}</div>
        <div className="vault-action-desc">{description}</div>
      </div>
      <button
        type="button"
        className={`vault-action-cta${primary ? " primary" : ""}`}
        onClick={onClick}
      >
        {cta}
      </button>
    </div>
  );
}
