// Projects view — /c/$companyId/projects (T42; 14 §2/§6 MVP slice): list +
// the 3-field Founder import form (name, objective/goal, constraints +
// optional git URL — nothing technical, P4) + detail pane with Overview and
// the rendered Intake Report (imported projects). Live-updated via the
// project.* invalidation family.
import { useState } from "react";
import { useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Field, Input, StatusPill, Textarea, cn } from "@acos/ui";
import type { ProjectDto } from "@acos/contracts";
import { api } from "../../lib/api.js";

const STATUS_TONE: Record<string, "ok" | "warn" | "accent" | "neutral"> = {
  active: "ok",
  intake: "accent",
  proposed: "neutral",
  paused: "warn",
  completed: "ok",
  archived: "neutral",
  cancelled: "warn",
  // yeni yaşam döngüsü (TASK 2)
  draft: "neutral",
  repository_setup: "accent",
  indexing: "accent",
  ready: "ok",
  planning: "accent",
  staffing_review: "accent",
  waiting_for_founder: "warn",
  executing: "ok",
  failed: "warn",
};

function CreateProjectForm({ companyId, onDone }: { companyId: string; onDone: () => void }) {
  const queryClient = useQueryClient();
  // TASK 1 — iki ana yol, tek Project Lifecycle: "Projeni Dahil Et"
  // (mevcut repo) ve "Proje Oluştur" (greenfield).
  const [mode, setMode] = useState<"import" | "create">("import");
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("");
  const [constraints, setConstraints] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [connectionId, setConnectionId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const connections = useQuery({
    queryKey: [companyId, "github", "connections"],
    queryFn: () => api.integrations.github.connections(companyId),
  });
  const conns = connections.data ?? [];

  /** Repo URL'den proje adı üret (TASK 1: ad opsiyonel). */
  const derivedName = () => {
    const m = /\/([^/]+?)(?:\.git)?\/?$/.exec(sourceUrl.trim());
    return m?.[1]?.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) ?? "";
  };

  const create = useMutation({
    mutationFn: () => {
      const finalName = mode === "import" && !name.trim() ? derivedName() : name.trim();
      return api.projects.create(companyId, {
        name: finalName,
        objective:
          mode === "import" && !objective.trim()
            ? `İçe aktarılan repo: ${sourceUrl.trim()}`
            : objective,
        ...(constraints.trim() && { constraints: constraints.trim() }),
        ...(mode === "import" && {
          source: { kind: "git_url" as const, url: sourceUrl.trim() },
        }),
        ...(connectionId && { githubConnectionId: connectionId }),
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [companyId, "projects"] });
      onDone();
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  const canSubmit =
    mode === "import"
      ? /^https?:\/\/.+/.test(sourceUrl.trim())
      : name.trim().length >= 2 && objective.trim().length >= 4;

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div data-testid="project-create-form" className="contents" />
      <h3 className="text-sm font-semibold">Yeni proje</h3>
      <div className="flex rounded-md border border-acos-line p-0.5">
        {(
          [
            ["import", "Projeni Dahil Et"],
            ["create", "Proje Oluştur"],
          ] as const
        ).map(([m, label]) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={cn(
              "flex-1 rounded px-3 py-1.5 text-xs font-medium",
              mode === m ? "bg-accent-500/10 text-accent-600" : "text-acos-fg1 hover:bg-acos-bg3",
            )}
            data-testid={`project-mode-${m}`}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === "import" ? (
        <>
          <Field label="GitHub repository URL">
            <Input
              name="sourceUrl"
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              placeholder="https://github.com/hesap/repo.git"
            />
          </Field>
          <Field label="Proje adı (opsiyonel — repo adından üretilir)">
            <Input
              name="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={derivedName() || "Repo adından üretilecek"}
            />
          </Field>
        </>
      ) : (
        <>
          <Field label="Proje adı">
            <Input name="name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Yapılmak istenen iş / hedef">
            <Textarea
              name="objective"
              rows={3}
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              placeholder="Bu proje iş açısından neyi başarmalı?"
            />
          </Field>
          <Field label="Kısıtlar (opsiyonel)">
            <Textarea
              name="constraints"
              rows={2}
              value={constraints}
              onChange={(e) => setConstraints(e.target.value)}
              placeholder="Bütçe, son tarih, 'X'e dokunma'…"
            />
          </Field>
        </>
      )}

      <Field label="GitHub bağlantısı">
        <select
          value={connectionId}
          onChange={(e) => setConnectionId(e.target.value)}
          className="w-full rounded-md border border-acos-line bg-acos-bg1 px-2 py-1.5 text-sm"
          data-testid="github-connection-select"
        >
          <option value="">
            {conns.length === 0 ? "Bağlantı yok — Ayarlar → GitHub" : "Şirket varsayılanı"}
          </option>
          {conns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.owner} ({c.status})
            </option>
          ))}
        </select>
      </Field>
      {mode === "create" && (
        <p className="text-xs text-acos-fg2">
          Takım/agent yapısı ve LLM model seçimleri Organizasyon ekranından yapılır; CEO eksik
          kadroyu planlama sırasında tespit edip onayına sunar.
        </p>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex gap-2">
        <Button
          onClick={() => create.mutate()}
          disabled={create.isPending || !canSubmit}
          data-testid="project-create-submit"
        >
          {create.isPending
            ? "Oluşturuluyor…"
            : mode === "import"
              ? "Projeyi dahil et"
              : "Proje oluştur"}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Vazgeç
        </Button>
      </div>
    </Card>
  );
}

function ProjectDetail({ companyId, project }: { companyId: string; project: ProjectDto }) {
  const [tab, setTab] = useState<"overview" | "report" | "status">("overview");
  const report = useQuery({
    queryKey: [companyId, "projects", project.id, "report"],
    queryFn: () => api.projects.report(companyId, project.id),
    enabled: tab === "report" && project.intakeReportArtifactId !== null,
  });

  // "Rafa kaldır" (2026-08-19): proje kapanır, görevleri iptal + arşivlenir.
  // Silme yok — olaylar ve projeden doğan anılar kalır; başka bir projede
  // "daha önce benzerini yapmıştık" retrieval'ı bu sayede çalışır.
  const queryClient = useQueryClient();
  const shelve = useMutation({
    mutationFn: () => api.projects.shelve(companyId, project.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [companyId, "projects"] });
      void queryClient.invalidateQueries({ queryKey: [companyId, "tasks"] });
    },
  });
  const shelvable = !["archived", "cancelled", "completed"].includes(project.status);

  return (
    // Card swallows unknown props — the testid rides an inner wrapper
    <Card className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <div data-testid="project-detail" className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 className="text-base font-semibold">{project.name}</h2>
        <StatusPill tone={STATUS_TONE[project.status] ?? "neutral"}>{project.status}</StatusPill>
        <StatusPill tone="neutral">{project.kind}</StatusPill>
        <div className="ml-auto flex gap-1">
          {shelvable && (
            <button
              onClick={() => {
                if (
                  window.confirm(
                    `"${project.name}" rafa kaldırılacak: tüm görevleri iptal edilip arşivlenir. ` +
                      "Hiçbir şey silinmez — olaylar ve projeden doğan anılar kalır. Emin misin?",
                  )
                ) {
                  shelve.mutate();
                }
              }}
              disabled={shelve.isPending}
              className="rounded-md border border-red-500/40 px-3 py-1 text-xs font-medium text-red-500 hover:bg-red-500/10 disabled:opacity-40"
              data-testid="shelve-project-button"
              title="Projeyi rafa kaldır — görevler iptal + arşiv; anılar kalır"
            >
              🗂 Rafa kaldır
            </button>
          )}
          {(["overview", "status", "report"] as const).map((t) => (
            <Button
              key={t}
              variant={tab === t ? "primary" : "ghost"}
              onClick={() => setTab(t)}
              data-testid={`project-tab-${t}`}
            >
              {t === "overview" ? "Genel" : t === "status" ? "Durum" : "Analiz Raporu"}
            </Button>
          ))}
        </div>
      </div>
      {tab === "status" ? (
        <ProjectStatusPanel companyId={companyId} projectId={project.id} />
      ) : tab === "overview" ? (
        <div className="flex flex-col gap-3 overflow-y-auto text-sm">
          {["ready", "staffing_review", "waiting_for_founder"].includes(project.status) && (
            <ReadyPanel companyId={companyId} project={project} />
          )}
          <section>
            <h4 className="text-xs font-semibold uppercase text-acos-fg2">Hedef</h4>
            <p className="whitespace-pre-wrap">{project.objective}</p>
          </section>
          {project.constraints && (
            <section>
              <h4 className="text-xs font-semibold uppercase text-acos-fg2">Kısıtlar</h4>
              <p className="whitespace-pre-wrap">{project.constraints}</p>
            </section>
          )}
          {project.repository && (
            <section>
              <h4 className="text-xs font-semibold uppercase text-acos-fg2">Depo</h4>
              <p>
                <code className="text-xs">{project.repository.barePath}</code> — varsayılan dal{" "}
                <code className="text-xs">{project.repository.defaultBranch}</code>
                {project.repository.originUrl && (
                  <>
                    {" "}
                    · içe aktarıldı: <code className="text-xs">{project.repository.originUrl}</code>
                  </>
                )}
              </p>
            </section>
          )}
        </div>
      ) : project.intakeReportArtifactId === null ? (
        <p className="text-sm text-acos-fg2" data-testid="report-missing">
          {project.status === "intake"
            ? "Analiz sürüyor — rapor buraya düşecek."
            : "Analiz raporu yok (sıfırdan proje)."}
        </p>
      ) : report.isLoading ? (
        <p className="text-sm text-acos-fg2">Rapor yükleniyor…</p>
      ) : (
        <pre
          className="flex-1 overflow-auto whitespace-pre-wrap rounded bg-acos-bg1 p-3 text-xs leading-relaxed"
          data-testid="intake-report"
        >
          {report.data?.contentMd ?? ""}
        </pre>
      )}
      </div>
    </Card>
  );
}

