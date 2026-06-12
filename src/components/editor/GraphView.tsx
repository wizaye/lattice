import { useEffect, useRef, useState } from "react";
import { getVaultGraph, VaultGraphData } from "../../lib/tauriApi";
import { useVaultStore } from "../../state/vaultStore";
import { useEditorStore } from "../../state/editorStore";
import {
  loadKanbanConfig,
  KanbanColumn,
  DEFAULT_COLUMNS,
} from "../../lib/taskMetadata";
import {
  IcChevronRight,
  IcClose,
  IcGear,
  IcSync,
  IcWand,
} from "../common/Icons";
import GraphCanvas, { type GraphCanvasHandle } from "./GraphCanvas";
import "./GraphView.css";

/**
 * GraphView — outer viewer chrome (loader, error, settings panel,
 * floating overlay controls). All canvas / gesture / cursor logic
 * lives in the separate <GraphCanvas/> component so the rendering
 * surface stays isolated from the editor pane it's hosted inside.
 *
 * This component owns:
 *   • Data fetching (mock vault wikilink scan OR Tauri backend)
 *   • Loading / error UI
 *   • Settings panel + wand / gear overlay buttons
 *
 * It does NOT touch the force-graph instance directly — see GraphCanvas.
 */

export default function GraphView({ onOpenFile }: { onOpenFile: (path: string) => void }) {
  // Initial fetch must run immediately; only the *re-fetches* triggered
  // by file edits should be debounced. Previously the debounce applied
  // unconditionally, so opening graph view always paid a 1-second
  // "Computing Network Topology..." tax before the canvas appeared.
  const firstFetchRef = useRef(true);
  const canvasRef = useRef<GraphCanvasHandle>(null);
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const flatVault = useVaultStore((s) => s.flatVault);
  const fileContents = useEditorStore((s) => s.fileContents);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [graphData, setGraphData] = useState<{ nodes: any[]; links: any[] } | null>(null);
  // UI overlay state owned at the GraphView level so the floating
  // settings panel can be toggled without re-rendering the canvas.
  const [showSettings, setShowSettings] = useState(false);
  const [columns, setColumns] = useState<KanbanColumn[]>(DEFAULT_COLUMNS);

  useEffect(() => {
    if (!vaultPath) return;
    const fetchCols = () => {
      loadKanbanConfig(vaultPath).then((config) => {
        setColumns(config.columns);
      });
    };
    fetchCols();
    window.addEventListener("lattice-kanban-config-changed", fetchCols);
    window.addEventListener("lattice-tasks-changed", fetchCols);
    return () => {
      window.removeEventListener("lattice-kanban-config-changed", fetchCols);
      window.removeEventListener("lattice-tasks-changed", fetchCols);
    };
  }, [vaultPath]);

  // 1. Debounced Data Fetcher
  useEffect(() => {
    if (!vaultPath) return;

    let isCancelled = false;

    const fetchGraph = async () => {
      try {
        const data: VaultGraphData = await getVaultGraph(vaultPath);
        if (isCancelled) return;

        const nodes = data.nodes.map((n) => ({
          id: n.id,
          name: n.label,
          path: n.path,
          nodeType: n.nodeType,
          taskStatus: n.taskStatus,
          val: n.nodeType === "task" ? 1.2 : (1 + data.edges.filter(
            (e) => e.target === n.id || e.source === n.id,
          ).length),
        }));

        const nodeMap = new Map(nodes.map((n) => [n.id, n]));
        const links = data.edges
          .filter((e) => nodeMap.has(e.source) && nodeMap.has(e.target))
          .map((e) => ({ source: e.source, target: e.target }));

        if (isCancelled) return;
        setGraphData({ nodes, links });
        setLoading(false);
      } catch (err: any) {
        if (!isCancelled) {
          setError(err.toString());
          setLoading(false);
        }
      }
    };

    // Fire immediately on first mount; debounce subsequent re-fetches
    // (triggered by typing in any open file) so we don't thrash the
    // backend during edits.
    if (firstFetchRef.current) {
      firstFetchRef.current = false;
      fetchGraph();
      return () => {
        isCancelled = true;
      };
    }
    const timeout = setTimeout(fetchGraph, 1000);
    return () => {
      isCancelled = true;
      clearTimeout(timeout);
    };
  }, [vaultPath, fileContents, flatVault]);

  // NOTE: The previous version of this component mounted force-graph
  // itself (three more useEffects: init, custom wheel hijack, cleanup)
  // and a custom wheel handler that called e.stopImmediatePropagation()
  // on both the canvas AND its container. That handler also tried to
  // disambiguate trackpad swipe from mouse wheel by deltaY size — and
  // misclassified small-delta mouse wheels (deltaY ≈ ±33 on modern
  // mice) as "trackpad swipe", so it panned instead of zooming. That
  // is what users were reporting as "zoom is blocked". All of that now
  // lives in the isolated <GraphCanvas/> component, which lets
  // force-graph's bundled d3-zoom handle wheel + drag-pan natively.

  return (
    <div
      style={{
        flex: 1,
        position: "relative",
        width: "100%",
        height: "100%",
        background: "var(--bg-app)",
        overflow: "hidden",
      }}
    >
      {loading && !graphData && (
        <div className="graph-loader" aria-label="Loading graph">
          <div className="graph-spinner" />
        </div>
      )}
      {error && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            color: "#ff5555",
            zIndex: 10,
          }}
        >
          {error}
        </div>
      )}

      {/* Isolated graph viewer. Renders nothing until data arrives so
          we don't init the force simulation on an empty payload (which
          would otherwise call zoomToFit on zero nodes and crash some
          force-graph builds). */}
      {graphData && (
        <GraphCanvas
          ref={canvasRef}
          nodes={graphData.nodes}
          links={graphData.links}
          columns={columns}
          onNodeClick={(node) => {
            if (node?.nodeType === "task") {
              const rawTaskId = node.id.replace(/^task:/, "");
              window.dispatchEvent(
                new CustomEvent("lattice-open-task-modal", {
                  detail: { fileId: node.path, line: 1, taskId: rawTaskId },
                })
              );
            } else if (node?.path) {
              onOpenFile(node.path);
            }
          }}
        />
      )}

      {/* Obsidian-style floating overlay controls (top-right inside the
          canvas). Gear opens the Filters/Groups/Display/Forces panel,
          wand re-runs the force simulation. Sits above the canvas with
          high z-index but doesn't capture pointer events outside the
          icons themselves so dragging/zooming the graph still works. */}
      {!loading && !error && (
        <div className="graph-overlay-controls">
          <button
            className={`icon-btn tiny${showSettings ? " active" : ""}`}
            title="Graph settings"
            aria-pressed={showSettings}
            onClick={() => setShowSettings((o) => !o)}
          >
            <IcGear />
          </button>
          <button
            className="icon-btn tiny"
            title="Re-grow network from densest hub"
            onClick={() => canvasRef.current?.growLayout()}
          >
            <IcWand />
          </button>
        </div>
      )}

      {showSettings && !loading && !error && (
        <GraphSettingsPanel
          onClose={() => setShowSettings(false)}
          onReset={() => {
            // Reset is a stub today — settings aren't yet persisted
            // (issue: backend doesn't expose filter/group state). The
            // affordance exists so the UX matches Obsidian.
          }}
        />
      )}
    </div>
  );
}

