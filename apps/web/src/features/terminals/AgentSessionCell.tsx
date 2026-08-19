// Ajan oturum hücresi (2026-08-18): ana sayfadaki terminal ızgarasının
// "düşünce terminali" — görev alan HER ajan (CEO dahil) için bir hücre.
// PTY hücresi ajanın kabuğuna bakar; bu hücre ajan DÖNGÜSÜNE bakar:
// agent_steps read-model'inden düşünce → araç çağrısı → gözlem akışı,
// Claude Code oturumu gibi kronolojik ve canlı (WS invalidation + poll).
// Salt-okunur; Founder müdahalesi ⤢ modalındaki direktif formundan (DM yolu).
import { useEffect, useMemo, useRef, useState, type HTMLAttributes } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { cn, presenceColor } from "@acos/ui";
import type { AgentStep, CompanyAgentSession, TerminalSessionDto } from "@acos/contracts";
import { api, queryClient } from "../../lib/api.js";
import { getRealtimeClient } from "../../realtime/client.js";
import { usePresence } from "../../stores/presence.js";
import { useFocus } from "../../stores/focus.js";
import { useTerminalGrid } from "../../stores/terminalGrid.js";
import { GridXterm } from "./GridXterm.js";

const SESSION_LIVE = new Set(["starting", "running", "waiting"]);