export function ProjectsView() {
  const { companyId } = useParams({ from: "/c/$companyId" });
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const projects = useQuery({
    queryKey: [companyId, "projects"],
    queryFn: () => api.projects.list(companyId),
    refetchInterval: 10_000, // intake progress without a dedicated ws family yet
  });
  const items = projects.data?.items ?? [];
  const selected = items.find((p) => p.id === selectedId) ?? null;

  return (
    <div className="flex h-full min-h-0 gap-3 p-3">
      <div className="flex w-80 shrink-0 flex-col gap-2">
        <Button onClick={() => setCreating(true)} data-testid="project-create-open">
          + Yeni proje
        </Button>
        <Card className="flex flex-1 flex-col gap-1 overflow-y-auto p-2">
          {projects.isLoading && <div className="p-2 text-sm text-acos-fg2">Yükleniyor…</div>}
          {!projects.isLoading && items.length === 0 && (
            <div className="p-2 text-sm text-acos-fg2">Henüz proje yok.</div>
          )}
          {items.map((p) => (
            <button
              key={p.id}
              onClick={() => setSelectedId(p.id)}
              data-testid="project-row"
              className={cn(
                "rounded px-2 py-1.5 text-left text-sm hover:bg-acos-bg3",
                selectedId === p.id && "bg-acos-bg2",
              )}
            >
              <div className="flex items-center gap-2">
                <span className="truncate font-medium">{p.name}</span>
                <StatusPill tone={STATUS_TONE[p.status] ?? "neutral"}>{p.status}</StatusPill>
              </div>
              <div className="mt-0.5 text-xs text-acos-fg2">
                {p.kind} · {new Date(p.createdAt).toLocaleDateString()}
              </div>
            </button>
          ))}
        </Card>
      </div>
      {creating ? (
        <CreateProjectForm companyId={companyId} onDone={() => setCreating(false)} />
      ) : selected ? (
        <ProjectDetail key={selected.id} companyId={companyId} project={selected} />
      ) : (
        <Card className="flex flex-1 items-center justify-center text-sm text-acos-fg2">
          Bir proje seçin ya da oluşturun.
        </Card>
      )}
    </div>
  );
}

