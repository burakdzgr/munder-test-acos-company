// Raporlar panel (36 §6 — U08): executive report artifacts (T49) in the
// Command Center's center column — dark list + content viewer, read-only.
import { useState } from "react";
import { useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@acos/ui";
import { api } from "../../lib/api.js";

export function ReportsPanel() {
  const { companyId } = useParams({ from: "/c/$companyId" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const reports = useQuery({
    queryKey: [companyId, "reports"],
    queryFn: () => api.reports.list(companyId),
    refetchInterval: 15_000,
  });

  const items = reports.data?.items ?? [];
  const selected = items.find((r) => r.id === selectedId) ?? items[0];

  return (
    <div className="grid h-full min-h-0 grid-cols-[230px_1fr] bg-acos-bg1" data-testid="reports-panel">
      <div className="min-h-0 overflow-y-auto border-r border-acos-line">
        {reports.data && items.length === 0 && (
          <div className="p-3 text-[10px] text-acos-fg2">
            Henüz executive report yok — proje tamamlanınca CEO raporlar.
          </div>
        )}
        {items.map((report) => (
          <button
            key={report.id}
            onClick={() => setSelectedId(report.id)}
            data-testid="panel-report-row"
            className={cn(
              "block w-full border-b border-acos-line/50 px-2.5 py-2 text-left hover:bg-acos-bg2",
              selected?.id === report.id && "bg-acos-bg2",
            )}
          >
            <div className="truncate text-[11px] font-semibold text-acos-fg0">{report.title}</div>
            <div className="mt-0.5 truncate text-[9px] text-acos-fg2">
              {report.projectName ?? "—"} · {report.createdByAgentName ?? "system"} ·{" "}
              {new Date(report.createdAt).toLocaleDateString()}
            </div>
          </button>
        ))}
      </div>
      <div className="min-h-0 overflow-y-auto p-4">
        {selected ? (
          <pre
            className="whitespace-pre-wrap font-sans text-[11.5px] leading-relaxed text-acos-fg1"
            data-testid="panel-report-content"
          >
            {selected.contentMd ?? "(boş)"}
          </pre>
        ) : (
          <div className="text-[10px] text-acos-fg2">Rapor seçilmedi.</div>
        )}
      </div>
    </div>
  );
}
