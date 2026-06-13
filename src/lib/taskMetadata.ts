import { isTauri, readFile, writeFile } from "./tauriApi";
import { useEditorStore } from "../state/editorStore";
import { useVaultStore } from "../state/vaultStore";

export interface KanbanColumn {
  id: string;
  label: string;
  accent: string;
  markers: string[];
}

export interface MetadataField {
  name: string;
  type: "text" | "date" | "select";
  options?: string[];
}

export interface KanbanConfig {
  columns: KanbanColumn[];
  metadataFields: MetadataField[];
}

export interface TaskMetadata {
  description?: string;
  dueDate?: string;
  customFields?: Record<string, string>;
}

export const DEFAULT_COLUMNS: KanbanColumn[] = [
  { id: "todo", label: "To do", accent: "var(--text-faint)", markers: [" "] },
  { id: "inprogress", label: "In progress", accent: "#f59e0b", markers: ["/", "-"] },
  { id: "done", label: "Done", accent: "#22c55e", markers: ["x", "X"] },
];

export const DEFAULT_FIELDS: MetadataField[] = [
  { name: "Priority", type: "select", options: ["Low", "Medium", "High"] },
  { name: "Assignee", type: "text" },
];

export const TASK_RE_DETAILED = /^([\s>]*-\s+\[)(.)(\]\s+)(.*?)(?:\s+<!--\s*id:\s*([\w-]+)\s*-->)?$/;

/** Generate a unique 6-character short alphanumeric ID. */
export function generateShortId(): string {
  return Math.random().toString(36).substring(2, 8);
}

/** Load Kanban & Custom Field settings for the vault. */
export async function loadKanbanConfig(vaultPath: string): Promise<KanbanConfig> {
  const defaults: KanbanConfig = { columns: DEFAULT_COLUMNS, metadataFields: DEFAULT_FIELDS };
  if (!vaultPath) return defaults;

  if (!isTauri()) {
    const local = localStorage.getItem(`lattice.kanban.${vaultPath}`);
    if (local) {
      try {
        const parsed = JSON.parse(local);
        return {
          columns: parsed.columns || DEFAULT_COLUMNS,
          metadataFields: parsed.metadataFields || DEFAULT_FIELDS,
        };
      } catch (e) {
        console.error("Failed to parse local kanban config", e);
      }
    }
    return defaults;
  }

  const path = `${vaultPath}/.lattice/kanban.json`;
  try {
    const content = await readFile(path);
    if (content) {
      const parsed = JSON.parse(content);
      return {
        columns: parsed.columns || DEFAULT_COLUMNS,
        metadataFields: parsed.metadataFields || DEFAULT_FIELDS,
      };
    }
  } catch (err) {
    // File doesn't exist, which is expected
  }
  return defaults;
}

/** Save Kanban & Custom Field settings for the vault. */
export async function saveKanbanConfig(vaultPath: string, config: KanbanConfig): Promise<void> {
  if (!vaultPath) return;

  if (!isTauri()) {
    localStorage.setItem(`lattice.kanban.${vaultPath}`, JSON.stringify(config));
    return;
  }

  const path = `${vaultPath}/.lattice/kanban.json`;
  await writeFile(path, JSON.stringify(config, null, 2));
}

/** Load metadata sidecar for a specific task. */
export async function loadTaskMetadata(vaultPath: string, taskId: string): Promise<TaskMetadata> {
  if (!vaultPath || !taskId || taskId.includes(":")) return {};

  if (!isTauri()) {
    const local = localStorage.getItem(`lattice.task.${vaultPath}.${taskId}`);
    return local ? JSON.parse(local) : {};
  }

  const path = `${vaultPath}/.lattice/tasks/${taskId}.json`;
  try {
    const content = await readFile(path);
    if (content) {
      return JSON.parse(content);
    }
  } catch (e) {
    // Expected for tasks without metadata yet
  }
  return {};
}

