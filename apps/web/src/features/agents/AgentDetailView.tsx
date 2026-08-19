import { useState } from "react";
// Agent detail (24 §6.2): identity header, bindings, escalation chain,
// sessions table, lifecycle actions + CANLI SÜREÇ AKIŞI (Founder gözlemi,
// 2026-08-14): agent_steps read-model'i 4 sn'de bir tazelenir — ajanın her
// düşüncesi/aksiyonu/gözlemi jeton ve maliyetiyle burada akar.
import { useParams } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { AgentStep } from "@acos/contracts";
import { AgentAvatar, AgentStatusPill, Button, Card, DataTable, cn } from "@acos/ui";
import { api, keys, queryClient } from "../../lib/api.js";

const KIND_TONE: Record<string, string> = {
  think: "bg-acos-bg2 text-acos-fg1",
  record_decision: "bg-acos-bg2 text-acos-fg1",
  use_tool: "bg-accent-500/15 text-accent-600",
  create_task: "bg-[#2ec26a]/15 text-[#2ec26a]",
  delegate_task: "bg-[#2ec26a]/15 text-[#2ec26a]",
  send_message: "bg-accent-500/15 text-accent-600",
  request_review: "bg-[#ffcb47]/15 text-[#b58a1f]",
  request_help: "bg-[#ffcb47]/15 text-[#b58a1f]",
  escalate: "bg-[#ff4d4d]/15 text-[#ff4d4d]",
  wait_for: "bg-acos-bg2 text-acos-fg1",
  update_task_status: "bg-accent-500/15 text-accent-600",
  complete_task: "bg-[#2ec26a]/15 text-[#2ec26a]",
  abandon: "bg-[#ff4d4d]/15 text-[#ff4d4d]",
};

