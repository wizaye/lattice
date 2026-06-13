import { useEffect, useState } from "react";
import { useVaultStore } from "../../state/vaultStore";
import { useEditorStore } from "../../state/editorStore";
import {
  loadKanbanConfig,
  loadTaskMetadata,
  saveTaskMetadata,
  updateTaskInMarkdown,
  ensureTaskHasStableId,
  KanbanColumn,
  MetadataField,
  TASK_RE_DETAILED,
} from "../../lib/taskMetadata";
import { IcClose } from "../common/Icons";
import "./TaskDetailModal.css";

interface TaskDetailModalProps {
  fileId: string;
  line: number;
  taskId: string;
  onClose: () => void;
}

export function TaskDetailModal({ fileId, line, taskId, onClose }: TaskDetailModalProps) {
  const vaultPath = useVaultStore((s) => s.vaultPath);

  const [loading, setLoading] = useState(true);
  const [columns, setColumns] = useState<KanbanColumn[]>([]);
  const [customFieldsSchema, setCustomFieldsSchema] = useState<MetadataField[]>([]);

  // Task fields
  const [resolvedTaskId, setResolvedTaskId] = useState(taskId);
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [newTagInput, setNewTagInput] = useState("");
  const [customFieldValues, setCustomFieldValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!vaultPath) return;

    const init = async () => {
      // 1. Load configuration
      const config = await loadKanbanConfig(vaultPath);
      setColumns(config.columns);
      setCustomFieldsSchema(config.metadataFields);

      // 2. Load task metadata from sidecar file only if we already have a stable ID
      let stableId = taskId;
      if (!taskId.includes(":")) {
        const meta = await loadTaskMetadata(vaultPath, taskId);
        setDescription(meta.description || "");
        setDueDate(meta.dueDate || "");
        setCustomFieldValues(meta.customFields || {});
      } else {
        setDescription("");
        setDueDate("");
        setCustomFieldValues({});
      }
      setResolvedTaskId(stableId);

      // 3. Load current values from markdown file
      const noteContent = await useEditorStore.getState().loadFile(fileId);
      const lines = noteContent.split("\n");
      let lineIdx = -1;

      if (stableId.includes(":")) {
        lineIdx = line - 1;
      } else {
        lineIdx = lines.findIndex((l) => l.includes(`<!-- id: ${stableId} -->`));
        if (lineIdx === -1) lineIdx = line - 1;
      }

      if (lineIdx !== -1 && lineIdx < lines.length) {
        const lineText = lines[lineIdx];
        const match = TASK_RE_DETAILED.exec(lineText);
        if (match) {
          const marker = match[2];
          const bodyText = match[4];

          // Map marker character to status column id
          const matchingCol =
            config.columns.find((c) => c.markers.includes(marker)) || config.columns[0];
          setStatus(matchingCol?.id || "todo");

          // Extract tags from line
          const TAG_RE = /#([\w/-]+)/g;
          const lineTags: string[] = [];
          let tagMatch;
          while ((tagMatch = TAG_RE.exec(bodyText)) !== null) {
            lineTags.push(tagMatch[1]);
          }
          setTags(lineTags);

          // Clean title
          const cleanTitle = bodyText.replace(TAG_RE, "").trim();
          setTitle(cleanTitle);
        }
      }
      setLoading(false);
    };

    init();
  }, [vaultPath, fileId, line, taskId]);

  const handleAddTag = () => {
    const cleanTag = newTagInput.trim().replace(/^#/, "");
    if (cleanTag && !tags.includes(cleanTag)) {
      setTags((prev) => [...prev, cleanTag]);
      setNewTagInput("");
    }
  };

  const handleRemoveTag = (tagToRemove: string) => {
    setTags((prev) => prev.filter((t) => t !== tagToRemove));
  };

  const handleCustomFieldChange = (fieldName: string, val: string) => {
    setCustomFieldValues((prev) => ({ ...prev, [fieldName]: val }));
  };

  const handleSave = async () => {
    if (!vaultPath) return;

    let finalTaskId = resolvedTaskId;
    const hasMetadata =
      description.trim() !== "" ||
      dueDate.trim() !== "" ||
      Object.values(customFieldValues).some((v) => v && v.trim() !== "");

    if (hasMetadata && finalTaskId.includes(":")) {
      // User entered some metadata, so now we must generate and persist a stable ID comment
      finalTaskId = await ensureTaskHasStableId(fileId, line, finalTaskId);
    }

    if (!finalTaskId.includes(":")) {
      // Save metadata sidecar
      await saveTaskMetadata(vaultPath, finalTaskId, {
        description,
        dueDate,
        customFields: customFieldValues,
      });
    }

    // 2. Sync to markdown file
    await updateTaskInMarkdown(
      fileId,
      finalTaskId,
      line,
      {
        status,
        text: title,
        tags,
      },
      columns
    );

    // 3. Dispatch changes notification
    window.dispatchEvent(new CustomEvent("lattice-tasks-changed"));
    onClose();
  };

  const handleJumpToNote = () => {
    window.dispatchEvent(
      new CustomEvent("lattice-open-wikilink", {
        detail: { target: fileId },
      })
    );
    setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("lattice-jump-to-line", {
          detail: { fileId, line, column: 0 },
        })
      );
    }, 150);
    onClose();
  };

  if (loading) return null;

  return (
    <div className="tdm-overlay" onClick={onClose}>
      <div className="tdm-container" onClick={(e) => e.stopPropagation()}>
        <div className="tdm-header">
          <div className="tdm-title">Task Details</div>
          <button className="tdm-close-btn" onClick={onClose}>
            <IcClose />
          </button>
        </div>

        <div className="tdm-body">
          {/* Title */}
          <div className="tdm-field">
            <label className="tdm-label">Task Name</label>
            <input
              type="text"
              className="tdm-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What needs to be done?"
            />
          </div>

          {/* Status and Due Date */}
          <div className="tdm-row">
            <div className="tdm-field">
              <label className="tdm-label">Status</label>
              <select
                className="tdm-select"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                {columns.map((col) => (
                  <option key={col.id} value={col.id}>
                    {col.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="tdm-field">
              <label className="tdm-label">Due Date</label>
              <input
                type="date"
                className="tdm-input"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>
          </div>

          {/* Description */}
          <div className="tdm-field">
            <label className="tdm-label">Detailed Description</label>
            <textarea
              className="tdm-input tdm-textarea"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add details, notes, or checklists here..."
            />
          </div>

          {/* Tags */}
          <div className="tdm-field">
            <label className="tdm-label">Tags</label>
            <div className="tdm-tags-input-container">
              <input
                type="text"
                className="tdm-input"
                style={{ flex: 1 }}
                value={newTagInput}
                onChange={(e) => setNewTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAddTag();
                  }
                }}
                placeholder="Add hashtag..."
              />
              <button className="tdm-btn tdm-btn-cancel" onClick={handleAddTag}>
                Add
              </button>
            </div>
            <div className="tdm-tags-list">
              {tags.map((tag) => (
                <span key={tag} className="tdm-tag-chip">
                  #{tag}
                  <button className="tdm-tag-delete" onClick={() => handleRemoveTag(tag)}>
                    ✕
                  </button>
                </span>
              ))}
            </div>
          </div>

          {/* Custom Fields Schema-driven */}
          {customFieldsSchema.length > 0 && (
            <div className="tdm-field" style={{ marginTop: "10px" }}>
              <label className="tdm-label" style={{ borderBottom: "1px solid var(--border-soft)", paddingBottom: "4px" }}>
                Vault Custom Metadata
              </label>
              <div className="tdm-row" style={{ marginTop: "10px", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
                {customFieldsSchema.map((f) => (
                  <div key={f.name} className="tdm-field">
                    <label className="tdm-label">{f.name}</label>
                    {f.type === "select" ? (
                      <select
                        className="tdm-select"
                        value={customFieldValues[f.name] || ""}
                        onChange={(e) => handleCustomFieldChange(f.name, e.target.value)}
                      >
                        <option value="">-- None --</option>
                        {f.options?.map((opt) => (
                          <option key={opt} value={opt}>
                            {opt}
                          </option>
                        ))}
                      </select>
                    ) : f.type === "date" ? (
                      <input
                        type="date"
                        className="tdm-input"
                        value={customFieldValues[f.name] || ""}
                        onChange={(e) => handleCustomFieldChange(f.name, e.target.value)}
                      />
                    ) : (
                      <input
                        type="text"
                        className="tdm-input"
                        value={customFieldValues[f.name] || ""}
                        onChange={(e) => handleCustomFieldChange(f.name, e.target.value)}
                        placeholder={`Enter ${f.name.toLowerCase()}...`}
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="tdm-footer">
          <div className="tdm-footer-left">
            <button className="tdm-btn tdm-btn-note" onClick={handleJumpToNote}>
              Open Note
            </button>
          </div>
          <div className="tdm-footer-right">
            <button className="tdm-btn tdm-btn-cancel" onClick={onClose}>
              Cancel
            </button>
            <button className="tdm-btn tdm-btn-save" onClick={handleSave}>
              Save Details
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
