import { useState, useRef, useEffect, useCallback } from "react";
import type { FileNode } from "../../state/types";
import { IcChevronDown, IcChevronRight } from "../common/Icons";
import { setDragImageBelowCursor } from "../common/dragGhost";
import { useVaultStore } from "../../state/vaultStore";
import { renameEntry, createFolder as createFolderOnDisk, createFile as createFileOnDisk, deleteFile, deleteFolder } from "../../lib/tauriApi";
import { renameAndUpdateLinks } from "../../lib/markdown";
import { confirm, message } from "@tauri-apps/plugin-dialog";
import "./FileTree.css";

// ── Context Menu ──
interface ContextMenuState {
  x: number;
  y: number;
  node: FileNode | null;
  isRoot: boolean;
}

function ContextMenu({
  menu,
  onClose,
  onAction,
}: {
  menu: ContextMenuState;
  onClose: () => void;
  onAction: (action: string) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEsc);
    };
  }, [onClose]);

  const items: { label: string; action: string; danger?: boolean }[] = [];

  if (menu.isRoot || (menu.node && menu.node.kind === "folder")) {
    items.push({ label: "New File", action: "newFile" });
    items.push({ label: "New Folder", action: "newFolder" });
  }

  if (menu.node) {
    if (items.length > 0) items.push({ label: "---", action: "" });
    items.push({ label: "Rename", action: "rename" });
    items.push({ label: "Delete", action: "delete", danger: true });
  }

  if (items.length === 0) return null;

  return (
    <div
      ref={menuRef}
      className="context-menu animate-fade-in"
      style={{ top: menu.y, left: menu.x }}
    >
      {items.map((item, i) =>
        item.label === "---" ? (
          <div key={i} className="context-menu-separator" />
        ) : (
          <button
            key={item.action}
            className={`context-menu-item ${item.danger ? "context-menu-danger" : ""}`}
            onClick={() => onAction(item.action)}
          >
            {item.label}
          </button>
        )
      )}
    </div>
  );
}

// ── Inline Input ──
function InlineInput({
  defaultValue,
  onSubmit,
  onCancel,
  depth,
}: {
  defaultValue: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  depth: number;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
      const dotIndex = defaultValue.lastIndexOf(".");
      if (dotIndex > 0) {
        inputRef.current.setSelectionRange(0, dotIndex);
      } else {
        inputRef.current.select();
      }
    }
  }, [defaultValue]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      const value = inputRef.current?.value.trim();
      if (value) onSubmit(value);
      else onCancel();
    } else if (e.key === "Escape") {
      onCancel();
    }
  };

  return (
    <div className="tree-row inline-input-wrapper" style={{ paddingLeft: depth * 14 }}>
      <input
        ref={inputRef}
        type="text"
        className="inline-input"
        defaultValue={defaultValue}
        onKeyDown={handleKeyDown}
        onBlur={onCancel}
      />
    </div>
  );
}

