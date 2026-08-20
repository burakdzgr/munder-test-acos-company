// E2/W6 — "Proje ekle" sihirbazı (2026-08-20).
//
// Founder'ın istediği akış: ad + gereksinim → CEO kadroyu ÖNERİR → kullanıcı
// DÜZENLER (takım ekle / sayı değiştir / çıkar) → ONAYLA → ajanlar başlar.
//
// Bugünkü sistemde proje açılışı zaten şu yolu izliyor: POST /projects →
// intake READY'de DURUR (P1-1) → POST /projects/:id/goal → planlama →
// StaffingService boşluk analizi → işe alım ONAYI. Yani "öneri" fikri
// sunucuda var ama DÜZENLENEBİLİR değil (plan tasks.context içinde donuk) —
// düzenlenebilir kalıcı öneri Oscar'ın T19'unda geliyor. Sihirbaz o sınırı
// staffingProposal.ts'te tek noktada tutuyor: uç varsa gerçek öneri, yoksa
// yerel taslak. Her iki hâlde de ONAY gerçek işi başlatır (setGoal), yani
// ekran hiçbir zaman "sahte" değildir — yalnız öneri kaynağı değişir.
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AcosApiError } from "@acos/contracts/client";
import { Button, Dialog, Field, Input, Textarea } from "@acos/ui";
import { api } from "../../lib/api.js";
import { useFocus } from "../../stores/focus.js";
import {
  confirmProposal,
  fetchProposal,
  localDraftProposal,
  patchProposal,
  type ProposalTeam,
  type StaffingProposal,
} from "./staffingProposal.js";

type Step = "brief" | "proposal" | "done";