/**
 * Floating, collapsible settings panel that mirrors Obsidian's graph
 * settings popover (Filters / Groups / Display / Forces). The control
 * inputs are placeholders today — they read/write local state only —
 * but the chrome exists so users can see the feature surface and we
 * have a single place to wire real behavior into later.
 */
function GraphSettingsPanel({
  onClose,
  onReset,
}: {
  onClose: () => void;
  onReset: () => void;
}) {
  return (
    <div className="graph-settings-panel" role="dialog" aria-label="Graph settings">
      <div className="graph-settings-header">
        <span className="graph-settings-title">Filters</span>
        <div className="graph-settings-header-actions">
          <button
            className="icon-btn tiny"
            title="Reset to defaults"
            onClick={onReset}
          >
            <IcSync />
          </button>
          <button
            className="icon-btn tiny"
            title="Close"
            onClick={onClose}
          >
            <IcClose />
          </button>
        </div>
      </div>
      <GraphSettingsSection title="Filters" defaultOpen={false}>
        <label className="graph-settings-row">
          <span>Search files</span>
          <input type="text" placeholder="path:" disabled />
        </label>
        <label className="graph-settings-checkbox">
          <input type="checkbox" defaultChecked disabled />
          <span>Show tags</span>
        </label>
        <label className="graph-settings-checkbox">
          <input type="checkbox" defaultChecked disabled />
          <span>Show attachments</span>
        </label>
        <label className="graph-settings-checkbox">
          <input type="checkbox" disabled />
          <span>Show orphans</span>
        </label>
      </GraphSettingsSection>
      <GraphSettingsSection title="Groups" defaultOpen={false}>
        <div className="graph-settings-empty">No groups yet.</div>
      </GraphSettingsSection>
      <GraphSettingsSection title="Display" defaultOpen={false}>
        <label className="graph-settings-row">
          <span>Text fade threshold</span>
          <input type="range" min={0} max={5} step={0.1} defaultValue={1.5} disabled />
        </label>
        <label className="graph-settings-row">
          <span>Node size</span>
          <input type="range" min={1} max={10} step={0.5} defaultValue={4} disabled />
        </label>
        <label className="graph-settings-row">
          <span>Link thickness</span>
          <input type="range" min={0.1} max={3} step={0.1} defaultValue={0.6} disabled />
        </label>
      </GraphSettingsSection>
      <GraphSettingsSection title="Forces" defaultOpen={false}>
        <label className="graph-settings-row">
          <span>Center force</span>
          <input type="range" min={0} max={1} step={0.05} defaultValue={0.5} disabled />
        </label>
        <label className="graph-settings-row">
          <span>Repel force</span>
          <input type="range" min={0} max={20} step={0.5} defaultValue={10} disabled />
        </label>
        <label className="graph-settings-row">
          <span>Link force</span>
          <input type="range" min={0} max={1} step={0.05} defaultValue={0.4} disabled />
        </label>
        <label className="graph-settings-row">
          <span>Link distance</span>
          <input type="range" min={10} max={500} step={10} defaultValue={150} disabled />
        </label>
      </GraphSettingsSection>
    </div>
  );
}

/**
 * A collapsible section header inside the graph settings panel.
 * Uses native <details> for keyboard + a11y semantics out of the box;
 * the chevron is the codicon, rotated via CSS based on [open].
 */
function GraphSettingsSection({
  title,
  defaultOpen,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details className="graph-settings-section" open={defaultOpen}>
      <summary className="graph-settings-section-summary">
        <IcChevronRight className="graph-settings-chevron" />
        <span>{title}</span>
      </summary>
      <div className="graph-settings-section-body">{children}</div>
    </details>
  );
}
