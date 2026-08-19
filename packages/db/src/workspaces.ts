// Workspace control plane (T38; ADR-010, 15 §3, _DECISIONS §13/§19). Lives
// in @acos/db for the same reason as the task engine: ONE implementation of
// the workspace records + state machine + soft-lock semantics shared by the
// server's REST surface (T41) and the worker's activities (T40). The actual
// git/container plumbing happens behind the SandboxPort — sandbox-manager is
// the only Docker-socket owner (S1) and this service never talks to Docker.
//
// Recorded deviations, bounded by the canonical schema (20 §14):
// - worktree volume names carry a task-id suffix (`ws-<n>-<uuid8>`) on top of
//   15 §3.1's `ws-<task_number>` because task numbers are per-company and
//   volume names are host-global.
// - `base_commit` / `last_activity_at` have no canonical columns; the base
//   commit is returned to the caller (and lives in git itself), activity
//   tracking arrives with the reaper (T40+).
import { and, asc, desc, eq, ne, notInArray, or, sql } from "drizzle-orm";
import {
  ISOLATION_LEVELS,
  taskBranchName,
  workspaceMachine,
  type IsolationLevel,
  type WorkspaceStatus,
} from "@acos/domain";
import { parseEventPayload } from "@acos/events";
import { appendEvents, type EventActor, type NewEventInput, type Tx } from "./outbox.js";
import type { CompanyContext } from "./context.js";
import type { GuardedDb } from "./tenant.js";
import {
  repositories,
  tasks,
  terminalSessions,
  workspaceLocks,
  workspaces,
} from "./schema/index.js";

export type WorkspaceRow = typeof workspaces.$inferSelect;
export type WorkspaceLockRow = typeof workspaceLocks.$inferSelect;
export type TerminalSessionRow = typeof terminalSessions.$inferSelect;
export type RepositoryRow = typeof repositories.$inferSelect;

const SYSTEM_ACTOR: EventActor = { kind: "system", id: null };

/**
 * C2 — the isolation ladder a single task workspace can climb. Ordered
 * weakest → strongest; a tool asking for a stronger level upgrades the
 * existing workspace instead of creating a second one over the same volume.
 * Levels outside this list (deploy/browser/media) are separate environments,
 * not steps on the ladder.
 */
const ESCALATION_LADDER = ["analysis", "coding", "testing"] as const;

/** Statuses the partial unique index treats as "live" (one live workspace
 *  per (task, isolation level)). */
const LIVE_STATUSES: WorkspaceStatus[] = ["provisioning", "ready", "in_use", "idle"];

async function emitDomainEvent(tx: Tx, ctx: CompanyContext, input: NewEventInput) {
  const payload = parseEventPayload(input.type, input.version ?? 1, input.payload ?? {});
  const [appended] = await appendEvents(tx, ctx, [{ ...input, payload }]);
  return appended!;
}

