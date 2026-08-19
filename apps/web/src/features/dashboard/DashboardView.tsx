// T48+UI: Unified dashboard — all key panels in one view
// Tasks + Memory + Agents + Projects in a responsive grid
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
  Card,
  DashboardIcon,
  OfficeIcon,
  TasksIcon,
  AgentsIcon,
  MemoryIcon,
  ProjectsIcon,
  CommunicationIcon,
  TerminalsIcon,
  ApprovalsIcon,
} from "@acos/ui";
import { api, keys } from "../../lib/api.js";

const QUICK_LINKS = [
  { path: "office", Icon: OfficeIcon, label: "Ofis" },
  { path: "tasks", Icon: TasksIcon, label: "Görevler" },
  { path: "agents", Icon: AgentsIcon, label: "Ajanlar" },
  { path: "memory", Icon: MemoryIcon, label: "Hafıza" },
  { path: "projects", Icon: ProjectsIcon, label: "Projeler" },
  { path: "communication", Icon: CommunicationIcon, label: "İletişim" },
  { path: "terminals", Icon: TerminalsIcon, label: "Terminaller" },
  { path: "approvals", Icon: ApprovalsIcon, label: "Onaylar" },
] as const;

export function DashboardView() {
  const { companyId } = useParams({ from: "/c/$companyId" });
  
  const tasks = useQuery({
    queryKey: keys.tasks(companyId),
    queryFn: () => api.tasks.list(companyId),
  });
  
  // İstemci adı `memories` (tekil `memory` diye bir uç yok) ve yanıt bir DİZİ
  // değil, `{ items, contradictions, lowConfidence }` zarfı — 12 §8.1.
  const memories = useQuery({
    queryKey: keys.memories(companyId),
    queryFn: () => api.memories.list(companyId, {}),
  });
  const memoryItems = memories.data?.items ?? [];
  
  const agents = useQuery({
    queryKey: keys.agents(companyId),
    queryFn: () => api.agents.list(companyId),
  });
  
  return (
    <div className="h-full overflow-auto bg-acos-bg0 p-4">
      <div className="mb-4 flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-acos-line bg-acos-bg1 text-acos-fg1">
          <DashboardIcon size={18} />
        </span>
        <div>
          <h1 className="text-lg font-semibold leading-tight text-acos-fg0">Komuta Merkezi</h1>
          <p className="text-[11px] text-acos-fg2">Tüm şirket durumu tek ekranda</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {/* Quick Links Panel */}
        <Card
          className="col-span-1 border-acos-line bg-acos-bg1 lg:col-span-2"
          title="Hızlı Erişim"
        >
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {QUICK_LINKS.map(({ path, Icon, label }) => (
              <Link
                key={path}
                // TanStack Router `to` bir ROTA KALIBI ister, kurulmuş URL
                // değil: parametre `params` ile verilir. Şablona companyId'yi
                // gömmek tip birliğiyle eşleşmiyordu.
                to={`/c/$companyId/${path}`}
                params={{ companyId }}
                className="group flex flex-col items-center justify-center gap-1.5 rounded-md border border-acos-line bg-acos-bg2 p-4 transition-colors duration-150 hover:border-dept-engineering hover:bg-acos-bg3"
              >
                <Icon
                  size={20}
                  className="text-acos-fg1 transition-colors duration-150 group-hover:text-dept-engineering"
                />
                <span className="text-xs text-acos-fg1 group-hover:text-acos-fg0">{label}</span>
              </Link>
            ))}
          </div>
        </Card>

        {/* Active Agents Panel */}
        <Card className="border-acos-line bg-acos-bg1" title="Ajanlar">
          <div className="space-y-2">
            {agents.data?.slice(0, 10).map((agent) => (
              <div key={agent.id} className="flex items-center justify-between text-xs">
                <span className="text-acos-fg0">{agent.name}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] ${
                    agent.status === "active"
                      ? "bg-green-500/20 text-green-400"
                      : "bg-acos-bg3 text-acos-fg2"
                  }`}
                >
                  {agent.status}
                </span>
              </div>
            )) ?? <p className="text-xs text-acos-fg2">Yükleniyor...</p>}
          </div>
        </Card>

        {/* Tasks Panel */}
        <Card className="col-span-1 border-acos-line bg-acos-bg1 lg:col-span-2" title="Görevler">
          <div className="grid grid-cols-4 gap-2 text-xs">
            {["IN_PROGRESS", "REVIEW", "WAITING", "BLOCKED"].map((status) => {
              const count = tasks.data?.filter((t) => t.status === status).length ?? 0;
              return (
                <div key={status} className="rounded border border-acos-line bg-acos-bg2 p-2">
                  <div className="text-[10px] text-acos-fg2">{status}</div>
                  <div className="text-lg font-bold text-acos-fg0">{count}</div>
                </div>
              );
            })}
          </div>
          <div className="mt-3 max-h-48 space-y-1 overflow-auto">
            {tasks.data
              ?.filter((t) => !["DONE", "CANCELLED", "FAILED"].includes(t.status))
              .slice(0, 8)
              .map((task) => (
                <div key={task.id} className="rounded bg-acos-bg2 p-2 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-acos-fg0">{task.title}</span>
                    <span className="text-[10px] text-acos-fg2">{task.status}</span>
                  </div>
                </div>
              )) ?? <p className="text-xs text-acos-fg2">Yükleniyor...</p>}
          </div>
        </Card>

        {/* Memory Panel */}
        <Card className="border-acos-line bg-acos-bg1" title="Hafıza">
          <div className="space-y-2 text-xs">
            <div className="flex justify-between">
              <span className="text-acos-fg2">Toplam</span>
              <span className="font-bold text-acos-fg0">{memoryItems.length}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-acos-fg2">Aktif</span>
              <span className="font-bold text-acos-fg0">
                {memoryItems.filter((m) => m.status === "active").length}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-acos-fg2">Proje</span>
              <span className="font-bold text-acos-fg0">
                {memoryItems.filter((m) => m.scope === "project").length}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-acos-fg2">Şirket</span>
              <span className="font-bold text-acos-fg0">
                {memoryItems.filter((m) => m.scope === "company").length}
              </span>
            </div>
          </div>
          <div className="mt-3 max-h-32 space-y-1 overflow-auto">
            {memories.isLoading ? (
              <p className="text-xs text-acos-fg2">Yükleniyor…</p>
            ) : (
              memoryItems.slice(0, 5).map((mem) => (
                <div key={mem.id} className="text-[10px] text-acos-fg1">
                  {mem.title}
                </div>
              ))
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
