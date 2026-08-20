// Detached office window (36 §7 — U09): shell-less full-viewport office for
// the "⧉ Ayır" popup (U14 reuses this route in Electron's second
// BrowserWindow). Mounts its own RealtimeDispatcher — the popup is a
// separate document with its own WS connection and presence snapshot.
import { useEffect, useMemo } from "react";
import { useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api, keys } from "../../lib/api.js";
import { useOfficeStore } from "../../stores/office.js";
import { usePresence } from "../../stores/presence.js";
import { RealtimeDispatcher } from "../../realtime/RealtimeDispatcher.js";
import { OfficeCanvas } from "./OfficeCanvas.js";

export function OfficeWindow() {
  const { companyId } = useParams({ from: "/c/$companyId/office-window" });
  const snapshot = usePresence((s) => s.snapshot);
  const setLayout = useOfficeStore((s) => s.setLayout);
  const setRoster = useOfficeStore((s) => s.setRoster);

  const layoutQuery = useQuery({
    queryKey: [companyId, "office", "layout"],
    queryFn: () => api.office.layout(companyId),
  });
  useEffect(() => {
    if (layoutQuery.data) setLayout(layoutQuery.data);
  }, [layoutQuery.data, setLayout]);

  const agents = useQuery({
    queryKey: keys.agents(companyId),
    queryFn: () => api.agents.list(companyId),
  });
  const avatarUrls = useMemo(
    () => new Map((agents.data ?? []).map((agent) => [agent.id, agent.avatarUrl])),
    [agents.data],
  );

  // FAZ 2B: ayrık pencere de aynı koltuk dağıtımını görmeli (CEO → CEO odası).
  const positions = useQuery({
    queryKey: keys.orgPositions(companyId),
    queryFn: () => api.org.listPositions(companyId),
  });
  const executive = useQuery({
    queryKey: [companyId, "tasks", "top-executive"],
    queryFn: () => api.tasks.topExecutive(companyId),
    retry: false,
  });
  useEffect(() => {
    const titleById = new Map((positions.data ?? []).map((p) => [p.id, p.title]));
    const executiveId = executive.data?.agentId ?? null;
    setRoster(
      new Map(
        (agents.data ?? []).map((agent) => [
          agent.id,
          { title: titleById.get(agent.positionId) ?? null, executive: agent.id === executiveId },
        ]),
      ),
    );
  }, [agents.data, positions.data, executive.data, setRoster]);

  return (
    <div className="flex h-screen flex-col bg-acos-bg0 font-sans text-acos-fg0">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-acos-line bg-acos-bg1 px-3 text-[11px]">
        <span className="font-bold">
          A<b style={{ color: "#2ec26a" }}>C</b>OS
        </span>
        <span className="text-acos-fg2">Ofis</span>
        <span className="ml-auto text-[10px] text-acos-fg2" data-testid="office-window-count">
          {snapshot?.agents.length ?? 0} ajan sahada
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <OfficeCanvas avatarUrls={avatarUrls} />
      </div>
      <RealtimeDispatcher companyId={companyId} />
    </div>
  );
}
