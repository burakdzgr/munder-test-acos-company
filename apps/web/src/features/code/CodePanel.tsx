// Kod panel (36 §7 — U09): IDE-style read-only view of the focused agent's
// active work — file tree (parsed from the unified diff) + colored diff pane,
// fed by the EXISTING reviews branch-diff endpoint (T43). Shows the
// "Task: TASK-n" context. Selection comes from focusStore (office avatar,
// roster row, terminal cell). Read-only by design.
import { useMemo, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { useQueries, useQuery } from "@tanstack/react-query";
import { cn } from "@acos/ui";
import type { Task } from "@acos/contracts";
import { api, keys } from "../../lib/api.js";
import { useFocus } from "../../stores/focus.js";
import { diffLineClass, splitDiff } from "./diff.js";

const ACTIVE_STATUSES: Array<Task["status"]> = [
  "IN_PROGRESS",
  "REVIEW",
  "CHANGES_REQUESTED",
  "QA",
  "APPROVAL",
  "ASSIGNED",
];

export function CodePanel() {
  const { companyId } = useParams({ from: "/c/$companyId" });
  const selectedAgentId = useFocus((s) => s.selectedAgentId);
  const [filePath, setFilePath] = useState<string | null>(null);

  const agents = useQuery({
    queryKey: keys.agents(companyId),
    queryFn: () => api.agents.list(companyId),
  });
  const tasks = useQuery({
    queryKey: [companyId, "tasks", "board"],
    queryFn: () => api.tasks.list(companyId, {}),
  });

  const agent = (agents.data ?? []).find((a) => a.id === selectedAgentId) ?? null;
  // the agent's tasks, active-first then newest — the review probe walks these
  const candidates = useMemo(() => {
    if (!selectedAgentId) return [];
    const mine = (tasks.data ?? []).filter((t) => t.ownerAgentId === selectedAgentId);
    const rank = (t: Task) => {
      const i = ACTIVE_STATUSES.indexOf(t.status);
      return i === -1 ? ACTIVE_STATUSES.length : i;
    };
    return mine
      .sort((a, b) => rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt))
      .slice(0, 6);
  }, [tasks.data, selectedAgentId]);

  // first candidate task that actually has a review (branch + diff)
  const reviewQueries = useQueries({
    queries: candidates.map((t) => ({
      queryKey: [companyId, "tasks", t.id, "reviews"],
      queryFn: () => api.reviews.listForTask(companyId, t.id),
    })),
  });
  const hitIndex = reviewQueries.findIndex((q) => (q.data?.items.length ?? 0) > 0);
  const task = (hitIndex >= 0 ? candidates[hitIndex] : candidates[0]) ?? null;
  const review = hitIndex >= 0 ? reviewQueries[hitIndex]!.data!.items[0]! : null;
  const diff = useQuery({
    queryKey: [companyId, "reviews", review?.id, "diff"],
    queryFn: () => api.reviews.diff(companyId, review!.id),
    enabled: review !== null,
  });

  const files = useMemo(() => (diff.data ? splitDiff(diff.data.diff) : []), [diff.data]);
  const activeFile = files.find((f) => f.path === filePath) ?? files[0] ?? null;

  if (!selectedAgentId) {
    return (
      <div
        className="flex h-full items-center justify-center bg-acos-bg1 p-4 text-center text-[10.5px] text-acos-fg2"
        data-testid="code-panel-empty"
      >
        Bir ajan seç (ofis avatarı, roster ya da terminal hücresi) — aktif işinin
        koduna buradan bakılır.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-acos-bg1" data-testid="code-panel">
      <div className="flex h-6 shrink-0 items-center gap-2 border-b border-acos-line px-2 text-[9.5px] text-acos-fg2">
        <span className="font-semibold text-acos-fg0">{agent?.name ?? "—"}</span>
        {task ? (
          <span>
            Görev: <span className="font-mono text-acos-fg1">{task.displayNumber}</span> ·{" "}
            {task.status}
          </span>
        ) : (
          <span>aktif task yok</span>
        )}
        {review && <code className="truncate text-[9px]">{review.branch}</code>}
        {diff.data?.truncated && <span style={{ color: "#ffcb47" }}>diff kırpıldı</span>}
      </div>
      {files.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-4 text-center text-[10.5px] text-acos-fg2">
          {task
            ? "Bu task için henüz review diff'i yok — ajan branch açıp PR üretince burada belirir."
            : "Bu ajanın üzerinde task yok."}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="w-40 shrink-0 overflow-y-auto border-r border-acos-line p-1.5 text-[10px]">
            {files.map((file) => (
              <button
                key={file.path}
                onClick={() => setFilePath(file.path)}
                data-testid="code-file"
                className={cn(
                  "block w-full truncate rounded px-1.5 py-0.5 text-left",
                  activeFile?.path === file.path
                    ? "bg-dept-engineering/15 text-dept-engineering"
                    : "text-acos-fg1 hover:bg-acos-bg3",
                )}
                title={file.path}
              >
                {file.path.split("/").pop()}
              </button>
            ))}
          </div>
          <pre
            className="min-w-0 flex-1 overflow-auto bg-[#0b0e13] p-2 font-mono text-[10px] leading-relaxed"
            data-testid="code-diff"
          >
            {activeFile?.lines.map((line, i) => (
              <div key={i} className={diffLineClass(line)}>
                {line || " "}
              </div>
            ))}
          </pre>
        </div>
      )}
    </div>
  );
}
