import { useEffect, useMemo, useState } from "react";
import {
  IcClose,
  IcFileSubmodule,
  IcFolderOpened,
  IcMore,
  IcPlus,
  IcTrash,
} from "./Icons";
import "./ManageVaultsModal.css";

export type Vault = {
  id: string;
  name: string;
  /** Display path — local-vault location or "Synced". */
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
  onOpenExistingVault: () => void;
  onClose: () => void;
};

/**
 * ManageVaultsModal — modeled on Obsidian's "Manage vaults" dialog
 * (minus the Obsidian wordmark/logo). Two sections stacked vertically:
 *
 *   1. The vault LIST — one row per known vault, each with an overflow
 *      menu (Reveal in file explorer / Remove from list). Clicking the
 *      row opens that vault.
 *   2. The ACTIONS panel — three rounded buttons covering the typical
 *      "what next" entry points:
 *        - Create new vault
 *        - Open folder as vault
 *        - Open vault
 *
 * The actual filesystem wiring isn't here yet (this is a UI shell —
 * the parent owns vault state). The callbacks let App / LeftSidebar
 * decide what each click does (e.g. invoke a Tauri command).
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
  // Esc to close — mirrors SettingsModal's behavior so the keyboard
  // contract across modals is consistent.
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

  // Decorate the vault list with `.active` so the row matching the
  // currently-open vault renders highlighted even if the parent forgot
  // to pre-set `active`. Memoized so we don't re-walk the list on every
  // unrelated rerender.
  const decoratedVaults = useMemo(
    () =>
      vaults.map((v) => ({
        ...v,
        active: v.active ?? v.name === activeVaultName,
      })),
    [vaults, activeVaultName],
  );

  if (!open) return null;

  return (
    <div
      className="vaults-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Manage vaults"
      onMouseDown={(e) => {
        // Backdrop click closes; clicks on the dialog itself stop here.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="vaults-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="vaults-header">
          <h2 className="vaults-title">Manage vaults</h2>
          <button
            className="vaults-close"
            title="Close"
            aria-label="Close manage vaults"
            onClick={onClose}
          >
            <IcClose />
          </button>
        </header>

        {/* Vault list. Stays scrollable so a long list never blows out
            the dialog height. Empty list still renders a friendly hint
            so the section never looks broken. */}
        <ul className="vaults-list" role="list">
          {decoratedVaults.length === 0 && (
            <li className="vaults-empty">
              No vaults yet — create one below to get started.
            </li>
          )}
          {decoratedVaults.map((v) => (
            <VaultRow
              key={v.id}
              vault={v}
              onOpen={() => onOpenVault(v.id)}
              onRemove={() => onRemoveFromList(v.id)}
            />
          ))}
        </ul>

        {/* Action panel — three large rounded buttons. Each row has an
            icon, a title + subtitle on the left and a small action
            button on the right that mirrors the row click target so
            either area is hit-friendly. */}
        <section className="vaults-actions">
          <ActionRow
            icon={<IcPlus />}
            title="Create new vault"
            description="Create a new vault in a folder of your choice."
            actionLabel="Create"
            onClick={onCreateNewVault}
          />
          <ActionRow
            icon={<IcFolderOpened />}
            title="Open folder as vault"
            description="Choose an existing folder to use as a vault."
            actionLabel="Open"
            onClick={onOpenFolderAsVault}
          />
          <ActionRow
            icon={<IcFileSubmodule />}
            title="Open vault"
            description="Reopen a previously closed vault from disk."
            actionLabel="Open"
            onClick={onOpenExistingVault}
          />
        </section>
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
  // Per-row overflow menu state. Local to keep parent props minimal —
  // there's only ever one row's menu open at a time, but multiple rows
  // tracking their own boolean is simpler than threading an open-id
  // through props for what's still a small list.
  const [menuOpen, setMenuOpen] = useState(false);

  // Close menu on outside click / Esc.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      // Each menu/trigger pair carries the row id via data-row so we
      // can keep one global handler and still scope close logic to the
      // right row without a per-row ref dance.
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
        <span className="vault-row-icon">
          <IcFileSubmodule />
        </span>
        <span className="vault-row-text">
          <span className="vault-row-name">{vault.name}</span>
          <span className="vault-row-path">{vault.path}</span>
        </span>
        {vault.active && <span className="vault-row-badge">Open</span>}
      </button>

      <div className="vault-row-more" data-row={vault.id}>
        <button
          type="button"
          className="icon-btn tiny"
          title="More options"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((o) => !o);
          }}
        >
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
  icon,
  title,
  description,
  actionLabel,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  actionLabel: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="vault-action" onClick={onClick}>
      <span className="vault-action-icon">{icon}</span>
      <span className="vault-action-text">
        <span className="vault-action-title">{title}</span>
        <span className="vault-action-desc">{description}</span>
      </span>
      <span className="vault-action-cta">{actionLabel}</span>
    </button>
  );
}
