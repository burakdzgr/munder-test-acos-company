// Skiller panel (36 §5/§10 — U07+U12): the Command Center's left skills
// panel. "Beceriler" = per-agent skill matrix with evidence-based levels
// (T47); "Terfi Adayı" = emergent skill candidates from the U12 discovery
// read-model — reason + evidence chips + "↑ Terfi Et" routes the cited work
// through the T47 evidence writer (the candidate becomes a REAL skill).
import { useState } from "react";
import { useParams } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { cn, departmentColors } from "@acos/ui";
import type { SkillCandidate } from "@acos/contracts";
import { api, queryClient } from "../../lib/api.js";
import { useNotifications } from "../../stores/notifications.js";

const CATEGORY_ACCENTS = [
  departmentColors.engineering,
  departmentColors.product,
  departmentColors.operations,
  departmentColors.marketing,
  departmentColors.sales,
  departmentColors.support,
];

function categoryColor(category: string): string {
  let h = 0;
  for (let i = 0; i < category.length; i++) h = (h * 31 + category.charCodeAt(i)) >>> 0;
  return CATEGORY_ACCENTS[h % CATEGORY_ACCENTS.length]!;
}

function CandidateCard({ candidate }: { candidate: SkillCandidate }) {
  const { companyId } = useParams({ from: "/c/$companyId" });
  const push = useNotifications((s) => s.push);
  const promote = useMutation({
    mutationFn: () =>
      api.skills.promote(companyId, {
        agentId: candidate.agentId,
        skillName: candidate.skillName,
        evidenceTaskIds: candidate.evidenceTaskIds,
      }),
    onSuccess: (result) => {
      push({
        kind: "ok",
        title: "Beceri terfi etti",
        desc: `${candidate.agentName} → ${candidate.skillName} (L${result.level}, ${result.evidenceCount} kanıt)`,
      });
      void queryClient.invalidateQueries({ queryKey: [companyId, "skills"] });
    },
  });
  return (
    <div
      className="mb-2 rounded-md border border-acos-line bg-acos-bg2 p-2"
      data-testid="skill-candidate"
    >
      <div className="text-[11px] font-semibold text-acos-fg0">
        {candidate.skillName}{" "}
        <span className="font-normal text-acos-fg2">· {candidate.agentName}</span>
      </div>
      <div className="mt-0.5 text-[9.5px] text-acos-fg2">{candidate.reason}</div>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        <span className="rounded bg-acos-bg3 px-1.5 py-px text-[8px] text-acos-fg1">
          {candidate.taskCount} iş
        </span>
        <span className="rounded bg-acos-bg3 px-1.5 py-px font-mono text-[8px] tabular-nums text-acos-fg1">
          skor {candidate.score.toFixed(2)}
        </span>
      </div>
      <button
        data-testid="promote-skill"
        onClick={() => promote.mutate()}
        disabled={promote.isPending}
        className="mt-1.5 rounded px-2.5 py-1 text-[9.5px] font-semibold disabled:opacity-40"
        style={{ background: "#2ec26a", color: "#04120a" }}
      >
        {promote.isPending ? "Terfi ediliyor…" : "↑ Terfi Et"}
      </button>
      {promote.error && (
        <div className="mt-1 text-[9px]" style={{ color: "#ff6b8a" }}>
          {String(promote.error)}
        </div>
      )}
    </div>
  );
}

export function SkillsPanel() {
  const { companyId } = useParams({ from: "/c/$companyId" });
  const [tab, setTab] = useState<"cur" | "cand">("cur");
  const matrix = useQuery({
    queryKey: [companyId, "skills", "matrix"],
    queryFn: () => api.skills.matrix(companyId),
  });
  const candidates = useQuery({
    queryKey: [companyId, "skills", "candidates"],
    queryFn: () => api.skills.candidates(companyId),
    staleTime: 60_000,
  });

  const rows = matrix.data?.items ?? [];
  const candidateItems = candidates.data?.items ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col bg-acos-bg1" data-testid="skills-panel">
      <div className="flex h-6 shrink-0 items-center gap-1 border-b border-acos-line px-2 text-[10px]">
        <button
          data-testid="sktab-cur"
          onClick={() => setTab("cur")}
          className={cn(
            "rounded px-2 py-0.5",
            tab === "cur" ? "bg-acos-bg3 text-acos-fg0" : "text-acos-fg2 hover:text-acos-fg1",
          )}
        >
          Beceriler
        </button>
        <button
          data-testid="sktab-cand"
          onClick={() => setTab("cand")}
          className={cn(
            "flex items-center gap-1 rounded px-2 py-0.5",
            tab === "cand" ? "bg-acos-bg3 text-acos-fg0" : "text-acos-fg2 hover:text-acos-fg1",
          )}
        >
          Terfi Adayı
          {candidateItems.length > 0 && (
            <span
              className="rounded-full px-1 text-[8px] font-bold text-white"
              style={{ background: "#ff4d4d" }}
              data-testid="candidate-count"
            >
              {candidateItems.length}
            </span>
          )}
        </button>
        <span className="ml-auto text-[9px] text-acos-fg2">{rows.length} kayıt</span>
      </div>

      {tab === "cur" && (
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {matrix.isLoading && <div className="p-2 text-[10px] text-acos-fg2">Yükleniyor…</div>}
          {!matrix.isLoading && rows.length === 0 && (
            <div className="p-2 text-[10px] text-acos-fg2">
              Henüz beceri kaydı yok — kanıta dayalı seviyeler işler tamamlandıkça oluşur (T47).
            </div>
          )}
          {rows.map((row) => {
            const color = categoryColor(row.category);
            return (
              <div
                key={`${row.agentId}:${row.skillId}`}
                className="mb-1.5 flex items-center gap-1.5 text-[10.5px]"
                data-testid="skill-row"
                title={`${row.category} · ${row.evidenceCount} kanıt · güven ${row.confidence.toFixed(2)}`}
              >
                <span className="w-14 shrink-0 truncate text-acos-fg2">
                  {row.agentName.split(" ")[0]}
                </span>
                <span className="w-24 shrink-0 truncate text-acos-fg0">{row.skillName}</span>
                <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-acos-bg3">
                  <span
                    className="block h-full rounded-full"
                    style={{
                      width: `${row.level * 20}%`,
                      background: color,
                      opacity: 0.45 + 0.55 * row.confidence,
                    }}
                  />
                </span>
                <span className="w-6 shrink-0 text-right font-mono text-[9px] tabular-nums text-acos-fg2">
                  L{row.level}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {tab === "cand" && (
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {candidates.isLoading && (
            <div className="p-2 text-[10px] text-acos-fg2">Adaylar taranıyor…</div>
          )}
          {!candidates.isLoading && candidateItems.length === 0 && (
            <div
              className="p-2 text-center text-[10px] text-acos-fg2"
              data-testid="skill-candidates-empty"
            >
              Aday yok — bir ajan aynı türden ≥3 işi başarıyla bitirince burada belirir
              (kanıta dayalı, T47 disipliniyle).
            </div>
          )}
          {candidateItems.map((candidate) => (
            <CandidateCard
              key={`${candidate.agentId}:${candidate.skillName}`}
              candidate={candidate}
            />
          ))}
        </div>
      )}
    </div>
  );
}
