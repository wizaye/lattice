import { useEffect, useRef, useState, useMemo } from "react";
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

  // Filters state
  const [searchQuery, setSearchQuery] = useState("");
  const [showTags, setShowTags] = useState(true);
  const [showAttachments, setShowAttachments] = useState(true);
  const [showOrphans, setShowOrphans] = useState(false);

  // Display state
  const [textFadeThreshold, setTextFadeThreshold] = useState(1.5);
  const [nodeSize, setNodeSize] = useState(4);
  const [linkThickness, setLinkThickness] = useState(0.6);

  // Forces state
  const [centerForce, setCenterForce] = useState(0.5);
  const [repelForce, setRepelForce] = useState(10);
  const [linkForce, setLinkForce] = useState(0.4);
  const [linkDistance, setLinkDistance] = useState(150);

  // Memoized filtered graph data
  const filteredGraphData = useMemo(() => {
    if (!graphData) return null;

    let nodes = graphData.nodes.filter((node) => {
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const matchesName = node.name?.toLowerCase().includes(q);
        const matchesPath = node.path?.toLowerCase().includes(q);
        if (!matchesName && !matchesPath) return false;
      }
      if (!showTags && node.nodeType === "tag") {
        return false;
      }
      if (!showAttachments && node.nodeType === "attachment") {
        return false;
      }
      return true;
    });

    const nodeIds = new Set(nodes.map((n) => n.id));
    let links = graphData.links.filter((link) => {
      const sourceId = typeof link.source === "object" ? link.source.id : link.source;
      const targetId = typeof link.target === "object" ? link.target.id : link.target;
      return nodeIds.has(sourceId) && nodeIds.has(targetId);
    });

    if (!showOrphans) {
      const linkedNodeIds = new Set<string>();
      for (const link of links) {
        const sourceId = typeof link.source === "object" ? link.source.id : link.source;
        const targetId = typeof link.target === "object" ? link.target.id : link.target;
        linkedNodeIds.add(sourceId);
        linkedNodeIds.add(targetId);
      }
      nodes = nodes.filter((node) => linkedNodeIds.has(node.id));
    }

    return { nodes, links };
  }, [graphData, searchQuery, showTags, showAttachments, showOrphans]);

  const handleReset = () => {
    setSearchQuery("");
    setShowTags(true);
    setShowAttachments(true);
    setShowOrphans(false);
    setTextFadeThreshold(1.5);
    setNodeSize(4);
    setLinkThickness(0.6);
    setCenterForce(0.5);
    setRepelForce(10);
    setLinkForce(0.4);
    setLinkDistance(150);
  };

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

  // Bug fix: when vaultPath is null the data-fetcher useEffect returns
  // early without ever calling setLoading(false), leaving the spinner
  // spinning forever.  Explicitly clear the loading state whenever there
  // is no vault to fetch from.
  useEffect(() => {
    if (!vaultPath) {
      setLoading(false);
      setGraphData(null);
      setError(null);
    }
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
      {/* Empty state: no vault open */}
      {!loading && !error && !graphData && !vaultPath && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            gap: 12,
            color: "var(--text-faint)",
            fontSize: 13,
            userSelect: "none",
          }}
        >
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2">
            <circle cx="12" cy="12" r="3" />
            <circle cx="4" cy="6" r="2" />
            <circle cx="20" cy="6" r="2" />
            <circle cx="4" cy="18" r="2" />
            <circle cx="20" cy="18" r="2" />
            <line x1="12" y1="9" x2="4" y2="7" />
            <line x1="12" y1="9" x2="20" y2="7" />
            <line x1="12" y1="15" x2="4" y2="17" />
            <line x1="12" y1="15" x2="20" y2="17" />
          </svg>
          <span>Open a vault to see the knowledge graph</span>
        </div>
      )}
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
      {filteredGraphData && (
        <GraphCanvas
          ref={canvasRef}
          nodes={filteredGraphData.nodes}
          links={filteredGraphData.links}
          columns={columns}
          textFadeThreshold={textFadeThreshold}
          nodeSize={nodeSize}
          linkThickness={linkThickness}
          centerForce={centerForce}
          repelForce={repelForce}
          linkForce={linkForce}
          linkDistance={linkDistance}
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
          onReset={handleReset}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          showTags={showTags}
          setShowTags={setShowTags}
          showAttachments={showAttachments}
          setShowAttachments={setShowAttachments}
          showOrphans={showOrphans}
          setShowOrphans={setShowOrphans}
          textFadeThreshold={textFadeThreshold}
          setTextFadeThreshold={setTextFadeThreshold}
          nodeSize={nodeSize}
          setNodeSize={setNodeSize}
          linkThickness={linkThickness}
          setLinkThickness={setLinkThickness}
          centerForce={centerForce}
          setCenterForce={setCenterForce}
          repelForce={repelForce}
          setRepelForce={setRepelForce}
          linkForce={linkForce}
          setLinkForce={setLinkForce}
          linkDistance={linkDistance}
          setLinkDistance={setLinkDistance}
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
  searchQuery,
  setSearchQuery,
  showTags,
  setShowTags,
  showAttachments,
  setShowAttachments,
  showOrphans,
  setShowOrphans,
  textFadeThreshold,
  setTextFadeThreshold,
  nodeSize,
  setNodeSize,
  linkThickness,
  setLinkThickness,
  centerForce,
  setCenterForce,
  repelForce,
  setRepelForce,
  linkForce,
  setLinkForce,
  linkDistance,
  setLinkDistance,
}: {
  onClose: () => void;
  onReset: () => void;
  searchQuery: string;
  setSearchQuery: (v: string) => void;
  showTags: boolean;
  setShowTags: (v: boolean) => void;
  showAttachments: boolean;
  setShowAttachments: (v: boolean) => void;
  showOrphans: boolean;
  setShowOrphans: (v: boolean) => void;
  textFadeThreshold: number;
  setTextFadeThreshold: (v: number) => void;
  nodeSize: number;
  setNodeSize: (v: number) => void;
  linkThickness: number;
  setLinkThickness: (v: number) => void;
  centerForce: number;
  setCenterForce: (v: number) => void;
  repelForce: number;
  setRepelForce: (v: number) => void;
  linkForce: number;
  setLinkForce: (v: number) => void;
  linkDistance: number;
  setLinkDistance: (v: number) => void;
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
          <input
            type="text"
            placeholder="path:"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </label>
        <label className="graph-settings-checkbox">
          <input
            type="checkbox"
            checked={showTags}
            onChange={(e) => setShowTags(e.target.checked)}
          />
          <span>Show tags</span>
        </label>
        <label className="graph-settings-checkbox">
          <input
            type="checkbox"
            checked={showAttachments}
            onChange={(e) => setShowAttachments(e.target.checked)}
          />
          <span>Show attachments</span>
        </label>
        <label className="graph-settings-checkbox">
          <input
            type="checkbox"
            checked={showOrphans}
            onChange={(e) => setShowOrphans(e.target.checked)}
          />
          <span>Show orphans</span>
        </label>
      </GraphSettingsSection>
      <GraphSettingsSection title="Groups" defaultOpen={false}>
        <div className="graph-settings-empty">No groups yet.</div>
      </GraphSettingsSection>
      <GraphSettingsSection title="Display" defaultOpen={false}>
        <label className="graph-settings-row">
          <span>Text fade threshold</span>
          <input
            type="range"
            min={0}
            max={5}
            step={0.1}
            value={textFadeThreshold}
            onChange={(e) => setTextFadeThreshold(parseFloat(e.target.value))}
          />
        </label>
        <label className="graph-settings-row">
          <span>Node size</span>
          <input
            type="range"
            min={1}
            max={10}
            step={0.5}
            value={nodeSize}
            onChange={(e) => setNodeSize(parseFloat(e.target.value))}
          />
        </label>
        <label className="graph-settings-row">
          <span>Link thickness</span>
          <input
            type="range"
            min={0.1}
            max={3}
            step={0.1}
            value={linkThickness}
            onChange={(e) => setLinkThickness(parseFloat(e.target.value))}
          />
        </label>
      </GraphSettingsSection>
      <GraphSettingsSection title="Forces" defaultOpen={false}>
        <label className="graph-settings-row">
          <span>Center force</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={centerForce}
            onChange={(e) => setCenterForce(parseFloat(e.target.value))}
          />
        </label>
        <label className="graph-settings-row">
          <span>Repel force</span>
          <input
            type="range"
            min={0}
            max={20}
            step={0.5}
            value={repelForce}
            onChange={(e) => setRepelForce(parseFloat(e.target.value))}
          />
        </label>
        <label className="graph-settings-row">
          <span>Link force</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={linkForce}
            onChange={(e) => setLinkForce(parseFloat(e.target.value))}
          />
        </label>
        <label className="graph-settings-row">
          <span>Link distance</span>
          <input
            type="range"
            min={10}
            max={500}
            step={10}
            value={linkDistance}
            onChange={(e) => setLinkDistance(parseFloat(e.target.value))}
          />
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
