// T57 link-3 — "onaylanan bir istek, canlı workflow YOKKEN de sahibinin turunu
// yeniden başlatmalı."
//
// Gateway artık kaydı açıyor (T57 link-1) ve `workflowId`'yi dolduruyor
// (link-2), ama CLI şeridinde (Decision A) ajanın turu karar gelmeden ÇOK önce
// bitmiş olabilir: MCP zarfı "bu çağrı çalışmadı, başka işe geç" diyor ve tur
// kapanıyor. O noktada `verdict`in ürettiği sinyalin taşınacağı canlı bir
// workflow YOKTUR — kayıt açılır, Founder onaylar ve ajan bunu HİÇ öğrenmez.
//
// Bu, T38'in (çözülen mesaj bekleyişi) ve T55'in (çözülen bağımlılık) üçüncü
// örneği: aynı tetikleyici mantık, farklı beklenen şey. Kapılar starter'ın
// içinde — tek canlı oturum + şirket tavanı; kapı reddederse görev ASSIGNED
// kuyruğunda bekler ve 30 dakikalık sweep backstop olarak durur.
import { and, eq, isNull, sql } from "drizzle-orm";
import type { CompanyContext } from "./context.js";
import type { GuardedDb } from "./tenant.js";
import { taskMachine } from "@acos/domain";
import { agentSessions, tasks } from "./schema/index.js";

/**
 * F1 (Jim review) — kavram tek yerden gelsin. Jim `REJECTED`'in de buraya
 * eklenmesini onerdi; ÖLÇTÜM ve eklemedim, çünkü REJECTED TERMİNAL DEĞİL:
 * `taskMachine` tablosunda `REJECTED: ["IN_PROGRESS", "FAILED"]` — çıkışı olan
 * bir DÜZELTME durumu (CHANGES_REQUESTED / QA_FAILED gibi). Eklemek, meşru bir
 * uyandırmayı SUSTURURDU.
 *
 * Ama bulgunun asıl yarısı doğruydu: aynı kelime iki dosyada iki farklı şeyi
 * anlatıyordu. `dispatch.ts`'teki küme "bu çocuk hâlâ AÇIK MI (bekleyeceğim
 * bir şey mi)" sorusunu yanıtlar ve REJECTED'i doğru şekilde dışlar; buradaki
 * ise "görev BİTTİ Mİ" sorusudur. İkisi farklı kavram, aynı ad. Artık elle
 * liste tutmuyoruz: terminallik zaten "çıkış kenarı yok" demek ve durum
 * makinesi bunu KENDİSİ türetiyor (`terminalStates`), yani kayamaz.
 */
const TERMINAL: ReadonlySet<string> = new Set(taskMachine.terminalStates);

export interface ApprovalWakePort {
  startAgentTurn(input: { companyId: string; agentId: string; taskId: string }): Promise<void>;
  /** Kapı reddi (normal) ile beklenmedik hata dışarıdan aynı görünmesin. */
  onError?(err: unknown, input: { companyId: string; agentId: string; taskId: string }): void;
}

/**
 * Karar verildikten SONRA çağrılır. `true` = tur başlatıldı.
 *
 * REDDEDİLEN karar da uyandırır: ajanın "çalışmadı, başka yol bul" bilgisini
 * alması gerekir — sessizce beklemeye devam etmesi değil.
 */
export async function wakeOnDecidedApproval(
  db: GuardedDb,
  ctx: CompanyContext,
  approval: { taskId: string | null; requestedByAgentId: string | null },
  port: ApprovalWakePort,
): Promise<boolean> {
  if (!approval.taskId || !approval.requestedByAgentId) return false;

  const [task] = await db
    .select({ status: tasks.status })
    .from(tasks)
    .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, approval.taskId)));
  // Görev bitmişse uyandıracak bir tur yok (geç gelen karar).
  if (!task || TERMINAL.has(task.status)) return false;

  // Canlı oturum varsa sinyal zaten oraya taşındı; ikinci tur açmak çift yazar
  // olurdu (INV-13) ve tavanda koşulabilir işi açlığa iterdi.
  const live = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.companyId, ctx.companyId),
        eq(agentSessions.taskId, approval.taskId),
        sql`${agentSessions.status} IN ('starting','running','waiting')`,
        isNull(agentSessions.endedAt),
      ),
    )
    .limit(1);
  if (live.length > 0) return false;

  const input = {
    companyId: ctx.companyId,
    agentId: approval.requestedByAgentId,
    taskId: approval.taskId,
  };
  try {
    await port.startAgentTurn(input);
    return true;
  } catch (err) {
    port.onError?.(err, input);
    return false;
  }
}
