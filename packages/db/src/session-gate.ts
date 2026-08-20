// E4/A (T30) — canlı oturum kapısı: TEK yer, iki kural.
//
// (1) AJAN BAŞINA TEK OTURUM (2026-08-18 Founder kararı): meşgul bir ajana
//     ikinci iş atanırsa workflow BAŞLAMAZ; görev kuyrukta bekler ve oturum
//     kapanınca drain sıradakini başlatır.
// (2) ŞİRKET BAŞINA EŞZAMANLI OTURUM TAVANI (E4): ajan turu artık konteynerde
//     koşan bir CLI süreci olabildiği için "N ajan = N canlı süreç" demek.
//     Köprünün 3-paralel tavanı ortadan kalkıyor; yerine açık bir tavan
//     gelmezse makineyi yine yere sereriz (bir kez serdik: Docker çöküşü,
//     149GB vhdx). Tavan aşılınca hiçbir şey BAŞARISIZ olmaz — görev ASSIGNED
//     kuyruğunda kalır, kapasite boşalınca başlar.
//
// Kural iki başlatma yolunda da (apps/server twin + worker) aynı olmalı; bu
// yüzden burada yaşar. Kopyalanan bir kapı, kaçınılmaz olarak ayrışan bir
// kapıdır.
import { sql } from "drizzle-orm";
import type { GuardedDb } from "./tenant.js";

export const LIVE_SESSION_STATUSES = ["starting", "running"] as const;

export type SessionGateDecision =
  | { ok: true }
  | { ok: false; reason: "agent_busy" | "company_cap"; liveSessions: number };

export interface SessionGateInput {
  companyId: string;
  agentId: string;
  taskId: string;
  /** undefined = tavan uygulanmaz (yalnız ajan-başına-tek kuralı işler). */
  maxLiveSessionsPerCompany?: number | undefined;
}

/**
 * Bu ajan + bu görev için yeni bir canlı oturum başlatılabilir mi?
 *
 * AYNI görevin yeniden başlatılması (çöküş sonrası restart, sweep, rework
 * yeniden girişi) hiçbir kuralla engellenmez: o zaten var olan bir oturumun
 * devamıdır, yeni bir eşzamanlılık değil.
 */
export async function checkSessionGate(
  db: GuardedDb,
  input: SessionGateInput,
): Promise<SessionGateDecision> {
  const result = await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE s.agent_id = ${input.agentId} AND s.task_id IS DISTINCT FROM ${input.taskId})::int AS agent_other,
      count(*) FILTER (WHERE s.agent_id = ${input.agentId} AND s.task_id = ${input.taskId})::int AS same_task,
      count(*)::int AS company_live
    FROM agent_sessions s
    WHERE s.company_id = ${input.companyId} AND s.status IN ('starting','running')
  `);
  const row = result.rows[0] as {
    agent_other: number;
    same_task: number;
    company_live: number;
  };
  const companyLive = Number(row.company_live);
  // Aynı görev için zaten canlı bir oturum var → bu bir yeniden başlatmadır.
  if (Number(row.same_task) > 0) return { ok: true };
  if (Number(row.agent_other) > 0) {
    return { ok: false, reason: "agent_busy", liveSessions: companyLive };
  }
  if (input.maxLiveSessionsPerCompany !== undefined && companyLive >= input.maxLiveSessionsPerCompany) {
    return { ok: false, reason: "company_cap", liveSessions: companyLive };
  }
  return { ok: true };
}

/**
 * Şirket çapında drain seçicisi: bir oturum kapandığında boşalan kapasite
 * YALNIZ o ajanın kuyruğuna değil, şirketteki en öncelikli bekleyen işe
 * gitmeli — yoksa tavan altında iş, tavanı dolduran ajanların arkasında
 * süresiz bekler. Canlı oturumu olan ajanlar elenir (ajan-başına-tek kuralı),
 * çözülmemiş bağımlılığı olan görevler atlanır (Scheduler kuralı), sıra
 * öncelik → yaş.
 */
export async function pickCompanyQueuedTasks(
  db: GuardedDb,
  companyId: string,
  limit: number,
): Promise<Array<{ taskId: string; agentId: string }>> {
  if (limit <= 0) return [];
  const result = await db.execute(sql`
    SELECT DISTINCT ON (t.owner_agent_id) t.id, t.owner_agent_id, t.priority, t.created_at
    FROM tasks t
    WHERE t.company_id = ${companyId}
      AND t.owner_agent_id IS NOT NULL
      AND t.status IN ('ASSIGNED','CHANGES_REQUESTED','QA_FAILED','REJECTED')
      AND NOT EXISTS (
        SELECT 1 FROM agent_sessions s
        WHERE s.company_id = ${companyId} AND s.agent_id = t.owner_agent_id
          AND s.status IN ('starting','running')
      )
      AND NOT EXISTS (
        SELECT 1 FROM task_dependencies td
        JOIN tasks dep ON dep.id = td.depends_on_task_id AND dep.company_id = td.company_id
        WHERE td.company_id = ${companyId} AND td.task_id = t.id
          AND td.resolved_at IS NULL AND dep.status NOT IN ('DONE','CANCELLED')
      )
    ORDER BY t.owner_agent_id, t.priority ASC, t.created_at ASC
  `);
  const rows = result.rows as Array<{
    id: string;
    owner_agent_id: string;
    priority: string;
    created_at: string | Date;
  }>;
  // DISTINCT ON ajan başına bir iş verir (aynı ajana iki oturum açılmasın) ama
  // kendi ORDER BY'ını dayatır (agent id önce). Şirket sırası — öncelik, sonra
  // yaş — bu yüzden burada uygulanır; aksi hâlde kapasite alfabetik dağılırdı.
  return rows
    .sort(
      (a, b) =>
        a.priority.localeCompare(b.priority) ||
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    )
    .slice(0, limit)
    .map((r) => ({ taskId: r.id, agentId: r.owner_agent_id }));
}
