import { useState } from "react";
import type { FileNode } from "../../state/types";
import { IcChevronDown, IcChevronRight } from "../common/Icons";
import { setDragImageBelowCursor } from "../common/dragGhost";
import "./FileTree.css";

type Props = {
  nodes: FileNode[];
  selectedId: string | null;
  onOpen: (file: FileNode) => void;
};

export function FileTree({ nodes, selectedId, onOpen }: Props) {
  return (
    <div className="file-tree">
      {nodes.map((n) => (
        <TreeRow key={n.id} node={n} depth={0} selectedId={selectedId} onOpen={onOpen} />
      ))}
    </div>
  );
}

function TreeRow({
  node,
  depth,
  selectedId,
  onOpen,
}: {
  node: FileNode;
  depth: number;
  selectedId: string | null;
  onOpen: (file: FileNode) => void;
}) {
  const [open, setOpen] = useState(true);
  const selected = node.id === selectedId;

  const onDragStart = (e: React.DragEvent) => {
    if (node.kind === "folder") return;
    e.dataTransfer.effectAllowed = "copyMove";
    e.dataTransfer.setData("application/x-lattice-file-id", node.id);
    e.dataTransfer.setData("text/plain", node.name);
    // Replace the default "faded element" drag image with a small chip
    // positioned below-right of the cursor (Obsidian-style).
    setDragImageBelowCursor(e, node.name);
  };

  if (node.kind === "folder") {
    return (
      <>
        <div
          className={`tree-row folder${selected ? " selected" : ""}`}
          style={{ paddingLeft: 6 + depth * 14 }}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="tree-chev">{open ? <IcChevronDown /> : <IcChevronRight />}</span>
          <span className="tree-label">{node.name}</span>
        </div>
        {open &&
          node.children?.map((c) => (
            <TreeRow
              key={c.id}
              node={c}
              depth={depth + 1}
              selectedId={selectedId}
              onOpen={onOpen}
            />
          ))}
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
      title={node.name}
    >
      <span className="tree-label">{node.name}</span>
    </div>
  );
}
