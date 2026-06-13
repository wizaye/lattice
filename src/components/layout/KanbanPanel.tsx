import { useCallback, useEffect, useState } from "react";
import { useVaultStore } from "../../state/vaultStore";
import type { FileNode } from "../../state/types";
import { scanTasks } from "../../lib/tauriApi";

interface Task {
  id: string;
  text: string;
  done: boolean;
  inProgress: boolean;
  fileId: string;
  fileName: string;
  line: number;
}

const TASK_RE = /^[\s>]*-\s+\[(.)\]\s+(.+)$/;

function extractTasks(nodes: FileNode[]): Task[] {
  const tasks: Task[] = [];
  for (const node of nodes) {
    if (node.kind === "file" && node.content) {
      const lines = node.content.split("\n");
      lines.forEach((line, idx) => {
        const m = TASK_RE.exec(line);
        if (!m) return;
        const marker = m[1];
        tasks.push({
          id: `${node.id}:${idx}`,
          text: m[2].trim(),
          done: marker === "x" || marker === "X",
          inProgress: marker === "/" || marker === "-",
          fileId: node.id,
          fileName: node.name.replace(/\.md$/i, ""),
          line: idx + 1,
        });
      });
    }
    if (node.children) tasks.push(...extractTasks(node.children));
  }
  return tasks;
}

interface Column {
  label: string;
  filter: (t: Task) => boolean;
  emptyText: string;
}

const COLUMNS: Column[] = [
  { label: "To do", filter: (t) => !t.done && !t.inProgress, emptyText: "No open tasks" },
  { label: "In progress", filter: (t) => t.inProgress, emptyText: "Nothing in progress" },
  { label: "Done", filter: (t) => t.done, emptyText: "No completed tasks" },
];

interface Props {
  onOpenFile?: (fileId: string, line: number) => void;
}

export function KanbanPanel({ onOpenFile }: Props) {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const fileTree = useVaultStore((s) => s.fileTree);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const loadTasks = useCallback(async () => {
    if (!vaultPath) {
      setTasks([]);
      return;
    }
    try {
      const backendTasks = await scanTasks(vaultPath);
      if (backendTasks && backendTasks.length > 0) {
        const mapped: Task[] = backendTasks.map((t) => ({
          id: t.id,
          text: t.text.replace(/<!--\s*id:\s*([\w-]+)\s*-->/, "").replace(/#([\w/-]+)/g, "").trim(),
          done: t.checked,
          inProgress: t.marker === "/" || t.marker === "-",
          fileId: t.note_path,
          fileName: t.note_path.split(/[/\\]/).pop()?.replace(/\.md$/i, "") || "",
          line: t.line_number,
        }));
        setTasks(mapped);
        return;
      }
    } catch (err) {
      console.error("Failed to scan tasks in KanbanPanel:", err);
    }
    setTasks(extractTasks(fileTree));
  }, [vaultPath, fileTree]);

  useEffect(() => {
    loadTasks();
    window.addEventListener("lattice-tasks-changed", loadTasks);
    return () => {
      window.removeEventListener("lattice-tasks-changed", loadTasks);
    };
  }, [loadTasks]);

  if (tasks.length === 0) {
    return (
      <div className="ls-empty">
        <p>No tasks found.</p>
        <p style={{ fontSize: 12, color: "var(--text-faint)" }}>
          Add <code>- [ ] task</code> items to any note.
        </p>
      </div>
    );
  }

  return (
    <div className="kanban-panel">
      {COLUMNS.map((col) => {
        const items = tasks.filter(col.filter);
        const isCollapsed = collapsed[col.label];
        return (
          <div key={col.label} className="kanban-column">
            <button
              className="kanban-col-header"
              onClick={() => setCollapsed((c) => ({ ...c, [col.label]: !c[col.label] }))}
            >
              <span className="kanban-col-label">{col.label}</span>
              <span className="kanban-col-count">{items.length}</span>
              <span className="kanban-col-chevron">{isCollapsed ? "▶" : "▼"}</span>
            </button>
            {!isCollapsed && (
              <div className="kanban-cards">
                {items.length === 0 ? (
                  <div className="kanban-empty">{col.emptyText}</div>
                ) : (
                  items.map((task) => (
                    <button
                      key={task.id}
                      className="kanban-card"
                      onClick={() => onOpenFile?.(task.fileId, task.line)}
                      title={`${task.fileName} · line ${task.line}`}
                    >
                      <span className="kanban-card-text">{task.text}</span>
                      <span className="kanban-card-source">{task.fileName}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