// ── Tree Row ──
function TreeRow({
  node,
  depth,
  selectedId,
  onOpen,
  onContextMenu,
  inlineEdit,
  onInlineSubmit,
  onInlineCancel,
}: {
  node: FileNode;
  depth: number;
  selectedId: string | null;
  onOpen: (file: FileNode) => void;
  onContextMenu: (e: React.MouseEvent, node: FileNode) => void;
  inlineEdit: { path: string; type: "newFile" | "newFolder" | "rename" } | null;
  onInlineSubmit: (value: string) => void;
  onInlineCancel: () => void;
}) {
  const [open, setOpen] = useState(true);
  const selected = node.id === selectedId;

  const onDragStart = (e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = "copyMove";
    e.dataTransfer.setData("application/x-lattice-file-id", node.id);
    e.dataTransfer.setData("text/plain", JSON.stringify({
      type: "nexus-sidebar-item",
      path: node.id,
      isDir: node.kind === "folder",
      name: node.name
    }));
    setDragImageBelowCursor(e, node.name);
  };

  const isRenaming = inlineEdit?.path === node.id && inlineEdit?.type === "rename";

  if (isRenaming) {
    return (
      <InlineInput
        defaultValue={node.name}
        onSubmit={onInlineSubmit}
        onCancel={onInlineCancel}
        depth={depth + (node.kind === "folder" ? 0 : 1)}
      />
    );
  }

  if (node.kind === "folder") {
    return (
      <>
        <div
          className={`tree-row folder${selected ? " selected" : ""}`}
          style={{ paddingLeft: 6 + depth * 14 }}
          onClick={() => setOpen((o) => !o)}
          onContextMenu={(e) => onContextMenu(e, node)}
          draggable
          onDragStart={onDragStart}
          onDragOver={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement).classList.add("drag-over-folder");
          }}
          onDragLeave={(e) => {
            (e.currentTarget as HTMLElement).classList.remove("drag-over-folder");
          }}
          onDrop={async (e) => {
            e.preventDefault();
            e.stopPropagation();
            (e.currentTarget as HTMLElement).classList.remove("drag-over-folder");

            const data = e.dataTransfer.getData("text/plain");
            if (!data) return;
            try {
              const parsed = JSON.parse(data);
              if (parsed.type !== "nexus-sidebar-item") return;
              const { path: sourcePath, name: sourceName } = parsed;

              if (sourcePath === node.id || node.id.startsWith(sourcePath + '/')) return;
              const parentDir = sourcePath.substring(0, sourcePath.lastIndexOf("/"));
              if (parentDir === node.id) return;

              const newPath = `${node.id}/${sourceName}`;
              const doMove = await confirm(`Are you sure you want to move '${sourceName}' into '${node.name}'?`, { title: "Move Item", kind: "warning" });
              if (!doMove) return;

              const vaultPath = useVaultStore.getState().vaultPath;
              const isMd = sourcePath.toLowerCase().endsWith(".md");

              if (isMd && vaultPath) {
                const doUpdate = await confirm(`Update all internal links to '${sourceName}'?`, { title: "Update Links" });
                if (doUpdate) {
                  await renameAndUpdateLinks(sourcePath, newPath);
                } else {
                  await renameEntry(sourcePath, newPath);
                }
              } else {
                await renameEntry(sourcePath, newPath);
              }
              useVaultStore.getState().refreshTree();
            } catch (err) {
              console.error("Move failed:", err);
            }
          }}
        >
          <span className="tree-chev">{open ? <IcChevronDown /> : <IcChevronRight />}</span>
          <span className="tree-label">{node.name}</span>
        </div>
        {open && (
          <>
            {inlineEdit && (inlineEdit.type === "newFile" || inlineEdit.type === "newFolder") && inlineEdit.path === node.id && (
              <InlineInput
                defaultValue={inlineEdit.type === "newFile" ? "untitled.md" : "New Folder"}
                onSubmit={onInlineSubmit}
                onCancel={onInlineCancel}
                depth={depth + 1}
              />
            )}
            {node.children?.map((c) => (
              <TreeRow
                key={c.id}
                node={c}
                depth={depth + 1}
                selectedId={selectedId}
                onOpen={onOpen}
                onContextMenu={onContextMenu}
                inlineEdit={inlineEdit}
                onInlineSubmit={onInlineSubmit}
                onInlineCancel={onInlineCancel}
              />
            ))}
          </>
        )}
      </>
    );
  }

  return (
    <div
      className={`tree-row file${selected ? " selected" : ""}`}
      style={{ paddingLeft: 22 + depth * 14 }}
      draggable
      onDragStart={onDragStart}
      onClick={() => onOpen(node)}
      onDoubleClick={() => onOpen(node)}
      onContextMenu={(e) => onContextMenu(e, node)}
      title={node.name}
    >
      <span className="tree-label">{node.name}</span>
    </div>
  );
}

export type InlineEditState = { path: string; type: "newFile" | "newFolder" | "rename" } | null;

type Props = {
  nodes: FileNode[];
  selectedId: string | null;
  onOpen: (file: FileNode) => void;
  inlineEdit: InlineEditState;
  setInlineEdit: (val: InlineEditState) => void;
  vaultPath: string | null;
};

