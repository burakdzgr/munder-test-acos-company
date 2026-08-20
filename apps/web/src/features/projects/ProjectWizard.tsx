// E2/W6 — "Proje ekle" sihirbazı (2026-08-20).
//
// Founder'ın istediği akış: ad + gereksinim → CEO kadroyu ÖNERİR → kullanıcı
// DÜZENLER (takım ekle / sayı değiştir / çıkar) → ONAYLA → ajanlar başlar.
//
// Sözleşme Oscar tarafından donduruldu (E2-faz2a-contracts.md §2) ve akış
// birebir onu izler:
//   1. POST /projects           → proje açılır (intake READY'de durur, P1-1)
//   2. POST /projects/:id/goal  → Founder hedefi; CEO (LLM) kadroyu önerir
//   3. GET  .../staffing-proposal → status 'awaiting_human' olana kadar beklenir;
//      planlama iş akışı bu noktada Temporal sinyalinde DURUYOR
//      Uç DÖRT durum ayırır (Oscar, 2026-08-20 teyidi):
//        404            → böyle bir proje/uç yok    → yerel taslak
//        200 draft      → CEO ÇALIŞIYOR, teams:[]   → BEKLEMEYE DEVAM
//        200 awaiting_human → öneri hazır           → düzenleme ekranı
//        200 cancelled  → önerilecek kadro çıkmadı; planlama deterministik
//                         yoldan zaten sürüyor      → sihirbaz burada BİTER
//   4. PATCH .../staffing-proposals/:id → kullanıcının düzenlediği TAM liste
//   5. POST  .../confirm        → iş akışı devam eder, applyPlan takımları kurar
//
// Uçlar henüz inmediyse (T19) sihirbaz YEREL taslağa düşer ve bunu ekranda
// söyler; hedef zaten 2. adımda verildiği için iş yine başlar — yalnız kadro
// düzenlemesi o turda sunucuya işlenmez.
import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AcosApiError } from "@acos/contracts/client";
import { Button, Dialog, Field, Input, Textarea } from "@acos/ui";
import { api } from "../../lib/api.js";
import { useFocus } from "../../stores/focus.js";
import {
  applyLocalEdit,
  confirmProposal,
  fetchProposal,
  localDraftProposal,
  patchProposal,
  StaleProposalError,
  toEdit,
  type ProposalTeamEdit,
  type StaffingProposal,
} from "./staffingProposal.js";

type Step = "brief" | "thinking" | "proposal" | "done" | "noproposal";

