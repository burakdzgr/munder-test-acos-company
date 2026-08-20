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
import { TasksService, TaskStateService } from "./task-engine.js";
import { DelegationService } from "./delegation.js";
import { ReviewError, ReviewsService } from "./reviews.js";
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
/**
 * Sahipsiz-yavru eşiği [WRITER-DECISION]: delege eden yönetici normalde
 * decompose'dan saniyeler sonra `delegate_task` çağırır. 5 dakikadır DRAFT/
 * BACKLOG/PLANNED'da sahipsiz duran çocuk YETİMDİR — yöneticinin döngüsü
 * delege etmeden kapanmış demektir (P0-3 canlı kanıtı: CEO'nun initiative'i
 * DRAFT+sahipsiz kaldı ve DAG ilk delegasyondan sonra bir daha ilerlemedi).
 */
export const ORPHAN_CHILD_STALE_MS = 5 * 60 * 1000;
/**
 * Çocuksuz konteyner eşiği [WRITER-DECISION]: bir hedef/girişim, sahibi onu
 * bölene kadar meşru olarak IN_PROGRESS'te durur — CEO'nun ilk turu dakikalar
 * sürebilir. Yarım saat sonra HİÇ çocuğu yoksa bölünme olmamış demektir;
 * yetim-çocuk eşiğini (5 dk) burada kullanmak sağlıklı bir decompose'u
 * yarıda yakalardı.
 */
export const CONTAINER_CHILDLESS_STALE_MS = 30 * 60 * 1000;

