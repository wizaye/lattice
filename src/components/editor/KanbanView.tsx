import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVaultStore } from "../../state/vaultStore";
import { useEditorStore } from "../../state/editorStore";
import type { FileNode } from "../../state/types";
import {
  loadKanbanConfig,
  DEFAULT_COLUMNS,
  TASK_RE_DETAILED,
} from "../../lib/taskMetadata";
import type { KanbanColumn } from "../../lib/taskMetadata";
import "./KanbanView.css";

// ─── Types ───────────────────────────────────────────────────────────────────

interface KanbanTask {
  id: string; // stable shortId, or fileId:lineIdx
  text: string;
  status: string; // column ID
  fileId: string;
  fileName: string;
  line: number;
  tags: string[];
}

interface DragState {
  taskId: string;
  fromCol: string;
}

const TAG_RE = /#([\w/-]+)/g;

function markerToStatus(marker: string, columns: KanbanColumn[]): string {
  const col = columns.find((c) => c.markers.includes(marker));
  return col ? col.id : columns[0]?.id || "todo";
}

function statusToMarker(status: string, columns: KanbanColumn[]): string {
  const col = columns.find((c) => c.id === status);
  return col && col.markers.length > 0 ? col.markers[0] : " ";
}

// ─── Extract tasks from the vault tree ───────────────────────────────────────

