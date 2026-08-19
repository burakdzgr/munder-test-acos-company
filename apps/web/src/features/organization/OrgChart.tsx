// Cytoscape org chart (24 §6.6): dagre top-down over the reports_to forest.
import { useEffect, useRef } from "react";
import cytoscape from "cytoscape";
import dagre from "cytoscape-dagre";
import type { Agent, OrgEdge } from "@acos/contracts";

cytoscape.use(dagre);

export function OrgChart({
  agents,
  edges,
  onSelect,
}: {
  agents: Agent[];
  edges: OrgEdge[];
  onSelect?: (agentId: string | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const agentById = new Map(agents.map((a) => [a.id, a]));
    const reportsTo = edges.filter(
      (e) => e.kind === "reports_to" && e.toAgentId && agentById.has(e.fromAgentId) && agentById.has(e.toAgentId),
    );
    const cy = cytoscape({
      container: containerRef.current,
      elements: [
        ...agents.map((agent) => ({
          data: { id: agent.id, label: `${agent.name}\n${agent.displayNumber}` },
        })),
        ...reportsTo.map((edge) => ({
          data: { id: edge.id, source: edge.fromAgentId, target: edge.toAgentId! },
        })),
      ],
      style: [
        {
          selector: "node",
          style: {
            label: "data(label)",
            "text-wrap": "wrap",
            "text-valign": "center",
            "text-halign": "center",
            "font-size": "10px",
            color: "#e6edf3",
            "background-color": "#1c232d",
            "border-color": "#4c9aff",
            "border-width": 1.5,
            shape: "round-rectangle",
            width: 110,
            height: 44,
          },
        },
        {
          selector: "edge",
          style: {
            width: 1.5,
            "line-color": "#3a424c",
            "target-arrow-shape": "triangle",
            "target-arrow-color": "#3a424c",
            "curve-style": "bezier",
          },
        },
        { selector: "node:selected", style: { "background-color": "#4a6bfa", color: "#fff" } },
      ],
      layout: { name: "dagre", rankDir: "BT", nodeSep: 30, rankSep: 60 } as never,
      wheelSensitivity: 0.2,
    });
    cy.on("select", "node", (event) => onSelect?.(event.target.id()));
    cy.on("unselect", "node", () => onSelect?.(null));
    return () => cy.destroy();
  }, [agents, edges, onSelect]);

  return <div ref={containerRef} data-testid="org-chart" className="h-[420px] w-full" />;
}