export interface StuckTaskFinding {
  companyId: string;
  taskId: string;
  taskNumber: number;
  title: string;
  ownerAgentId: string | null;
  /** Bildirim gidecek yönetici (reports_to bir üst). */
  managerAgentId: string | null;
  kind:
    | "waiting_past_sla"
    | "assigned_too_long"
    | "rework_stalled"
    | "orphan_child_assigned"
    | "review_reopened"
    | "container_childless";
  /** Sahibinin canlı oturumu yoksa çağıran workflow'u yeniden başlatmalı. */
  needsWorkflowRestart: boolean;
  stuckForMs: number;
  /** review_reopened: çağıran reviewWorkflow'u bu bilgiyle başlatmalı. */
  review?: { reviewId: string; reviewerAgentId: string; authorAgentId: string };
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

/**
 * 07 §5: sahibinin sırası olan yeniden-giriş durumları. Üçünün de tek çıkışı
 * owner|manager ile IN_PROGRESS — yani ASSIGNED ile aynı anlamda "bu görev
 * sahibinin döngüsünü bekliyor". Kuyruk (pickNextQueuedTaskId) ve sweep aynı
 * kümeyi görmeli, yoksa düzeltme turu kaybolur (T14).
 */
const REWORK_STATUSES: ReadonlySet<string> = new Set([
  "CHANGES_REQUESTED",
  "QA_FAILED",
  "REJECTED",
]);

export async function sweepStuckTasks(
  db: Db,
  guardedDb: GuardedDb,
  opts: {
    now?: Date;
    waitForMs?: number;
    assignedStaleMs?: number;
    orphanStaleMs?: number;
    containerChildlessStaleMs?: number;
  } = {},
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
     WHERE t.status IN ('WAITING','ASSIGNED','CHANGES_REQUESTED','QA_FAILED','REJECTED')
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
      kind:
        task.status === "WAITING"
          ? "waiting_past_sla"
          : REWORK_STATUSES.has(task.status)
            ? "rework_stalled"
            : "assigned_too_long",
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
                    : finding.kind === "rework_stalled"
                      ? `TASK-${task.number} ${Math.round(idleMs / 60_000)} dakikadır ${task.status} — düzeltme turu hiç başlamadı`
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

  // 3. YETİM ÇOCUKLAR (P0-3): decompose edilmiş ama delege edilmemiş görevler.
  // create_task DRAFT'ta sahipsiz bırakır; delegasyon yalnız yöneticinin
  // döngüsünden gelir. Döngü delege etmeden kapanır/çökerse DAG sonsuza kadar
  // durur — canlı kanıt: CEO'nun initiative'i DRAFT+sahipsiz kaldı, hiçbir
  // mekanizma almadı. Sweep, ebeveynin sahibi adına Scheduler'ın deterministik
  // seçicisiyle (INVARIANT 10: atamayı skor yapar, LLM değil) delege eder;
  // workflow başlatma çağıranın işi (needsWorkflowRestart=true).
  const orphanStaleMs = opts.orphanStaleMs ?? ORPHAN_CHILD_STALE_MS;
  const orphanRows = await db.execute(sql`
    SELECT c.id, c.company_id, c.number, c.title, c.created_at,
           p.owner_agent_id AS parent_owner
      FROM ${tasks} c
      JOIN ${tasks} p ON p.id = c.parent_id AND p.company_id = c.company_id
     WHERE c.status IN ('DRAFT','BACKLOG','PLANNED')
       AND c.owner_agent_id IS NULL
       AND c.parent_id IS NOT NULL
       AND p.owner_agent_id IS NOT NULL
       AND p.status NOT IN ('CANCELLED','FAILED')
  `);
  const orphans = (orphanRows.rows as Array<{
    id: string;
    company_id: string;
    number: number;
    title: string;
    created_at: string | Date;
    parent_owner: string;
  }>).filter((o) => now.getTime() - new Date(o.created_at).getTime() >= orphanStaleMs);

  if (orphans.length > 0) {
    const tasksService = new TasksService(guardedDb);
    const delegation = new DelegationService(guardedDb, tasksService, state);
    for (const orphan of orphans) {
      const ctx = companyContext(orphan.company_id);
      try {
        const target = await delegation.resolveDelegateTarget(ctx, orphan.parent_owner, "", orphan.id);
        if (!target) {
          // uygun rapor yok — yöneticiye escalation (kadro eksikliği ayrı
          // akışın işi; sweep sessiz kalmasın yeter)
          await guardedDb
            .transaction(async (tx) =>
              appendEvents(tx, ctx, [
                {
                  type: "agent.escalated",
                  actor: { kind: "system", id: null },
                  taskId: orphan.id,
                  agentId: orphan.parent_owner,
                  payload: {
                    reason: `TASK-${orphan.number} decompose edildi ama delege edilecek uygun rapor yok`,
                    toAgentId: orphan.parent_owner,
                  },
                },
              ]),
            )
            .catch(() => {});
          continue;
        }
        const delegated = await delegation.delegateTask(ctx, orphan.parent_owner, orphan.id, target);
        if (delegated.ok) {
          result.findings.push({
            companyId: orphan.company_id,
            taskId: orphan.id,
            taskNumber: Number(orphan.number),
            title: orphan.title,
            ownerAgentId: target,
            managerAgentId: orphan.parent_owner,
            kind: "orphan_child_assigned",
            needsWorkflowRestart: true,
            stuckForMs: now.getTime() - new Date(orphan.created_at).getTime(),
          });
        }
      } catch (err) {
        /* kapasite/izin yarışı — sweep en iyi çabadır, 30 dk sonra yeniden dener */
        console.warn("orphan sweep delegate failed", err);
      }
    }
  }

  // 4. İNCELEME/QA YETİMLERİ (P0-2 + T11(b)): request_review görevi REVIEW'a taşıdı ama o
  // an uygun reviewer yoktu (REVIEW_NO_ELIGIBLE_REVIEWER sessizce yutulur) →
  // review satırı yok, görevi kapatacak zincir hiç başlamadı ve görev süresiz
  // REVIEW'da asılı. Kadro sonradan tamamlanınca (ör. Agent Factory lideri
  // işe aldı) sweep incelemeyi yeniden açar; reviewWorkflow'u başlatmak
  // Temporal istemcisini tutan katmanın işi (review alanı finding'de).
  const reviewOrphanRows = await db.execute(sql`
    SELECT t.id, t.company_id, t.number, t.title, t.owner_agent_id, t.status,
           COALESCE(
             (SELECT max(e.occurred_at) FROM events e
               WHERE e.company_id = t.company_id AND e.task_id = t.id
                 AND e.type = 'task.status.changed'),
             t.created_at
           ) AS since
      FROM ${tasks} t
     WHERE t.status IN ('REVIEW', 'QA') AND t.owner_agent_id IS NOT NULL
       -- T10 (Oscar verify): konteynerleri (goal/initiative) inceleme-yetimi
       -- sweep'ine ASLA sokma. Konteyner 07 §2 gereği roll-up ile kapanır;
       -- buraya girerse review satırı açılır → QA → mergeIfEligible fence'i
       -- olmasa system-close → A5 TASK_TRANSITION_INVALID → reviewWorkflow ölür.
       AND t.kind NOT IN ('goal', 'initiative')
       AND NOT EXISTS (
         SELECT 1 FROM reviews r
          WHERE r.company_id = t.company_id AND r.task_id = t.id
            AND r.status IN ('pending','in_review')
       )
  `);
  const reviewOrphans = (reviewOrphanRows.rows as Array<{
    id: string;
    company_id: string;
    number: number;
    title: string;
    owner_agent_id: string;
    status: string;
    since: string | Date;
  }>).filter((o) => now.getTime() - new Date(o.since).getTime() >= orphanStaleMs);

  if (reviewOrphans.length > 0) {
    const reviewsService = new ReviewsService(guardedDb);
    for (const orphan of reviewOrphans) {
      const ctx = companyContext(orphan.company_id);
      try {
        const { review } = await reviewsService.requestReview(ctx, {
          taskId: orphan.id,
          authorAgentId: orphan.owner_agent_id,
          // T11(b): QA turu açılamadığında görev SESSİZCE QA'da asılı kalıyordu
          // — bu sweep yalnız REVIEW'a bakıyordu. Aynı yetimlik, bir sonraki
          // aşamada. Durum QA ise yeniden açılan tur da QA turudur; 'code'
          // açmak incelemeyi bir adım geri sarardı.
          kind: orphan.status === "QA" ? "qa" : "code",
        });
        if (!review.reviewerAgentId) continue;
        result.findings.push({
          companyId: orphan.company_id,
          taskId: orphan.id,
          taskNumber: Number(orphan.number),
          title: orphan.title,
          ownerAgentId: orphan.owner_agent_id,
          managerAgentId: await managerOf(db, orphan.company_id, orphan.owner_agent_id),
          kind: "review_reopened",
          needsWorkflowRestart: false,
          stuckForMs: now.getTime() - new Date(orphan.since).getTime(),
          review: {
            reviewId: review.id,
            reviewerAgentId: review.reviewerAgentId,
            authorAgentId: orphan.owner_agent_id,
          },
        });
      } catch (err) {
        // hâlâ uygun reviewer yok / görev bu arada taşındı — 30 dk sonra tekrar
        if (!(err instanceof ReviewError)) {
          console.warn("review-orphan sweep failed", err);
        }
      }
    }
  }

  // 5. ÇOCUKSUZ KONTEYNERLER (T11a): 07 §2'ye göre hedef/girişim kendi işini
  // YAPMAZ, çocuklarından TÜREYEREK kapanır. Sahibi hiç bölmeden turunu
  // kapatırsa (ya da complete_task'ı konteyner fence'ine çarparsa) ortada
  // kapatacak çocuk yoktur: rollUpContainer 0 çocukta erken döner ve bu sweep
  // IN_PROGRESS'i hiç taramaz. Sonuç: konteyner SONSUZA KADAR IN_PROGRESS'te
  // durur ve hiçbir mekanizma bunu söylemez.
  //
  // Sweep burada görevi TAŞIMAZ — konteynerin durumunu roll-up yazar (INV-13)
  // ve "bu hedef nasıl bölünmeli" bir insan/yönetici kararıdır. Yaptığı şey
  // sessizliği bozmaktır: bir kez eskale eder (tekrar tekrar değil; işaret
  // olay defterindeki guardFlag'dir) ve bulguyu çağırana bildirir.
  const containerStaleMs = opts.containerChildlessStaleMs ?? CONTAINER_CHILDLESS_STALE_MS;
  const childlessRows = await db.execute(sql`
    SELECT t.id, t.company_id, t.number, t.title, t.owner_agent_id,
           COALESCE(
             (SELECT max(e.occurred_at) FROM events e
               WHERE e.company_id = t.company_id AND e.task_id = t.id
                 AND e.type = 'task.status.changed'),
             t.created_at
           ) AS since
      FROM ${tasks} t
     WHERE t.kind IN ('goal', 'initiative')
       AND t.status = 'IN_PROGRESS'
       AND NOT EXISTS (
         SELECT 1 FROM ${tasks} c
          WHERE c.company_id = t.company_id AND c.parent_id = t.id
       )
       -- bir kez söylenir: aynı konteyner için ikinci bir eskalasyon üretme
       AND NOT EXISTS (
         SELECT 1 FROM events e
          WHERE e.company_id = t.company_id AND e.task_id = t.id
            AND e.type = 'agent.escalated'
            AND e.payload->>'guardFlag' = 'container_childless'
       )
  `);
  const childless = (childlessRows.rows as Array<{
    id: string;
    company_id: string;
    number: number;
    title: string;
    owner_agent_id: string | null;
    since: string | Date;
  }>).filter((c) => now.getTime() - new Date(c.since).getTime() >= containerStaleMs);

  for (const container of childless) {
    const ctx = companyContext(container.company_id);
    const manager = container.owner_agent_id
      ? await managerOf(db, container.company_id, container.owner_agent_id)
      : null;
    try {
      await guardedDb.transaction(async (tx) =>
        appendEvents(tx, ctx, [
          {
            type: "agent.escalated",
            actor: { kind: "system", id: null },
            taskId: container.id,
            ...(container.owner_agent_id && { agentId: container.owner_agent_id }),
            payload: {
              reason: `TASK-${container.number} bir konteyner (hedef/girişim) ama HİÇ alt görevi yok ve ${Math.round(containerStaleMs / 60000)} dakikadır IN_PROGRESS: bölünme hiç olmamış, kapanışı türetecek çocuk yok.`,
              attempted: ["roll-up (0 çocukta erken döner)", "stuck sweep (IN_PROGRESS taranmaz)"],
              recommendation: "Hedefi alt görevlere böl ya da iptal et — konteyner kendi başına kapanamaz.",
              guardFlag: "container_childless",
              ...(manager && { toAgentId: manager }),
              ...(manager ? {} : { toFounder: true }),
            },
          },
        ]),
      );
      result.findings.push({
        companyId: container.company_id,
        taskId: container.id,
        taskNumber: Number(container.number),
        title: container.title,
        ownerAgentId: container.owner_agent_id,
        managerAgentId: manager,
        kind: "container_childless",
        // konteynerin sahibinin döngüsünü yeniden başlatmak İŞE YARAMAZ:
        // eksik olan bir tur değil, bir karar (böl ya da iptal et)
        needsWorkflowRestart: false,
        stuckForMs: now.getTime() - new Date(container.since).getTime(),
      });
    } catch (err) {
      console.warn("childless-container sweep failed", err);
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
      : finding.kind === "orphan_child_assigned"
        ? `${minutes} dakikadır sahipsizdi — Scheduler seçimiyle delege edildi`
        : finding.kind === "container_childless"
          ? `${minutes} dakikadır HİÇ alt görevi olmayan bir konteyner olarak IN_PROGRESS — bölünmesi ya da iptali gerekiyor`
          : finding.kind === "review_reopened"
            ? `${minutes} dakikadır incelemecisiz REVIEW/QA'daydı — tur yeniden açıldı`
            : finding.kind === "rework_stalled"
              ? `${minutes} dakikadır düzeltme bekliyor ama tur hiç başlamadı`
              : `${minutes} dakikadır atanmış ama başlamadı`;
  const restart = finding.needsWorkflowRestart ? " — ajanın döngüsü çalışmıyor, yeniden başlatılıyor" : "";
  return `TASK-${finding.taskNumber} "${finding.title}" ${what}${restart}.`;
}
