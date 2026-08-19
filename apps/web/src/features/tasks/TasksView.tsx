// Tasks board (24 §6.3, T27): three tabs — Kanban (canonical state columns),
// Tree (kind hierarchy), DAG (Cytoscape dependency graph). Transitions offer
// the machine-legal targets; the SERVER enforces role permission and the UI
// surfaces its 409 verbatim (demo step 12: per-role permissions enforced).
import { useMemo, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TASK_NEXT_STATUSES, type Task } from "@acos/contracts";
import { AcosApiError } from "@acos/contracts/client";
import { Button, Card, Dialog, Field, Input, Select, StatusPill, Textarea, cn } from "@acos/ui";
import { api, keys } from "../../lib/api.js";
import { TaskDag } from "./TaskDag.js";

// id = kararlı testid anahtarı (data-testid={`column-${id}`}); label = görünen
// Türkçe başlık. e2e 06/08/13 column-Draft/Backlog/… testid'lerine bağlı.
const COLUMNS: Array<{ id: string; label: string; statuses: string[] }> = [
  { id: "Draft", label: "Taslak", statuses: ["DRAFT"] },
  { id: "Backlog", label: "Bekleyen", statuses: ["BACKLOG"] },
  { id: "Planned", label: "Planlandı", statuses: ["PLANNED"] },
  { id: "Assigned", label: "Atandı", statuses: ["ASSIGNED"] },
  { id: "In Progress", label: "Sürüyor", statuses: ["IN_PROGRESS", "WAITING", "BLOCKED"] },
  { id: "Review", label: "İnceleme", statuses: ["REVIEW", "CHANGES_REQUESTED"] },
  { id: "QA", label: "QA", statuses: ["QA", "QA_FAILED"] },
  { id: "Approval", label: "Onay", statuses: ["APPROVAL", "REJECTED"] },
  { id: "Done", label: "Bitti", statuses: ["DONE"] },
  { id: "Closed", label: "Kapandı", statuses: ["FAILED", "CANCELLED"] },
];

const PRIORITY_TONE = { P0: "danger", P1: "warn", P2: "accent", P3: "neutral" } as const;

const CLOSED_STATUSES = new Set(["DONE", "FAILED", "CANCELLED", "REJECTED"]);

function TaskCard({
  task,
  onSelect,
  companyId,
}: {
  task: Task;
  onSelect: (t: Task) => void;
  companyId: string;
}) {
  const queryClient = useQueryClient();
  const archive = useMutation({
    mutationFn: (archived: boolean) => api.tasks.archive(companyId, task.id, archived),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [companyId, "tasks"] }),
  });
  // Kaldırma düğmesi yalnız KAPANMIŞ işlerde: açık bir işi panodan gizlemek
  // onu unutmak demek olurdu. Kapanmış iş zaten bitmiş; panoda durması artık
  // bilgi değil gürültü.
  const closed = CLOSED_STATUSES.has(task.status);
  const archived = task.archivedAt !== null;

  return (
    <div
      className="relative w-full rounded-md border border-acos-line bg-acos-bg2 shadow-sm hover:shadow"
      data-testid={`task-card-${task.number}`}
    >
      <button onClick={() => onSelect(task)} className="w-full p-2 text-left text-xs">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-acos-fg2">{task.displayNumber}</span>
          <StatusPill tone={PRIORITY_TONE[task.priority]}>{task.priority}</StatusPill>
          <span className="ml-auto uppercase text-[10px] text-acos-fg2">{task.kind}</span>
        </div>
        <p className="mt-1 line-clamp-2 font-medium text-acos-fg0">{task.title}</p>
        <p className="mt-0.5 text-[10px] text-acos-fg2">{task.status}</p>
      </button>
      {closed && (
        <button
          onClick={() => archive.mutate(!archived)}
          disabled={archive.isPending}
          title={
            archived
              ? "Panoya geri getir"
              : "Panodan kaldır — görev, olayları ve anıları silinmez, arşivde durur"
          }
          className="absolute right-1 top-1 rounded px-1.5 py-0.5 text-[10px] text-acos-fg2 hover:bg-acos-bg3 hover:text-acos-fg1"
          data-testid={`task-archive-${task.number}`}
        >
          {archived ? "↩" : "✕"}
        </button>
      )}
    </div>
  );
}