/** CEO önerisi için bekleme: sözleşmede status 'awaiting_human' olduğunda hazır. */
const POLL_MS = 2000;
const POLL_TIMEOUT_MS = 60_000;

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
  const [noProposal, setNoProposal] = useState<"cancelled" | "applied" | null>(null);
  const cancelled = useRef(false);
  // kullanıcı beklemeyi kesip taslakla devam edebilir (uç yoksa ya da
  // CEO adımı uzarsa ekranda çakılı kalmasın)
  const skipWait = useRef(false);

  useEffect(() => {
    if (!open) {
      cancelled.current = true;
      skipWait.current = false;
      setStep("brief");
      setName("");
      setRequirements("");
      setProjectId(null);
      setProposal(null);
      setError(null);
      setNewTeamName("");
      setNoProposal(null);
    } else {
      cancelled.current = false;
    }
  }, [open]);

  /** 1–3. adım: projeyi aç, hedefi ver, CEO'nun önerisini bekle. */
  const start = useMutation({
    mutationFn: async () => {
      setError(null);
      const project = await api.projects.create(companyId, {
        name: name.trim(),
        objective: requirements.trim(),
      });
      setProjectId(project.id);
      setStep("thinking");
      void queryClient.invalidateQueries({ queryKey: [companyId, "projects", "list"] });
      // hedef = CEO'nun kadro önerisini tetikleyen adım (W4)
      await api.projects.setGoal(companyId, project.id, requirements.trim());

      const deadline = Date.now() + POLL_TIMEOUT_MS;
      // Uç açık ama CEO henüz bitirmediyse elimizde GERÇEK bir satır olur
      // (status 'draft'). Kullanıcı beklemeyi keserse yerel taslak UYDURMAK
      // yerine o satırı düzenletiriz: Oscar'ın garantisi (source 'human'a
      // dönünce LLM önerisi üzerine YAZMAZ) yalnız sunucu satırı için geçerli.
      let serverDraft: StaffingProposal | null = null;
      for (;;) {
        if (cancelled.current) throw new Error("iptal");
        const server = await fetchProposal(companyId, project.id);
        if (server?.status === "draft") serverDraft = server;
        if (server?.status === "awaiting_human") {
          return { projectId: project.id, proposal: server };
        }
        if (server?.status === "cancelled") {
          // önerilecek kadro çıkmadı; planlama deterministik yoldan sürüyor.
          // HATA DEĞİL — burada sihirbazı bitiriyoruz, taslak uydurmuyoruz.
          return { projectId: project.id, proposal: null, reason: "cancelled" as const };
        }
        if (server?.status === "applied" || server?.status === "confirmed") {
          // öneri zaten uygulanmış (insan beklemeyen kurulum) — düzenlenecek bir şey yok
          return { projectId: project.id, proposal: null, reason: "applied" as const };
        }
        // status 'draft' = CEO HÂLÂ ÇALIŞIYOR (satır baştan açılıyor, teams boş).
        // Hazır sanıp boş listeyle düzenleme ekranına geçmemek için bekleriz.
        if (skipWait.current || Date.now() > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
      // Beklemeyi kestik ya da süre doldu.
      // a) sunucuda açık bir taslak satırı VARSA onu düzenletiriz (PATCH edilir,
      //    aynı id baştan sona korunur, CEO araya girse bile insanın planı kalır)
      // b) yoksa (uç hiç yok) yerel taslağa düşeriz ve bunu ekranda söyleriz
      return {
        projectId: project.id,
        proposal: serverDraft ?? localDraftProposal(project.id, name, requirements),
      };
    },
    onSuccess: ({ projectId: id, proposal: next, reason }) => {
      if (!next) {
        setNoProposal(reason ?? "cancelled");
        setSelectedProject(id);
        setStep("noproposal");
        void queryClient.invalidateQueries({ queryKey: [companyId, "tasks", "list"] });
        return;
      }
      setProposal(next);
      setStep("proposal");
    },
    onError: (err) => {
      setStep("brief");
      setError(
        err instanceof AcosApiError ? `${err.problem.code}: ${err.problem.detail}` : String(err),
      );
    },
  });

  /** 4. adım: düzenlemeyi kalıcılaştır (uç yoksa yerel türetme). */
  async function editTeams(teams: ProposalTeamEdit[]) {
    if (!proposal) return;
    setError(null);
    const optimistic = applyLocalEdit(proposal, teams);
    setProposal(optimistic);
    if (proposal.local) return;
    try {
      const saved = await patchProposal(companyId, proposal.id, proposal.version, teams);
      if (saved) setProposal(saved);
    } catch (err) {
      if (err instanceof StaleProposalError && projectId) {
        // biri (CEO adımı ya da başka bir sekme) araya girdi: taze hâli al
        const fresh = await fetchProposal(companyId, projectId);
        if (fresh) setProposal(fresh);
        setError("Öneri bu arada güncellendi — güncel liste yüklendi, değişikliğinizi tekrar yapın.");
      } else {
        setError(String(err));
      }
    }
  }

  /** 5. adım: onay — duran planlama iş akışı devam eder (applyPlan). */
  const confirm = useMutation({
    mutationFn: async () => {
      setError(null);
      if (!proposal) throw new Error("öneri yok");
      if (!proposal.local) {
        const ok = await confirmProposal(companyId, proposal.id);
        if (!ok) throw new Error("onay ucu yanıt vermedi");
      }
      // yerel taslakta hedef zaten verildi; iş mevcut planlama zinciriyle yürür
      return true;
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

  if (!open) return null;

  const teams = proposal?.teams ?? [];
  const headcountTotal = teams.reduce((sum, t) => sum + t.headcount, 0);
  const hireTotal = teams.reduce((sum, t) => sum + t.hireCount, 0);

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
              <p
                className="rounded bg-danger/10 px-2 py-1 text-xs text-danger"
                data-testid="project-wizard-error"
              >
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                Vazgeç
              </Button>
              <Button
                disabled={
                  name.trim().length < 2 || requirements.trim().length < 4 || start.isPending
                }
                onClick={() => start.mutate()}
                data-testid="project-wizard-next"
              >
                Devam — kadroyu öner
              </Button>
            </div>
          </>
        )}

        {step === "thinking" && (
          <div
            className="rounded-md border border-acos-line bg-acos-bg2 p-4 text-xs text-acos-fg1"
            data-testid="project-wizard-thinking"
          >
            <p className="font-medium text-acos-fg0">CEO kadroyu değerlendiriyor…</p>
            <p className="mt-1 text-acos-fg2">
              Proje açıldı ve hedef CEO&apos;ya verildi. Hangi takımların, kaç kişiyle gerektiğini
              öneriyor; birazdan burada göreceksiniz ve değiştirebileceksiniz.
            </p>
            <div className="mt-3">
              <Button
                variant="ghost"
                onClick={() => {
                  skipWait.current = true;
                }}
                data-testid="proposal-skip-wait"
              >
                Beklemeden taslakla devam et
              </Button>
            </div>
          </div>
        )}

        {step === "proposal" && proposal && (
          <>
            <div className="rounded-md border border-acos-line bg-acos-bg2 p-2.5">
              <p className="text-[11.5px] font-medium text-acos-fg0">{name} için önerilen kadro</p>
              <p className="mt-1 whitespace-pre-wrap text-[10.5px] text-acos-fg2">
                {proposal.rationaleMd}
              </p>
              {!proposal.local && proposal.status === "draft" && (
                <p
                  className="mt-1 text-[10px] text-acos-fg2"
                  data-testid="proposal-draft-server-note"
                >
                  CEO değerlendirmesini henüz bitirmedi. Kadroyu buradan siz kurarsanız plan
                  sizin olur — CEO&apos;nun önerisi bunun üzerine yazmaz.
                </p>
              )}
              {proposal.local && (
                <p className="mt-1 text-[10px] text-acos-fg2" data-testid="proposal-draft-note">
                  (taslak öneri — kalıcı CEO önerisi bağlandığında bu liste doğrudan CEO&apos;dan
                  gelecek)
                </p>
              )}
            </div>

            <ul className="space-y-1.5" data-testid="proposal-teams">
              {teams.map((team, index) => (
                <li
                  key={team.key}
                  className="flex items-center gap-2 rounded-md border border-acos-line bg-acos-bg1 px-2.5 py-1.5"
                  data-testid={`proposal-team-${team.key}`}
                >
                  <span className="min-w-24 truncate text-[11.5px] font-medium text-acos-fg0">
                    {team.teamName}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[10px] text-acos-fg2">
                    {team.rationale ?? team.capability}
                    {team.existingCount > 0 && (
                      <span className="ml-1 text-acos-fg2">
                        · {team.existingCount} mevcut, {team.hireCount} yeni
                      </span>
                    )}
                  </span>
                  <button
                    onClick={() =>
                      void editTeams(
                        teams.map((t, i) =>
                          i === index
                            ? { ...toEdit(t), headcount: Math.max(1, t.headcount - 1) }
                            : toEdit(t),
                        ),
                      )
                    }
                    data-testid={`proposal-dec-${team.key}`}
                    aria-label={`${team.teamName} kişi sayısını azalt`}
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
                      void editTeams(
                        teams.map((t, i) =>
                          i === index
                            ? { ...toEdit(t), headcount: Math.min(20, t.headcount + 1) }
                            : toEdit(t),
                        ),
                      )
                    }
                    data-testid={`proposal-inc-${team.key}`}
                    aria-label={`${team.teamName} kişi sayısını artır`}
                    className="h-5 w-5 rounded border border-acos-line text-acos-fg1 hover:text-acos-fg0"
                  >
                    +
                  </button>
                  <button
                    onClick={() =>
                      void editTeams(teams.filter((_, i) => i !== index).map(toEdit))
                    }
                    data-testid={`proposal-remove-${team.key}`}
                    aria-label={`${team.teamName} takımını çıkar`}
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
                  const label = newTeamName.trim();
                  const capability = label
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, "-")
                    .replace(/^-+|-+$/g, "");
                  void editTeams([
                    ...teams.map(toEdit),
                    {
                      key: capability || `takim-${teams.length + 1}`,
                      capability: capability || `takim-${teams.length + 1}`,
                      teamName: label,
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
              Toplam {teams.length} takım · {headcountTotal} kişi
              {hireTotal > 0 && ` · ${hireTotal} yeni işe alım`}
              {proposal.estimatedCostCents > 0 &&
                ` · ~$${(proposal.estimatedCostCents / 100).toFixed(0)}`}
            </p>

            {error && (
              <p
                className="rounded bg-danger/10 px-2 py-1 text-xs text-danger"
                data-testid="project-wizard-error"
              >
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                Sonra
              </Button>
              <Button
                disabled={teams.length === 0 || confirm.isPending}
                onClick={() => confirm.mutate()}
                data-testid="proposal-confirm"
              >
                {confirm.isPending ? "Başlatılıyor…" : "Onayla ve başlat"}
              </Button>
            </div>
          </>
        )}

        {step === "noproposal" && (
          <div
            className="rounded-md border border-acos-line bg-acos-bg2 p-3 text-xs text-acos-fg1"
            data-testid="project-wizard-noproposal"
          >
            <p className="font-medium text-acos-fg0">{name} açıldı.</p>
            <p className="mt-1 text-acos-fg2">
              {noProposal === "applied"
                ? "Kadro onay beklemeden kuruldu; düzenlenecek bir öneri kalmadı. Proje seçicide bu proje seçili."
                : "Bu hedef için ayrı bir kadro önerisi çıkmadı — planlama olağan yoldan sürüyor ve iş mevcut ekiplere dağıtılıyor. Proje seçicide bu proje seçili."}
            </p>
            <div className="mt-3">
              <Button onClick={onClose} data-testid="project-wizard-close">
                Kapat
              </Button>
            </div>
          </div>
        )}

        {step === "done" && (
          <div
            className="rounded-md border border-acos-line bg-acos-bg2 p-3 text-xs text-acos-fg1"
            data-testid="project-wizard-done"
          >
            <p className="font-medium text-acos-fg0">{name} başladı.</p>
            <p className="mt-1 text-acos-fg2">
              Onayladığınız kadro kuruluyor ve iş kırılımı CEO ile ekibinde. Üst çubuktaki proje
              seçicisinde artık bu proje seçili.
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
