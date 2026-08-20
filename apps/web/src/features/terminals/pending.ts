// SIRADAKI AJANLAR (2026-08-21) — saf veri, canlı koşum izlenebilirliği.
//
// Şirket başına canlı oturum TAVANI var (varsayılan 3; sunucu tarafında
// checkSessionGate). Tavan doluyken dördüncü ajanın oturumu HİÇ açılmaz:
// broker 30 sn sonra tekrar dener. Sonuç ekranda şuydu — Founder dört ajanlı
// bir koşumda üç hücre görüyor, dördüncü ajan ORTADA YOK. "Sıradaki mi,
// çökmüş mü, unutulmuş mu?" sorusunun ekranda cevabı yoktu.
//
// Burada o boşluğu kapatıyoruz: görevi olan ama canlı oturumu olmayan her
// ajan bir "hayalet hücre" olarak listelenir. Tavan sayısı istemciye
// verilmiyor (sunucu yapılandırması) — bu yüzden "3/3 dolu" gibi bir SAYI
// UYDURMUYORUZ; yalnız gözlenebilir olguyu söylüyoruz: görevi var, oturumu
// yok, sebebi görev durumundan okunuyor.
import type { CompanyAgentSession, Task } from "@acos/contracts";

/** starting/running/waiting = ajan hâlâ o oturumun içinde (hücresi var). */
const LIVE_SESSION = new Set(["starting", "running", "waiting"]);

export type PendingKind = "queued" | "parked" | "detached";

export interface PendingRow {
  agentId: string;
  agentName: string;
  taskNumber: number;
  taskTitle: string;
  kind: PendingKind;
  /** ekranda gösterilecek kısa sebep */
  label: string;
}

const LABEL: Record<PendingKind, string> = {
  // Görev sahibinde; iş henüz başlamadı. En olası sebep canlı oturum tavanı.
  queued: "sırada — canlı oturum tavanı boşalınca başlar",
  // İş başladı ve park etti: cevabı/kararı bekliyor. Oturum kapanmış olabilir.
  parked: "beklemede — cevap/karar bekliyor",
  // İş IN_PROGRESS ama oturum yok: kapanmış oturum, yeniden alınacak.
  detached: "oturumu kapalı — görev açık, yeniden başlatılacak",
};

const KIND_BY_STATUS: Record<string, PendingKind> = {
  ASSIGNED: "queued",
  PLANNED: "queued",
  WAITING: "parked",
  BLOCKED: "parked",
  APPROVAL: "parked",
  IN_PROGRESS: "detached",
};

/** Öncelik: önce gerçekten bekleyenler, sonra sıradakiler, sonra kopuklar. */
const KIND_ORDER: PendingKind[] = ["parked", "queued", "detached"];

/**
 * Canlı oturumu olmayan ama açık görevi olan ajanlar. Ajan başına TEK satır
 * (bir ajanın iki açık görevi varsa en "konuşulası" olanı gösterilir).
 */
export function pendingRows(
  tasks: readonly Task[],
  sessions: readonly CompanyAgentSession[],
  agentNames: ReadonlyMap<string, string>,
): PendingRow[] {
  const busy = new Set(
    sessions.filter((s) => LIVE_SESSION.has(s.status)).map((s) => s.agentId),
  );
  const byAgent = new Map<string, PendingRow>();
  for (const task of tasks) {
    const agentId = task.ownerAgentId;
    if (!agentId || busy.has(agentId)) continue;
    const kind = KIND_BY_STATUS[task.status];
    if (!kind) continue;
    const row: PendingRow = {
      agentId,
      agentName: agentNames.get(agentId) ?? "—",
      taskNumber: task.number,
      taskTitle: task.title,
      kind,
      label: LABEL[kind],
    };
    const existing = byAgent.get(agentId);
    if (!existing || KIND_ORDER.indexOf(kind) < KIND_ORDER.indexOf(existing.kind)) {
      byAgent.set(agentId, row);
    }
  }
  return [...byAgent.values()].sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.taskNumber - b.taskNumber,
  );
}
