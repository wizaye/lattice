import { useEffect, useRef, useState } from "react";
import ForceGraph from "force-graph";
import { getVaultGraph, VaultGraphData } from "../../lib/tauriApi";
import { useVaultStore } from "../../state/vaultStore";
import { useEditorStore } from "../../state/editorStore";

export default function GraphView({ onOpenFile }: { onOpenFile: (path: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphInstanceRef = useRef<any>(null);
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const fileContents = useEditorStore((s) => s.fileContents);
  
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [graphData, setGraphData] = useState<{nodes: any[], links: any[]} | null>(null);

  // 1. Debounced Data Fetcher
  useEffect(() => {
    if (!vaultPath) return;

    let isCancelled = false;
    const fetchGraph = async () => {
      try {
        const data: VaultGraphData = await getVaultGraph(vaultPath);
        if (isCancelled) return;

        const nodes = data.nodes.map(n => ({
          id: n.id,
          name: n.label,
          path: n.path,
          val: Math.max(1, Math.min(10, 1 + (data.edges.filter(e => e.target === n.id || e.source === n.id).length)))
        }));

        const nodeMap = new Map(nodes.map(n => [n.id, n]));
        const links = data.edges
          .filter(e => nodeMap.has(e.source) && nodeMap.has(e.target))
          .map(e => ({ source: e.source, target: e.target }));

        setGraphData({ nodes, links });
        setLoading(false);
      } catch (err: any) {
        if (!isCancelled) {
          setError(err.toString());
          setLoading(false);
        }
      }
    };

    // Debounce graph recalculation by 1000ms
    const timeout = setTimeout(fetchGraph, 1000);

    return () => {
      isCancelled = true;
      clearTimeout(timeout);
    };
  }, [vaultPath, fileContents]);

  // 2. Graph Initialization & Update
  useEffect(() => {
    if (!containerRef.current || !graphData) return;

    // Initialize graph once
    if (!graphInstanceRef.current) {
      const ForceGraphAny = ForceGraph as any;
      graphInstanceRef.current = ForceGraphAny()(containerRef.current)
        .nodeLabel('name')
        .nodeColor(() => {
          const isLight = document.body.classList.contains('light'); // Assuming body.light class for theme
          return isLight ? '#222222' : '#ffffff';
        })
        .linkColor(() => {
          const isLight = document.body.classList.contains('light');
          return isLight ? '#dddddd' : '#444444';
        })
        .backgroundColor('transparent')
        .nodeCanvasObject((node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
          const isLight = document.body.classList.contains('light');
          const label = node.name;
          const fontSize = 12 / globalScale;
          ctx.beginPath();
          ctx.arc(node.x, node.y, node.val, 0, 2 * Math.PI, false);
          ctx.fillStyle = isLight ? '#222222' : '#ffffff';
          ctx.fill();

          if (globalScale > 1.5) {
            ctx.font = `${fontSize}px Inter, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = isLight ? '#555555' : '#cccccc';
            ctx.fillText(label, node.x, node.y + node.val + (fontSize * 1.5));
          }
        })
        .onNodeClick((node: any) => {
          if (node.path) {
            onOpenFile(node.path);
          }
        });

      const resizeObserver = new ResizeObserver(() => {
        if (!containerRef.current || !graphInstanceRef.current) return;
        const { clientWidth, clientHeight } = containerRef.current;
        if (clientWidth && clientHeight) {
          graphInstanceRef.current.width(clientWidth);
          graphInstanceRef.current.height(clientHeight);
        }
      });
      resizeObserver.observe(containerRef.current);
    }

    // Update data without resetting zoom/camera
    graphInstanceRef.current.graphData(graphData);

  }, [graphData, onOpenFile]);

  // 3. Cleanup on unmount
  useEffect(() => {
    return () => {
      if (graphInstanceRef.current) {
        graphInstanceRef.current._destructor && graphInstanceRef.current._destructor();
        graphInstanceRef.current = null;
      }
    };
  }, []);

  return (
    <div style={{ flex: 1, position: "relative", width: "100%", height: "100%", background: "var(--bg-panel)", overflow: "hidden" }}>
      {loading && !graphData && (
        <div style={{ position: "absolute", inset: 0, display: "flex", justifyContent: "center", alignItems: "center", color: "var(--text-secondary)", zIndex: 10 }}>
          Computing Network Topology...
        </div>
      )}
      {error && (
        <div style={{ position: "absolute", inset: 0, display: "flex", justifyContent: "center", alignItems: "center", color: "var(--text-error, #ff5555)", zIndex: 10 }}>
          {error}
        </div>
      )}
      <div ref={containerRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />
    </div>
  );
}
