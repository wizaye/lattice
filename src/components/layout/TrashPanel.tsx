import React from "react";
import { useVaultStore } from "../../state/vaultStore";
import { IcFolder, IcStickyNote, IcRefresh, IcTrash } from "../common/Icons";
import { deleteFile, deleteFolder, renameEntry, restoreFromTrash } from "../../lib/tauriApi";
import { confirm } from "@tauri-apps/plugin-dialog";
import "./TrashPanel.css";

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

function getRelativePath(absolutePath: string, vaultPath: string | null): string {
  if (!vaultPath) return absolutePath;
  const abs = normalizePath(absolutePath);
  const vault = normalizePath(vaultPath);
  if (abs.startsWith(vault)) {
    let rel = abs.slice(vault.length);
    if (rel.startsWith("/")) rel = rel.slice(1);
    return rel;
  }
  return absolutePath;
}

export function TrashPanel() {
  const fileTree = useVaultStore((s) => s.fileTree);
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const refreshTree = useVaultStore((s) => s.refreshTree);

  // Find the 'trash' folder in the file tree
  const trashNode = fileTree.find(
    (n) => n.name === "trash" && n.kind === "folder"
  );
  const trashItems = trashNode?.children || [];

  const handleRestore = async (e: React.MouseEvent, item: any) => {
    e.stopPropagation();
    try {
      if (item.kind === "file" && item.name.toLowerCase().endsWith(".md")) {
        const rel = getRelativePath(item.id, vaultPath);
        await restoreFromTrash(rel);
      } else {
        // Restore folders or other files back to the vault root or inbox
        const inboxPath = `${vaultPath}/inbox/${item.name}`;
        await renameEntry(item.id, inboxPath);
      }
      await refreshTree();
    } catch (err) {
      console.error("Restore failed:", err);
    }
  };

  const handleDeletePermanently = async (e: React.MouseEvent, item: any) => {
    e.stopPropagation();
    const msg = `Permanently delete "${item.name}"? This cannot be undone.`;
    const doDelete = await confirm(msg, {
      title: "Permanently Delete",
      kind: "warning",
    });
    if (doDelete) {
      try {
        if (item.kind === "folder") {
          await deleteFolder(item.id, true);
        } else {
          await deleteFile(item.id, true);
        }
        await refreshTree();
      } catch (err) {
        console.error("Delete failed:", err);
      }
    }
  };

  if (trashItems.length === 0) {
    return (
      <div className="ls-empty">
        <div style={{ fontSize: 24, marginBottom: 8, opacity: 0.6 }}>🗑️</div>
        <p>Trash is empty</p>
      </div>
    );
  }

  return (
    <div className="trash-list">
      {trashItems.map((item) => (
        <div key={item.id} className="trash-list-item" title={item.id}>
          <span className="trash-item-icon">
            {item.kind === "folder" ? <IcFolder /> : <IcStickyNote />}
          </span>
          <span className="trash-item-name">{item.name}</span>
          <div className="trash-item-actions">
            <button
              className="icon-btn tiny"
              title="Restore"
              onClick={(e) => handleRestore(e, item)}
            >
              <IcRefresh />
            </button>
            <button
              className="icon-btn tiny danger"
              title="Delete Permanently"
              onClick={(e) => handleDeletePermanently(e, item)}
            >
              <IcTrash />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
