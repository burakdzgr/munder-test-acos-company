// "Bugünün Hedefleri" (36 §3/§9 — U11): bottom-left goals panel over the
// Command Center — goal-kind tasks with live completion (task.* WS
// invalidation refreshes the query). Collapsible; read-only.
import { useState } from "react";
import { useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@acos/ui";
import { api } from "../lib/api.js";

export function GoalsPanel() {
  const { companyId } = useParams({ from: "/c/$companyId" });
  const [open, setOpen] = useState(true);
  const goals = useQuery({
    queryKey: [companyId, "tasks", "goals"],
    queryFn: () => api.tasks.list(companyId, { kind: "goal" }),
  });

  const all = goals.data ?? [];
  const doneCount = all.filter((t) => t.status === "DONE").length;
  const items = [...all]
    .sort(
      (a, b) =>
        Number(a.status === "DONE") - Number(b.status === "DONE") ||
        b.createdAt.localeCompare(a.createdAt),
    )
    .slice(0, 6);

  return (
    <div
      className="absolute bottom-2 left-2 z-30 w-56 overflow-hidden rounded-md border border-acos-line bg-acos-bg1 shadow-lg"
      data-testid="goals-panel"
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-2.5 py-1.5 text-[9px] uppercase tracking-wide text-acos-fg2 hover:text-acos-fg1"
      >
        <span>Bugünün Hedefleri</span>
        <span className="font-mono tabular-nums" data-testid="goals-count">
          {doneCount}/{all.length}
        </span>
      </button>
      {open && (
        <div className="border-t border-acos-line">
          {items.length === 0 && (
            <div className="px-2.5 py-2 text-[9.5px] text-acos-fg2">
              Hedef yok — Founder bir objective verince burada belirir.
            </div>
          )}
          {items.map((goal) => {
            const done = goal.status === "DONE";
            return (
              <div
                key={goal.id}
                className="flex items-center gap-2 border-b border-acos-line/40 px-2.5 py-1.5 text-[10px]"
                data-testid="goal-row"
              >
                <span
                  className={cn(
                    "h-3 w-3 shrink-0 rounded border",
                    done ? "border-transparent" : "border-acos-fg2",
                  )}
                  style={done ? { background: "#2ec26a" } : undefined}
                />
                <span className={cn("truncate", done ? "text-acos-fg2 line-through" : "text-acos-fg0")}>
                  {goal.title}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
