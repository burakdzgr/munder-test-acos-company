// Office view — /c/$companyId/office (23 §5–8 skeleton): Pixi scene fed by
// the presence snapshot + office.* instruction deltas (via officeStore), an
// agent card popover with the "Open in Agent Monitor" link, and the debug
// inspector surface (last applied causeEventId). No animation code here —
// the office lint rule bans it outside the Pixi bridge.
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Button, Card, cn, OfficeIcon, StatusPill } from "@acos/ui";
import { api, keys } from "../../lib/api.js";
import { useOfficeStore } from "../../stores/office.js";
import { usePresence } from "../../stores/presence.js";
import { useRealtimeStatus } from "../../realtime/RealtimeDispatcher.js";
import { OfficeCanvas } from "./OfficeCanvas.js";
import { DirectiveDialog } from "./DirectiveDialog.js";

export function OfficeView() {
  const { companyId } = useParams({ from: "/c/$companyId" });
  const status = useRealtimeStatus();
  const snapshot = usePresence((s) => s.snapshot);
  const badges = usePresence((s) => s.badges);
  const engine = useOfficeStore((s) => s.engine);
  const setLayout = useOfficeStore((s) => s.setLayout);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [directiveOpen, setDirectiveOpen] = useState(false);

  // Şirketin tepesi kim? Bu soruya cevap veren bir yüzey yoktu; Founder
  // CEO'yu 32 ajanlık düz listede arıyordu (2026-08-17). Sunucu mantığı
  // (ProjectsService.topExecutive) zaten vardı, yalnız açılmamıştı.
  const executiveQuery = useQuery({
    queryKey: [companyId, "org", "top-executive"],
    queryFn: () => api.tasks.topExecutive(companyId),
    retry: false, // ajansız şirkette 404 normaldir, tekrar denemeye değmez
  });
  const executive = executiveQuery.data ?? null;

  // floor plan (U04): read-only REST projection of the projector's layout
  const layoutQuery = useQuery({
    queryKey: [companyId, "office", "layout"],
    queryFn: () => api.office.layout(companyId),
  });
  useEffect(() => {
    if (layoutQuery.data) setLayout(layoutQuery.data);
  }, [layoutQuery.data, setLayout]);

  const agentsQuery = useQuery({
    queryKey: keys.agents(companyId),
    queryFn: () => api.agents.list(companyId),
  });
  const avatarUrls = useMemo(
    () => new Map((agentsQuery.data ?? []).map((agent) => [agent.id, agent.avatarUrl])),
    [agentsQuery.data],
  );

  const selected = selectedAgentId
    ? snapshot?.agents.find((a) => a.agentId === selectedAgentId)
    : null;

  const agentCount = snapshot?.agents.length ?? 0;

  return (
    <div className="space-y-4">
      {/* Başlık şeridi — durum + ajan sayacı + debug aksiyonu, tek satır */}
      <div className="flex flex-wrap items-center gap-3 rounded-card border border-acos-line bg-acos-bg1 px-4 py-3 shadow-sm">
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-acos-line bg-acos-bg2 text-acos-fg1"
          aria-hidden
        >
          <OfficeIcon size={18} />
        </span>
        <div className="min-w-0">
          <h1 className="text-[15px] font-semibold leading-tight text-acos-fg0">Ofis</h1>
          <p className="truncate text-[11px] text-acos-fg2">Canlı sanal ofis — ajan varlığı ve etkileşimleri</p>
        </div>
        <StatusPill tone={status === "open" ? "ok" : "warn"}>ws: {status}</StatusPill>
        <span
          className="flex items-center gap-1.5 rounded-full border border-acos-line bg-acos-bg2 px-2.5 py-1 text-[11px] text-acos-fg1"
          data-testid="office-agent-count"
        >
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              agentCount > 0 ? "bg-presence-communicating" : "bg-acos-fg2",
            )}
          />
          {agentCount} ajan ofiste
        </span>
        <div className="ml-auto flex items-center gap-2">
          {/*
            Founder'ın iş verme yolu artık BAŞLIKTA duruyor ve kimin
            yöneteceğini adıyla söylüyor. Ofisteki CEO'ya tıklamak da aynı
            diyaloğu açar — ama Founder'ın önce doğru avatarı bulması
            gerekmesin.
          */}
          {executive && (
            <Button onClick={() => setDirectiveOpen(true)} data-testid="office-directive-button">
              {executive.positionTitle}'a görev ver
            </Button>
          )}
          <Button
            variant={inspectorOpen ? "secondary" : "ghost"}
            onClick={() => setInspectorOpen((v) => !v)}
            data-testid="office-debug-toggle"
          >
            {inspectorOpen ? "İnceleyiciyi gizle" : "Debug inceleyici"}
          </Button>
        </div>
      </div>

      {/* Pixi sahnesi — chrome dışında hiçbir render/animasyon mantığına dokunulmadı */}
      <Card className="overflow-hidden border-acos-line bg-acos-bg1 shadow-lg" padding={false}>
        <div className="h-[540px] overflow-hidden bg-[#0f1420]">
          <OfficeCanvas
            onSelectAgent={setSelectedAgentId}
            avatarUrls={avatarUrls}
            executiveAgentId={executive?.agentId ?? null}
          />
        </div>
      </Card>

      {selected && (
        <Card
          className="border-acos-line bg-acos-bg1 shadow-lg"
          data-testid="agent-card-popover"
        >
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-acos-line bg-acos-bg2 text-sm font-semibold text-acos-fg0">
              {selected.name.slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-acos-fg0">{selected.name}</span>
                {/* Kimin patron olduğu kartta YAZILI — keşfedilmesi gereken
                    bir bilgi olmaktan çıktı. */}
                {executive?.agentId === selected.agentId && (
                  <span
                    className="rounded-full border border-dept-executive px-2 py-0.5 text-[10px] font-semibold text-dept-executive"
                    data-testid="office-ceo-badge"
                  >
                    {executive.positionTitle}
                  </span>
                )}
              </div>
              <StatusPill tone={badges[selected.agentId] === "OFFLINE" ? "neutral" : "ok"}>
                {badges[selected.agentId] ?? selected.badge}
              </StatusPill>
            </div>
            <div className="ml-auto flex shrink-0 gap-2">
              {executive?.agentId === selected.agentId && (
                <Button onClick={() => setDirectiveOpen(true)} data-testid="office-card-directive">
                  Görev ver
                </Button>
              )}
              {/* Konuşma: DM kanalı iletişim ekranında zaten var, buradan
                  ajanı seçili olarak açılıyor — Founder'ın kanalı elle
                  bulması gerekmiyor. */}
              <Link
                to="/c/$companyId/communication"
                params={{ companyId }}
                search={{ dm: selected.agentId }}
              >
                <Button variant="secondary" data-testid="office-card-chat">
                  Konuş
                </Button>
              </Link>
              <Link to="/c/$companyId/agents/$agentId" params={{ companyId, agentId: selected.agentId }}>
                <Button variant="ghost">Monitör</Button>
              </Link>
              <Button variant="ghost" onClick={() => setSelectedAgentId(null)}>
                Kapat
              </Button>
            </div>
          </div>
        </Card>
      )}

      {executive && (
        <DirectiveDialog
          companyId={companyId}
          executive={executive}
          open={directiveOpen}
          onClose={() => setDirectiveOpen(false)}
        />
      )}

      {inspectorOpen && (
        <Card
          className="border-acos-line bg-acos-bg1 text-xs shadow-sm"
          data-testid="office-inspector"
        >
          <div className="space-y-2">
            <div className="font-medium text-acos-fg1">
              Her animasyonun nedensel olay id'si var — son uygulanan:{" "}
              <code
                className="rounded border border-acos-line bg-acos-bg2 px-1.5 py-0.5 text-acos-fg0"
                data-testid="last-applied-event-id"
              >
                {engine.lastAppliedEventId ?? "—"}
              </code>
            </div>
            <pre className="max-h-48 overflow-auto rounded-md border border-acos-line bg-acos-bg2 p-2.5 text-acos-fg1">
              {JSON.stringify(engine.debugRing.slice(-20), null, 2)}
            </pre>
          </div>
        </Card>
      )}
    </div>
  );
}
