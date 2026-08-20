// Ofis panel (36 §7 — U09): the Command Center's right-top office tab.
// Edge-to-edge floorplan canvas (U04 renderer) with a slim dark header —
// live agent count, "+ Çalışan" (existing hire flow) and "⧉ Ayır" (detach
// into a popup window; Electron promotes this to a second BrowserWindow in
// U14). Selecting an avatar feeds focusStore (cross-panel highlight). No
// animation logic here — the office lint rule keeps motion in the bridge.
import { useEffect, useMemo, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api, keys } from "../../lib/api.js";
import { useFocusAgentSet } from "../../lib/teamFilter.js";
import { useOfficeStore } from "../../stores/office.js";
import { usePresence } from "../../stores/presence.js";
import { useFocus } from "../../stores/focus.js";
import { HireModal } from "../agents/HireModal.js";
import { OfficeCanvas } from "./OfficeCanvas.js";

export function OfficePanel() {
  const { companyId } = useParams({ from: "/c/$companyId" });
  const snapshot = usePresence((s) => s.snapshot);
  const badges = usePresence((s) => s.badges);
  const activeCount = Object.values(badges).filter(
    (b) => b !== "IDLE" && b !== "OFFLINE",
  ).length;
  const setLayout = useOfficeStore((s) => s.setLayout);
  const setRoster = useOfficeStore((s) => s.setRoster);
  const setSelectedAgent = useFocus((s) => s.setSelectedAgent);
  const [hireOpen, setHireOpen] = useState(false);

  const layoutQuery = useQuery({
    queryKey: [companyId, "office", "layout"],
    queryFn: () => api.office.layout(companyId),
  });
  useEffect(() => {
    if (layoutQuery.data) setLayout(layoutQuery.data);
  }, [layoutQuery.data, setLayout]);

  // U15: persistent identity → same character (avatar_url or agent-id hash)
  const agents = useQuery({
    queryKey: keys.agents(companyId),
    queryFn: () => api.agents.list(companyId),
  });
  const avatarUrls = useMemo(
    () => new Map((agents.data ?? []).map((agent) => [agent.id, agent.avatarUrl])),
    [agents.data],
  );
  // FAZ 2B: koltuk dağıtımı unvana bakar (CEO → CEO odası, lider → lider
  // masası). Unvan pozisyonlarda, tepe yönetici ayrı uçta; ikisi de burada
  // birleştirilip yansıtıcıya veriliyor.
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
          {
            title: titleById.get(agent.positionId) ?? null,
            executive: agent.id === executiveId,
          },
        ]),
      ),
    );
  }, [agents.data, positions.data, executive.data, setRoster]);

  // E2/W8: odak kümesi takım filtresini VE seçili projeyi izler
  const { members: focusMembers } = useFocusAgentSet(companyId);

  function detach() {
    // Electron shell → second BrowserWindow (U14b); browser → popup window
    if (window.acosDesktop) {
      window.acosDesktop.openOffice(companyId);
      return;
    }
    window.open(
      `/c/${companyId}/office-window`,
      "acos-office",
      "width=1100,height=760,popup=yes",
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-acos-bg1" data-testid="office-panel">
      <div className="flex h-6 shrink-0 items-center gap-2 border-b border-acos-line px-2 text-[9.5px] text-acos-fg2">
        {/* AGENTDESK dili: "aktif/toplam" — aktif = IDLE/OFFLINE dışı rozet */}
        <span data-testid="office-panel-count">
          <span className="font-semibold text-[#3fd0a0]">{activeCount}</span>/
          {snapshot?.agents.length ?? 0} aktif
        </span>
        <span className="ml-auto" />
        <button
          data-testid="office-hire"
          onClick={() => setHireOpen(true)}
          className="rounded border border-acos-line bg-acos-bg3 px-1.5 py-0.5 text-acos-fg1 hover:text-acos-fg0"
        >
          + Çalışan
        </button>
        <button
          data-testid="office-detach"
          onClick={detach}
          title="Ofisi ayrı pencerede aç"
          className="rounded border border-acos-line bg-acos-bg3 px-1.5 py-0.5 text-acos-fg1 hover:text-acos-fg0"
        >
          ⧉ Ayır
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <OfficeCanvas
          onSelectAgent={(agentId) => setSelectedAgent(agentId)}
          avatarUrls={avatarUrls}
          focusAgentIds={focusMembers}
        />
      </div>
      <HireModal open={hireOpen} onClose={() => setHireOpen(false)} />
    </div>
  );
}
