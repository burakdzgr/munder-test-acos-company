// Canlı runtime yaşam döngüsü olayları (LIVE-CONSOLE TASK 2/3). Ephemeral
// core-NATS hattında akar (`rt.<companyId>` — term.<sessionId> emsali):
// kalıcı event log'a GİRMEZ, kayıplı ve yalnız canlı fanout içindir. Truth
// her zaman DB'dedir (agent_steps / approvals / llm_calls); bu kanal yalnız
// "şu an ne oluyor" görünürlüğü taşır. Chain-of-thought TAŞIMAZ — yalnız
// yapılandırılmış lifecycle/progress alanları.
import { z } from "zod";

export const RUNTIME_EVENT_TYPES = [
  "context.build.started",
  "context.build.completed",
  "llm.started",
  "llm.completed",
  "action.selected",
  "tool.started",
  "tool.output",
  "tool.completed",
  "task.created",
  "task.delegated",
  "approval.requested",
  "approval.received",
  "wait.started",
  "wait.completed",
  "agent.status",
  "op.heartbeat",
] as const;
export type RuntimeEventType = (typeof RUNTIME_EVENT_TYPES)[number];

/** rt.<companyId> konusundaki tek çerçeve. `seq` gateway'de atanır (fanout
 *  sırasında) — üretici atamaz. */
export const RuntimeEventSchema = z.object({
  v: z.literal(1),
  type: z.enum(RUNTIME_EVENT_TYPES),
  companyId: z.uuid(),
  /** agent_sessions.id — Console hücresi bu alanla filtreler. approval.*
   *  gibi sunucu kaynaklı olaylar sessionId bilemeyebilir → taskId ile eşle. */
  sessionId: z.string().nullable(),
  agentId: z.string().nullable(),
  taskId: z.string().nullable(),
  stepNo: z.number().int().nullable(),
  /** Aktif operasyon kimliği (TASK 3): llm/tool started↔heartbeat↔completed
   *  üçlüsünü aynı opId bağlar. */
  opId: z.string().nullable(),
  /** epoch ms — üretici saati; UI elapsed hesabında kullanır. */
  ts: z.number(),
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;

export const RUNTIME_SUBJECT_PREFIX = "rt.";
export function runtimeSubjectFor(companyId: string): string {
  return `${RUNTIME_SUBJECT_PREFIX}${companyId}`;
}