export function ProjectWizard({
  companyId,
  open,
  onClose,
}: {
  companyId: string;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const setSelectedProject = useFocus((s) => s.setSelectedProject);
  const [step, setStep] = useState<Step>("brief");
  const [name, setName] = useState("");
  const [requirements, setRequirements] = useState("");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [proposal, setProposal] = useState<StaffingProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newTeamName, setNewTeamName] = useState("");

  useEffect(() => {
    if (!open) {
      setStep("brief");
      setName("");
      setRequirements("");
      setProjectId(null);
      setProposal(null);
      setError(null);
    }
  }, [open]);

  /** 1. adım: projeyi aç ve öneriyi getir (yoksa yerel taslak). */
  const start = useMutation({
    mutationFn: async () => {
      setError(null);
      const project = await api.projects.create(companyId, {
        name: name.trim(),
        objective: requirements.trim(),
      });
      const server = await fetchProposal(companyId, project.id);
      return { project, proposal: server };
    },
    onSuccess: ({ project, proposal: server }) => {
      setProjectId(project.id);
      setProposal(server ?? { ...localDraftProposal(name, requirements), projectId: project.id });
      setStep("proposal");
      void queryClient.invalidateQueries({ queryKey: [companyId, "projects", "list"] });
    },
    onError: (err) =>
      setError(
        err instanceof AcosApiError ? `${err.problem.code}: ${err.problem.detail}` : String(err),
      ),
  });

  /** 3. adım: onay — kadroyu gönder (uç varsa) ve hedefi CEO'ya ver. */
  const confirm = useMutation({
    mutationFn: async () => {
      setError(null);
      if (!projectId || !proposal) throw new Error("proje yok");
      const applied = await confirmProposal(companyId, projectId, proposal.teams);
      // Onay ucu yoksa (T19 inmedi) iş yine BAŞLAR: hedef CEO'ya verilir ve
      // mevcut planlama/işe-alım zinciri yürür. Kullanıcı için sonuç aynı.
      const goal = await api.projects.setGoal(
        companyId,
        projectId,
        `${requirements.trim()}\n\nÖnerilen kadro (Founder onayı): ${proposal.teams
          .map((t) => `${t.name} × ${t.headcount}`)
          .join(", ")}`,
      );
      return { applied: applied?.applied ?? false, state: goal.state };
    },
    onSuccess: () => {
      setStep("done");
      if (projectId) setSelectedProject(projectId);
      void queryClient.invalidateQueries({ queryKey: [companyId, "projects", "list"] });
      void queryClient.invalidateQueries({ queryKey: [companyId, "tasks", "list"] });
    },
    onError: (err) =>
      setError(
        err instanceof AcosApiError ? `${err.problem.code}: ${err.problem.detail}` : String(err),
      ),
  });

  function editTeams(next: ProposalTeam[]) {
    setProposal((current) => (current ? { ...current, teams: next, status: "adjusted" } : current));
    // sunucu önerisi ise düzenlemeyi kalıcılaştır (uç yoksa sessizce yerelde kalır)
    if (projectId && proposal?.source === "server") void patchProposal(companyId, projectId, next);
  }

  if (!open) return null;

  const headcountTotal = (proposal?.teams ?? []).reduce((sum, t) => sum + t.headcount, 0);

  return (
    <Dialog open onClose={onClose} title="Yeni proje">
      <div className="space-y-3" data-testid="project-wizard">
        {step === "brief" && (
          <>
            <p className="text-xs text-acos-fg2">
              Ne yapılacağını yazın; CEO gerekli takımları ve kişi sayısını önersin. Öneriyi
              onaylamadan önce değiştirebilirsiniz.
            </p>
            <Field label="Proje adı">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                name="projectName"
                placeholder="Örn. Vitrin Sitesi"
                data-testid="project-name"
              />
            </Field>
            <Field label="Gereksinimler">
              <Textarea
                value={requirements}
                onChange={(e) => setRequirements(e.target.value)}
                name="projectRequirements"
                rows={5}
                placeholder="Ne istiyorsunuz? Neyi başarı sayıyorsunuz? (ör. React vitrin sitesi, iletişim formu, SEO)"
                data-testid="project-requirements"
              />
            </Field>
            {error && (
              <p className="rounded bg-danger/10 px-2 py-1 text-xs text-danger" data-testid="project-wizard-error">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                Vazgeç
              </Button>
              <Button
                disabled={name.trim().length < 2 || requirements.trim().length < 4 || start.isPending}
                onClick={() => start.mutate()}
                data-testid="project-wizard-next"
              >
                {start.isPending ? "CEO düşünüyor…" : "Devam — kadroyu öner"}
              </Button>
            </div>
          </>
        )}

        {step === "proposal" && proposal && (
          <>
            <div className="rounded-md border border-acos-line bg-acos-bg2 p-2.5">
              <p className="text-[11.5px] font-medium text-acos-fg0">
                {name} için önerilen kadro
              </p>
              <p className="mt-1 text-[10.5px] text-acos-fg2">{proposal.rationale}</p>
              {proposal.source === "local-draft" && (
                <p className="mt-1 text-[10px] text-acos-fg2" data-testid="proposal-draft-note">
                  (taslak öneri — kalıcı CEO önerisi bağlandığında bu liste doğrudan CEO'dan
                  gelecek)
                </p>
              )}
            </div>

            <ul className="space-y-1.5" data-testid="proposal-teams">
              {proposal.teams.map((team, index) => (
                <li
                  key={team.key}
                  className="flex items-center gap-2 rounded-md border border-acos-line bg-acos-bg1 px-2.5 py-1.5"
                  data-testid={`proposal-team-${team.key}`}
                >
                  <span className="min-w-24 truncate text-[11.5px] font-medium text-acos-fg0">
                    {team.name}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[10px] text-acos-fg2">
                    {team.rationale ?? team.capability}
                  </span>
                  <button
                    onClick={() =>
                      editTeams(
                        proposal.teams.map((t, i) =>
                          i === index ? { ...t, headcount: Math.max(1, t.headcount - 1) } : t,
                        ),
                      )
                    }
                    data-testid={`proposal-dec-${team.key}`}
                    aria-label={`${team.name} kişi sayısını azalt`}
                    className="h-5 w-5 rounded border border-acos-line text-acos-fg1 hover:text-acos-fg0"
                  >
                    −
                  </button>
                  <span
                    className="w-6 text-center font-mono text-[11.5px] tabular-nums text-acos-fg0"
                    data-testid={`proposal-count-${team.key}`}
                  >
                    {team.headcount}
                  </span>
                  <button
                    onClick={() =>
                      editTeams(
                        proposal.teams.map((t, i) =>
                          i === index ? { ...t, headcount: Math.min(20, t.headcount + 1) } : t,
                        ),
                      )
                    }
                    data-testid={`proposal-inc-${team.key}`}
                    aria-label={`${team.name} kişi sayısını artır`}
                    className="h-5 w-5 rounded border border-acos-line text-acos-fg1 hover:text-acos-fg0"
                  >
                    +
                  </button>
                  <button
                    onClick={() => editTeams(proposal.teams.filter((_, i) => i !== index))}
                    data-testid={`proposal-remove-${team.key}`}
                    aria-label={`${team.name} takımını çıkar`}
                    className="ml-1 text-[11px] text-acos-fg2 hover:text-danger"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>

            <div className="flex items-center gap-2">
              <Input
                value={newTeamName}
                onChange={(e) => setNewTeamName(e.target.value)}
                name="newTeamName"
                placeholder="Takım ekle (ör. Veri)"
                data-testid="proposal-new-team"
              />
              <Button
                variant="secondary"
                disabled={!newTeamName.trim()}
                onClick={() => {
                  editTeams([
                    ...proposal.teams,
                    {
                      key: `added-${proposal.teams.length}-${newTeamName.trim().toLowerCase()}`,
                      name: newTeamName.trim(),
                      capability: newTeamName.trim().toLowerCase(),
                      headcount: 1,
                      rationale: "Founder ekledi",
                    },
                  ]);
                  setNewTeamName("");
                }}
                data-testid="proposal-add-team"
              >
                Ekle
              </Button>
            </div>

            <p className="text-[10.5px] text-acos-fg2" data-testid="proposal-total">
              Toplam {proposal.teams.length} takım · {headcountTotal} kişi
            </p>

            {error && (
              <p className="rounded bg-danger/10 px-2 py-1 text-xs text-danger" data-testid="project-wizard-error">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                Sonra
              </Button>
              <Button
                disabled={proposal.teams.length === 0 || confirm.isPending}
                onClick={() => confirm.mutate()}
                data-testid="proposal-confirm"
              >
                {confirm.isPending ? "Başlatılıyor…" : "Onayla ve başlat"}
              </Button>
            </div>
          </>
        )}

        {step === "done" && (
          <div
            className="rounded-md border border-acos-line bg-acos-bg2 p-3 text-xs text-acos-fg1"
            data-testid="project-wizard-done"
          >
            <p className="font-medium text-acos-fg0">{name} başladı.</p>
            <p className="mt-1 text-acos-fg2">
              Hedef CEO&apos;ya verildi; kadro kurulumu ve iş kırılımı ekibiyle birlikte yürüyor.
              Üst çubuktaki proje seçicisinde artık bu proje seçili.
            </p>
            <div className="mt-3">
              <Button onClick={onClose} data-testid="project-wizard-close">
                Kapat
              </Button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
