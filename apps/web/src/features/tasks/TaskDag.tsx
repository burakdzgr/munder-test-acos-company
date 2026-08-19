// Dependency DAG tab (24 §6.3): Cytoscape + dagre, blocks-edges point from
// prerequisite to dependent; resolved edges are dimmed.
import { useEffect, useRef } from "react";
import cytoscape from "cytoscape";
import dagre from "cytoscape-dagre";
import { useQuery } from "@tanstack/react-query";
import type { Task } from "@acos/contracts";
import { api } from "../../lib/api.js";

cytoscape.use(dagre);

const STATUS_COLOR: Record<string, string> = {
  DONE: "#2fbf71",
  IN_PROGRESS: "#4a6bfa",
  BLOCKED: "#e5484d",
  FAILED: "#e5484d",
  CANCELLED: "#8b94a7",
};

export function TaskDag({
  companyId,
  tasks,
  onSelect,
}: {
  companyId: string;
  tasks: Task[];
  onSelect?: (task: Task) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dag = useQuery({
    queryKey: [companyId, "tasks", "dag"],
    queryFn: () => api.tasks.dag(companyId),
  });

  useEffect(() => {
    if (!containerRef.current || !dag.data) return;
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const edges = dag.data.edges.filter(
      (e) => taskById.has(e.taskId) && taskById.has(e.dependsOnTaskId),
    );
    const connected = new Set(edges.flatMap((e) => [e.taskId, e.dependsOnTaskId]));
    const nodes = tasks.filter((t) => connected.has(t.id));
    const cy = cytoscape({
      container: containerRef.current,
      elements: [
        ...nodes.map((task) => ({
          data: {
            id: task.id,
            label: `${task.displayNumber}\n${task.title.slice(0, 24)}`,
            color: STATUS_COLOR[task.status] ?? "#e9ebf0",
          },
        })),
        ...edges.map((edge) => ({
          data: {
            id: edge.id,
            source: edge.dependsOnTaskId,
            target: edge.taskId,
            resolved: edge.resolvedAt ? 1 : 0,
          },
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
            "font-size": "9px",
            color: "#161b26",
            "background-color": "#f4f5f8",
            "border-color": "data(color)" as never,
            "border-width": 2,
            shape: "round-rectangle",
            width: 120,
            height: 40,
          },
        },
        {
          selector: "edge",
          style: {
            width: 1.5,
            "line-color": "#8b94a7",
            "target-arrow-shape": "triangle",
            "target-arrow-color": "#8b94a7",
            "curve-style": "bezier",
          },
        },
        { selector: "edge[resolved = 1]", style: { "line-style": "dashed", opacity: 0.4 } },
      ],
      layout: { name: "dagre", rankDir: "LR", nodeSep: 30, rankSep: 60 } as never,
    });
    cy.on("tap", "node", (event) => {
      const task = taskById.get(event.target.id() as string);
      if (task) onSelect?.(task);
    });
    return () => cy.destroy();
  }, [tasks, dag.data, onSelect]);

  const hasEdges = (dag.data?.edges.length ?? 0) > 0;
  return hasEdges ? (
    <div ref={containerRef} className="h-[480px] w-full" data-testid="task-dag" />
  ) : (
    <p className="py-10 text-center text-sm text-acos-fg2" data-testid="task-dag-empty">
      Henüz bağımlılık yok — görevler birbirini blokladıkça DAG belirir.
    </p>
  );
}
