// Memory relation graph (12 §8.2; P1-B UI/UX review): nodes colored by TYPE
// (failure/procedural/semantic/… — same palette as the Command Center panel),
// size ∝ importance, opacity ∝ confidence; edges styled per relation kind.
// Layout is a real force graph (cytoscape-fcose) with label overlap
// management: labels wrap, carry an outline for contrast, and fade out
// entirely below a zoom threshold so dense graphs stay readable.
import { useEffect, useRef } from "react";
import cytoscape from "cytoscape";
import fcose from "cytoscape-fcose";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@acos/ui";
import { api } from "../../lib/api.js";
import { memoryTypeColor } from "./MemoryPanel.js";

cytoscape.use(fcose);

const EDGE_STYLE: Record<string, { color: string; style: "solid" | "dashed"; width: number }> = {
  contradicts: { color: "#ff4d4d", style: "dashed", width: 2.5 },
  derived_from: { color: "#a879ff", style: "solid", width: 3 },
  supports: { color: "#3fd0a0", style: "solid", width: 1.5 },
  supersedes: { color: "#5c6773", style: "solid", width: 2 },
  related_to: { color: "#3a424c", style: "solid", width: 1 },
};

export function MemoryGraph({
  companyId,
  onSelect,
}: {
  companyId: string;
  onSelect: (memoryId: string | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graph = useQuery({
    queryKey: [companyId, "memories", "graph"],
    queryFn: () => api.memories.graph(companyId),
  });

  useEffect(() => {
    if (!containerRef.current || !graph.data) return;
    const cy = cytoscape({
      container: containerRef.current,
      elements: [
        ...graph.data.nodes.map((node) => ({
          data: { ...node, label: node.title.slice(0, 48) },
        })),
        ...graph.data.edges.map((edge, i) => ({
          data: { id: `e${i}`, source: edge.from, target: edge.to, kind: edge.kind },
        })),
      ],
      style: [
        {
          selector: "node",
          style: {
            label: "data(label)",
            "text-wrap": "wrap",
            "text-max-width": "110px",
            "font-size": "9px",
            color: "#c6d0dc",
            // outline keeps labels readable over edges; labels vanish when
            // zoomed out so dense graphs don't become text soup
            "text-outline-color": "#0a0c10",
            "text-outline-width": 2,
            "min-zoomed-font-size": 7,
            "text-valign": "bottom",
            "text-margin-y": 4,
            shape: "ellipse",
            width: (el: cytoscape.NodeSingular) => 16 + 30 * (el.data("importance") as number),
            height: (el: cytoscape.NodeSingular) => 16 + 30 * (el.data("importance") as number),
            "background-color": (el: cytoscape.NodeSingular) =>
              memoryTypeColor(el.data("type") as string),
            "background-opacity": (el: cytoscape.NodeSingular) =>
              0.35 + 0.65 * (el.data("confidence") as number),
            "border-width": (el: cytoscape.NodeSingular) =>
              el.data("status") === "candidate" ? 2 : 0,
            "border-style": "dashed",
            "border-color": "#ffcb47",
          },
        },
        ...Object.entries(EDGE_STYLE).map(([kind, style]) => ({
          selector: `edge[kind = "${kind}"]`,
          style: {
            width: style.width,
            "line-color": style.color,
            "line-style": style.style,
            "line-opacity": 0.7,
            "target-arrow-shape": "triangle" as const,
            "target-arrow-color": style.color,
            "curve-style": "bezier" as const,
          },
        })),
        { selector: "node:selected", style: { "border-width": 3, "border-color": "#4c9aff", "border-style": "solid" } },
      ],
      // real force layout — fcose spreads clusters and avoids the cose blob
      layout: {
        name: "fcose",
        animate: false,
        nodeRepulsion: 6500,
        idealEdgeLength: 90,
        nodeSeparation: 60,
        packComponents: true,
      } as never,
    });
    cy.on("tap", "node", (event) => onSelect(event.target.id() as string));
    cy.on("tap", (event) => {
      if (event.target === cy) onSelect(null);
    });
    return () => cy.destroy();
  }, [graph.data, onSelect]);

  return (
    <Card className="p-2" data-testid="memory-graph">
      {graph.data?.capped && (
        <p className="p-2 text-xs" style={{ color: "#ffcb47" }}>
          Graf 500 düğümle sınırlı — filtreleri daraltın.
        </p>
      )}
      <div ref={containerRef} style={{ height: 560, background: "#08090d", borderRadius: 8 }} />
    </Card>
  );
}