function extractTasks(nodes: FileNode[], columns: KanbanColumn[]): KanbanTask[] {
  const tasks: KanbanTask[] = [];
  for (const node of nodes) {
    if (node.kind === "file" && node.content) {
      const lines = node.content.split("\n");
      lines.forEach((line, idx) => {
        const m = TASK_RE_DETAILED.exec(line);
        if (!m) return;
        const marker = m[2];
        const bodyText = m[4];
        const stableId = m[5] || `${node.id}:${idx}`;

        const tags: string[] = [];
        let tagMatch: RegExpExecArray | null;
        TAG_RE.lastIndex = 0;
        while ((tagMatch = TAG_RE.exec(bodyText)) !== null) tags.push(tagMatch[1]);
        
        const cleanText = bodyText.replace(TAG_RE, "").trim();

        tasks.push({
          id: stableId,
          text: cleanText,
          status: markerToStatus(marker, columns),
          fileId: node.id,
          fileName: node.name.replace(/\.md$/i, ""),
          line: idx + 1,
          tags,
        });
      });
    }
    if (node.children) tasks.push(...extractTasks(node.children, columns));
  }
  return tasks;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Update the marker character of a task line in note content. */
function updateTaskMarker(
  content: string,
  lineIdx: number,
  newStatus: string,
  columns: KanbanColumn[]
): string {
  const lines = content.split("\n");
  if (lineIdx < 0 || lineIdx >= lines.length) return content;
  const line = lines[lineIdx];
  const m = TASK_RE_DETAILED.exec(line);
  if (!m) return content;
  
  const markerPrefix = matchPrefix(line);
  const rest = line.substring(markerPrefix.length + 3); // skips `[x]`
  lines[lineIdx] = `${markerPrefix}[${statusToMarker(newStatus, columns)}]${rest}`;
  return lines.join("\n");
}

function matchPrefix(line: string): string {
  const m = /^([\s>]*-\s+)/.exec(line);
  return m ? m[1] : "- ";
}

// ─── Card component ──────────────────────────────────────────────────────────

interface CardProps {
  task: KanbanTask;
  onOpenFile: (fileId: string, line: number) => void;
  onDragStart: (task: KanbanTask) => void;
}

function KanbanCard({ task, onOpenFile, onDragStart }: CardProps) {
  const handleOpenDetails = () => {
    window.dispatchEvent(
      new CustomEvent("lattice-open-task-modal", {
        detail: { fileId: task.fileId, line: task.line, taskId: task.id },
      })
    );
  };

  return (
    <div
      className="kb-card"
      draggable
      onDragStart={() => onDragStart(task)}
      onClick={handleOpenDetails}
      title="Click to view details / description"
    >
      <div className="kb-card-text">{task.text}</div>
      {task.tags.length > 0 && (
        <div className="kb-card-tags">
          {task.tags.map((t) => (
            <span key={t} className="kb-tag">
              #{t}
            </span>
          ))}
        </div>
      )}
      <div className="kb-card-footer">
        <span
          className="kb-card-source"
          onClick={(e) => {
            e.stopPropagation(); // prevent opening details
            onOpenFile(task.fileId, task.line);
          }}
          title="Click to jump to line in note"
          style={{ textDecoration: "underline", cursor: "pointer" }}
        >
          {task.fileName}
        </span>
        <span className="kb-card-line">:{task.line}</span>
      </div>
    </div>
  );
}

// ─── Column component ─────────────────────────────────────────────────────────

interface ColumnProps {
  col: KanbanColumn;
  tasks: KanbanTask[];
  isDragOver: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (colId: string) => void;
  onOpenFile: (fileId: string, line: number) => void;
  onDragStart: (task: KanbanTask) => void;
}

function KanbanColumn({
  col,
  tasks,
  isDragOver,
  onDragOver,
  onDragLeave,
  onDrop,
  onOpenFile,
  onDragStart,
}: ColumnProps) {
  return (
    <div
      className={`kb-column${isDragOver ? " kb-column--drop" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        onDragOver(e);
      }}
      onDragLeave={onDragLeave}
      onDrop={() => onDrop(col.id)}
    >
      <div className="kb-col-header">
        <span className="kb-col-dot" style={{ background: col.accent }} />
        <span className="kb-col-label">{col.label}</span>
        <span className="kb-col-count">{tasks.length}</span>
      </div>

      <div className="kb-cards">
        {tasks.length === 0 ? (
          <div className={`kb-col-empty${isDragOver ? " kb-col-empty--active" : ""}`}>
            Drop here
          </div>
        ) : (
          tasks.map((task) => (
            <KanbanCard
              key={task.id}
              task={task}
              onOpenFile={onOpenFile}
              onDragStart={onDragStart}
            />
          ))
        )}
        {isDragOver && tasks.length > 0 && <div className="kb-drop-indicator" />}
      </div>
    </div>
  );
}

// ─── Main KanbanView ─────────────────────────────────────────────────────────

interface Props {
  onOpenFileByPath?: (path: string) => void;
}

export function KanbanView({ onOpenFileByPath }: Props) {
  const fileTree = useVaultStore((s) => s.fileTree);
  const flatVault = useVaultStore((s) => s.flatVault);
  const vaultPath = useVaultStore((s) => s.vaultPath);

  const [columns, setColumns] = useState<KanbanColumn[]>(DEFAULT_COLUMNS);
  const [filter, setFilter] = useState("");
  const dragRef = useRef<DragState | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  // Local optimistic overrides so columns update instantly
  const [overrides, setOverrides] = useState<Record<string, string>>({});

  const loadConfig = useCallback(async () => {
    if (!vaultPath) return;
    const config = await loadKanbanConfig(vaultPath);
    setColumns(config.columns);
  }, [vaultPath]);

  // Initial load + event bindings
  useEffect(() => {
    loadConfig();

    const handler = () => {
      loadConfig();
      // Clear overrides on remote changes to reload from actual file
      setOverrides({});
    };

    window.addEventListener("lattice-kanban-config-changed", handler);
    window.addEventListener("lattice-tasks-changed", handler);
    return () => {
      window.removeEventListener("lattice-kanban-config-changed", handler);
      window.removeEventListener("lattice-tasks-changed", handler);
    };
  }, [loadConfig]);

  const baseTasks = useMemo(() => extractTasks(fileTree, columns), [fileTree, columns]);

  const tasks = useMemo(
    () => baseTasks.map((t) => (overrides[t.id] ? { ...t, status: overrides[t.id] } : t)),
    [baseTasks, overrides]
  );

  const filteredTasks = useMemo(() => {
    const q = filter.toLowerCase().trim();
    if (!q) return tasks;
    return tasks.filter(
      (t) =>
        t.text.toLowerCase().includes(q) ||
        t.fileName.toLowerCase().includes(q) ||
        t.tags.some((tag) => tag.toLowerCase().includes(q))
    );
  }, [tasks, filter]);

  const byStatus = useMemo(() => {
    const map: Record<string, KanbanTask[]> = {};
    columns.forEach((col) => {
      map[col.id] = [];
    });
    filteredTasks.forEach((task) => {
      if (map[task.status]) {
        map[task.status].push(task);
      } else {
        // Safe fallback for unmapped statuses
        const defaultColId = columns[0]?.id || "todo";
        if (map[defaultColId]) map[defaultColId].push(task);
      }
    });
    return map;
  }, [columns, filteredTasks]);

  const onDragStart = useCallback((task: KanbanTask) => {
    dragRef.current = { taskId: task.id, fromCol: task.status };
  }, []);

  const onDrop = useCallback(
    async (toCol: string) => {
      setDragOver(null);
      if (!dragRef.current) return;
      const { taskId, fromCol } = dragRef.current;
      if (fromCol === toCol) return;
      dragRef.current = null;

      // Optimistic UI update
      setOverrides((prev) => ({ ...prev, [taskId]: toCol }));

      // Persist change back to disk immediately
      const task = baseTasks.find((t) => t.id === taskId);
      if (!task) return;
      const node = flatVault.get(task.fileId);
      if (!node || !node.content) return;

      const lines = node.content.split("\n");
      let lineIdx = task.line - 1;

      // Resolve line idx dynamically if we have a stable ID
      if (!taskId.includes(":")) {
        const found = lines.findIndex((l) => l.includes(`<!-- id: ${taskId} -->`));
        if (found !== -1) lineIdx = found;
      }

      const newContent = updateTaskMarker(node.content, lineIdx, toCol, columns);
      
      // Update store and write directly to disk
      useVaultStore.getState().updateFileContent(task.fileId, newContent);
      useEditorStore.getState().setFileContent(task.fileId, newContent);
      await useEditorStore.getState().saveFile(task.fileId);
    },
    [baseTasks, flatVault, columns]
  );

  const openFile = useCallback(
    (fileId: string, line: number) => {
      const node = flatVault.get(fileId);
      if (!node) return;
      if (onOpenFileByPath) onOpenFileByPath(node.id);
      setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent("lattice-jump-to-line", {
            detail: { fileId, line, column: 0 },
          })
        );
      }, 150);
    },
    [flatVault, onOpenFileByPath]
  );

  const totalTasks = tasks.length;

  return (
    <div className="kb-root">
      {/* Toolbar */}
      <div className="kb-toolbar">
        <span className="kb-title">Kanban</span>
        <span className="kb-subtitle">
          {totalTasks} task{totalTasks !== 1 ? "s" : ""} across vault
        </span>
        <div className="kb-spacer" />
        <button
          className="kb-config-btn"
          onClick={() => window.dispatchEvent(new CustomEvent("lattice-open-kanban-config"))}
          title="Configure Columns & Custom Fields"
          style={{ marginRight: "10px" }}
        >
          ⚙️ Customize Board
        </button>
        <input
          className="kb-filter"
          type="text"
          placeholder="Filter tasks…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      {/* Board */}
      {totalTasks === 0 ? (
        <div className="kb-empty">
          <div className="kb-empty-icon">□</div>
          <div className="kb-empty-title">No tasks found</div>
          <div className="kb-empty-body">
            Add <code>- [ ] task</code> items to any note in your vault. They'll appear here
            automatically.
          </div>
        </div>
      ) : (
        <div className="kb-board">
          {columns.map((col) => (
            <KanbanColumn
              key={col.id}
              col={col}
              tasks={byStatus[col.id] || []}
              isDragOver={dragOver === col.id}
              onDragOver={() => setDragOver(col.id)}
              onDragLeave={() => setDragOver(null)}
              onDrop={onDrop}
              onOpenFile={openFile}
              onDragStart={onDragStart}
            />
          ))}
        </div>
      )}
    </div>
  );
}