/** Save metadata sidecar for a specific task. */
export async function saveTaskMetadata(
  vaultPath: string,
  taskId: string,
  metadata: TaskMetadata
): Promise<void> {
  if (!vaultPath || !taskId || taskId.includes(":")) return;

  if (!isTauri()) {
    localStorage.setItem(`lattice.task.${vaultPath}.${taskId}`, JSON.stringify(metadata));
    return;
  }

  const path = `${vaultPath}/.lattice/tasks/${taskId}.json`;
  await writeFile(path, JSON.stringify(metadata, null, 2));
}

/** 
 * Ensure the task checkbox line contains a stable ID.
 * Returns the stable ID (either the existing one or the newly created one).
 */
export async function ensureTaskHasStableId(
  fileId: string,
  lineNum: number, // 1-based
  currentId: string
): Promise<string> {
  if (!currentId.includes(":")) {
    // Already stable
    return currentId;
  }

  const content = await useEditorStore.getState().loadFile(fileId);
  const lines = content.split("\n");
  if (lineNum <= 0 || lineNum > lines.length) return currentId;

  const line = lines[lineNum - 1];
  const match = TASK_RE_DETAILED.exec(line);
  if (!match) return currentId;

  const existingId = match[5];
  if (existingId) return existingId;

  // Need to assign a new ID
  const newId = generateShortId();
  const cleanLine = line.trimEnd();
  lines[lineNum - 1] = `${cleanLine} <!-- id: ${newId} -->`;

  const newContent = lines.join("\n");
  useVaultStore.getState().updateFileContent(fileId, newContent);
  useEditorStore.getState().setFileContent(fileId, newContent);
  await useEditorStore.getState().saveFile(fileId);

  return newId;
}

/** Sync task status, text description, and tags back to the markdown note line on disk. */
export async function updateTaskInMarkdown(
  fileId: string,
  taskId: string,
  lineNum: number, // 1-based fallback
  updates: {
    status?: string; // column ID
    text?: string;
    tags?: string[];
  },
  columns: KanbanColumn[]
): Promise<void> {
  const content = await useEditorStore.getState().loadFile(fileId);
  const lines = content.split("\n");

  // Locate the line index
  let lineIdx = -1;
  if (taskId.includes(":")) {
    lineIdx = lineNum - 1;
  } else {
    lineIdx = lines.findIndex((l) => l.includes(`<!-- id: ${taskId} -->`));
    if (lineIdx === -1) {
      lineIdx = lineNum - 1;
    }
  }

  if (lineIdx === -1 || lineIdx >= lines.length) {
    console.error("Task line not found", taskId, fileId);
    return;
  }

  const line = lines[lineIdx];
  const match = TASK_RE_DETAILED.exec(line);
  if (!match) return;

  const prefix = match[1];
  let marker = match[2];
  const suffix = match[3];
  let bodyText = match[4];
  const existingId = match[5];

  // Update marker based on column status
  if (updates.status !== undefined) {
    const col = columns.find((c) => c.id === updates.status);
    if (col && col.markers.length > 0) {
      marker = col.markers[0];
    }
  }

  // Update text description
  if (updates.text !== undefined) {
    bodyText = updates.text.trim();
  }

  // Update tags in markdown line
  if (updates.tags !== undefined) {
    // Remove existing tags
    const TAG_RE = /#([\w/-]+)/g;
    bodyText = bodyText.replace(TAG_RE, "").trim();
    if (updates.tags.length > 0) {
      bodyText += " " + updates.tags.map((t) => `#${t}`).join(" ");
    }
  }

  // Assemble back
  const idComment = existingId
    ? ` <!-- id: ${existingId} -->`
    : taskId.includes(":")
    ? ""
    : ` <!-- id: ${taskId} -->`;

  lines[lineIdx] = `${prefix}${marker}${suffix}${bodyText}${idComment}`;

  const newContent = lines.join("\n");
  useVaultStore.getState().updateFileContent(fileId, newContent);
  useEditorStore.getState().setFileContent(fileId, newContent);
  await useEditorStore.getState().saveFile(fileId);
}
