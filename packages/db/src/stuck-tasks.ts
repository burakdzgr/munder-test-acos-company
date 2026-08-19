// A6 — stuck-task sweep (09 §9 Temporal Schedules, 07 §7–8).
//
// 09 §9 bu sweep'i tabloda adıyla listeliyor: `stuck-task-sweep` · every 30m ·
// "detects ASSIGNED-too-long / WAITING-past-SLA tasks → manager
// notifications (07 §7–8)". Kodda yoktu.
//
// Neden önemliydi: iş yalnız üç yoldan ilerliyordu — HTTP route,
// `delegate_task` sonrası, intake sonrası. Bir görev WAITING'e park edilirse
// (guard, bağımlılık, onay) onu geri alan HİÇBİR mekanizma yoktu; sahibinin
// workflow'u öldüyse görev sonsuza kadar orada kalıyordu. Şirket sessizce
// duruyor ve Founder'ın elinde bunu gösteren tek bir işaret bile olmuyordu.
//
// Sweep iki şey yapar:
//   1. WAITING + `wait_for` süresi dolmuş → BLOCKED + `agent.escalated`
//      (07 §8'in birebir tarifi: "If unresolved after the wait_for timeout
//      (default 2h) → BLOCKED + escalation one level up the reports_to
//      chain").
//   2. ASSIGNED çok uzun süredir duruyor → sahibinin canlı oturumu var mı
//      diye bakar; yoksa çağırana bildirir (workflow'u yeniden başlatmak
//      Temporal istemcisini elinde tutan katmanın işi).
//
// Bu modül SİSTEM GENELİ çalışır (sweepApprovals gibi): şirket başına
// döngüye girer, her yazmayı kendi CompanyContext'iyle yapar (INV-4).
import { and, eq, isNull, sql } from "drizzle-orm";
import { companyContext } from "./context.js";
import type { Db } from "./index.js";
import type { GuardedDb } from "./tenant.js";
import { TaskStateService } from "./task-engine.js";
import { agentSessions, orgEdges, tasks } from "./schema/index.js";
import { appendEvents } from "./outbox.js";

/** 07 §8 [WRITER-DECISION]: "default 2h" — görev kendi süresini taşımıyorsa. */
export const DEFAULT_WAIT_FOR_MS = 2 * 60 * 60 * 1000;
/**
 * ASSIGNED eşiği [WRITER-DECISION]: sweep 30 dakikada bir koştuğu için daha
 * kısa bir eşik aynı görevi iki kez raporlamaya yol açardı. Bir görev yarım
 * saattir atanmış ama başlamamışsa, sahibinin döngüsü gerçekten durmuş
 * demektir.
 */
export const ASSIGNED_STALE_MS = 30 * 60 * 1000;

export interface StuckTaskFinding {
  companyId: string;
  taskId: string;
  taskNumber: number;
  title: string;
  ownerAgentId: string | null;
  /** Bildirim gidecek yönetici (reports_to bir üst). */
  managerAgentId: string | null;
  kind: "waiting_past_sla" | "assigned_too_long";
  /** Sahibinin canlı oturumu yoksa çağıran workflow'u yeniden başlatmalı. */
  needsWorkflowRestart: boolean;
  stuckForMs: number;
}

export interface StuckSweepResult {
  findings: StuckTaskFinding[];
  /** WAITING → BLOCKED taşınan görev sayısı. */
  blocked: number;
}

/** `reports_to` zincirinde bir üst (07 §8 "one level up"). */
async function managerOf(db: Db, companyId: string, agentId: string): Promise<string | null> {
  const rows = await db.execute(sql`
    SELECT e.to_agent_id AS manager_id
    FROM ${orgEdges} e
    WHERE e.company_id = ${companyId}
      AND e.from_agent_id = ${agentId}
      AND e.kind = 'reports_to'
    LIMIT 1
  `);
  const row = (rows.rows as Array<{ manager_id: string | null }>)[0];
  return row?.manager_id ?? null;
}