/** 128400 → "128.4k" — ekran görüntüsündeki jeton sayacı biçimi. */
function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** 442sn → "7dk 22sn" */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}dk ${s}sn` : `${s}sn`;
}

function compact(value: unknown, max = 220): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

interface StepLine {
  icon: string;
  tone: string; // tailwind text sınıfı
  title: string;
  body?: string;
  obs?: { ok: boolean; text: string };
}

/** Bir agent_steps satırı → terminal satırı. Kind listesi şemadaki CHECK'i izler. */
function describeStep(step: AgentStep): StepLine {
  const action = (step.action ?? {}) as Record<string, unknown>;
  const obsRaw = step.observation as Record<string, unknown> | null;
  const obs =
    obsRaw && typeof obsRaw === "object"
      ? {
          ok: obsRaw.ok !== false && obsRaw.error === undefined,
          text: compact(obsRaw.error ?? obsRaw.summary ?? obsRaw.result ?? obsRaw, 200),
        }
      : undefined;
  // think, şema CHECK'i gereği record_decision altında saklanır (kayıtlı sapma)
  if (action.type === "think") {
    const plan = Array.isArray(action.plan) ? ` · plan: ${compact(action.plan, 120)}` : "";
    return {
      icon: "✻",
      tone: "text-[#a879ff]",
      title: "düşünüyor",
      body: `${compact(action.thought, 600)}${plan}`,
    };
  }
  switch (step.actionKind) {
    case "use_tool":
      return {
        icon: "▶",
        tone: "text-[#4cc2ff]",
        title: String(action.tool ?? "araç"),
        body: [compact(action.input), action.reason ? `— ${compact(action.reason, 160)}` : ""]
          .filter(Boolean)
          .join(" "),
        ...(obs ? { obs } : {}),
      };
    case "send_message":
      return { icon: "✉", tone: "text-[#e8c268]", title: "mesaj", body: compact(action.body ?? action.content, 300) };
    case "create_task":
      return { icon: "＋", tone: "text-[#3fd0a0]", title: "görev oluşturdu", body: compact(action.title ?? action.tasks, 300) };
    case "delegate_task":
      return { icon: "⤷", tone: "text-[#3fd0a0]", title: "delege etti", body: compact(action.title ?? action, 300) };
    case "update_task_status":
      return { icon: "◇", tone: "text-acos-fg1", title: "durum", body: compact(action, 160) };
    case "request_review":
      return { icon: "☑", tone: "text-[#e8c268]", title: "inceleme istedi", body: compact(action.reason ?? action, 200) };
    case "request_help":
      return { icon: "？", tone: "text-[#e8c268]", title: "yardım istedi", body: compact(action.reason ?? action, 200) };
    case "escalate":
      return { icon: "⚠", tone: "text-[#ff6b8a]", title: "eskalasyon", body: compact(action.reason ?? action, 300) };
    case "record_decision":
      return { icon: "✻", tone: "text-[#a879ff]", title: "karar", body: compact(action, 300) };
    case "complete_task":
      return { icon: "✔", tone: "text-[#2ec26a]", title: "görevi tamamladı", body: compact(action.summary ?? action, 300) };
    case "wait_for":
      return { icon: "⏸", tone: "text-acos-fg2", title: "bekliyor", body: compact(action, 200) };
    case "abandon":
      return { icon: "✕", tone: "text-[#ff6b8a]", title: "bıraktı", body: compact(action.reason ?? action, 300) };
    default:
      return { icon: "·", tone: "text-acos-fg1", title: step.actionKind, body: compact(action, 200) };
  }
}

// ---- LIVE-CONSOLE TASK 2/3: canlı runtime lifecycle akışı ------------------
// runtime:<companyId> WS topic'inden gelen structured olaylar (context/llm/
// tool/wait/approval) persisted adımların ALTINA geçici satırlar olarak düşer;
// yeni adım context.build.started ile başlayınca tampon sıfırlanır. Aktif
// operation (llm/tool) saniyelik elapsed sayacıyla, heartbeat kesilirse ⏳
// uyarısıyla gösterilir. Chain-of-thought yok — yalnız lifecycle/progress.

interface RuntimeEvt {
  type: string;
  sessionId: string | null;
  taskId: string | null;
  opId: string | null;
  ts: number;
  payload: Record<string, unknown>;
}

interface ConsoleLine {
  key: string;
  icon: string;
  tone: string;
  text: string;
}

interface ActiveOp {
  opId: string;
  label: string;
  startedAt: number;
  lastBeatAt: number;
}

interface LlmContextTelemetry {
  estTotalTokens?: number;
  memoryTokens?: number;
  codeIndexTokens?: number;
  recentStepTokens?: number;
}

const HEARTBEAT_STALL_MS = 3 * 60_000;

function useSessionRuntime(companyId: string, session: CompanyAgentSession, enabled: boolean) {
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [activeOp, setActiveOp] = useState<ActiveOp | null>(null);
  const [lastModel, setLastModel] = useState<{
    latencyMs: number;
    context: LlmContextTelemetry | null;
  } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const client = getRealtimeClient();
    const push = (line: ConsoleLine) => setLines((prev) => [...prev.slice(-39), line]);
    const unsubscribe = client.subscribe(`runtime:${companyId}`, (events) => {
      for (const raw of events) {
        const evt = raw as RuntimeEvt;
        if (!evt || typeof evt.type !== "string") continue;
        // approval.* gibi sunucu kaynaklı olaylar sessionId bilmez → taskId eşle
        const mine =
          evt.sessionId === session.id ||
          (evt.sessionId === null && evt.taskId !== null && evt.taskId === session.taskId);
        if (!mine) continue;
        const p = evt.payload ?? {};
        switch (evt.type) {
          case "context.build.started":
            // yeni adım = taze tampon (önceki adımın geçici satırları düşer;
            // kalıcı kaydı zaten agent_steps satırı olarak feed'de)
            setLines([
              { key: `${evt.ts}-ctx`, icon: "◌", tone: "text-acos-fg2", text: "Context hazırlanıyor" },
            ]);
            break;
          case "context.build.completed": {
            const est = typeof p.estTotalTokens === "number" ? p.estTotalTokens : null;
            push({
              key: `${evt.ts}-ctxdone`,
              icon: "✓",
              tone: "text-acos-fg2",
              text: est !== null ? `${formatTokens(est)} token context hazır` : "context hazır",
            });
            break;
          }
          case "llm.started":
            setActiveOp({
              opId: evt.opId ?? "llm",
              label: "Model yanıtı bekleniyor",
              startedAt: evt.ts,
              lastBeatAt: evt.ts,
            });
            break;
          case "tool.started":
            setActiveOp({
              opId: evt.opId ?? "tool",
              label: `Araç çalışıyor: ${String(p.tool ?? "?")}`,
              startedAt: evt.ts,
              lastBeatAt: evt.ts,
            });
            break;
          case "op.heartbeat":
            setActiveOp((op) => (op && op.opId === evt.opId ? { ...op, lastBeatAt: evt.ts } : op));
            break;
          case "llm.completed": {
            setActiveOp((op) => (op && op.opId === evt.opId ? null : op));
            const latency = typeof p.latencyMs === "number" ? p.latencyMs : 0;
            setLastModel({
              latencyMs: latency,
              context: (p.context as LlmContextTelemetry | undefined) ?? null,
            });
            push({
              key: `${evt.ts}-llm`,
              icon: "✓",
              tone: "text-acos-fg2",
              text: `Model yanıtı · ${(latency / 1000).toFixed(1)}sn`,
            });
            break;
          }
          case "action.selected":
            push({
              key: `${evt.ts}-action`,
              icon: "✓",
              tone: "text-[#4cc2ff]",
              text: `Action: ${String(p.actionType ?? "?")}${p.tool ? ` · ${String(p.tool)}` : ""}`,
            });
            break;
          case "tool.output":
            // aynı operasyonun önceki kuyruğu değişir — tek dim satır kalır
            setLines((prev) => [
              ...prev.filter((l) => l.key !== `out-${evt.opId}`).slice(-39),
              {
                key: `out-${evt.opId}`,
                icon: "…",
                tone: "text-acos-fg2/70",
                text: String(p.tail ?? "").slice(-160),
              },
            ]);
            break;
          case "tool.completed":
            setActiveOp((op) => (op && op.opId === evt.opId ? null : op));
            push({
              key: `${evt.ts}-tool`,
              icon: p.ok !== false ? "✓" : "✗",
              tone: p.ok !== false ? "text-[#2ec26a]" : "text-[#ff6b8a]",
              text: `${String(p.tool ?? "araç")}${typeof p.exitCode === "number" ? ` · exit ${p.exitCode}` : ""}`,
            });
            break;
          case "task.created":
            push({
              key: `${evt.ts}-task`,
              icon: "＋",
              tone: "text-[#3fd0a0]",
              text: `Görev oluşturuldu: ${String(p.title ?? p.taskId ?? "")}`.slice(0, 160),
            });
            break;
          case "task.delegated":
            push({
              key: `${evt.ts}-deleg`,
              icon: "⤷",
              tone: "text-[#3fd0a0]",
              text: "Görev delege edildi",
            });
            break;
          case "approval.requested":
            push({
              key: `${evt.ts}-apr`,
              icon: "🔔",
              tone: "text-[#e8c268]",
              text: `Founder onayı istendi: ${String(p.title ?? "")}`.slice(0, 160),
            });
            break;
          case "approval.received": {
            const verdict = String(p.verdict ?? "");
            const approved = verdict === "approved";
            push({
              key: `${evt.ts}-verdict`,
              icon: approved ? "✓" : "✕",
              tone: approved ? "text-[#2ec26a]" : "text-[#ff6b8a]",
              text: `Founder kararı: ${verdict}${p.note ? ` — ${String(p.note)}` : ""}`.slice(0, 200),
            });
            break;
          }
          case "wait.started":
            push(
              p.alreadyResolved === true
                ? {
                    key: `${evt.ts}-wait`,
                    icon: "✓",
                    tone: "text-[#2ec26a]",
                    text: `Onay zaten kararlaşmış (${String(p.verdict ?? "")}) — bekleme atlandı`,
                  }
                : {
                    key: `${evt.ts}-wait`,
                    icon: "⏸",
                    tone: "text-acos-fg2",
                    text: `Bekleniyor: ${String(p.what ?? "sinyal")}`,
                  },
            );
            break;
          case "wait.completed":
            push({
              key: `${evt.ts}-woke`,
              icon: "▶",
              tone: "text-[#4cc2ff]",
              text: "Bekleyiş bitti — devam ediyor",
            });
            break;
          default:
            break; // agent.status vb. — durum satırı oturum poll'undan gelir
        }
      }
    });
    return () => {
      unsubscribe();
      setActiveOp(null);
      setLines([]);
    };
  }, [companyId, session.id, session.taskId, enabled]);

  return { lines, activeOp, lastModel };
}

/** Kronolojik düşünce/aksiyon akışı — altta kalmayı kollar (auto-follow). */
export function SessionFeed({
  companyId,
  session,
  fontSize,
}: {
  companyId: string;
  session: CompanyAgentSession;
  fontSize: number;
}) {
  const live = SESSION_LIVE.has(session.status);
  const steps = useQuery({
    // AgentDetailView'in [cid,"agents",agentId,"steps"] önekini paylaşır —
    // agent.step.recorded invalidation'ı ikisini birden tazeler.
    queryKey: [companyId, "agents", session.agentId, "steps", session.id],
    queryFn: () => api.agents.steps(companyId, session.agentId, { sessionId: session.id, limit: 200 }),
    refetchInterval: live ? 4000 : false,
  });
  const ordered = useMemo(() => [...(steps.data ?? [])].reverse(), [steps.data]);
  const totalTokens = useMemo(
    () => ordered.reduce((sum, s) => sum + s.tokensIn + s.tokensOut, 0),
    [ordered],
  );
  // TASK 2/3: canlı lifecycle satırları + aktif operation sayacı
  const { lines: runtimeLines, activeOp, lastModel } = useSessionRuntime(companyId, session, live);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  useEffect(() => {
    const host = hostRef.current;
    if (host && followRef.current) host.scrollTop = host.scrollHeight;
  }, [ordered.length, runtimeLines.length]);

  // ✳ durum satırındaki süre sayacı — yalnız canlı oturumda saniyede bir işler
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [live]);
  const elapsedMs =
    (session.endedAt ? new Date(session.endedAt).getTime() : Date.now()) -
    new Date(session.startedAt).getTime();
  // Takılma sinyali: canlı görünen oturumda son adımın üzerinden 3+ dk geçtiyse
  // "Çalışıyor" demek yalan olur — sarı ⏳ satırına düşülür.
  const lastStep = ordered.length > 0 ? ordered[ordered.length - 1]! : null;
  const lastStepAt = lastStep ? new Date(lastStep.createdAt).getTime() : null;
  const sinceLastStepMs = Date.now() - (lastStepAt ?? new Date(session.startedAt).getTime());
  const stalled = live && sinceLastStepMs > 3 * 60_000 && activeOp === null;
  // TASK 3: aktif operation'ın heartbeat'i kesildiyse "çalışıyor" diyemeyiz
  const beatStalledMs = activeOp ? Date.now() - activeOp.lastBeatAt : 0;
  const beatStalled = activeOp !== null && beatStalledMs > HEARTBEAT_STALL_MS;
  // Bilinen bekleme türleri: takılma değil, adı konmuş bekleyiş — Founder ne
  // olduğunu (ve gerekiyorsa NE YAPACAĞINI) durum satırında görür.
  const lastAction = (lastStep?.action ?? {}) as Record<string, unknown>;
  const knownWait =
    !live || !lastStep
      ? null
      : lastStep.actionKind === "wait_for"
        ? `⏸ Bekliyor: ${String(lastAction.what ?? "sinyal")} (${formatElapsed(sinceLastStepMs)})`
        : lastStep.actionKind === "escalate" && stalled
          ? "🔔 Founder kararı bekliyor — Onaylar sekmesine bak"
          : lastStep.actionKind === "delegate_task" && stalled
            ? `⤷ Alt görev sürüyor (${formatElapsed(sinceLastStepMs)})`
            : null;

  return (
    <div
      ref={hostRef}
      data-testid="session-feed"
      onScroll={(e) => {
        const el = e.currentTarget;
        followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      className="min-h-0 flex-1 overflow-y-auto bg-[#06080b] px-2 py-1.5 font-mono"
      style={{ fontSize }}
    >
      {ordered.length === 0 ? (
        <p className="text-acos-fg2">
          {live ? "oturum başladı — ilk adım bekleniyor…" : "bu oturumda kayıtlı adım yok"}
        </p>
      ) : (
        ordered.map((step) => {
          const line = describeStep(step);
          return (
            <div key={`${step.agentSessionId}-${step.stepNo}`} className="mb-1.5 leading-snug">
              <div className="flex items-baseline gap-1.5">
                <span className={cn("shrink-0", line.tone)}>{line.icon}</span>
                <span className={cn("shrink-0 font-semibold", line.tone)}>{line.title}</span>
                <span className="ml-auto shrink-0 tabular-nums text-[0.8em] text-acos-fg2/70">
                  {step.tokensIn + step.tokensOut > 0 && `${step.tokensIn + step.tokensOut}t · `}
                  {new Date(step.createdAt).toLocaleTimeString()}
                </span>
              </div>
              {line.body && (
                <p className="whitespace-pre-wrap break-words pl-4 text-acos-fg1">{line.body}</p>
              )}
              {line.obs && (
                <p className={cn("break-words pl-4", line.obs.ok ? "text-[#2ec26a]" : "text-[#ff6b8a]")}>
                  {line.obs.ok ? "✓" : "✗"} {line.obs.text}
                </p>
              )}
            </div>
          );
        })
      )}
      {/* TASK 2: canlı lifecycle satırları — persisted adımların altına düşer,
          yeni adım başlayınca (context.build.started) tampon sıfırlanır */}
      {live &&
        runtimeLines.map((line) => (
          <div key={line.key} className="flex items-baseline gap-1.5 leading-snug" data-testid="runtime-line">
            <span className={cn("shrink-0", line.tone)}>{line.icon}</span>
            <span className={cn("truncate", line.tone)}>{line.text}</span>
          </div>
        ))}
      {/* TASK 3: aktif operation — saniyelik elapsed; heartbeat kesilirse ⏳ */}
      {live && activeOp && (
        <p
          className={cn("mt-0.5", beatStalled ? "text-[#e8c268]" : "animate-pulse text-[#4cc2ff]")}
          data-testid="active-operation"
        >
          {beatStalled
            ? `⏳ ${Math.floor(beatStalledMs / 60_000)}dk yeni heartbeat yok — ${activeOp.label}`
            : `◌ ${activeOp.label} · ${formatElapsed(Date.now() - activeOp.startedAt)}`}
        </p>
      )}
      {/* ✳ durum satırı: GERÇEK ilerlemeyi yansıtır (Founder geri bildirimi,
          2026-08-18: oturum saatlerce adımsız kalırken "Çalışıyor" demek
          yanıltıcıydı). Ölçü, oturum yaşı değil SON ADIMIN yaşıdır. */}
      <p
        className={cn(
          "mt-1",
          !live
            ? "text-acos-fg2/70"
            : knownWait
              ? "text-[#4cc2ff]"
              : stalled
                ? "text-[#e8c268]"
                : "animate-pulse text-[#a879ff]",
        )}
        data-testid="session-live-cursor"
      >
        {!live
          ? `${session.status === "completed" ? "✔ Tamamlandı" : "✕ Bitti"} — ${formatElapsed(elapsedMs)}`
          : (knownWait ??
            (stalled
              ? `⏳ ${formatElapsed(sinceLastStepMs)} oldu, yeni adım yok (${session.currentActivity}) — toplam ${formatElapsed(elapsedMs)}`
              : `✳ Çalışıyor — ${formatElapsed(elapsedMs)}`))}
        {totalTokens > 0 && ` · ${formatTokens(totalTokens)} jeton`}
      </p>
      {/* TASK 7: kısa telemetri — hangi bölüm context'i büyütüyor + model süresi */}
      {live && lastModel?.context && (
        <p className="text-[0.85em] text-acos-fg2/70" data-testid="context-telemetry">
          {[
            typeof lastModel.context.estTotalTokens === "number" &&
              `Context ${formatTokens(lastModel.context.estTotalTokens)}`,
            typeof lastModel.context.memoryTokens === "number" &&
              `Memory ${formatTokens(lastModel.context.memoryTokens)}`,
            typeof lastModel.context.codeIndexTokens === "number" &&
              `Kod ${formatTokens(lastModel.context.codeIndexTokens)}`,
            typeof lastModel.context.recentStepTokens === "number" &&
              `Adımlar ${formatTokens(lastModel.context.recentStepTokens)}`,
            `Model ${(lastModel.latencyMs / 1000).toFixed(1)}sn`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
    </div>
  );
}

/** Founder → ajan direktifi — MEVCUT comms yolu (DM; denetlenebilir, N4). */
export function FounderDirectiveForm({
  companyId,
  agentId,
  agentName,
  taskId,
}: {
  companyId: string;
  agentId: string | null;
  agentName: string | null;
  taskId: string | null;
}) {
  const [draft, setDraft] = useState("");
  const [sentNote, setSentNote] = useState<string | null>(null);
  const directive = useMutation({
    mutationFn: async (body: string) => {
      const channel = await api.comms.openDm(companyId, agentId!);
      return api.comms.send(companyId, channel.id, {
        body,
        ...(taskId ? { refs: [{ kind: "task", id: taskId }] } : {}),
      });
    },
    onSuccess: () => {
      setDraft("");
      setSentNote("Direktif gönderildi — Founder→ajan DM'i olarak kaydedildi (denetlenebilir).");
      void queryClient.invalidateQueries({ queryKey: [companyId, "channels"] });
    },
  });

  return (
    <>
      <form
        className="flex shrink-0 items-center gap-2 border-t border-acos-line bg-acos-bg2 px-3 py-2"
        onSubmit={(e) => {
          e.preventDefault();
          const body = draft.trim();
          if (body && agentId && !directive.isPending) directive.mutate(body);
        }}
      >
        <input
          data-testid="directive-input"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setSentNote(null);
          }}
          placeholder={
            agentId
              ? `${agentName ?? "ajan"}'a Founder direktifi… (DM olarak iletilir)`
              : "bu oturuma bağlı ajan yok"
          }
          disabled={!agentId || directive.isPending}
          className="min-w-0 flex-1 rounded-md border border-acos-line bg-acos-bg1 px-2.5 py-1.5 font-mono text-[12px] text-acos-fg0 placeholder:text-acos-fg2 focus:border-dept-engineering focus:outline-none"
        />
        <button
          type="submit"
          data-testid="directive-send"
          disabled={!agentId || draft.trim() === "" || directive.isPending}
          className="shrink-0 rounded-md px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-40"
          style={{ background: "#a879ff" }}
        >
          {directive.isPending ? "Gönderiliyor…" : "Direktif Gönder"}
        </button>
      </form>
      {(sentNote ?? directive.error) && (
        <div
          className="shrink-0 border-t border-acos-line px-3 py-1 text-[10px]"
          style={{ color: directive.error ? "#ff6b8a" : "#3fd0a0" }}
          data-testid="directive-status"
        >
          {directive.error ? `Gönderilemedi: ${String(directive.error)}` : sentNote}
        </div>
      )}
    </>
  );
}