/** TASK 18 — Project Understanding + "Bu projede ne yapmak istiyorsun?" */
function ReadyPanel({ companyId, project }: { companyId: string; project: ProjectDto }) {
  const queryClient = useQueryClient();
  const understanding = useQuery({
    queryKey: [companyId, "projects", project.id, "understanding"],
    queryFn: () => api.projects.understanding(companyId, project.id),
  });
  const [objective, setObjective] = useState("");
  const setGoal = useMutation({
    mutationFn: () => api.projects.setGoal(companyId, project.id, objective),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: [companyId, "projects"] }),
  });
  const resume = useMutation({
    mutationFn: () => api.projects.continuePlanning(companyId, project.id),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: [companyId, "projects"] }),
  });
  const u = (understanding.data ?? {}) as {
    repository?: { originUrl: string | null; defaultBranch: string } | null;
    headSha?: string | null;
    indexState?: string;
    stack?: Array<{ language: string; files: number }>;
    modules?: Array<{ module: string; files: number }>;
    index?: { files: number; symbols: number; edges: number };
    commands?: Record<string, string>;
  };
  return (
    <section
      className="rounded-md border border-accent-500/30 bg-accent-500/5 p-3"
      data-testid="project-ready-panel"
    >
      <h4 className="text-xs font-semibold uppercase text-acos-fg2">Proje Anlayışı</h4>
      <div className="mt-2 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
        {u.repository?.originUrl && <div>Repo: {u.repository.originUrl}</div>}
        <div>Dal: {u.repository?.defaultBranch ?? "main"}</div>
        <div>
          İndeks: {u.indexState ?? "-"}
          {u.headSha ? ` @ ${u.headSha.slice(0, 8)}` : ""}
        </div>
        {u.index && (
          <div>
            {u.index.files} dosya · {u.index.symbols} sembol · {u.index.edges} ilişki
          </div>
        )}
        {u.stack && u.stack.length > 0 && (
          <div>Stack: {u.stack.map((sx) => `${sx.language} (${sx.files})`).join(", ")}</div>
        )}
        {u.modules && u.modules.length > 0 && (
          <div>Modüller: {u.modules.slice(0, 6).map((m) => m.module).join(", ")}</div>
        )}
        {u.commands && Object.keys(u.commands).length > 0 && (
          <div className="sm:col-span-2">
            Komutlar:{" "}
            {Object.entries(u.commands)
              .slice(0, 5)
              .map(([k, v]) => `${k} → ${v}`)
              .join(" · ")}
          </div>
        )}
      </div>
      {project.status === "ready" ? (
        <div className="mt-3">
          <h4 className="text-sm font-semibold">Bu projede ne yapmak istiyorsun?</h4>
          <Textarea
            rows={2}
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            placeholder="Örn: Ödeme sayfasındaki hatayı düzelt ve testler ekle"
            data-testid="ready-goal-input"
          />
          <Button
            className="mt-2"
            onClick={() => setGoal.mutate()}
            disabled={setGoal.isPending || objective.trim().length < 8}
            data-testid="ready-goal-submit"
          >
            {setGoal.isPending ? "Başlatılıyor…" : "Hedefi ver — CEO planlasın"}
          </Button>
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-3">
          <p className="text-xs text-acos-fg1">
            {project.status === "waiting_for_founder"
              ? "Kadro onayın bekleniyor — Onaylar ekranına bak."
              : "Kadro eksik — Organizasyon ekranından ekip kur, sonra devam et."}
          </p>
          <Button
            variant="ghost"
            onClick={() => resume.mutate()}
            disabled={resume.isPending}
            data-testid="resume-planning"
          >
            Planlamaya devam et
          </Button>
        </div>
      )}
    </section>
  );
}

