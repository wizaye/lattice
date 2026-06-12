import { useCallback, useMemo, useRef, useState } from "react";
import { useVaultStore } from "../../state/vaultStore";
import type { FileNode } from "../../state/types";
import "./KanbanView.css";

// ─── Types ───────────────────────────────────────────────────────────────────

type TaskStatus = "todo" | "inprogress" | "done";

interface KanbanTask {
  id: string;
  text: string;
  status: TaskStatus;
  fileId: string;
  fileName: string;
  line: number;
  tags: string[];
}

interface DragState {
  taskId: string;
  fromCol: TaskStatus;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const TASK_RE = /^[\s>]*-\s+\[(.)\]\s+(.+)$/;
const TAG_RE = /#([\w/-]+)/g;

const COLUMNS: { id: TaskStatus; label: string; accent: string }[] = [
  { id: "todo",       label: "To do",       accent: "var(--text-faint)" },
  { id: "inprogress", label: "In progress", accent: "#f59e0b" },
  { id: "done",       label: "Done",        accent: "#22c55e" },
];

function markerToStatus(marker: string): TaskStatus {
  if (marker === "x" || marker === "X") return "done";
  if (marker === "/" || marker === "-") return "inprogress";
  return "todo";
}

function statusToMarker(status: TaskStatus): string {
  if (status === "done") return "x";
  if (status === "inprogress") return "/";
  return " ";
}

// ─── Extract tasks from the vault tree ───────────────────────────────────────

function extractTasks(nodes: FileNode[]): KanbanTask[] {
  const tasks: KanbanTask[] = [];
  for (const node of nodes) {
    if (node.kind === "file" && node.content) {
      const lines = node.content.split("\n");
      lines.forEach((line, idx) => {
        const m = TASK_RE.exec(line);
        if (!m) return;
        const tags: string[] = [];
        let tagMatch: RegExpExecArray | null;
        TAG_RE.lastIndex = 0;
        while ((tagMatch = TAG_RE.exec(m[2])) !== null) tags.push(tagMatch[1]);
        tasks.push({
          id: `${node.id}:${idx}`,
          text: m[2].replace(TAG_RE, "").trim(),
          status: markerToStatus(m[1]),
          fileId: node.id,
          fileName: node.name.replace(/\.md$/i, ""),
          line: idx + 1,
          tags,
        });
      });
    }
    if (node.children) tasks.push(...extractTasks(node.children));
  }
  return tasks;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Update the marker character of a task line in note content. */
function updateTaskMarker(content: string, lineIdx: number, newStatus: TaskStatus): string {
  const lines = content.split("\n");
  const line = lines[lineIdx];
  const m = TASK_RE.exec(line);
  if (!m) return content;
  lines[lineIdx] = line.replace(`[${m[1]}]`, `[${statusToMarker(newStatus)}]`);
  return lines.join("\n");
}

// ─── Card component ──────────────────────────────────────────────────────────

interface CardProps {
  task: KanbanTask;
  onOpenFile: (fileId: string, line: number) => void;
  onDragStart: (task: KanbanTask) => void;
}

function KanbanCard({ task, onOpenFile, onDragStart }: CardProps) {
  return (
    <div
      className="kb-card"
      draggable
      onDragStart={() => onDragStart(task)}
      onClick={() => onOpenFile(task.fileId, task.line)}
      title={`${task.fileName} · line ${task.line}\nClick to open`}
    >
      <div className="kb-card-text">{task.text}</div>
      {task.tags.length > 0 && (
        <div className="kb-card-tags">
          {task.tags.map((t) => (
            <span key={t} className="kb-tag">#{t}</span>
          ))}
        </div>
      )}
      <div className="kb-card-footer">
        <span className="kb-card-source">{task.fileName}</span>
        <span className="kb-card-line">:{task.line}</span>
      </div>
    </div>
  );
}

// ─── Column component ─────────────────────────────────────────────────────────

interface ColumnProps {
  col: typeof COLUMNS[number];
  tasks: KanbanTask[];
  isDragOver: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (colId: TaskStatus) => void;
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
      onDragOver={(e) => { e.preventDefault(); onDragOver(e); }}
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
        {isDragOver && tasks.length > 0 && (
          <div className="kb-drop-indicator" />
        )}
      </div>
    </div>
  );
}

// ─── Main KanbanView ─────────────────────────────────────────────────────────

interface Props {
  onOpenFileByPath?: (path: string) => void;
}

export function KanbanView({ onOpenFileByPath }: Props) {
  const fileTree   = useVaultStore((s) => s.fileTree);
  const flatVault  = useVaultStore((s) => s.flatVault);

  // Local optimistic task state so moves feel instant
  const [overrides, setOverrides] = useState<Record<string, TaskStatus>>({});
  const [dragOver, setDragOver] = useState<TaskStatus | null>(null);
  const [filter, setFilter] = useState("");
  const dragRef = useRef<DragState | null>(null);

  const baseTasks = useMemo(() => extractTasks(fileTree), [fileTree]);

  const tasks = useMemo(() =>
    baseTasks.map((t) => overrides[t.id] ? { ...t, status: overrides[t.id] } : t),
    [baseTasks, overrides],
  );

  const filteredTasks = useMemo(() => {
    const q = filter.toLowerCase().trim();
    if (!q) return tasks;
    return tasks.filter(
      (t) =>
        t.text.toLowerCase().includes(q) ||
        t.fileName.toLowerCase().includes(q) ||
        t.tags.some((tag) => tag.toLowerCase().includes(q)),
    );
  }, [tasks, filter]);

  const byStatus = useMemo(
    () => ({
      todo:       filteredTasks.filter((t) => t.status === "todo"),
      inprogress: filteredTasks.filter((t) => t.status === "inprogress"),
      done:       filteredTasks.filter((t) => t.status === "done"),
    }),
    [filteredTasks],
  );

  const onDragStart = useCallback((task: KanbanTask) => {
    dragRef.current = { taskId: task.id, fromCol: task.status };
  }, []);

  const onDrop = useCallback((toCol: TaskStatus) => {
    setDragOver(null);
    if (!dragRef.current) return;
    const { taskId, fromCol } = dragRef.current;
    if (fromCol === toCol) return;
    dragRef.current = null;

    // Optimistic UI update
    setOverrides((prev) => ({ ...prev, [taskId]: toCol }));

    // Persist change to note content via vault store
    const task = baseTasks.find((t) => t.id === taskId);
    if (!task) return;
    const node = flatVault.get(task.fileId);
    if (!node || !node.content) return;
    const newContent = updateTaskMarker(node.content, task.line - 1, toCol);
    useVaultStore.getState().updateFileContent(task.fileId, newContent);
  }, [baseTasks, flatVault]);

  const openFile = useCallback((fileId: string, line: number) => {
    const node = flatVault.get(fileId);
    if (!node) return;
    // Open the file
    if (onOpenFileByPath) onOpenFileByPath(node.id);
    // Jump to the task line after a short delay for mount
    setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("lattice-jump-to-line", {
          detail: { fileId, line, column: 0 },
        }),
      );
    }, 150);
  }, [flatVault, onOpenFileByPath]);

  const totalTasks = tasks.length;

  return (
    <div className="kb-root">
      {/* Toolbar */}
      <div className="kb-toolbar">
        <span className="kb-title">Kanban</span>
        <span className="kb-subtitle">{totalTasks} task{totalTasks !== 1 ? "s" : ""} across vault</span>
        <div className="kb-spacer" />
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
            Add <code>- [ ] task</code> items to any note in your vault.
            They'll appear here automatically.
          </div>
        </div>
      ) : (
        <div className="kb-board">
          {COLUMNS.map((col) => (
            <KanbanColumn
              key={col.id}
              col={col}
              tasks={byStatus[col.id]}
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
