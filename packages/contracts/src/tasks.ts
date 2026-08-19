// Tasks API contracts (21 §3.7; 07 §1–5). Enum sources are @acos/domain —
// the same constants the state machine uses.
import { z } from "zod";
import { PRIORITIES, TASK_KINDS, TASK_RISKS, TASK_STATUSES, type TaskStatus } from "@acos/domain";
import { taskMachine } from "@acos/domain/state-machines";

/** Machine-legal next statuses per status — for UI affordances only; the
 *  server re-authorizes every transition (role matrix included). */
export const TASK_NEXT_STATUSES: Readonly<Record<TaskStatus, readonly TaskStatus[]>> =
  Object.fromEntries(TASK_STATUSES.map((s) => [s, taskMachine.transitionsFrom(s)])) as Record<
    TaskStatus,
    readonly TaskStatus[]
  >;

export const TaskKindSchema = z.enum(TASK_KINDS);
export const TaskPrioritySchema = z.enum(PRIORITIES);
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export const TaskRiskLevelSchema = z.enum(TASK_RISKS);

export const TaskSchema = z.object({
  id: z.uuid(),
  number: z.number().int(),
  displayNumber: z.string(), // TASK-81
  kind: TaskKindSchema,
  parentId: z.uuid().nullable(),
  projectId: z.uuid().nullable(),
  title: z.string(),
  objective: z.string(),
  priority: TaskPrioritySchema,
  status: TaskStatusSchema,
  successCriteria: z.array(z.string()),
  risk: TaskRiskLevelSchema,
  budgetCents: z.number().int().nullable(),
  spentCents: z.number().int(),
  deadline: z.iso.datetime().nullable(),
  ownerAgentId: z.uuid().nullable(),
  creatorAgentId: z.uuid().nullable(),
  orgUnitId: z.uuid().nullable(),
  delegationDepth: z.number().int(),
  reassignmentCount: z.number().int(),
  createdAt: z.iso.datetime(),
  closedAt: z.iso.datetime().nullable(),
  /** Founder panodan kaldırdıysa dolu — satır silinmez, yalnız gizlenir. */
  archivedAt: z.iso.datetime().nullable(),
});
export type Task = z.infer<typeof TaskSchema>;

export const CreateTaskRequestSchema = z.object({
  projectId: z.uuid().optional(),
  parentId: z.uuid().optional(),
  kind: TaskKindSchema,
  title: z.string().min(1).max(200),
  objective: z.string().min(1),
  priority: TaskPrioritySchema.default("P2"),
  successCriteria: z.array(z.string()).default([]),
  risk: TaskRiskLevelSchema.default("low"),
  budgetCents: z.number().int().positive().optional(),
  deadline: z.iso.datetime({ offset: true }).optional(),
  orgUnitId: z.uuid().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});

export const UpdateTaskRequestSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  objective: z.string().min(1).optional(),
  priority: TaskPrioritySchema.optional(),
  successCriteria: z.array(z.string()).optional(),
  risk: TaskRiskLevelSchema.optional(),
  budgetCents: z.number().int().positive().nullable().optional(),
  deadline: z.iso.datetime({ offset: true }).nullable().optional(),
});

export const TaskTransitionRequestSchema = z.object({
  to: TaskStatusSchema,
  reason: z.string().max(1000).optional(),
});

export const TaskListQuerySchema = z.object({
  projectId: z.uuid().optional(),
  kind: TaskKindSchema.optional(),
  status: z.union([TaskStatusSchema, z.array(TaskStatusSchema)]).optional(),
  ownerAgentId: z.uuid().optional(),
  orgUnitId: z.uuid().optional(),
  priority: TaskPrioritySchema.optional(),
  risk: TaskRiskLevelSchema.optional(),
  parentId: z.uuid().optional(),
  q: z.string().optional(),
  /**
   * Görünürlük penceresi. Varsayılan "active": arşivlenmiş görevler ve
   * kapanalı bir haftadan çok olmuş görevler panoda çıkmaz — satırlar
   * durur, yalnız görünmezler.
   */
  include: z.enum(["active", "archived", "all"]).optional(),
});

export const ArchiveTaskRequestSchema = z.object({ archived: z.boolean() });

/**
 * Founder direktifi — TEK adımda hedef verme.
 *
 * Eski yol beş ayrı işlemdi: görev oluştur → DRAFT→BACKLOG → BACKLOG→PLANNED
 * → 32 ajanlık düz listeden CEO'yu bul → ata. Founder "yeni iş nereden
 * verilir" sorusuna cevap bulamıyordu ve haklıydı: hiçbir ekran "şirketin
 * tepesi bu kişi" demiyordu. Bu istek aynı yasal geçişleri sunucuda sırayla
 * yürütür — durum makinesi (07 §2) ve izin matrisi (07 §5) aynen geçerli,
 * kısayol yok; kısalan tek şey Founder'ın tıklama sayısı.
 */
export const CreateDirectiveRequestSchema = z.object({
  title: z.string().min(1).max(200),
  objective: z.string().min(1).max(8000),
  priority: TaskPrioritySchema.default("P1"),
  successCriteria: z.array(z.string().min(1).max(500)).max(20).default([]),
  /** 2026-08-18: hedef bir projeye bağlanır — alt görevler kalıtır ve kodlama
   *  workspace'leri repo'suz kalmaz (Founder gözlemi: "no project" eskalasyon
   *  döngüsü). Boş bırakılabilir (kod gerektirmeyen hedefler). */
  projectId: z.uuid().optional(),
});

/** Şirketin tepe yöneticisi (CEO) — org zincirinin kökü. */
export const TopExecutiveResponseSchema = z.object({
  agentId: z.uuid(),
  name: z.string(),
  positionTitle: z.string(),
});

export const CreateDependencyRequestSchema = z.object({ dependsOnTaskId: z.uuid() });

export const TaskDependencySchema = z.object({
  id: z.uuid(),
  taskId: z.uuid(),
  dependsOnTaskId: z.uuid(),
  resolvedAt: z.iso.datetime().nullable(),
});

export const TaskDependenciesResponseSchema = z.object({
  blockedBy: z.array(TaskDependencySchema),
  blocks: z.array(TaskDependencySchema),
});

export const CreateAssignmentRequestSchema = z.object({
  agentId: z.uuid(),
  role: z.enum(["owner", "reviewer", "qa", "collaborator"]).default("owner"),
  reason: z.string().max(500).optional(),
});

export const TaskAssignmentSchema = z.object({
  id: z.uuid(),
  taskId: z.uuid(),
  agentId: z.uuid(),
  role: z.enum(["owner", "reviewer", "qa", "collaborator"]),
  assignedByAgentId: z.uuid().nullable(),
  reason: z.string().nullable(),
  assignedAt: z.iso.datetime(),
  unassignedAt: z.iso.datetime().nullable(),
});
export type TaskAssignment = z.infer<typeof TaskAssignmentSchema>;

export interface TaskTreeNode extends Task {
  children: TaskTreeNode[];
}
export const TaskTreeNodeSchema: z.ZodType<TaskTreeNode> = TaskSchema.extend({
  children: z.lazy(() => z.array(TaskTreeNodeSchema)),
}) as z.ZodType<TaskTreeNode>;

export type TaskDependency = z.infer<typeof TaskDependencySchema>;