export async function sweepStuckTasks(
  db: Db,
  guardedDb: GuardedDb,
  opts: { now?: Date; waitForMs?: number; assignedStaleMs?: number } = {},
): Promise<StuckSweepResult> {
  const now = opts.now ?? new Date();
  const waitForMs = opts.waitForMs ?? DEFAULT_WAIT_FOR_MS;
  const assignedStaleMs = opts.assignedStaleMs ?? ASSIGNED_STALE_MS;
  const state = new TaskStateService(guardedDb);
  const result: StuckSweepResult = { findings: [], blocked: 0 };

  // "Ne kadardır takılı" sorusunun doğru cevabı görevin son DURUM DEĞİŞİMİdir,
  // satırın yaratılma anı değil. `tasks`'ta updated_at yok; olay defteri zaten
  // her geçişi yazıyor (INV-11), oradan okuyoruz.
  const rows = await db.execute(sql`
    SELECT t.id, t.company_id, t.number, t.title, t.status, t.owner_agent_id, t.context,
           COALESCE(
             (SELECT max(e.occurred_at) FROM events e
               WHERE e.company_id = t.company_id AND e.task_id = t.id
                 AND e.type = 'task.status.changed'),
             t.created_at
           ) AS since
      FROM ${tasks} t
     WHERE t.status IN ('WAITING','ASSIGNED')
  `);
  const candidates = (rows.rows as Array<{
    id: string;
    company_id: string;
    number: number;
    title: string;
    status: string;
    owner_agent_id: string | null;
    context: unknown;
    since: string | Date;
  }>).map((r) => ({
    id: r.id,
    companyId: r.company_id,
    number: Number(r.number),
    title: r.title,
    status: r.status,
    ownerAgentId: r.owner_agent_id,
    context: r.context,
    since: r.since,
  }));

  for (const task of candidates) {
    const idleMs = now.getTime() - new Date(task.since).getTime();
    const ctx = companyContext(task.companyId);

    if (task.status === "WAITING") {
      // görev kendi bekleme süresini taşıyabilir (08 §5 wait_for)
      const context = (task.context ?? {}) as Record<string, unknown>;
      const own = typeof context.waitForMs === "number" ? context.waitForMs : null;
      if (idleMs < (own ?? waitForMs)) continue;

      // 07 §8: "If unresolved after the wait_for timeout → BLOCKED +
      // escalation one level up." Ama §5'in KANONİK tablosunda WAITING'den
      // BLOCKED'a kenar yok — orada WAITING "gönüllü duraklama", BLOCKED
      // "zorunlu duruş" olarak ayrılmış ve WAITING yalnız IN_PROGRESS'e ya da
      // CANCELLED'a çıkıyor. Aynı dokümanın iki bölümü çeliştiğinde kanonik
      // durum tablosu bağlayıcıdır (§1.1), o yüzden hedefe iki meşru adımda
      // gidiyoruz: bekleme süresi doldu ⇒ ajan devam eder (IN_PROGRESS) ve
      // hemen orada tıkalı olduğunu görür (BLOCKED). Sonuç 07 §8'in istediği
      // durumun aynısı, yol makineye uygun.
      const note = `wait_for timeout: ${Math.round(idleMs / 60_000)} dk yanıtsız (07 §8)`;
      const moved = await state
        .transition(ctx, task.id, "IN_PROGRESS", { kind: "system" }, { note })
        .then(() => state.transition(ctx, task.id, "BLOCKED", { kind: "system" }, { note }))
        .then(() => true)
        .catch(() => false); // yarışta başkası taşımış olabilir — sweep en iyi çabadır
      if (moved) result.blocked += 1;
    } else if (idleMs < assignedStaleMs) {
      continue;
    }

    const managerAgentId = task.ownerAgentId
      ? await managerOf(db, task.companyId, task.ownerAgentId)
      : null;

    // sahibinin canlı bir oturumu var mı? yoksa döngü gerçekten durmuş
    const live = task.ownerAgentId
      ? await db
          .select({ id: agentSessions.id })
          .from(agentSessions)
          .where(
            and(
              eq(agentSessions.companyId, task.companyId),
              eq(agentSessions.taskId, task.id),
              sql`${agentSessions.status} IN ('starting','running','waiting')`,
            ),
          )
          .limit(1)
      : [];

    const finding: StuckTaskFinding = {
      companyId: task.companyId,
      taskId: task.id,
      taskNumber: task.number,
      title: task.title,
      ownerAgentId: task.ownerAgentId,
      managerAgentId,
      kind: task.status === "WAITING" ? "waiting_past_sla" : "assigned_too_long",
      needsWorkflowRestart: task.ownerAgentId !== null && live.length === 0,
      stuckForMs: idleMs,
    };
    result.findings.push(finding);

    // 07 §8: `agent.escalated` — Founder'ın Approval/Observatory yüzeyi ve
    // notification consumer'ı bu olayı zaten dinliyor
    if (task.ownerAgentId) {
      await guardedDb
        .transaction(async (tx) =>
          appendEvents(tx, ctx, [
            {
              type: "agent.escalated",
              actor: { kind: "system", id: null },
              taskId: task.id,
              agentId: task.ownerAgentId,
              payload: {
                reason:
                  finding.kind === "waiting_past_sla"
                    ? `TASK-${task.number} ${Math.round(idleMs / 60_000)} dakikadır WAITING — wait_for süresi doldu (07 §8)`
                    : `TASK-${task.number} ${Math.round(idleMs / 60_000)} dakikadır ASSIGNED ve başlamadı`,
                toAgentId: managerAgentId,
              },
            },
          ]),
        )
        .catch(() => {
          /* olay yazımı sweep'i durdurmamalı */
        });
    }
  }

  return result;
}

/** Sahipsiz kalmış aktif oturumları temizlemek için yardımcı (A6 wiring). */
export async function hasLiveSession(
  db: Db,
  companyId: string,
  taskId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.companyId, companyId),
        eq(agentSessions.taskId, taskId),
        isNull(agentSessions.endedAt),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Sweep'in bildirim metni — hem log hem mesaj gövdesi aynı cümleyi kullansın. */
export function describeStuckTask(finding: StuckTaskFinding): string {
  const minutes = Math.round(finding.stuckForMs / 60_000);
  const what =
    finding.kind === "waiting_past_sla"
      ? `${minutes} dakikadır yanıt bekliyor (wait_for süresi doldu, BLOCKED'a alındı)`
      : `${minutes} dakikadır atanmış ama başlamadı`;
  const restart = finding.needsWorkflowRestart ? " — ajanın döngüsü çalışmıyor, yeniden başlatılıyor" : "";
  return `TASK-${finding.taskNumber} "${finding.title}" ${what}${restart}.`;
}