function TaskDetail({
  companyId,
  task,
  onClose,
}: {
  companyId: string;
  task: Task;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const agents = useQuery({ queryKey: keys.agents(companyId), queryFn: () => api.agents.list(companyId) });
  const [error, setError] = useState<string | null>(null);
  const [assignee, setAssignee] = useState("");

  const refresh = () => queryClient.invalidateQueries({ queryKey: [companyId, "tasks"] });

  const transition = useMutation({
    mutationFn: (to: string) => api.tasks.transition(companyId, task.id, { to }),
    onSuccess: () => {
      setError(null);
      void refresh();
      onClose();
    },
    onError: (err) =>
      setError(err instanceof AcosApiError ? `${err.problem.code}: ${err.problem.detail}` : String(err)),
  });
  const assign = useMutation({
    mutationFn: () => api.tasks.assign(companyId, task.id, { agentId: assignee }),
    onSuccess: () => {
      setError(null);
      void refresh();
      onClose();
    },
    onError: (err) =>
      setError(err instanceof AcosApiError ? `${err.problem.code}: ${err.problem.detail}` : String(err)),
  });

  const nextStatuses = TASK_NEXT_STATUSES[task.status] ?? [];

  return (
    <Dialog open onClose={onClose} title={`${task.displayNumber} · ${task.title}`}>
      <div className="space-y-3 text-sm">
        <p className="text-acos-fg1">{task.objective}</p>
        <div className="flex flex-wrap gap-2 text-xs text-acos-fg1">
          <StatusPill tone="accent">{task.status}</StatusPill>
          <span>tür: {task.kind}</span>
          <span>risk: {task.risk}</span>
          <span>derinlik: {task.delegationDepth}</span>
          {task.ownerAgentId && (
            <span>
              sahip: {agents.data?.find((a) => a.id === task.ownerAgentId)?.name ?? task.ownerAgentId}
            </span>
          )}
        </div>

        {error && (
          <p className="rounded bg-danger/10 px-2 py-1 text-xs text-danger" data-testid="transition-error">
            {error}
          </p>
        )}

        <div className="flex flex-wrap gap-2" data-testid="transition-buttons">
          {nextStatuses.map((to) => (
            <Button
              key={to}
              variant="secondary"
              disabled={transition.isPending}
              onClick={() => transition.mutate(to)}
              data-testid={`transition-${to}`}
            >
              → {to}
            </Button>
          ))}
          {nextStatuses.length === 0 && <span className="text-xs text-acos-fg2">uç durum</span>}
        </div>

        {(task.status === "PLANNED" || task.status === "ASSIGNED") && (
          <div className="flex items-end gap-2 border-t border-acos-line pt-3">
            <div className="flex-1">
              <Field label="Sahip ata">
                <Select
                  value={assignee}
                  onChange={(e) => setAssignee(e.target.value)}
                  name="taskAssignee"
                >
                  <option value="">bir ajan seçin…</option>
                  {agents.data
                    ?.filter((a) => a.status === "active")
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </Select>
              </Field>
            </div>
            <Button disabled={!assignee || assign.isPending} onClick={() => assign.mutate()} data-testid="assign-button">
              Ata
            </Button>
          </div>
        )}

        <TaskReviews companyId={companyId} taskId={task.id} />
      </div>
    </Dialog>
  );
}

/** Reviews panel (T43; 24 §6 review UI slice): the PR entity rows + diff. */
function TaskReviews({ companyId, taskId }: { companyId: string; taskId: string }) {
  const [diffFor, setDiffFor] = useState<string | null>(null);
  const reviewsQuery = useQuery({
    queryKey: [companyId, "tasks", taskId, "reviews"],
    queryFn: () => api.reviews.listForTask(companyId, taskId),
  });
  const diff = useQuery({
    queryKey: [companyId, "reviews", diffFor, "diff"],
    queryFn: () => api.reviews.diff(companyId, diffFor!),
    enabled: diffFor !== null,
  });
  const items = reviewsQuery.data?.items ?? [];
  if (items.length === 0) return null;

  const TONE: Record<string, "ok" | "warn" | "accent" | "neutral"> = {
    approved: "ok",
    changes_requested: "warn",
    in_review: "accent",
    pending: "neutral",
    blocked: "warn",
  };
  return (
    <div className="border-t border-acos-line pt-3" data-testid="task-reviews">
      <h4 className="mb-1 text-xs font-semibold uppercase text-acos-fg2">İncelemeler</h4>
      <div className="space-y-1">
        {items.map((r) => (
          <div key={r.id} className="rounded bg-acos-bg1 px-2 py-1.5 text-xs" data-testid="review-row">
            <div className="flex items-center gap-2">
              <StatusPill tone={TONE[r.status] ?? "neutral"}>{r.status}</StatusPill>
              <span className="font-medium">{r.kind}</span>
              <span className="text-acos-fg2">
                {r.authorName ?? "?"} → {r.reviewerName ?? "atanmadı"}
              </span>
              {r.mergedCommit && (
                <code className="text-acos-fg2">merge @ {r.mergedCommit.slice(0, 8)}</code>
              )}
              <Button
                variant="ghost"
                className="ml-auto"
                onClick={() => setDiffFor(diffFor === r.id ? null : r.id)}
                data-testid="review-diff-toggle"
              >
                {diffFor === r.id ? "diff'i gizle" : "diff"}
              </Button>
            </div>
            {r.verdictMd && <p className="mt-1 text-acos-fg1">{r.verdictMd}</p>}
            {diffFor === r.id && (
              <pre
                className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-acos-bg2 p-2 font-mono text-[11px]"
                data-testid="review-diff"
              >
                {diff.isLoading ? "diff yükleniyor…" : (diff.data?.diff ?? "(diff yok)")}
              </pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function CreateTaskDialog({
  companyId,
  open,
  onClose,
  tasks,
}: {
  companyId: string;
  open: boolean;
  onClose: () => void;
  tasks: Task[];
}) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState("task");
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [priority, setPriority] = useState("P2");
  const [parentId, setParentId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const parentKind: Record<string, string | null> = {
    goal: null,
    initiative: "goal",
    epic: "initiative",
    task: "epic",
    subtask: "task",
  };
  const parentOptions = tasks.filter((t) => t.kind === parentKind[kind]);

  const create = useMutation({
    mutationFn: () =>
      api.tasks.create(companyId, {
        kind,
        title,
        objective,
        priority,
        ...(parentId && { parentId }),
      }),
    onSuccess: () => {
      setTitle("");
      setObjective("");
      setError(null);
      void queryClient.invalidateQueries({ queryKey: [companyId, "tasks"] });
      onClose();
    },
    onError: (err) =>
      setError(err instanceof AcosApiError ? `${err.problem.code}: ${err.problem.detail}` : String(err)),
  });

  if (!open) return null;
  return (
    <Dialog open onClose={onClose} title="Yeni görev">
      <div className="space-y-3">
        <div className="flex gap-2">
          <div className="w-36">
            <Field label="Tür">
              <Select value={kind} onChange={(e) => setKind(e.target.value)} name="taskKind">
                {["goal", "initiative", "epic", "task", "subtask"].map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="w-28">
            <Field label="Öncelik">
              <Select value={priority} onChange={(e) => setPriority(e.target.value)} name="taskPriority">
                {["P0", "P1", "P2", "P3"].map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </Select>
            </Field>
          </div>
          {parentKind[kind] !== null && (
            <div className="flex-1">
              <Field label={`Üst görev (${parentKind[kind]})`}>
                <Select value={parentId} onChange={(e) => setParentId(e.target.value)} name="taskParent">
                  <option value="">{kind === "task" ? "yok (ad-hoc)" : "zorunlu…"}</option>
                  {parentOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayNumber} {p.title}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}
        </div>
        <Field label="Başlık">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} name="taskTitle" />
        </Field>
        <Field label="Hedef">
          <Textarea
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            name="taskObjective"
            rows={3}
          />
        </Field>
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Vazgeç
          </Button>
          <Button
            disabled={!title || !objective || create.isPending}
            onClick={() => create.mutate()}
            data-testid="create-task-submit"
          >
            Oluştur
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function TreeTab({ tasks, onSelect }: { tasks: Task[]; onSelect: (t: Task) => void }) {
  const byParent = useMemo(() => {
    const map = new Map<string | null, Task[]>();
    for (const t of tasks) {
      const key = t.parentId && tasks.some((p) => p.id === t.parentId) ? t.parentId : null;
      map.set(key, [...(map.get(key) ?? []), t]);
    }
    return map;
  }, [tasks]);

  function renderLevel(parentId: string | null, depth: number) {
    return (byParent.get(parentId) ?? []).map((task) => (
      <div key={task.id} style={{ paddingLeft: depth * 20 }}>
        <button
          onClick={() => onSelect(task)}
          className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-acos-bg3"
        >
          <span className="font-mono text-xs text-acos-fg2">{task.displayNumber}</span>
          <span className="uppercase text-[10px] text-acos-fg2">{task.kind}</span>
          <span className="text-acos-fg0">{task.title}</span>
          <StatusPill tone={task.status === "DONE" ? "ok" : "neutral"}>{task.status}</StatusPill>
        </button>
        {renderLevel(task.id, depth + 1)}
      </div>
    ));
  }

  return <div data-testid="task-tree">{renderLevel(null, 0)}</div>;
}

export function TasksView() {
  const { companyId } = useParams({ from: "/c/$companyId" });
  const [tab, setTab] = useState<"kanban" | "tree" | "dag">("kanban");
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<Task | null>(null);

  // Arşiv görünümü: varsayılan pano yalnız açık + yeni kapanmış işleri
  // gösterir (sunucudaki "active" penceresi). Kapanan hiçbir şey silinmez,
  // buradan geri getirilir.
  const [showArchive, setShowArchive] = useState(false);

  const tasks = useQuery({
    queryKey: [companyId, "tasks", "list", showArchive ? "archived" : "active"],
    queryFn: () => api.tasks.list(companyId, { include: showArchive ? "archived" : "active" }),
  });
  const rows = tasks.data ?? [];

  // "Rafa kaldır" (2026-08-19): tüm görevleri yasal geçişlerle iptal edip
  // arşivler. SİLME YOK — olaylar ve görevlerden doğan anılar kalır; başka
  // projede "daha önce benzerini yapmıştık" retrieval'ı bu sayede çalışır.
  const queryClientRef = useQueryClient();
  const shelveAll = useMutation({
    mutationFn: () => api.tasks.shelve(companyId),
    onSuccess: () => void queryClientRef.invalidateQueries({ queryKey: [companyId, "tasks"] }),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold text-acos-fg0">Görevler</h1>
        <div className="flex rounded-md border border-acos-line p-0.5">
          {(["kanban", "tree", "dag"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "rounded px-3 py-1 text-xs font-medium",
                tab === t ? "bg-accent-500/10 text-accent-600" : "text-acos-fg1 hover:bg-acos-bg3",
              )}
              data-testid={`tab-${t}`}
            >
              {t === "kanban" ? "Kanban" : t === "tree" ? "Ağaç" : "DAG"}
            </button>
          ))}
        </div>
        <button
          onClick={() => setShowArchive((v) => !v)}
          className={cn(
            "ml-auto rounded-md border px-3 py-1 text-xs font-medium",
            showArchive
              ? "border-accent-500/40 bg-accent-500/10 text-accent-600"
              : "border-acos-line text-acos-fg1 hover:bg-acos-bg3",
          )}
          data-testid="toggle-archive"
        >
          {showArchive ? "Panoya dön" : "Arşiv"}
        </button>
        <button
          onClick={() => {
            if (
              window.confirm(
                `${rows.length} görevin tamamı rafa kaldırılacak (iptal + arşiv). ` +
                  "Görevler silinmez; olaylar ve anılar kalır. Emin misin?",
              )
            ) {
              shelveAll.mutate();
            }
          }}
          disabled={shelveAll.isPending || rows.length === 0}
          className="rounded-md border border-red-500/40 px-3 py-1 text-xs font-medium text-red-500 hover:bg-red-500/10 disabled:opacity-40"
          data-testid="shelve-all-button"
          title="Tüm görevleri rafa kaldır — silme yok, anılar kalır"
        >
          🗑 Tümünü rafa kaldır
        </button>
        <Button onClick={() => setCreateOpen(true)} data-testid="new-task-button">
          Yeni görev
        </Button>
      </div>

      {rows.length === 0 && !tasks.isLoading ? (
        <p className="py-12 text-center text-sm text-acos-fg2">
          Görev yok — CEO'ya bir hedef verin.
        </p>
      ) : tab === "kanban" ? (
        <div className="flex gap-3 overflow-x-auto pb-2" data-testid="kanban-board">
          {COLUMNS.map((column) => {
            const cards = rows.filter((t) => column.statuses.includes(t.status));
            return (
              <div key={column.id} className="w-56 shrink-0" data-testid={`column-${column.id}`}>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-acos-fg1">
                  {column.label} <span className="text-acos-fg2">{cards.length}</span>
                </p>
                <div className="space-y-2">
                  {cards.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      onSelect={setSelected}
                      companyId={companyId}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : tab === "tree" ? (
        <Card className="p-3">
          <TreeTab tasks={rows} onSelect={setSelected} />
        </Card>
      ) : (
        <Card className="p-3">
          <TaskDag companyId={companyId} tasks={rows} onSelect={setSelected} />
        </Card>
      )}

      <CreateTaskDialog
        companyId={companyId}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        tasks={rows}
      />
      {selected && (
        <TaskDetail companyId={companyId} task={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}
