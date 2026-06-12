import { useMemo } from "react";
import { useVaultStore } from "../../state/vaultStore";
import type { FileNode } from "../../state/types";
import { IcGrid } from "../common/Icons";

function collectCanvasFiles(nodes: FileNode[]): FileNode[] {
  const out: FileNode[] = [];
  for (const n of nodes) {
    if (n.kind === "canvas") out.push(n);
    if (n.children) out.push(...collectCanvasFiles(n.children));
  }
  return out;
}

interface Props {
  onOpenFile: (file: FileNode) => void;
}

export function CanvasListPanel({ onOpenFile }: Props) {
  const fileTree = useVaultStore((s) => s.fileTree);
  const canvasFiles = useMemo(() => collectCanvasFiles(fileTree), [fileTree]);

  if (canvasFiles.length === 0) {
    return (
      <div className="ls-empty">
        <IcGrid />
        <p>No canvas files yet.</p>
        <p style={{ fontSize: 12, color: "var(--text-faint)" }}>
          Create a <code>.canvas</code> file to start a whiteboard.
        </p>
      </div>
    );
  }

  return (
    <div className="canvas-list">
      {canvasFiles.map((f) => (
        <button
          key={f.id}
          className="canvas-list-item"
          onClick={() => onOpenFile(f)}
          title={f.id}
        >
          <IcGrid />
          <span className="canvas-list-name">
            {f.name.replace(/\.canvas$/i, "")}
          </span>
        </button>
      ))}
    </div>
  );
}