/** TASK 20 — Founder proje durumu paneli (tek uçtan). */
function ProjectStatusPanel({ companyId, projectId }: { companyId: string; projectId: string }) {
  const overview = useQuery({
    queryKey: [companyId, "projects", projectId, "overview"],
    queryFn: () => api.projects.overview(companyId, projectId),
    refetchInterval: 10_000,
  });
  const o = (overview.data ?? {}) as {
    lifecycle?: string;
    indexState?: string;
    indexCommitSha?: string | null;
    members?: Array<{ id: string; name: string; status: string; team: string | null; current_task: string | null }>;
    taskCounts?: Array<{ status: string; n: number }>;
    workspaces?: Array<{ id: string; branch: string | null; status: string }>;
    approvals?: Array<{ id: string; title: string; urgency: string }>;
    costCents?: number;
    openPorts?: Array<{ payload: { port?: number; previewUrl?: string } }>;
    memoryHealth?: { activeProjectMemories: number };
  };
  if (overview.isLoading) return <p className="p-3 text-sm text-acos-fg2">Yükleniyor…</p>;
  return (
    <div className="flex flex-col gap-3 overflow-y-auto text-sm" data-testid="project-status-panel">
      <div className="grid gap-2 sm:grid-cols-3">
        <Card className="p-3">
          <p className="text-xs text-acos-fg2">Yaşam döngüsü</p>
          <p className="font-semibold">{o.lifecycle}</p>
        </Card>
        <Card className="p-3">
          <p className="text-xs text-acos-fg2">İndeks</p>
          <p className="font-semibold">
            {o.indexState}
            {o.indexCommitSha ? ` @ ${o.indexCommitSha.slice(0, 8)}` : ""}
          </p>
        </Card>
        <Card className="p-3">
          <p className="text-xs text-acos-fg2">Maliyet / Anı sağlığı</p>
          <p className="font-semibold">
            {((o.costCents ?? 0) / 100).toFixed(2)}$ · {o.memoryHealth?.activeProjectMemories ?? 0} anı
          </p>
        </Card>
      </div>
      <section>
        <h4 className="text-xs font-semibold uppercase text-acos-fg2">Kadro</h4>
        {(o.members ?? []).length === 0 && <p className="text-xs text-acos-fg2">Atanmış ajan yok.</p>}
        <ul className="mt-1 space-y-0.5 text-xs">
          {(o.members ?? []).map((m) => (
            <li key={m.id}>
              {m.name} — {m.team ?? "?"} · {m.status}
              {m.current_task ? ` · şu an: ${m.current_task}` : ""}
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h4 className="text-xs font-semibold uppercase text-acos-fg2">Görev kuyruğu</h4>
        <p className="text-xs">
          {(o.taskCounts ?? []).map((t) => `${t.status}: ${t.n}`).join(" · ") || "görev yok"}
        </p>
      </section>
      <section>
        <h4 className="text-xs font-semibold uppercase text-acos-fg2">Aktif workspace'ler</h4>
        <p className="text-xs">
          {(o.workspaces ?? []).map((w) => `${w.branch ?? w.id.slice(0, 8)} (${w.status})`).join(" · ") ||
            "yok"}
        </p>
      </section>
      {(o.openPorts ?? []).length > 0 && (
        <section>
          <h4 className="text-xs font-semibold uppercase text-acos-fg2">Açık preview portları</h4>
          <ul className="text-xs">
            {(o.openPorts ?? []).map((pr, i) => (
              <li key={i}>
                <a
                  href={pr.payload.previewUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent-600 hover:underline"
                >
                  :{pr.payload.port} — Open Preview
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
      {(o.approvals ?? []).length > 0 && (
        <section>
          <h4 className="text-xs font-semibold uppercase text-acos-fg2">Bekleyen onaylar</h4>
          <ul className="text-xs">
            {(o.approvals ?? []).map((a) => (
              <li key={a.id}>
                {a.title} ({a.urgency})
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