export class WorkspaceError extends Error {
  constructor(
    public readonly code:
      | "WORKSPACE_NOT_FOUND"
      | "WORKSPACE_TASK_INVALID"
      | "WORKSPACE_INVALID_TRANSITION"
      | "WORKSPACE_PROVISION_FAILED"
      | "TERMINAL_SESSION_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

/** The provisioning seam to sandbox-manager (implemented over its internal
 *  HTTP API by the execution worker, T40; faked in tests). */
export interface SandboxPort {
  ensureRepo(projectId: string): Promise<{ barePath: string; headCommit: string }>;
  provisionWorktree(input: {
    projectId: string;
    volumeName: string;
    branch: string;
  }): Promise<{ baseCommit: string }>;
  createContainer(input: {
    workspaceId: string;
    isolation: IsolationLevel;
    image: string;
    volumeName: string;
  }): Promise<{ containerId: string }>;
  destroyContainer(workspaceId: string): Promise<void>;
  removeWorktree(volumeName: string): Promise<void>;
}

export interface ProvisionInput {
  taskId: string;
  agentId?: string | undefined;
  isolationLevel?: IsolationLevel | undefined;
  /** Workspace image; projects carry the default (14 §1.3). */
  image?: string | undefined;
  /** Informational limits snapshot (27 §11) — callers with @acos/tools pass
   *  ISOLATION_LIMITS[level]; enforcement lives in sandbox-manager (S8). */
  limits?: Record<string, unknown> | undefined;
  actor?: EventActor | undefined;
}

export interface ProvisionResult {
  workspace: WorkspaceRow;
  baseCommit: string | null;
  created: boolean;
}

export interface LockConflict {
  lockId: string;
  workspaceId: string;
  taskId: string | null;
  pathPrefix: string;
}

export interface AcquireLockResult {
  lock: WorkspaceLockRow;
  /** Soft-lock semantics (15 §3.8): overlapping live locks WARN, never block. */
  conflicts: LockConflict[];
  created: boolean;
}

const DEFAULT_IMAGE = "acos/workspace-node";

/** `ws-<task_number>-<uuid8>` (15 §3.1 + recorded uniqueness suffix). The
 *  LAST 8 hex carry uuidv7's random bits — the first 8 are timestamp high
 *  bits shared by ids minted within the same ~65s window. */
export function worktreeVolumeName(taskNumber: number, taskId: string): string {
  return `ws-${taskNumber}-${taskId.replace(/-/g, "").slice(-8)}`;
}

export class WorkspaceService {
  constructor(private readonly db: GuardedDb) {}

  /** Get-or-create the project's repository row — bare path is derived
   *  (`/data/repos/<project_id>.git`, ADR-010) and stored for audit. */
  async ensureRepository(ctx: CompanyContext, projectId: string): Promise<RepositoryRow> {
    return this.db.transaction((tx) => this.ensureRepositoryInTx(tx, ctx, projectId));
  }

  private async ensureRepositoryInTx(
    tx: Tx,
    ctx: CompanyContext,
    projectId: string,
  ): Promise<RepositoryRow> {
    const existing = await tx
      .select()
      .from(repositories)
      .where(and(eq(repositories.companyId, ctx.companyId), eq(repositories.projectId, projectId)))
      .limit(1);
    if (existing[0]) return existing[0];
    await tx
      .insert(repositories)
      .values({
        companyId: ctx.companyId,
        projectId,
        name: "origin",
        barePath: `/data/repos/${projectId}.git`,
      })
      .onConflictDoNothing();
    const [row] = await tx
      .select()
      .from(repositories)
      .where(and(eq(repositories.companyId, ctx.companyId), eq(repositories.projectId, projectId)))
      .limit(1);
    return row!;
  }

  /**
   * Provision a per-task workspace (15 §3.1): repository ensured, worktree
   * volume cloned on branch `task/<n>-<slug>`, hardened container started —
   * then the row moves provisioning → ready with `workspace.provisioned`.
   * Idempotent: an existing live workspace for (task, level) is returned
   * as-is (backed by the partial unique index).
   */
  async provision(
    ctx: CompanyContext,
    input: ProvisionInput,
    port: SandboxPort,
  ): Promise<ProvisionResult> {
    const actor = input.actor ?? SYSTEM_ACTOR;
    const level: IsolationLevel = input.isolationLevel ?? "coding";
    if (!(ISOLATION_LEVELS as readonly string[]).includes(level)) {
      throw new WorkspaceError("WORKSPACE_TASK_INVALID", `unknown isolation level "${level}"`);
    }

    const [task] = await this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, input.taskId)))
      .limit(1);
    if (!task) {
      throw new WorkspaceError("WORKSPACE_NOT_FOUND", `task ${input.taskId} not found`);
    }
    if (!task.projectId) {
      throw new WorkspaceError(
        "WORKSPACE_TASK_INVALID",
        `task TASK-${task.number} has no project — coding workspaces need a repository`,
      );
    }
    const projectId = task.projectId;

