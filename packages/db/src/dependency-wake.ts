// T55(b) — "çözülen bir BAĞIMLILIK, canlı workflow YOKKEN de sahibinin turunu
// yeniden başlatmalı."
//
// 07 §12: bir görevi bölen sahip `wait_for dependency` ile WAITING'e park eder
// ve "resumes on dependencyResolved signals" der. Sinyal köprüsü (09 §9) o
// sinyali YALNIZCA canlı bir oturumu olan workflow'a taşıyor — CLI şeridinde
// (Decision A) `wait_for` turu BİTİRİR (`drive.ts`: WAITING bir handoff
// statüsü), yani sinyalin taşınacağı workflow zaten yoktur. Canlı kanıt
// (run #2): çocuklar bittiğinde epic'ler WAITING'de kaldı, hiçbir şey onları
// uyandırmadı; 2 saatlik `waiting_past_sla` sweep'i sonunda BLOCKED'a taşırdı —
// ilerleme değil, eskalasyon. T38'in mesaj tarafında çözdüğü sorunun aynısı,
// farklı tetikleyici.
//
// KASITLI OLARAK dar — T38'deki gerekçenin aynısı: tetikleyici bir DURUM
// TARAMASI değil, BEKLENEN ŞEYİN GELMESİ. Dört koşul birlikte "bekleyiş
// çözüldü" demektir: görev WAITING, sahibi var, sahibinin canlı oturumu yok ve
// bu görevin ÇÖZÜLMEMİŞ BAŞKA bağımlılığı KALMADI. Son koşul olmadan iki
// çocuklu bir ebeveyn ilk çocuk bitince uyanır, hâlâ beklediğini görür, yeniden
// park eder — bir oturum + LLM turu yakar ve eşzamanlılık tavanında koşulabilir
// işi açlığa iter.
//
// Eşzamanlılık güvenliği çağıranın: starter tek-canlı-oturum kapısını ve şirket
// tavanını uyguluyor; kapı reddederse görev ASSIGNED kuyruğunda bekler. 30
// dakikalık sweep BİRİNCİL yol değil, BACKSTOP olarak kalır.
import { and, eq, isNull, sql } from "drizzle-orm";
import type { CompanyContext } from "./context.js";
import type { GuardedDb } from "./tenant.js";
import { agentSessions, taskDependencies, tasks } from "./schema/index.js";

/** Turu başlatan taraf (server'ın `agentWorkflowStarter`'ı). */
export interface DependencyWakePort {
  startAgentTurn(input: { companyId: string; agentId: string; taskId: string }): Promise<void>;
  /** F3 (Jim review): starter'ın REDDİ ile BEKLENMEDİK bir hata dışarıdan aynı
   *  görünmemeli. Reddi zaten kapı/tavan üretir ve normaldir; beklenmedik hata
   *  sessizce yutulursa geriye tek dayanak 30 dakikalık sweep kalır ve kimse
   *  görevin neden beklediğini bilemez. */
  onError?(err: unknown, input: { companyId: string; agentId: string; taskId: string }): void;
}

/**
 * Bir bağımlılık çözüldükten SONRA çağrılır. `true` = tur başlatıldı.
 * Koşullar tutmuyorsa sessizce `false` — bu bir hata değil, "henüz değil".
 */
export async function wakeOnResolvedDependency(
  db: GuardedDb,
  ctx: CompanyContext,
  taskId: string,
  port: DependencyWakePort,
): Promise<boolean> {
  const [task] = await db
    .select({ id: tasks.id, status: tasks.status, ownerAgentId: tasks.ownerAgentId })
    .from(tasks)
    .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, taskId)));
  if (!task || task.status !== "WAITING" || !task.ownerAgentId) return false;

  // Hâlâ bekleyen başka bağımlılık varsa uyandırma — bekleyiş bitmedi.
  const [pending] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(taskDependencies)
    .where(
      and(
        eq(taskDependencies.companyId, ctx.companyId),
        eq(taskDependencies.taskId, taskId),
        isNull(taskDependencies.resolvedAt),
      ),
    );
  if ((pending?.n ?? 0) > 0) return false;

  // Canlı oturum varsa sinyal zaten ulaştı; ikinci bir tur açmak çift yazar olurdu.
  const live = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.companyId, ctx.companyId),
        eq(agentSessions.taskId, taskId),
        sql`${agentSessions.status} IN ('starting','running','waiting')`,
      ),
    )
    .limit(1);
  if (live.length > 0) return false;

  try {
    await port.startAgentTurn({
      companyId: ctx.companyId,
      agentId: task.ownerAgentId,
      taskId: task.id,
    });
    return true;
  } catch (err) {
    // uyandırma best-effort: sweep backstop olarak duruyor — ama SESSİZ değil.
    port.onError?.(err, {
      companyId: ctx.companyId,
      agentId: task.ownerAgentId,
      taskId: task.id,
    });
    return false;
  }
}