const STATUS_LABEL: Record<string, string> = {
  starting: "başlıyor",
  running: "çalışıyor",
  waiting: "bekliyor",
  completed: "tamamlandı",
  failed: "başarısız",
  cancelled: "iptal",
};

function SessionBadge({ status }: { status: string }) {
  const live = SESSION_LIVE.has(status);
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border px-1.5 text-[8.5px] font-semibold",
        live
          ? "border-[#a879ff]/60 text-[#a879ff]"
          : status === "completed"
            ? "border-[#2ec26a]/60 text-[#2ec26a]"
            : "border-acos-line text-acos-fg2",
      )}
    >
      oturum · {STATUS_LABEL[status] ?? status}
    </span>
  );
}

/** ⤢ modal: oturum akışı büyütülmüş + Founder direktif formu. */
export function SessionFocusModal({
  companyId,
  session,
  onClose,
}: {
  companyId: string;
  session: CompanyAgentSession;
  onClose: () => void;
}) {
  const badges = usePresence((s) => s.badges);
  const badge = badges[session.agentId] ?? "IDLE";

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
      aria-label="Oturum focus"
      data-testid="focus-session"
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
          <SessionBadge status={session.status} />
          {session.taskTitle && (
            <code className="truncate text-[10px] text-acos-fg2">{session.taskTitle}</code>
          )}
          <button
            data-testid="focus-close"
            onClick={onClose}
            className="ml-auto text-acos-fg2 hover:text-acos-fg0"
            aria-label="Kapat"
          >
            ✕
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col bg-[#06080b] p-1">
          <SessionFeed companyId={companyId} session={session} fontSize={13} />
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

/** Izgara hücresi: başlık (ajan · görev · durum) + gövde.
 *  LIVE-CONSOLE TASK 1 (Agent Console ≠ Shell): gövde iki ayrı görünümdür —
 *  "Konsol" reasoning lifecycle + tool/approval/event akışı (SessionFeed),
 *  "Kabuk" yalnız gerçek PTY (GridXterm). Kabuk sekmesi ancak ajanın canlı
 *  terminal oturumu varsa görünür — CEO gibi kabuksuz ajanlarda hücre salt
 *  Konsol'dur. Başlık aynı zamanda sürükleme tutamacıdır (U05+ drag&drop). */
export function AgentSessionCell({
  companyId,
  session,
  ptySessions = [],
  fontSize,
  onFocus,
  onFocusShell,
  dragHandleProps,
}: {
  companyId: string;
  session: CompanyAgentSession;
  ptySessions?: TerminalSessionDto[];
  fontSize: number;
  onFocus: () => void;
  onFocusShell?: (pty: TerminalSessionDto) => void;
  dragHandleProps?: HTMLAttributes<HTMLDivElement>;
}) {
  const badges = usePresence((s) => s.badges);
  const closeAgent = useTerminalGrid((s) => s.closeAgent);
  const selectedAgentId = useFocus((s) => s.selectedAgentId);
  const setSelectedAgent = useFocus((s) => s.setSelectedAgent);
  const badge = badges[session.agentId] ?? "IDLE";
  const focused = session.agentId === selectedAgentId;
  const [tab, setTab] = useState<"console" | "shell">("console");
  const shellPty = ptySessions[0] ?? null;
  const shellActive = tab === "shell" && shellPty !== null;

  return (
    <div
      data-testid="session-cell"
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
          onClick={() => setSelectedAgent(focused ? null : session.agentId)}
          title={session.taskTitle ?? session.workflowId}
        >
          {session.agentName ?? "ajan"}
        </button>
        {session.taskNumber !== null && (
          <span className="shrink-0 text-acos-fg2">· TASK-{session.taskNumber}</span>
        )}
        <SessionBadge status={session.status} />
        {shellPty && (
          <span className="flex shrink-0 items-center gap-0.5" data-testid="cell-tabs">
            <button
              data-testid="tab-console"
              onClick={() => setTab("console")}
              className={cn(
                "rounded px-1 text-[8.5px] font-semibold",
                tab === "console"
                  ? "bg-dept-engineering text-acos-bg0"
                  : "text-acos-fg2 hover:text-acos-fg0",
              )}
            >
              Konsol
            </button>
            <button
              data-testid="tab-shell"
              onClick={() => setTab("shell")}
              className={cn(
                "rounded px-1 text-[8.5px] font-semibold",
                tab === "shell"
                  ? "bg-dept-engineering text-acos-bg0"
                  : "text-acos-fg2 hover:text-acos-fg0",
              )}
            >
              Kabuk
            </button>
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-acos-fg2">
          <button
            data-testid="cell-focus"
            title="öne çıkar + Founder direktifi"
            onClick={() => {
              if (shellActive && onFocusShell && shellPty) onFocusShell(shellPty);
              else onFocus();
            }}
            className="hover:text-acos-fg0"
          >
            ⤢
          </button>
          <button
            data-testid="cell-close"
            title="görünümü kapat (oturum sürer)"
            onClick={() => closeAgent(session.agentId)}
            className="hover:text-acos-fg0"
          >
            ✕
          </button>
        </span>
      </div>
      {shellActive && shellPty ? (
        <GridXterm session={shellPty} fontSize={fontSize} />
      ) : (
        <SessionFeed companyId={companyId} session={session} fontSize={fontSize} />
      )}
    </div>
  );
}
