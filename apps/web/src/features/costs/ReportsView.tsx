// Reports view — /c/$companyId/reports (T49; 29 step 24): executive report
// artifacts generated on project completion, referencing the REAL cost
// ledger and consolidated learnings.
import { useState } from "react";
import { useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Card, cn } from "@acos/ui";
import { api } from "../../lib/api.js";

export function ReportsView() {
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
    <div className="grid gap-4 p-4 md:grid-cols-[320px_1fr]">
      <div className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Yönetici raporları</h2>
        {items.map((report) => (
          <Card
            key={report.id}
            className={cn(
              "cursor-pointer p-3",
              selected?.id === report.id && "ring-2 ring-blue-500",
            )}
          >
            <div data-testid="report-row" onClick={() => setSelectedId(report.id)}>
              <p className="text-sm font-medium">{report.title}</p>
              <p className="text-xs text-acos-fg2">
                {report.projectName ?? "—"} · {report.createdByAgentName ?? "system"} ·{" "}
                {new Date(report.createdAt).toLocaleString()}
              </p>
            </div>
          </Card>
        ))}
        {reports.data && items.length === 0 && (
          <Card className="p-6 text-sm text-acos-fg2">
            <div data-testid="reports-empty">
              Henüz yönetici raporu yok — proje tamamlanınca CEO raporlar.
            </div>
          </Card>
        )}
      </div>
      <div>
        {selected && (
          <Card className="p-4">
            <pre
              className="whitespace-pre-wrap font-sans text-sm"
              data-testid="report-content"
            >
              {selected.contentMd ?? "(boş)"}
            </pre>
          </Card>
        )}
      </div>
    </div>
  );
}