    // C2/Y5 — ONE workspace per task, level escalated on demand.
    //
    // The lookup used to be keyed on (taskId, isolationLevel) while the volume
    // name is derived from the task alone. So `fs.read` (analysis) and
    // `fs.write` (coding) produced TWO workspace rows and TWO containers
    // mounting the SAME worktree volume, with `provisionWorktree` called twice
    // for it. Callers that query by taskId (`git.merge`, `checkpointBranch`)
    // then picked an arbitrary one — and `analysis` runs with `network: none`,
    // so a `terminal.run` that landed there saw `npm install` die for no
    // visible reason.
    //
    // A task now has a single workspace whose isolation is raised to the
    // highest level any tool has asked for (analysis < coding < testing);
    // raising it recreates the container over the same volume. Levels outside
    // that ladder (deploy/browser/media) are unrelated environments, so they
    // keep their own row.
    const onLadder = ESCALATION_LADDER.indexOf(level as (typeof ESCALATION_LADDER)[number]);
    const [live] = await this.db
      .select()
      .from(workspaces)
      .where(
        and(
          eq(workspaces.companyId, ctx.companyId),
          eq(workspaces.taskId, input.taskId),
          ...(onLadder < 0 ? [eq(workspaces.isolationLevel, level)] : []),
          notInArray(workspaces.status, ["merged", "discarded", "failed", "destroyed"]),
        ),
      )
      // deterministic: the task's first live workspace, never an arbitrary row
      .orderBy(asc(workspaces.createdAt))
      .limit(1);
    if (live) {
      const liveRank = ESCALATION_LADDER.indexOf(
        live.isolationLevel as (typeof ESCALATION_LADDER)[number],
      );
      // already at or above the requested level (or off-ladder) — reuse as-is
      if (onLadder < 0 || liveRank < 0 || onLadder <= liveRank) {
        return { workspace: live, baseCommit: null, created: false };
      }
      const escalated = await this.escalateIsolation(ctx, live, level, port, actor);
      return { workspace: escalated, baseCommit: null, created: false };
    }

    const branch = taskBranchName(task.number, task.title);
    const volumeName = worktreeVolumeName(task.number, task.id);
    const image = input.image ?? DEFAULT_IMAGE;

    const inserted = await this.db.transaction(async (tx) => {
      const repo = await this.ensureRepositoryInTx(tx, ctx, projectId);
      const [row] = await tx
        .insert(workspaces)
        .values({
          companyId: ctx.companyId,
          projectId,
          taskId: task.id,
          repositoryId: repo.id,
          agentId: input.agentId ?? task.ownerAgentId,
          isolationLevel: level,
          image,
          branch,
          volumePath: volumeName,
          status: "provisioning",
          limits: input.limits ?? {},
        })
        .returning();
      return row!;
    });

    let baseCommit: string;
    let containerId: string;
    try {
      await port.ensureRepo(projectId);
      const worktree = await port.provisionWorktree({ projectId, volumeName, branch });
      baseCommit = worktree.baseCommit;
      const container = await port.createContainer({
        workspaceId: inserted.id,
        isolation: level,
        image,
        volumeName,
      });
      containerId = container.containerId;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await this.db.transaction(async (tx) => {
        await tx
          .update(workspaces)
          .set({ status: "failed" })
          .where(and(eq(workspaces.companyId, ctx.companyId), eq(workspaces.id, inserted.id)));
        await emitDomainEvent(tx, ctx, {
          type: "workspace.status.changed",
          actor,
          taskId: task.id,
          projectId,
          payload: { workspaceId: inserted.id, from: "provisioning", to: "failed" },
        });
        await emitDomainEvent(tx, ctx, {
          type: "workspace.failed",
          actor,
          taskId: task.id,
          projectId,
          payload: { workspaceId: inserted.id, reason },
        });
      });
      throw new WorkspaceError("WORKSPACE_PROVISION_FAILED", reason);
    }

