import { useEffect, useState } from "react";
import { useVaultStore } from "../../state/vaultStore";
import {
  loadKanbanConfig,
  saveKanbanConfig,
} from "../../lib/taskMetadata";
import type { KanbanColumn, MetadataField } from "../../lib/taskMetadata";
import { IcClose } from "../common/Icons";
import "./KanbanConfigModal.css";

interface KanbanConfigModalProps {
  onClose: () => void;
}

interface TempColumn {
  id: string;
  label: string;
  accent: string;
  markersString: string;
}

interface TempField {
  name: string;
  type: "text" | "date" | "select";
  optionsString: string;
}

export function KanbanConfigModal({ onClose }: KanbanConfigModalProps) {
  const vaultPath = useVaultStore((s) => s.vaultPath);

  const [columns, setColumns] = useState<TempColumn[]>([]);
  const [fields, setFields] = useState<TempField[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!vaultPath) return;

    loadKanbanConfig(vaultPath).then((config) => {
      const tempCols: TempColumn[] = config.columns.map((c) => ({
        id: c.id,
        label: c.label,
        accent: c.accent,
        markersString: c.markers.join(", "),
      }));

      const tempFields: TempField[] = config.metadataFields.map((f) => ({
        name: f.name,
        type: f.type,
        optionsString: f.options ? f.options.join(", ") : "",
      }));

      setColumns(tempCols);
      setFields(tempFields);
      setLoading(false);
    });
  }, [vaultPath]);

  const handleAddColumn = () => {
    const randomId = "col_" + Math.random().toString(36).substring(2, 8);
    setColumns((prev) => [
      ...prev,
      { id: randomId, label: "New Column", accent: "#7c5bf0", markersString: "?" },
    ]);
  };

  const handleRemoveColumn = (idx: number) => {
    setColumns((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleMoveColumn = (idx: number, direction: "up" | "down") => {
    const targetIdx = direction === "up" ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= columns.length) return;

    setColumns((prev) => {
      const next = [...prev];
      const temp = next[idx];
      next[idx] = next[targetIdx];
      next[targetIdx] = temp;
      return next;
    });
  };

  const handleColumnChange = (idx: number, field: keyof TempColumn, value: string) => {
    setColumns((prev) =>
      prev.map((col, i) => (i === idx ? { ...col, [field]: value } : col))
    );
  };

  const handleAddField = () => {
    setFields((prev) => [...prev, { name: "New Field", type: "text", optionsString: "" }]);
  };

  const handleRemoveField = (idx: number) => {
    setFields((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleFieldChange = (idx: number, field: keyof TempField, value: string) => {
    setFields((prev) =>
      prev.map((f, i) => (i === idx ? { ...f, [field]: value } : f))
    );
  };

  const handleSave = async () => {
    if (!vaultPath) return;

    // Build configuration
    const finalColumns: KanbanColumn[] = columns.map((col) => {
      // Split markers by comma, clean whitespace, filter out empty
      const markers = col.markersString
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean);

      return {
        id: col.id,
        label: col.label.trim() || "Untitled",
        accent: col.accent,
        markers: markers.length > 0 ? markers : [" "],
      };
    });

    const finalFields: MetadataField[] = fields.map((f) => {
      const options = f.optionsString
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean);

      return {
        name: f.name.trim() || "Untitled Field",
        type: f.type,
        ...(f.type === "select" ? { options } : {}),
      };
    });

    await saveKanbanConfig(vaultPath, {
      columns: finalColumns,
      metadataFields: finalFields,
    });

    // Notify updates
    window.dispatchEvent(new CustomEvent("lattice-kanban-config-changed"));
    onClose();
  };

  if (loading) return null;

  return (
    <div className="kbc-overlay" onClick={onClose}>
      <div className="kbc-container" onClick={(e) => e.stopPropagation()}>
        <div className="kbc-header">
          <div className="kbc-title">Customize Kanban Columns & Fields</div>
          <button className="kbc-close-btn" onClick={onClose}>
            <IcClose />
          </button>
        </div>

        <div className="kbc-body">
          {/* Columns Section */}
          <div className="kbc-section">
            <div className="kbc-section-title">Kanban Columns (Definition of Done)</div>
            <div className="kbc-item-list">
              {columns.map((col, idx) => (
                <div key={col.id} className="kbc-column-row">
                  <input
                    type="color"
                    className="kbc-col-color-picker"
                    value={col.accent.startsWith("#") ? col.accent : "#7c5bf0"}
                    onChange={(e) => handleColumnChange(idx, "accent", e.target.value)}
                    title="Accent Color"
                  />
                  <input
                    type="text"
                    className="kbc-input kbc-col-label-input"
                    value={col.label}
                    onChange={(e) => handleColumnChange(idx, "label", e.target.value)}
                    placeholder="Column Label"
                  />
                  <input
                    type="text"
                    className="kbc-input kbc-col-marker-input"
                    value={col.markersString}
                    onChange={(e) => handleColumnChange(idx, "markersString", e.target.value)}
                    placeholder="Marker characters (e.g. x, X)"
                    title="Markdown checklist character markers (comma-separated)"
                  />
                  <button
                    className="kbc-btn-icon"
                    onClick={() => handleMoveColumn(idx, "up")}
                    disabled={idx === 0}
                    title="Move Up"
                  >
                    ↑
                  </button>
                  <button
                    className="kbc-btn-icon"
                    onClick={() => handleMoveColumn(idx, "down")}
                    disabled={idx === columns.length - 1}
                    title="Move Down"
                  >
                    ↓
                  </button>
                  <button
                    className="kbc-btn-icon"
                    onClick={() => handleRemoveColumn(idx)}
                    title="Remove Column"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <button className="kbc-btn-add" onClick={handleAddColumn}>
              + Add Status Column
            </button>
          </div>

          {/* Fields Section */}
          <div className="kbc-section">
            <div className="kbc-section-title">Task Metadata Fields</div>
            <div className="kbc-item-list">
              {fields.map((f, idx) => (
                <div key={idx} className="kbc-field-row">
                  <input
                    type="text"
                    className="kbc-input"
                    style={{ flex: 2 }}
                    value={f.name}
                    onChange={(e) => handleFieldChange(idx, "name", e.target.value)}
                    placeholder="Field Name"
                  />
                  <select
                    className="kbc-select"
                    style={{ flex: 1 }}
                    value={f.type}
                    onChange={(e) => handleFieldChange(idx, "type", e.target.value as any)}
                  >
                    <option value="text">Text Input</option>
                    <option value="date">Date Picker</option>
                    <option value="select">Dropdown Choice</option>
                  </select>
                  {f.type === "select" ? (
                    <input
                      type="text"
                      className="kbc-input"
                      style={{ flex: 2 }}
                      value={f.optionsString}
                      onChange={(e) => handleFieldChange(idx, "optionsString", e.target.value)}
                      placeholder="Options (comma-separated)"
                    />
                  ) : (
                    <div style={{ flex: 2 }} />
                  )}
                  <button
                    className="kbc-btn-icon"
                    onClick={() => handleRemoveField(idx)}
                    title="Remove Field"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <button className="kbc-btn-add" onClick={handleAddField}>
              + Add Custom Field
            </button>
          </div>
        </div>

        <div className="kbc-footer">
          <button className="kbc-btn kbc-btn-cancel" onClick={onClose}>
            Cancel
          </button>
          <button className="kbc-btn kbc-btn-save" onClick={handleSave}>
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}
