// Terminal grid (36 §4 — U05): the Command Center's center "Terminal" tab —
// a tiling grid of live agent terminals, one cell per open terminal_session.
// S/M/L sets the column count (S=2 big, M=4, L=6 dense). Closing a cell only
// detaches the view (the session keeps running server-side; reopen from the
// roster toggle). Output is the REAL sandbox PTY stream — ring replay first,
// then live frames over `terminal:<sessionId>` (T41); read-only here, the
// focus-terminal Founder directive lands in U06.
import { useEffect, useState, type HTMLAttributes, type ReactNode } from "react";
import { useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { cn, presenceColor } from "@acos/ui";
import type { CompanyAgentSession, TerminalSessionDto } from "@acos/contracts";
import { api, keys } from "../../lib/api.js";
import { useTeamMemberSet } from "../../lib/teamFilter.js";
import { usePresence } from "../../stores/presence.js";
import { useFocus } from "../../stores/focus.js";
import { useTerminalGrid, type TerminalDensity } from "../../stores/terminalGrid.js";
import { AgentSessionCell, FounderDirectiveForm, SessionFocusModal } from "./AgentSessionCell.js";
import { pendingRows, type PendingRow } from "./pending.js";
import { GridXterm } from "./GridXterm.js";

const DENSITY_FONT: Record<TerminalDensity, number> = { S: 12, M: 10, L: 9 };
const DENSITY_MIN_H: Record<TerminalDensity, string> = {
  S: "minmax(260px,1fr)",
  M: "minmax(200px,1fr)",
  L: "minmax(150px,1fr)",
};
// Sütun sayısı sabit değil (2026-08-18, Founder geri bildirimi: dar panelde
// hücreler okunmaz oluyordu): yoğunluk MINIMUM hücre genişliğini seçer,
// sütun sayısı panelin gerçek genişliğinden türer (auto-fill). Dar panelde
// tek sütun tüm genişliği kaplar; panel büyüdükçe sütun eklenir.
const DENSITY_MIN_W: Record<TerminalDensity, number> = { S: 460, M: 320, L: 230 };

function DensityChip({ value }: { value: TerminalDensity }) {
  const density = useTerminalGrid((s) => s.density);
  const setDensity = useTerminalGrid((s) => s.setDensity);
  return (
    <button
      data-testid={`density-${value}`}
      onClick={() => setDensity(value)}
      className={cn(
        "rounded border px-1.5 text-[10px]",
        density === value
          ? "border-dept-engineering bg-dept-engineering font-semibold text-acos-bg0"
          : "border-acos-line bg-acos-bg3 text-acos-fg1 hover:text-acos-fg0",
      )}
    >
      {value}
    </button>
  );
}

/** ⤢ modal (36 §4 — U06): the terminal enlarged, live output + a prompt.
 *  The prompt is a Founder→agent directive through the EXISTING comms path
 *  (MessageService: Founder↔agent DM) — persisted, audited, emits
 *  agent.message.sent. It is NOT a write into the agent loop (N4). */
function FocusModal({ session, onClose }: { session: TerminalSessionDto; onClose: () => void }) {
  const { companyId } = useParams({ from: "/c/$companyId" });
  const badges = usePresence((s) => s.badges);
  const badge = session.agentId ? (badges[session.agentId] ?? "IDLE") : "IDLE";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Terminal focus"
      data-testid="focus-terminal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex h-full w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-acos-line bg-acos-bg1">
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-acos-line bg-acos-bg2 px-3 text-[11px]">
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: presenceColor(badge.toLowerCase()) }}
          />
          <span className="font-semibold text-acos-fg0">{session.agentName ?? "—"}</span>
          {session.taskNumber !== null && (
            <span className="text-acos-fg2">TASK-{session.taskNumber}</span>
          )}
          <code className="truncate text-[10px] text-acos-fg2">{session.title}</code>
          <button
            data-testid="focus-close"
            onClick={onClose}
            className="ml-auto text-acos-fg2 hover:text-acos-fg0"
            aria-label="Kapat"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 bg-[#06080b] p-1">
          <GridXterm session={session} fontSize={13} />
        </div>
        <FounderDirectiveForm
          companyId={companyId}
          agentId={session.agentId}
          agentName={session.agentName}
          taskId={session.taskId}
        />
      </div>
    </div>
  );
}