    const ready = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(workspaces)
        .set({ status: "ready", containerId })
        .where(and(eq(workspaces.companyId, ctx.companyId), eq(workspaces.id, inserted.id)))
        .returning();
      await emitDomainEvent(tx, ctx, {
        type: "workspace.status.changed",
        actor,
        taskId: task.id,
        projectId,
        payload: { workspaceId: inserted.id, from: "provisioning", to: "ready" },
      });
      await emitDomainEvent(tx, ctx, {
        type: "workspace.provisioned",
        actor,
        taskId: task.id,
        projectId,
        agentId: inserted.agentId,
        payload: {
          workspaceId: inserted.id,
          taskId: task.id,
          image,
          isolationLevel: level,
        },
      });
      return row!;
    });

    return { workspace: ready, baseCommit, created: true };
  }

  /**
   * C2 — raise a live workspace to a stronger isolation level in place: the
   * container is recreated at the new level over the SAME worktree volume, so
   * the agent's uncommitted work survives. The row keeps its id, its branch
   * and its status; only the level and the container change. A failure here
   * leaves the old container alone rather than stranding the task.
   */
  private async escalateIsolation(
    ctx: CompanyContext,
    live: WorkspaceRow,
    level: IsolationLevel,
    port: SandboxPort,
    actor: EventActor,
  ): Promise<WorkspaceRow> {
    let containerId: string;
    try {
      await port.destroyContainer(live.id);
      const container = await port.createContainer({
        workspaceId: live.id,
        isolation: level,
        image: live.image,
        volumeName: live.volumePath ?? "",
      });
      containerId = container.containerId;
    } catch (err) {
      throw new WorkspaceError(
        "WORKSPACE_PROVISION_FAILED",
        `isolation escalation ${live.isolationLevel} → ${level} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(workspaces)
        .set({ isolationLevel: level, containerId })
        .where(and(eq(workspaces.companyId, ctx.companyId), eq(workspaces.id, live.id)))
        .returning();
      // a new container over the same volume IS a provisioning event — the
      // Founder's workspace timeline should show the level change
      await emitDomainEvent(tx, ctx, {
        type: "workspace.provisioned",
        actor,
        taskId: live.taskId,
        projectId: live.projectId,
        agentId: live.agentId,
        payload: {
          workspaceId: live.id,
          taskId: live.taskId,
          image: live.image,
          isolationLevel: level,
        },
      });
      return row!;
    });
  }

  async get(ctx: CompanyContext, workspaceId: string): Promise<WorkspaceRow> {
    const [row] = await this.db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.companyId, ctx.companyId), eq(workspaces.id, workspaceId)))
      .limit(1);
    if (!row) throw new WorkspaceError("WORKSPACE_NOT_FOUND", `workspace ${workspaceId} not found`);
    return row;
  }

  /**
   * The ONE status writer — every transition is guarded by the canonical
   * workspace machine (_DECISIONS §19) and emits `workspace.status.changed`
   * plus the outcome-specific event; merged/discarded releases soft locks.
   */
  async transition(
    ctx: CompanyContext,
    workspaceId: string,
    to: WorkspaceStatus,
    opts: {
      actor?: EventActor | undefined;
      reason?: string | undefined;
      mergeCommit?: string | undefined;
    } = {},
  ): Promise<WorkspaceRow> {
    const actor = opts.actor ?? SYSTEM_ACTOR;
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(workspaces)
        .where(and(eq(workspaces.companyId, ctx.companyId), eq(workspaces.id, workspaceId)))
        .for("update");
      if (!row) {
        throw new WorkspaceError("WORKSPACE_NOT_FOUND", `workspace ${workspaceId} not found`);
      }
      const from = row.status as WorkspaceStatus;
      if (!workspaceMachine.canTransition(from, to)) {
        throw new WorkspaceError(
          "WORKSPACE_INVALID_TRANSITION",
          `workspace ${workspaceId}: illegal ${from} → ${to}`,
        );
      }

      const [updated] = await tx
        .update(workspaces)
        .set({ status: to, ...(to === "destroyed" && { destroyedAt: new Date() }) })
        .where(and(eq(workspaces.companyId, ctx.companyId), eq(workspaces.id, workspaceId)))
        .returning();

      const refs = { taskId: row.taskId, projectId: row.projectId };
      await emitDomainEvent(tx, ctx, {
        type: "workspace.status.changed",
        actor,
        ...refs,
        payload: { workspaceId, from, to },
      });
      if (to === "merged") {
        await emitDomainEvent(tx, ctx, {
          type: "workspace.merged",
          actor,
          ...refs,
          payload: {
            workspaceId,
            branch: row.branch ?? "",
            mergeCommit: opts.mergeCommit ?? "",
          },
        });
      } else if (to === "failed") {
        await emitDomainEvent(tx, ctx, {
          type: "workspace.failed",
          actor,
          ...refs,
          payload: { workspaceId, reason: opts.reason ?? "unspecified" },
        });
      } else if (to === "destroyed") {
        await emitDomainEvent(tx, ctx, {
          type: "workspace.destroyed",
          actor,
          ...refs,
          payload: { workspaceId, reason: opts.reason ?? from },
        });
      }
      if (to === "merged" || to === "discarded") {
        await this.releaseLocksInTx(tx, ctx, row, actor);
      }
      // Yaşayan ajan terminali workspace ile birlikte kapanır (INV-11: durum
      // + olay aynı tx). Aktif satır kalsaydı Founder panelinde günlerce açık
      // görünen donmuş terminal hücresi kalırdı (closeOrphanedTerminals'ın
      // yorumundaki canlı vaka) — artık son savunma o süpürme, ilk savunma bu.
      if (to === "merged" || to === "discarded" || to === "failed" || to === "destroyed") {
        await this.closeTerminalsInTx(tx, ctx, row, actor);
      }
      return updated!;
    });
  }

  private async closeTerminalsInTx(
    tx: Tx,
    ctx: CompanyContext,
    ws: WorkspaceRow,
    actor: EventActor,
  ): Promise<void> {
    const closed = await tx
      .update(terminalSessions)
      .set({ status: "closed", closedAt: new Date() })
      .where(
        and(
          eq(terminalSessions.companyId, ctx.companyId),
          eq(terminalSessions.workspaceId, ws.id),
          eq(terminalSessions.status, "active"),
        ),
      )
      .returning({ id: terminalSessions.id });
    for (const row of closed) {
      await emitDomainEvent(tx, ctx, {
        type: "workspace.terminal.closed",
        actor,
        taskId: ws.taskId,
        projectId: ws.projectId,
        payload: { sessionId: row.id, workspaceId: ws.id },
      });
    }
  }

  /**
   * Soft file locks (15 §3.8): advisory, warn-not-block. Acquiring upserts a
   * live lock on the path prefix and returns every overlapping live lock
   * held by OTHER workspaces on the same repository as a structured warning
   * (`workspace.lock.conflict` on the timeline) — the write itself is never
   * blocked.
   */
  async acquireLock(
    ctx: CompanyContext,
    input: { workspaceId: string; pathPrefix: string; actor?: EventActor | undefined },
  ): Promise<AcquireLockResult> {
    const actor = input.actor ?? SYSTEM_ACTOR;
    const pathPrefix = input.pathPrefix.replace(/^\/+/, "");
    if (pathPrefix === "") {
      throw new WorkspaceError("WORKSPACE_TASK_INVALID", "empty lock path");
    }
    return this.db.transaction(async (tx) => {
      const [ws] = await tx
        .select()
        .from(workspaces)
        .where(and(eq(workspaces.companyId, ctx.companyId), eq(workspaces.id, input.workspaceId)))
        .limit(1);
      if (!ws) {
        throw new WorkspaceError(
          "WORKSPACE_NOT_FOUND",
          `workspace ${input.workspaceId} not found`,
        );
      }
      if (!ws.repositoryId || !(LIVE_STATUSES as string[]).includes(ws.status)) {
        throw new WorkspaceError(
          "WORKSPACE_TASK_INVALID",
          `workspace ${input.workspaceId} cannot hold locks (status=${ws.status})`,
        );
      }

      const [existing] = await tx
        .select()
        .from(workspaceLocks)
        .where(
          and(
            eq(workspaceLocks.companyId, ctx.companyId),
            eq(workspaceLocks.workspaceId, ws.id),
            eq(workspaceLocks.pathPrefix, pathPrefix),
            sql`${workspaceLocks.releasedAt} IS NULL`,
          ),
        )
        .limit(1);

      let lock = existing;
      const created = !existing;
      if (!lock) {
        const [inserted] = await tx
          .insert(workspaceLocks)
          .values({
            companyId: ctx.companyId,
            workspaceId: ws.id,
            repositoryId: ws.repositoryId,
            taskId: ws.taskId,
            pathPrefix,
          })
          .returning();
        lock = inserted!;
      }

      // prefix overlap in either direction = the same subtree is being edited
      const overlapping = await tx
        .select({
          lock: workspaceLocks,
          wsStatus: workspaces.status,
        })
        .from(workspaceLocks)
        .innerJoin(workspaces, eq(workspaceLocks.workspaceId, workspaces.id))
        .where(
          and(
            eq(workspaceLocks.companyId, ctx.companyId),
            eq(workspaceLocks.repositoryId, ws.repositoryId),
            ne(workspaceLocks.workspaceId, ws.id),
            sql`${workspaceLocks.releasedAt} IS NULL`,
            or(
              sql`${workspaceLocks.pathPrefix} LIKE ${pathPrefix + "%"}`,
              sql`${pathPrefix} LIKE ${workspaceLocks.pathPrefix} || '%'`,
            ),
          ),
        );
      const conflicts: LockConflict[] = overlapping.map((o) => ({
        lockId: o.lock.id,
        workspaceId: o.lock.workspaceId,
        taskId: o.lock.taskId,
        pathPrefix: o.lock.pathPrefix,
      }));

      if (created) {
        await emitDomainEvent(tx, ctx, {
          type: "workspace.lock.acquired",
          actor,
          taskId: ws.taskId,
          projectId: ws.projectId,
          payload: {
            lockId: lock.id,
            paths: [pathPrefix],
            taskIds: ws.taskId ? [ws.taskId] : [],
          },
        });
        if (conflicts.length > 0) {
          const taskIds = [
            ...new Set(
              [ws.taskId, ...conflicts.map((c) => c.taskId)].filter((t): t is string => !!t),
            ),
          ];
          await emitDomainEvent(tx, ctx, {
            type: "workspace.lock.conflict",
            actor,
            taskId: ws.taskId,
            projectId: ws.projectId,
            payload: {
              lockId: lock.id,
              paths: [pathPrefix, ...conflicts.map((c) => c.pathPrefix)],
              taskIds,
            },
          });
        }
      }

      return { lock, conflicts, created };
    });
  }

  /** Release every live lock a workspace holds (also runs on merge/discard). */
  async releaseLocks(
    ctx: CompanyContext,
    workspaceId: string,
    actor: EventActor = SYSTEM_ACTOR,
  ): Promise<number> {
    return this.db.transaction(async (tx) => {
      const ws = await tx
        .select()
        .from(workspaces)
        .where(and(eq(workspaces.companyId, ctx.companyId), eq(workspaces.id, workspaceId)))
        .limit(1);
      if (!ws[0]) {
        throw new WorkspaceError("WORKSPACE_NOT_FOUND", `workspace ${workspaceId} not found`);
      }
      return this.releaseLocksInTx(tx, ctx, ws[0], actor);
    });
  }

  private async releaseLocksInTx(
    tx: Tx,
    ctx: CompanyContext,
    ws: WorkspaceRow,
    actor: EventActor,
  ): Promise<number> {
    const released = await tx
      .update(workspaceLocks)
      .set({ releasedAt: new Date() })
      .where(
        and(
          eq(workspaceLocks.companyId, ctx.companyId),
          eq(workspaceLocks.workspaceId, ws.id),
          sql`${workspaceLocks.releasedAt} IS NULL`,
        ),
      )
      .returning();
    if (released.length > 0) {
      await emitDomainEvent(tx, ctx, {
        type: "workspace.lock.released",
        actor,
        taskId: ws.taskId,
        projectId: ws.projectId,
        payload: {
          lockId: released[0]!.id,
          paths: released.map((l) => l.pathPrefix),
          taskIds: ws.taskId ? [ws.taskId] : [],
        },
      });
    }
    return released.length;
  }

  /** Live locks for a repository — delegation planning reads these to route
   *  tasks apart (ADR-010). */
  async liveLocks(ctx: CompanyContext, repositoryId: string): Promise<WorkspaceLockRow[]> {
    return this.db
      .select()
      .from(workspaceLocks)
      .where(
        and(
          eq(workspaceLocks.companyId, ctx.companyId),
          eq(workspaceLocks.repositoryId, repositoryId),
          sql`${workspaceLocks.releasedAt} IS NULL`,
        ),
      );
  }

  /** Open a terminal session record (frames stream via sandbox-manager). */
  async openTerminal(
    ctx: CompanyContext,
    input: {
      workspaceId: string;
      agentId?: string | undefined;
      title: string;
      cols?: number | undefined;
      rows?: number | undefined;
      actor?: EventActor | undefined;
    },
  ): Promise<TerminalSessionRow> {
    const actor = input.actor ?? SYSTEM_ACTOR;
    return this.db.transaction(async (tx) => {
      const [ws] = await tx
        .select()
        .from(workspaces)
        .where(and(eq(workspaces.companyId, ctx.companyId), eq(workspaces.id, input.workspaceId)))
        .limit(1);
      if (!ws) {
        throw new WorkspaceError(
          "WORKSPACE_NOT_FOUND",
          `workspace ${input.workspaceId} not found`,
        );
      }
      const values = {
        companyId: ctx.companyId,
        workspaceId: ws.id,
        agentId: input.agentId ?? null,
        title: input.title,
        ...(input.cols !== undefined && { cols: input.cols }),
        ...(input.rows !== undefined && { rows: input.rows }),
        logPath: "",
      };
      const [row] = await tx.insert(terminalSessions).values(values).returning();
      // log path is keyed by the session id (22 §5.2) — derived post-insert
      const [withLog] = await tx
        .update(terminalSessions)
        .set({ logPath: `/data/terminals/${row!.id}.log` })
        .where(
          and(eq(terminalSessions.companyId, ctx.companyId), eq(terminalSessions.id, row!.id)),
        )
        .returning();
      await emitDomainEvent(tx, ctx, {
        type: "workspace.terminal.opened",
        actor,
        taskId: ws.taskId,
        projectId: ws.projectId,
        agentId: input.agentId ?? null,
        payload: { sessionId: row!.id, workspaceId: ws.id },
      });
      return withLog!;
    });
  }

  /**
   * Munder-tarzı YAŞAYAN ajan terminali (2026-08-19 runtime; 22 §5.2, 24 §6.9).
   * Komut başına aç-kapa yerine ajan+workspace başına TEK aktif oturum:
   * `terminal.run` her çağrıda bu oturumu yeniden kullanır, kareler aynı
   * `term.<id>` konusunda ve aynı ring/log'da birikir — Founder ajanın bütün
   * komutlarını TEK canlı akışta izler ve oturum ajan yaşadıkça yaşar.
   * Oturum, workspace terminal duruma geçerken (transition) ya da açılış
   * süpürmesinde (closeOrphanedTerminals) kapanır.
   */
  async ensureAgentTerminal(
    ctx: CompanyContext,
    input: { workspaceId: string; agentId: string; actor?: EventActor | undefined },
  ): Promise<TerminalSessionRow> {
    const [existing] = await this.db
      .select()
      .from(terminalSessions)
      .where(
        and(
          eq(terminalSessions.companyId, ctx.companyId),
          eq(terminalSessions.workspaceId, input.workspaceId),
          eq(terminalSessions.agentId, input.agentId),
          eq(terminalSessions.status, "active"),
        ),
      )
      .orderBy(desc(terminalSessions.createdAt))
      .limit(1);
    if (existing) return existing;
    return this.openTerminal(ctx, {
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      title: "agent-live",
      actor: input.actor,
    });
  }

  /** Close a terminal session (idempotent). */
  async closeTerminal(
    ctx: CompanyContext,
    sessionId: string,
    actor: EventActor = SYSTEM_ACTOR,
  ): Promise<TerminalSessionRow> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(terminalSessions)
        .where(and(eq(terminalSessions.companyId, ctx.companyId), eq(terminalSessions.id, sessionId)))
        .for("update");
      if (!row) {
        throw new WorkspaceError(
          "TERMINAL_SESSION_NOT_FOUND",
          `terminal session ${sessionId} not found`,
        );
      }
      if (row.status === "closed") return row;
      const [ws] = await tx
        .select()
        .from(workspaces)
        .where(and(eq(workspaces.companyId, ctx.companyId), eq(workspaces.id, row.workspaceId)))
        .limit(1);
      const [updated] = await tx
        .update(terminalSessions)
        .set({ status: "closed", closedAt: new Date() })
        .where(and(eq(terminalSessions.companyId, ctx.companyId), eq(terminalSessions.id, sessionId)))
        .returning();
      await emitDomainEvent(tx, ctx, {
        type: "workspace.terminal.closed",
        actor,
        taskId: ws?.taskId ?? null,
        projectId: ws?.projectId ?? null,
        payload: { sessionId, workspaceId: row.workspaceId },
      });
      return updated!;
    });
  }

  /**
   * Açılışta öksüz terminal oturumlarını kapatır.
   *
   * Bir terminal oturumu, onu açan `exec` çağrısıyla aynı süreçte yaşar ve
   * normalde dispatch'in `finally` bloğunda kapanır. Ama sunucu exec sürerken
   * ölürse (yeniden dağıtım, çökme) satır sonsuza kadar `active` kalıyor:
   * hiçbir şey onu kapatmıyordu. Sonuç, Founder'ın panelinde GÜNLERCE "1 açık
   * terminal" görünmesi ve o hücrenin donmuş, iki gün önceki çıktıyı
   * göstermesiydi — 2026-08-14'ten kalma bir `pnpm test` oturumu 17 Ağustos'ta
   * hâlâ açıktı ve ekrandaki metin yapılmış bir düzeltmenin hâlâ bozuk
   * olduğunu düşündürdü.
   *
   * Açılışta hayatta kalan hiçbir oturum canlı OLAMAZ: sahibi olan süreç
   * öldü. Bu yüzden kapatmak doğru ve güvenli. Kapanışlar tek tek
   * `closeTerminal`'den geçer — her biri kendi `workspace.terminal.closed`
   * olayını üretir (INV-11: durum değişikliği olaysız olmaz).
   */
  async closeOrphanedTerminals(companyIds: readonly string[]): Promise<number> {
    let closed = 0;
    // ŞİRKET BAŞINA: kiracı tablosuna `company_id` yüklemi olmadan sorgu
    // atılamaz (S4 — guard bunu TenancyViolationError ile reddediyor ve
    // haklı; ilk sürümüm şirketler arası tarama yapıp sunucunun açılışını
    // kırdı). Şirket listesi çağıran taraftan gelir.
    for (const companyId of companyIds) {
      const rows = await this.db
        .select({ id: terminalSessions.id })
        .from(terminalSessions)
        .where(
          and(
            eq(terminalSessions.companyId, companyId),
            eq(terminalSessions.status, "active"),
          ),
        );
      for (const row of rows) {
        try {
          await this.closeTerminal({ companyId }, row.id);
          closed += 1;
        } catch {
          // tek bir oturumun kapanmaması açılışı engellememeli
        }
      }
    }
    return closed;
  }
}
