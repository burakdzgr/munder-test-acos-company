// Konuşma panel (36 §7 — U09): compact dark agent-chat for the right-bottom
// tab. Channel strip (DM/team/task threads) + message pane + Founder send —
// all through the EXISTING comms API (MessageService; N4-compliant like
// U06's directive). When an agent is focused, a "DM aç" shortcut opens the
// Founder↔agent DM (get-or-create).
import { useEffect, useRef, useState } from "react";
import { useParams, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { cn } from "@acos/ui";
import { api, keys, queryClient } from "../../lib/api.js";
import { useFocus } from "../../stores/focus.js";

export function ChatPanel() {
  const { companyId } = useParams({ from: "/c/$companyId" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const selectedAgentId = useFocus((s) => s.selectedAgentId);
  const paneRef = useRef<HTMLDivElement | null>(null);

  const channels = useQuery({
    queryKey: [companyId, "channels", "list"],
    queryFn: () => api.comms.listChannels(companyId),
  });
  const agents = useQuery({
    queryKey: keys.agents(companyId),
    queryFn: () => api.agents.list(companyId),
  });
  const agentName = new Map((agents.data ?? []).map((a) => [a.id, a.name]));

  const selected = (channels.data ?? []).find((c) => c.id === selectedId) ?? null;
  const messages = useQuery({
    queryKey: [companyId, "channels", "messages", selectedId],
    queryFn: () => api.comms.messages(companyId, selectedId!, { limit: 50 }),
    enabled: selectedId !== null,
  });

  useEffect(() => {
    paneRef.current?.scrollTo({ top: paneRef.current.scrollHeight });
  }, [messages.data]);

  const openDm = useMutation({
    mutationFn: (agentId: string) => api.comms.openDm(companyId, agentId),
    onSuccess: (channel) => {
      setSelectedId(channel.id);
      void queryClient.invalidateQueries({ queryKey: [companyId, "channels"] });
    },
  });

  /**
   * Ofisten "Konuş" ile gelindiğinde DM'i KENDİLİĞİNDEN aç.
   *
   * Ofisteki avatara tıklayıp "Konuş" demek, iletişim ekranında doğru kanalı
   * elle aramak zorunda kalmak demek olmamalı. `?dm=<agentId>` bir kez
   * tüketilir: openDm idempotent (var olan kanalı döndürür) ama her render'da
   * tetiklenmesi gereksiz istek olurdu.
   */
  const dmParam = useSearch({ from: "/c/$companyId/communication" }).dm ?? null;
  const consumedDmRef = useRef<string | null>(null);
  // Mutation nesnesi her render'da yeniden kurulduğu için bağımlılığa
  // konamaz; onun yerine ref'te tutulur ve efekt yalnız parametreye bakar.
  const openDmRef = useRef(openDm.mutate);
  openDmRef.current = openDm.mutate;
  useEffect(() => {
    if (!dmParam || consumedDmRef.current === dmParam) return;
    consumedDmRef.current = dmParam;
    openDmRef.current(dmParam);
  }, [dmParam]);
  const send = useMutation({
    mutationFn: () => api.comms.send(companyId, selectedId!, { body: draft }),
    onSuccess: () => {
      setDraft("");
      void queryClient.invalidateQueries({ queryKey: [companyId, "channels"] });
    },
  });

  function channelLabel(channel: NonNullable<typeof selected>): string {
    if (channel.name) return channel.name;
    if (channel.kind === "dm") {
      // dmKey carries the participant ids; map the first agent uuid we find
      const uuid = channel.dmKey?.match(/[0-9a-f]{8}-[0-9a-f-]{27}/i)?.[0];
      return `DM · ${uuid ? (agentName.get(uuid) ?? "ajan") : "Founder"}`;
    }
    return `${channel.kind} ${channel.id.slice(-4)}`;
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-acos-bg1" data-testid="chat-panel">
      <div className="flex h-7 shrink-0 items-center gap-1 overflow-x-auto border-b border-acos-line px-1.5">
        {selectedAgentId && (
          <button
            data-testid="chat-open-dm"
            onClick={() => openDm.mutate(selectedAgentId)}
            className="shrink-0 rounded border border-dept-engineering/60 bg-dept-engineering/10 px-1.5 py-0.5 text-[9px] text-dept-engineering"
          >
            + DM: {agentName.get(selectedAgentId) ?? "seçili ajan"}
          </button>
        )}
        {(channels.data ?? []).slice(0, 20).map((channel) => (
          <button
            key={channel.id}
            onClick={() => setSelectedId(channel.id)}
            className={cn(
              "shrink-0 rounded px-1.5 py-0.5 text-[9px]",
              selectedId === channel.id
                ? "bg-acos-bg3 text-acos-fg0"
                : "text-acos-fg2 hover:text-acos-fg1",
            )}
          >
            {channelLabel(channel)}
          </button>
        ))}
      </div>
      <div ref={paneRef} className="min-h-0 flex-1 overflow-y-auto p-2" data-testid="chat-pane">
        {!selected && (
          <div className="p-2 text-[10px] text-acos-fg2">
            Kanal seç — ajanlar arası gerçek mesajlaşma burada akar.
          </div>
        )}
        {(messages.data ?? []).map((message) => {
          const sender =
            message.senderAgentId === null
              ? "Founder"
              : (agentName.get(message.senderAgentId) ?? "ajan");
          return (
            <div key={message.id} className="mb-1.5" data-testid="chat-message">
              <div className="text-[8.5px] font-semibold" style={{ color: "#3fd0a0" }}>
                {sender}
                <span className="ml-1 font-normal text-acos-fg2">
                  {new Date(message.createdAt).toLocaleTimeString()}
                </span>
              </div>
              <div className="mt-0.5 inline-block max-w-full rounded-md border border-acos-line bg-acos-bg2 px-2 py-1 text-[10.5px] text-acos-fg1">
                {message.body}
              </div>
            </div>
          );
        })}
      </div>
      {selected && (
        <form
          className="flex shrink-0 gap-1.5 border-t border-acos-line p-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim() && !send.isPending) send.mutate();
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Founder olarak yaz…"
            data-testid="chat-input"
            className="min-w-0 flex-1 rounded border border-acos-line bg-acos-bg2 px-2 py-1 text-[10.5px] text-acos-fg0 placeholder:text-acos-fg2 focus:border-dept-engineering focus:outline-none"
          />
          <button
            type="submit"
            disabled={draft.trim() === "" || send.isPending}
            className="shrink-0 rounded px-2 py-1 text-[10px] font-semibold text-white disabled:opacity-40"
            style={{ background: "#a879ff" }}
          >
            Gönder
          </button>
        </form>
      )}
    </div>
  );
}
