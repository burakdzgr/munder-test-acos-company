// Skills view — /c/$companyId/skills (T47; 13 §10): the agents × skills
// matrix from REAL agent_skills rows. Levels come exclusively from the
// deterministic recompute — no simulated data anywhere.
import { useMemo } from "react";
import { useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Card, cn } from "@acos/ui";
import type { SkillMatrixRow } from "@acos/contracts";
import { api } from "../../lib/api.js";

const LEVEL_TONE: Record<number, string> = {
  1: "bg-acos-bg3 text-acos-fg1",
  2: "bg-sky-100 text-sky-800",
  3: "bg-emerald-100 text-emerald-800",
  4: "bg-amber-100 text-amber-800",
  5: "bg-purple-100 text-purple-800",
};

export function SkillsView() {
  const { companyId } = useParams({ from: "/c/$companyId" });
  const matrix = useQuery({
    queryKey: [companyId, "skills", "matrix"],
    queryFn: () => api.skills.matrix(companyId),
    refetchInterval: 15_000,
  });

  const { agents, skills, byCell } = useMemo(() => {
    const rows = matrix.data?.items ?? [];
    const agentNames = new Map<string, string>();
    const skillNames = new Map<string, string>();
    const cells = new Map<string, SkillMatrixRow>();
    for (const row of rows) {
      agentNames.set(row.agentId, row.agentName);
      skillNames.set(row.skillId, row.skillName);
      cells.set(`${row.agentId}:${row.skillId}`, row);
    }
    return {
      agents: [...agentNames.entries()].sort((a, b) => a[1].localeCompare(b[1])),
      skills: [...skillNames.entries()].sort((a, b) => a[1].localeCompare(b[1])),
      byCell: cells,
    };
  }, [matrix.data]);

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Yetenek matrisi</h2>
        <p className="text-xs text-acos-fg2">
          Seviyeler kanıt izinden deterministik hesaplanır — asla bir model tarafından atanmaz.
        </p>
      </div>
      {matrix.isLoading && <p className="text-sm text-acos-fg2">Yükleniyor…</p>}
      {matrix.data && agents.length === 0 && (
        <Card className="p-6 text-sm text-acos-fg2" data-testid="skills-empty">
          Henüz yetenek kanıtı yok — etiketli görevler tamamlanıp incelemeler kabul edilince
          seviyeler belirir.
        </Card>
      )}
      {agents.length > 0 && (
        <Card className="overflow-x-auto" padding={false}>
          <table className="w-full text-sm" data-testid="skills-matrix">
            <thead>
              <tr className="border-b bg-acos-bg2 text-left">
                <th className="p-2 font-medium">Ajan</th>
                {skills.map(([skillId, name]) => (
                  <th key={skillId} className="p-2 font-medium">
                    {name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {agents.map(([agentId, agentName]) => (
                <tr key={agentId} className="border-b last:border-b-0">
                  <td className="p-2 font-medium">{agentName}</td>
                  {skills.map(([skillId]) => {
                    const cell = byCell.get(`${agentId}:${skillId}`);
                    return (
                      <td key={skillId} className="p-2">
                        {cell ? (
                          <span
                            data-testid={`skill-cell-${cell.skillName}`}
                            title={`güven ${cell.confidence.toFixed(2)} — ${cell.evidenceCount} kanıt satırı`}
                            className={cn(
                              "inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-semibold",
                              LEVEL_TONE[cell.level] ?? LEVEL_TONE[1],
                            )}
                          >
                            L{cell.level}
                            <span className="font-normal opacity-70">
                              ×{cell.evidenceCount}
                            </span>
                          </span>
                        ) : (
                          <span className="text-acos-fg2">—</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
