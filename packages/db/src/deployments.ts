// D1 — teslimat kaydı (14 §5, 15 §2).
//
// `deployments` tablosu ve `project.deployment.*` olayları şemada ve olay
// kataloğunda baştan beri vardı; kodda hiçbir yazan yoktu ("dark in MVP,
// schema present"). Sonuç: bir iş merge edilip bittiğinde şirketin elinde
// "bu değişiklik nereye, ne zaman, hangi commit'le gitti" sorusunun cevabı
// yoktu — pano boş, maliyet atfı eksikti.
//
// Kapsam DOKÜMANIN çizdiği yer: 14 §5 "MVP scope: deployments to `sandbox`-
// kind environments only … `deploy` sandbox level and external environments
// are Phase 3". Yani burada dış hedef YOK; olan şey, sandbox ortamına yapılan
// teslimatın kaydı ve olaylarıdır. Dış hedefler ayrı bir faz kararı.
import { and, desc, eq } from "drizzle-orm";
import type { CompanyContext } from "./context.js";
import type { GuardedDb } from "./tenant.js";
import { appendEvents, type EventActor, type Tx } from "./outbox.js";
import { parseEventPayload } from "@acos/events";
import { deployments, environments } from "./schema/index.js";

export class DeploymentError extends Error {
  constructor(
    readonly code: "ENVIRONMENT_NOT_FOUND" | "ENVIRONMENT_NOT_SANDBOX" | "APPROVAL_REQUIRED" | "DEPLOYMENT_NOT_FOUND" | "DEPLOYMENT_STATE_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "DeploymentError";
  }
}

async function emitDomainEvent(
  tx: Tx,
  ctx: CompanyContext,
  input: Parameters<typeof appendEvents>[2][number],
) {
  const payload = parseEventPayload(input.type, input.version ?? 1, input.payload ?? {});
  await appendEvents(tx, ctx, [{ ...input, payload }]);
}

/**
 * 14 §5: MVP yalnız `sandbox` türü ortamlara teslimat. Ortam türü
 * `environments.config.kind` alanından okunuyor; `local` tarihsel olarak
 * sandbox ortamı olduğu için tür belirtilmemişse öyle sayılıyor.
 */
function environmentKind(name: string, config: unknown): string {
  const declared = (config as { kind?: unknown } | null)?.kind;
  if (typeof declared === "string" && declared.length > 0) return declared;
  return name === "local" ? "sandbox" : name;
}

function isApprovalGated(config: unknown): boolean {
  return (config as { approvalGated?: unknown } | null)?.approvalGated === true;
}

export class DeploymentsService {
  constructor(private readonly db: GuardedDb) {}

  /**
   * Teslimatı başlat: satır `running`, `project.deployment.started` düşer.
   * Onay kapılı ortam (14 §5, S6 destructive-prod) için Approval Engine
   * kararı şart — burada kararın kendisi ARANIR, üretilmez.
   */
  async start(
    ctx: CompanyContext,
    input: {
      projectId: string;
      environmentId: string;
      taskId?: string | undefined;
      gitRef: string;
      actor: EventActor;
      /** Onay kapılı ortamda Approval Engine'in verdiği onayın id'si. */
      approvalId?: string | undefined;
    },
  ) {
    return this.db.transaction(async (tx) => {
      const [environment] = await tx
        .select()
        .from(environments)
        .where(
          and(
            eq(environments.companyId, ctx.companyId),
            eq(environments.id, input.environmentId),
            eq(environments.projectId, input.projectId),
          ),
        );
      if (!environment) {
        throw new DeploymentError("ENVIRONMENT_NOT_FOUND", "environment not found for this project");
      }
      const kind = environmentKind(environment.name, environment.config);
      if (kind !== "sandbox") {
        throw new DeploymentError(
          "ENVIRONMENT_NOT_SANDBOX",
          `deployments are MVP-scoped to sandbox environments (14 §5); "${environment.name}" is ${kind} — external targets are Phase 3`,
        );
      }
      if (isApprovalGated(environment.config) && !input.approvalId) {
        throw new DeploymentError(
          "APPROVAL_REQUIRED",
          `environment "${environment.name}" is approval-gated: an Approval Engine verdict is required regardless of autonomy level (14 §5)`,
        );
      }

      const [row] = await tx
        .insert(deployments)
        .values({
          companyId: ctx.companyId,
          projectId: input.projectId,
          environmentId: input.environmentId,
          taskId: input.taskId ?? null,
          gitRef: input.gitRef,
          status: "running",
          startedAt: new Date(),
        })
        .returning();
      await emitDomainEvent(tx, ctx, {
        type: "project.deployment.started",
        actor: input.actor,
        projectId: input.projectId,
        ...(input.taskId && { taskId: input.taskId }),
        payload: {
          deploymentId: row!.id,
          environment: environment.name,
          ref: input.gitRef,
          statusDetail: "started",
        },
      });
      return row!;
    });
  }

  /** Teslimatı kapat: `succeeded` / `failed` / `rolled_back` + olayı. */
  async finish(
    ctx: CompanyContext,
    deploymentId: string,
    input: {
      status: "succeeded" | "failed" | "rolled_back";
      detail?: string | undefined;
      logsUri?: string | undefined;
      actor: EventActor;
    },
  ) {
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(deployments)
        .where(and(eq(deployments.companyId, ctx.companyId), eq(deployments.id, deploymentId)))
        .for("update");
      if (!existing) throw new DeploymentError("DEPLOYMENT_NOT_FOUND", "deployment not found");
      if (existing.status !== "running" && existing.status !== "pending") {
        // idempotent kapanış: aynı sonuca ikinci kez kapatmak hata değil
        if (existing.status === input.status) return existing;
        throw new DeploymentError(
          "DEPLOYMENT_STATE_INVALID",
          `deployment already ${existing.status}`,
        );
      }
      const [environment] = await tx
        .select({ name: environments.name })
        .from(environments)
        .where(
          and(
            eq(environments.companyId, ctx.companyId),
            eq(environments.id, existing.environmentId),
          ),
        );
      const [row] = await tx
        .update(deployments)
        .set({
          status: input.status,
          finishedAt: new Date(),
          ...(input.logsUri !== undefined && { logsUri: input.logsUri }),
        })
        .where(and(eq(deployments.companyId, ctx.companyId), eq(deployments.id, deploymentId)))
        .returning();
      await emitDomainEvent(tx, ctx, {
        // katalogda `completed` var (`succeeded` değil) — olay adı sabittir
        type: input.status === "succeeded" ? "project.deployment.completed" : "project.deployment.failed",
        actor: input.actor,
        projectId: existing.projectId,
        ...(existing.taskId && { taskId: existing.taskId }),
        payload: {
          deploymentId,
          environment: environment?.name ?? "",
          ref: existing.gitRef,
          statusDetail: input.detail ?? input.status,
        },
      });
      return row!;
    });
  }

  /** Proje panosunun okuduğu liste (14 §6). */
  async list(ctx: CompanyContext, projectId: string, limit = 20) {
    return this.db
      .select()
      .from(deployments)
      .where(and(eq(deployments.companyId, ctx.companyId), eq(deployments.projectId, projectId)))
      .orderBy(desc(deployments.createdAt))
      .limit(limit);
  }
}