function CellFrame({
  session,
  children,
  onFocus,
  dragHandleProps,
}: {
  session: TerminalSessionDto;
  children: ReactNode;
  onFocus: () => void;
  dragHandleProps?: HTMLAttributes<HTMLDivElement>;
}) {
  const badges = usePresence((s) => s.badges);
  const closeAgent = useTerminalGrid((s) => s.closeAgent);
  const selectedAgentId = useFocus((s) => s.selectedAgentId);
  const setSelectedAgent = useFocus((s) => s.setSelectedAgent);
  const badge = session.agentId ? (badges[session.agentId] ?? "IDLE") : "IDLE";
  const focused = session.agentId !== null && session.agentId === selectedAgentId;

  return (
    <div
      data-testid="terminal-cell"
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-md border bg-[#06080b]",
        focused ? "border-dept-engineering" : "border-acos-line",
      )}
    >
      <div
        className="flex h-[22px] shrink-0 cursor-grab items-center gap-1.5 border-b border-acos-line bg-acos-bg2 px-1.5 text-[9.5px] active:cursor-grabbing"
        {...dragHandleProps}
      >
        <span
          className="h-[5px] w-[5px] shrink-0 rounded-full"
          style={{ background: presenceColor(badge.toLowerCase()) }}
        />
        <button
          className="truncate font-semibold text-acos-fg0 hover:text-dept-engineering"
          onClick={() => session.agentId && setSelectedAgent(focused ? null : session.agentId)}
          title={session.title}
        >
          {session.agentName ?? session.title}
        </button>
        {session.taskNumber !== null && (
          <span className="shrink-0 text-acos-fg2">· TASK-{session.taskNumber}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-acos-fg2">
          <button
            data-testid="cell-focus"
            title="öne çıkar + Founder direktifi"
            onClick={onFocus}
            className="hover:text-acos-fg0"
          >
            ⤢
          </button>
          {session.agentId && (
            <button
              data-testid="cell-close"
              title="görünümü kapat (oturum sürer)"
              onClick={() => closeAgent(session.agentId!)}
              className="hover:text-acos-fg0"
            >
              ✕
            </button>
          )}
        </span>
      </div>
      {children}
    </div>
  );
}

/** Izgaradaki bir hücre: ajan oturumu (Agent Console + varsa Kabuk sekmesi)
 *  ya da bağımsız PTY (canlı ajan oturumu olmayan kabuk). LIVE-CONSOLE
 *  TASK 1: ajanın kabuğu ayrı hücre değil, oturum hücresinin sekmesidir. */
type GridCell =
  | { key: string; kind: "session"; session: CompanyAgentSession; ptys: TerminalSessionDto[] }
  | { key: string; kind: "pty"; session: TerminalSessionDto };

/** Hayalet hücre: ajanın canlı oturumu yok ama açık görevi var. Terminal
 *  göstermez — çünkü GERÇEKTEN akan bir şey yok; uydurma bir konsol çizmek
 *  Founder'ı yanıltırdı. Söylediği tek şey doğru olan şey: kim, hangi işte,
 *  neden ekranda akış yok. */
function PendingCell({ row }: { row: PendingRow }) {
  const tone =
    row.kind === "parked"
      ? "text-[#4cc2ff] border-[#4cc2ff]/40"
      : row.kind === "queued"
        ? "text-acos-fg2 border-acos-line"
        : "text-[#e8c268] border-[#e8c268]/40";
  return (
    <div
      data-testid={`pending-cell-${row.kind}`}
      data-agent-id={row.agentId}
      className="flex min-h-0 flex-col rounded-md border border-dashed border-acos-line bg-acos-bg1/60"
    >
      <div className="flex h-6 shrink-0 items-center gap-1.5 border-b border-acos-line/60 px-2 text-[9.5px]">
        <span className="h-1.5 w-1.5 rounded-full bg-acos-fg2/50" />
        <span className="truncate font-semibold text-acos-fg1">{row.agentName}</span>
        <span className="shrink-0 text-acos-fg2">TASK-{row.taskNumber}</span>
        <span className={cn("ml-auto shrink-0 rounded-full border px-1.5 text-[8.5px] font-semibold", tone)}>
          {row.kind === "parked" ? "beklemede" : row.kind === "queued" ? "sırada" : "kopuk"}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col justify-center gap-1 px-3 text-[10px]">
        <p className="truncate text-acos-fg1">{row.taskTitle}</p>
        <p className={cn("text-[9.5px]", tone.split(" ")[0])} data-testid="pending-reason">
          {row.kind === "parked" ? "⏸ " : row.kind === "queued" ? "⋯ " : "⚠ "}
          {row.label}
        </p>
      </div>
    </div>
  );
}

export function TerminalGrid() {
  const { companyId } = useParams({ from: "/c/$companyId" });
  const density = useTerminalGrid((s) => s.density);
  const closedAgentIds = useTerminalGrid((s) => s.closedAgentIds);
  const openAll = useTerminalGrid((s) => s.openAll);
  const order = useTerminalGrid((s) => s.order);
  const setOrder = useTerminalGrid((s) => s.setOrder);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [focusedSessionId, setFocusedSessionId] = useState<string | null>(null);
  // sürükle-bırak durumu (U05+): tutamaç başlıktır, bırakma hedefi hücredir
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);

  const sessions = useQuery({
    queryKey: [companyId, "terminals"],
    queryFn: () => api.terminals.list(companyId, { limit: 100 }),
    refetchInterval: 10_000,
  });
  // Ajan oturum hücreleri (2026-08-18): görev alan HER ajan — CEO dahil —
  // burada bir "düşünce terminali" açar. Poll yedek; asıl tazeleme
  // agent.step.recorded / agent.session.* WS invalidation'ından gelir.
  const agentSessions = useQuery({
    queryKey: [companyId, "agent-sessions"],
    queryFn: () => api.agents.companySessions(companyId, { limit: 50 }),
    refetchInterval: 10_000,
  });

  // SIRADAKİLER (2026-08-21): canlı oturum tavanı dolduğunda görev almış ama
  // oturumu açılmamış ajanlar ızgaradan TAMAMEN kayboluyordu. Aynı iki
  // sorgunun cache'i görev panosu/roster ile paylaşılır (ek yük yok).
  const boardTasks = useQuery({
    queryKey: [companyId, "tasks", "board"],
    queryFn: () => api.tasks.list(companyId, {}),
    refetchInterval: 15_000,
  });
  const roster = useQuery({
    queryKey: keys.agents(companyId),
    queryFn: () => api.agents.list(companyId),
  });

  const { team, members } = useTeamMemberSet(companyId);
  const active = (sessions.data?.items ?? []).filter(
    (s) =>
      s.status === "active" &&
      (members === null || (s.agentId !== null && members.has(s.agentId))),
  );
  const open = active.filter((s) => !s.agentId || !closedAgentIds.includes(s.agentId));
  const visibleSessions = (agentSessions.data ?? []).filter(
    (s) => members === null || members.has(s.agentId),
  );
  const openSessions = visibleSessions.filter((s) => !closedAgentIds.includes(s.agentId));
  const hiddenCount =
    active.length - open.length + (visibleSessions.length - openSessions.length);
  const agentNames = new Map(
    (roster.data ?? []).map((a) => [a.id, a.name] as const),
  );
  const pending = pendingRows(boardTasks.data ?? [], visibleSessions, agentNames).filter(
    (row) => members === null || members.has(row.agentId),
  );
  const focused = focusedId ? (active.find((s) => s.id === focusedId) ?? null) : null;
  const focusedSession = focusedSessionId
    ? (visibleSessions.find((s) => s.id === focusedSessionId) ?? null)
    : null;

  // TASK 1 (Console ≠ Shell): canlı ajan oturumu olan ajanın PTY'leri kendi
  // oturum hücresinin "Kabuk" sekmesine bağlanır — CEO gibi kabuğu olmayan
  // ajanlarda hücre yalnız Console gösterir. Sahipsiz/oturumsuz PTY'ler
  // bağımsız hücre olarak kalır.
  const sessionAgentIds = new Set(openSessions.map((s) => s.agentId));
  const ptyByAgent = new Map<string, TerminalSessionDto[]>();
  for (const pty of open) {
    if (pty.agentId && sessionAgentIds.has(pty.agentId)) {
      ptyByAgent.set(pty.agentId, [...(ptyByAgent.get(pty.agentId) ?? []), pty]);
    }
  }
  const standalonePtys = open.filter((p) => !p.agentId || !sessionAgentIds.has(p.agentId));
  // Birleşik hücre listesi: oturumlar + bağımsız PTY'ler, kalıcı sıraya göre.
  // Sırada kaydı olmayan hücreler doğal sırayla sona düşer (stable sort).
  const cells: GridCell[] = [
    ...openSessions.map((s) => ({
      key: `sess:${s.agentId}`,
      kind: "session" as const,
      session: s,
      ptys: ptyByAgent.get(s.agentId) ?? [],
    })),
    ...standalonePtys.map((s) => ({ key: `pty:${s.id}`, kind: "pty" as const, session: s })),
  ];
  const orderPos = new Map(order.map((k, i) => [k, i] as const));
  cells.sort(
    (a, b) => (orderPos.get(a.key) ?? Number.MAX_SAFE_INTEGER) - (orderPos.get(b.key) ?? Number.MAX_SAFE_INTEGER),
  );

  /** Başlık tutamacı: hücreyi sürüklenebilir yapar. */
  const handleFor = (key: string): HTMLAttributes<HTMLDivElement> => ({
    draggable: true,
    onDragStart: (e) => {
      setDragKey(key);
      e.dataTransfer.setData("text/plain", key);
      e.dataTransfer.effectAllowed = "move";
    },
    onDragEnd: () => {
      setDragKey(null);
      setOverKey(null);
    },
  });

  /** Bırakma: sürüklenen hücre, hedefin konumuna girer (hedef sağa kayar). */
  const dropOn = (targetKey: string | null) => {
    if (!dragKey || dragKey === targetKey) return;
    const keys = cells.map((c) => c.key).filter((k) => k !== dragKey);
    const at = targetKey ? keys.indexOf(targetKey) : -1;
    if (at === -1) keys.push(dragKey);
    else keys.splice(at, 0, dragKey);
    setOrder(keys);
    setDragKey(null);
    setOverKey(null);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-acos-bg1">
      <div className="flex h-6 shrink-0 items-center gap-1.5 border-b border-acos-line px-2 text-[9.5px] text-acos-fg2">
        <span>
          {openSessions.length} oturum · {open.length} terminal
          {pending.length > 0 && (
            <span data-testid="pending-count"> · {pending.length} sırada</span>
          )}
          {hiddenCount > 0 && ` · ${hiddenCount} gizli`}
          {team && <span className="text-dept-engineering"> · filtre: {team.name}</span>}
        </span>
        {/*
          Salt-okunur olduğu YAZILI olmalı. Founder bir komut istemi görüp
          yazamayınca (canlı örnek: corepack "[Y/n]" sorusu) doğal tepki
          "neden yazamıyorum" oluyor; bu pencere ajanın terminaline BAKAR,
          onu sürmez. Bunu keşfettirmek yerine söylemek gerekiyor.
        */}
        <span className="text-acos-fg2/70" title="Ajanların terminaline bakan pencere — komut girilmez">
          · salt okunur
        </span>
        {hiddenCount > 0 && (
          <button
            data-testid="terminal-open-all"
            onClick={openAll}
            className="text-dept-engineering hover:underline"
          >
            hepsini aç
          </button>
        )}
        <span className="ml-auto">yoğunluk:</span>
        <DensityChip value="S" />
        <DensityChip value="M" />
        <DensityChip value="L" />
      </div>
      {open.length === 0 && openSessions.length === 0 && pending.length === 0 ? (
        <div
          className="flex flex-1 items-center justify-center text-[11px] text-acos-fg2"
          data-testid="terminal-grid-empty"
        >
          {active.length === 0 && visibleSessions.length === 0
            ? "Açık oturum yok — bir ajana görev verildiğinde düşünce ve aksiyon akışı burada belirir."
            : "Tüm hücreler gizli — roster'dan ya da 'hepsini aç' ile geri aç."}
        </div>
      ) : (
        <div
          data-testid="terminal-grid"
          className="grid min-h-0 flex-1 gap-1 overflow-auto p-1"
          style={{
            gridTemplateColumns: `repeat(auto-fill, minmax(min(${DENSITY_MIN_W[density]}px, 100%), 1fr))`,
            gridAutoRows: DENSITY_MIN_H[density],
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            // boşluğa bırakma = sona taşı
            e.preventDefault();
            dropOn(null);
          }}
        >
          {/* Ajan oturumları (düşünce terminali) + PTY'ler (kabuk) tek sıralı
              listede; başlığından sürükleyip herhangi bir hücrenin üstüne
              bırakınca o konuma taşınır (sıra kalıcı, U05+). */}
          {cells.map((cell) => (
            <div
              key={cell.key}
              className={cn(
                "flex min-h-0 rounded-md [&>*]:min-w-0 [&>*]:flex-1",
                overKey === cell.key && dragKey && dragKey !== cell.key
                  ? "ring-2 ring-dept-engineering"
                  : "",
                dragKey === cell.key ? "opacity-50" : "",
              )}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setOverKey(cell.key);
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                dropOn(cell.key);
              }}
            >
              {cell.kind === "session" ? (
                <AgentSessionCell
                  companyId={companyId}
                  session={cell.session}
                  ptySessions={cell.ptys}
                  fontSize={DENSITY_FONT[density]}
                  onFocus={() => setFocusedSessionId(cell.session.id)}
                  onFocusShell={(pty) => setFocusedId(pty.id)}
                  dragHandleProps={handleFor(cell.key)}
                />
              ) : (
                <CellFrame
                  session={cell.session}
                  onFocus={() => setFocusedId(cell.session.id)}
                  dragHandleProps={handleFor(cell.key)}
                >
                  {/* while focused, the cell releases its topic subscription so the
                      modal's fresh subscribe gets the full ring replay (refcount) */}
                  {focused?.id === cell.session.id ? (
                    <div className="flex flex-1 items-center justify-center text-[10px] text-acos-fg2">
                      öne çıkarıldı ⤢
                    </div>
                  ) : (
                    <GridXterm session={cell.session} fontSize={DENSITY_FONT[density]} />
                  )}
                </CellFrame>
              )}
            </div>
          ))}
          {/* Sıradakiler her zaman SONDA: canlı hücreler öne çıksın, ama
              dördüncü ajan da ekranda kalsın (tavan dolu ≠ ajan yok). */}
          {pending.map((row) => (
            <PendingCell key={`pending:${row.agentId}`} row={row} />
          ))}
        </div>
      )}
      {focused && <FocusModal session={focused} onClose={() => setFocusedId(null)} />}
      {focusedSession && (
        <SessionFocusModal
          companyId={companyId}
          session={focusedSession}
          onClose={() => setFocusedSessionId(null)}
        />
      )}
    </div>
  );
}