/** Aksiyon JSON'undan insan-okur tek satırlık özet. */
function stepSummary(step: AgentStep): string {
  const a = (step.action ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  switch (step.actionKind) {
    case "think":
      return s(a.thought);
    case "record_decision": {
      const plan = Array.isArray(a.plan) ? (a.plan as unknown[]).map(String) : [];
      return s(a.decision) || s(a.title) || plan.slice(0, 2).join(" · ");
    }
    case "use_tool":
      return `${s(a.tool)} — ${s(a.reason)}`;
    case "create_task":
      return `${s(a.kind)}: ${s(a.title)}`;
    case "delegate_task":
      return s(a.note);
    case "send_message":
      return s(a.body);
    case "escalate":
      return s(a.reason);
    case "wait_for":
      return `bekliyor: ${s(a.what)}`;
    case "update_task_status":
      return `→ ${s(a.to)} — ${s(a.note)}`;
    case "complete_task":
      return s((a.result as Record<string, unknown> | undefined)?.summary);
    case "abandon":
      return s(a.reason);
    default:
      return JSON.stringify(a).slice(0, 160);
  }
}

function observationBadge(step: AgentStep): { label: string; err: boolean } | null {
  const o = step.observation as { ok?: boolean; error?: string; detail?: string } | null;
  if (!o || typeof o.ok !== "boolean") return null;
  if (o.ok) return { label: "ok", err: false };
  return { label: (o.error ?? "hata").slice(0, 60), err: true };
}

export function AgentDetailView() {
  const { companyId, agentId } = useParams({ from: "/c/$companyId/agents/$agentId" });
  const agent = useQuery({
    queryKey: keys.agent(companyId, agentId),
    queryFn: () => api.agents.get(companyId, agentId),
  });
  const bindings = useQuery({
    queryKey: keys.agentBindings(companyId, agentId),
    queryFn: () => api.agents.listBindings(companyId, agentId),
  });
  const sessions = useQuery({
    queryKey: keys.agentSessions(companyId, agentId),
    queryFn: () => api.agents.listSessions(companyId, agentId),
  });
  const chain = useQuery({
    queryKey: keys.agentChain(companyId, agentId),
    queryFn: () => api.org.chain(companyId, agentId),
  });
  // canlı süreç akışı — koşan oturum varken 4 sn'de bir tazelenir
  const steps = useQuery({
    queryKey: [companyId, "agents", agentId, "steps"],
    queryFn: () => api.agents.steps(companyId, agentId, { limit: 40 }),
    refetchInterval: 4000,
  });
  const running = (sessions.data ?? []).some((s) => s.status === "running");

  const lifecycle = useMutation({
    mutationFn: (action: "pause" | "resume" | "offboard") =>
      api.agents.lifecycle(companyId, agentId, action),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.agent(companyId, agentId) });
      await queryClient.invalidateQueries({ queryKey: keys.agents(companyId) });
      await queryClient.invalidateQueries({ queryKey: keys.orgEdges(companyId) });
    },
  });

  if (!agent.data) return <p className="text-sm text-acos-fg2">Yükleniyor…</p>;
  const a = agent.data;

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-center gap-4">
          <AgentAvatar name={a.name} imageUrl={a.avatarUrl} size={56} />
          <div>
            <h1 className="text-lg font-bold text-acos-fg0" data-testid="agent-name">
              {a.name}
            </h1>
            <p className="text-sm text-acos-fg2">
              {a.displayNumber} · {a.seniority} · otonomi L{a.autonomyLevel}
            </p>
          </div>
          <AgentStatusPill status={a.status} />
          <div className="ml-auto flex gap-2">
            {a.status === "active" && (
              <Button variant="secondary" onClick={() => lifecycle.mutate("pause")}>
                Duraklat
              </Button>
            )}
            {a.status === "paused" && (
              <Button variant="secondary" onClick={() => lifecycle.mutate("resume")}>
                Devam
              </Button>
            )}
            {a.status !== "offboarded" && (
              <Button variant="danger" onClick={() => lifecycle.mutate("offboard")}>
                İşten çıkar
              </Button>
            )}
          </div>
        </div>
        <p className="mt-3 text-sm text-acos-fg1">{a.persona}</p>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Model bağları (kimlik ⊥ model)">
          <DataTable
            rows={bindings.data ?? []}
            rowKey={(binding) => binding.id}
            empty="Özel bağ yok — şirket profilleri geçerli."
            columns={[
              { header: "Amaç", cell: (binding) => binding.purpose },
              { header: "Model", cell: (binding) => binding.model },
              { header: "Öncelik", cell: (binding) => String(binding.priority) },
            ]}
          />
          <BindingEditor companyId={companyId} agentId={agentId} />
        </Card>

        <Card title="Eskalasyon zinciri">
          <ol className="space-y-1 text-sm" data-testid="escalation-chain">
            {chain.data?.map((hop, index) => (
              <li key={index} className="text-acos-fg0">
                {index + 1}. {hop.kind === "founder" ? "Founder (sanal)" : hop.name}
              </li>
            ))}
          </ol>
        </Card>
      </div>

      <Card
        title={
          <span className="flex items-center gap-2">
            Canlı süreç
            {running && (
              <span className="flex items-center gap-1 text-[10px] font-normal text-[#2ec26a]">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[#2ec26a]" />
                çalışıyor
              </span>
            )}
          </span>
        }
      >
        {(steps.data ?? []).length === 0 ? (
          <p className="py-4 text-center text-sm text-acos-fg2">
            Henüz adım yok — bu çalışana bir görev atandığında düşünce ve aksiyon akışı burada
            canlı izlenir.
          </p>
        ) : (
          <div className="max-h-96 space-y-1 overflow-y-auto" data-testid="agent-step-stream">
            {(steps.data ?? []).map((step) => {
              const obs = observationBadge(step);
              return (
                <div
                  key={`${step.agentSessionId}-${step.stepNo}-${step.createdAt}`}
                  className="rounded border border-acos-line px-2 py-1.5 text-xs"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] tabular-nums text-acos-fg2">
                      #{step.stepNo}
                    </span>
                    <span
                      className={cn(
                        "rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                        KIND_TONE[step.actionKind] ?? "bg-acos-bg2 text-acos-fg1",
                      )}
                    >
                      {step.actionKind}
                    </span>
                    {obs && (
                      <span className={cn("text-[10px]", obs.err ? "text-danger" : "text-[#2ec26a]")}>
                        {obs.label}
                      </span>
                    )}
                    <span className="ml-auto text-[10px] tabular-nums text-acos-fg2">
                      {step.tokensIn + step.tokensOut > 0 &&
                        `${step.tokensIn + step.tokensOut} jeton · `}
                      {new Date(step.createdAt).toLocaleTimeString()}
                    </span>
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-acos-fg1">{stepSummary(step)}</p>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card title="Oturumlar">
        <DataTable
          rows={sessions.data ?? []}
          rowKey={(session) => session.id}
          empty="Henüz oturum yok."
          columns={[
            { header: "İş akışı", cell: (session) => session.workflowId },
            { header: "Durum", cell: (session) => session.status },
            { header: "Adım", cell: (session) => String(session.stepsCount) },
            {
              header: "Başlangıç",
              cell: (session) => new Date(session.startedAt).toLocaleString(),
            },
          ]}
        />
      </Card>
    </div>
  );
}

/** TASK 11: agent başına model seçimi — registry'den, string dağıtmadan. */
function BindingEditor({ companyId, agentId }: { companyId: string; agentId: string }) {
  const registry = useQuery({
    queryKey: [companyId, "model-registry"],
    queryFn: () => api.agents.modelRegistry(companyId),
  });
  const [purpose, setPurpose] = useState("default");
  const [choice, setChoice] = useState("");
  const set = useMutation({
    mutationFn: () => {
      const profile = (registry.data?.profiles ?? []).find(
        (p) => `${p.providerId}::${p.model}` === choice,
      );
      if (!profile) throw new Error("model seçilmedi");
      return api.agents.setBinding(companyId, agentId, {
        purpose,
        providerId: profile.providerId,
        model: profile.model,
      });
    },
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: keys.agentBindings(companyId, agentId) }),
  });
  const profiles = registry.data?.profiles ?? [];
  const unique = [...new Map(profiles.map((p) => [`${p.providerId}::${p.model}`, p])).values()];
  return (
    <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-acos-line pt-3">
      <label className="text-xs text-acos-fg2">
        Amaç
        <select
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
          className="mt-1 block rounded-md border border-acos-line bg-acos-bg1 px-2 py-1 text-sm"
          data-testid="binding-purpose"
        >
          {["default", "coding", "planning", "review", "fast"].map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs text-acos-fg2">
        Model (kayıtlı profiller)
        <select
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
          className="mt-1 block rounded-md border border-acos-line bg-acos-bg1 px-2 py-1 text-sm"
          data-testid="binding-model"
        >
          <option value="">Seç…</option>
          {unique.map((p) => (
            <option key={`${p.providerId}::${p.model}`} value={`${p.providerId}::${p.model}`}>
              {p.provider} / {p.model}
            </option>
          ))}
        </select>
      </label>
      <Button onClick={() => set.mutate()} disabled={set.isPending || !choice} data-testid="binding-save">
        Bağla
      </Button>
      {set.isError && <span className="text-xs text-red-500">kaydedilemedi</span>}
    </div>
  );
}