export function FileTree({ nodes, selectedId, onOpen, inlineEdit, setInlineEdit, vaultPath }: Props) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent, node: FileNode) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, node, isRoot: false });
  }, []);

  const handleRootContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (!vaultPath) return;
    setContextMenu({ x: e.clientX, y: e.clientY, node: null, isRoot: true });
  }, [vaultPath]);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const handleContextAction = useCallback(async (action: string) => {
    if (!contextMenu) return;
    const node = contextMenu.node;

    if (action === "newFile" || action === "newFolder") {
      const parentPath = node?.kind === "folder" ? node.id : vaultPath;
      if (parentPath) {
        setInlineEdit({ path: parentPath, type: action as "newFile" | "newFolder" });
      }
    } else if (action === "rename" && node) {
      setInlineEdit({ path: node.id, type: "rename" });
    } else if (action === "delete" && node) {
      const msg = node.kind === "folder" ? `Delete folder "${node.name}" and all contents?` : `Delete "${node.name}"?`;
      const doDelete = await confirm(msg, { title: "Delete", kind: "warning" });
      if (doDelete) {
        (async () => {
          try {
            if (node.kind === "folder") {
              await deleteFolder(node.id);
            } else {
              await deleteFile(node.id);
            }
            useVaultStore.getState().refreshTree();
          } catch (err) {
            console.error("Delete failed:", err);
          }
        })();
      }
    }
    closeContextMenu();
  }, [contextMenu, vaultPath, setInlineEdit]);

  const handleInlineSubmit = useCallback(async (value: string) => {
    if (!inlineEdit) return;
    try {
      if (inlineEdit.type === "newFile") {
        const newPath = `${inlineEdit.path}/${value}`;
        await createFileOnDisk(newPath);
        await useVaultStore.getState().refreshTree();
        // optionally auto-open:
        const flat = useVaultStore.getState().flatVault;
        const newNode = flat.get(newPath);
        if (newNode) onOpen(newNode);
      } else if (inlineEdit.type === "newFolder") {
        const newPath = `${inlineEdit.path}/${value}`;
        await createFolderOnDisk(newPath);
        await useVaultStore.getState().refreshTree();
      } else if (inlineEdit.type === "rename") {
        const oldPath = inlineEdit.path;
        const parentDir = oldPath.substring(0, oldPath.lastIndexOf("/"));
        const newPath = `${parentDir}/${value}`;
        const isMd = oldPath.toLowerCase().endsWith(".md");

        if (isMd && vaultPath) {
          const doUpdate = await confirm(`Rename to "${value}"?\n\nUpdate internal links?`, { title: "Update Links" });
          if (doUpdate) {
            await renameAndUpdateLinks(oldPath, newPath);
          } else {
            await renameEntry(oldPath, newPath);
          }
        } else {
          await renameEntry(oldPath, newPath);
        }
        await useVaultStore.getState().refreshTree();
      }
    } catch (err) {
      console.error("Operation failed:", err);
      await message(`Operation failed: ${err}`, { title: "Error", kind: "error" });
    }
    setInlineEdit(null);
  }, [inlineEdit, vaultPath, onOpen, setInlineEdit]);

  const handleInlineCancel = useCallback(() => setInlineEdit(null), [setInlineEdit]);

  return (
    <div 
      className="file-tree"
      onContextMenu={handleRootContextMenu}
      onDragOver={(e) => e.preventDefault()}
      onDrop={async (e) => {
        e.preventDefault();
        const data = e.dataTransfer.getData("text/plain");
        if (!data || !vaultPath) return;
        try {
          const parsed = JSON.parse(data);
          if (parsed.type !== "nexus-sidebar-item") return;
          const { path: sourcePath, name: sourceName } = parsed;
          const parentDir = sourcePath.substring(0, sourcePath.lastIndexOf("/"));
          if (parentDir === vaultPath) return; // already in root

          const newPath = `${vaultPath}/${sourceName}`;
          const doMove = await confirm(`Move '${sourceName}' to the vault root?`, { title: "Move Item", kind: "warning" });
          if (!doMove) return;

          const isMd = sourcePath.toLowerCase().endsWith(".md");
          if (isMd) {
            const doUpdate = await confirm(`Update internal links to '${sourceName}'?`, { title: "Update Links" });
            if (doUpdate) {
              await renameAndUpdateLinks(sourcePath, newPath);
            } else {
              await renameEntry(sourcePath, newPath);
            }
          } else {
            await renameEntry(sourcePath, newPath);
          }
          useVaultStore.getState().refreshTree();
        } catch (err) {
          console.error("Root move failed:", err);
        }
      }}
    >
      {inlineEdit && (inlineEdit.type === "newFile" || inlineEdit.type === "newFolder") && inlineEdit.path === vaultPath && (
        <InlineInput
          defaultValue={inlineEdit.type === "newFile" ? "untitled.md" : "New Folder"}
          onSubmit={handleInlineSubmit}
          onCancel={handleInlineCancel}
          depth={0}
        />
      )}
      {nodes.map((n) => (
        <TreeRow
          key={n.id}
          node={n}
          depth={0}
          selectedId={selectedId}
          onOpen={onOpen}
          onContextMenu={handleContextMenu}
          inlineEdit={inlineEdit}
          onInlineSubmit={handleInlineSubmit}
          onInlineCancel={handleInlineCancel}
        />
      ))}
      {contextMenu && (
        <ContextMenu
          menu={contextMenu}
          onClose={closeContextMenu}
          onAction={handleContextAction}
        />
      )}
    </div>
  );
}
