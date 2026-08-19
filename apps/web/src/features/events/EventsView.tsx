// Events view — /c/$companyId/events (24 §6.11): filter bar → reverse-
// chronological timeline. "Live" pins to the head via eventTickerStore (WS);
// off = paged REST browsing via the seq-cursor endpoint. Rows expand to the
// raw payload JSON.
import { useMemo, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Button, Card, Input, StatusPill, cn } from "@acos/ui";
import type { Event } from "@acos/contracts";
import { api } from "../../lib/api.js";
import { useEventTicker } from "../../stores/eventTicker.js";
import { useRealtimeStatus } from "../../realtime/RealtimeDispatcher.js";

const ACTOR_TONE = { founder: "accent", agent: "ok", system: "neutral" } as const;

function EventTimelineRow({ event }: { event: Event }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border-b border-acos-line py-1.5 text-sm last:border-0">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-baseline gap-2 text-left"
        data-testid="event-row"
      >
        <span className="w-14 shrink-0 tabular-nums text-xs text-acos-fg2">#{event.seq}</span>
        <time className="shrink-0 tabular-nums text-xs text-acos-fg2">
          {new Date(event.occurredAt).toLocaleTimeString()}
        </time>
        <StatusPill tone={ACTOR_TONE[event.actor.kind]}>{event.actor.kind}</StatusPill>
        <code className="shrink-0 rounded bg-acos-bg2 px-1.5 py-0.5 text-xs text-accent-600">
          {event.type}
        </code>
        <span className="truncate text-xs text-acos-fg2">
          {event.subject.agentId ? `agent ${event.subject.agentId.slice(-6)}` : ""}
        </span>
        <span className={cn("ml-auto text-xs text-acos-fg2", expanded && "rotate-90")}>▸</span>
      </button>
      {expanded && (
        <pre className="mt-1 overflow-x-auto rounded bg-acos-bg1 p-2 text-xs text-acos-fg1">
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function EventsView() {
  const { companyId } = useParams({ from: "/c/$companyId" });
  const [live, setLive] = useState(true);
  const [typeFilter, setTypeFilter] = useState("");
  const status = useRealtimeStatus();
  const ticker = useEventTicker((s) => s.events);

  const types = useMemo(
    () =>
      typeFilter
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    [typeFilter],
  );

  const paged = useInfiniteQuery({
    queryKey: [companyId, "events", "page", { types }],
    queryFn: ({ pageParam }) =>
      api.events.list(companyId, {
        ...(types.length > 0 && { types }),
        limit: 50,
        ...(pageParam !== null && { cursor: pageParam }),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: !live,
  });

  const matchesFilter = (event: Event) =>
    types.length === 0 ||
    types.some((t) => (t.endsWith(".*") ? event.type.startsWith(t.slice(0, -1)) : event.type === t));

  const liveEvents = ticker.filter(matchesFilter);
  const pagedEvents = paged.data?.pages.flatMap((p) => p.items) ?? [];
  const events = live ? liveEvents : pagedEvents;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold text-acos-fg0">Olaylar</h1>
        <StatusPill tone={status === "open" ? "ok" : status === "replaying" ? "accent" : "warn"}>
          ws: {status}
        </StatusPill>
        <div className="ml-auto flex items-center gap-2">
          <Input
            aria-label="Tür filtresi"
            placeholder="türler (virgüllü, önek olur: agent.*)"
            className="!w-72"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
          />
          <Button
            variant={live ? "primary" : "ghost"}
            onClick={() => setLive((v) => !v)}
            data-testid="live-toggle"
          >
            {live ? "● Canlı" : "Sayfalı"}
          </Button>
        </div>
      </div>

      <Card className="p-4">
        {events.length === 0 ? (
          <p className="py-8 text-center text-sm text-acos-fg2">
            {live
              ? "Şirketiniz hareket ettikçe olaylar burada akar."
              : "Filtrelere uyan olay yok."}
          </p>
        ) : (
          <div data-testid="event-timeline">
            {events.map((event) => (
              <EventTimelineRow key={event.id} event={event} />
            ))}
          </div>
        )}
        {!live && paged.hasNextPage && (
          <div className="pt-3 text-center">
            <Button variant="ghost" onClick={() => void paged.fetchNextPage()}>
              Daha eski olayları yükle
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
