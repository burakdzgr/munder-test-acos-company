// Temporal activities for the CLI-session runtime (E4/T31, ADR-022).
//   resolveAgentRuntimeActivity — steps | cli for this turn (config + task shape)
//   runCliSessionActivity       — ONE long-lived activity = the whole agent turn:
//     provision/ensure the workspace + the agent's live terminal, then
//     driveSession() (admission → broker → gateway → claude in the PTY → watch
//     → close → revoke), then persist session-level llm_calls from the broker's
//     metered usage (closes the accounting gap ADR-022 calls out) and roll the
//     totals into agent_sessions. Heartbeats every 10s so the workflow's
//     heartbeatTimeout reschedules a dead worker fast.
import { and, eq } from "drizzle-orm";
import { uuidv5 } from "@acos/domain";
import { WorkspaceService, companyContext, type GuardedDb } from "@acos/db";
import { agentSessions, agents, companies, llmCalls, modelProviders, positions, tasks } from "@acos/db/schema";
import type { RuntimeEventPort } from "../runtime-events.js";
import { buildCliBrief } from "./brief.js";
import { createWorkspaceSandboxPort } from "./clients.js";
import { driveSession, type DriveInput } from "./drive.js";
import {
  ALWAYS_ADMIT,
  type AdmissionPort,
  type BrokerPort,
  type CliOutcome,
  type GatewaySessionPort,
  type SandboxSessionPort,
  type SessionLimits,
} from "./ports.js";

export interface CliRuntimeConfig {
  /** Global switch; "steps" = the classic callModelActivity loop. */
  readonly runtime: "steps" | "cli";
  readonly sessionMode: "interactive" | "print";
  readonly workspaceKind: "auto" | "worktree" | "session";
  readonly workspaceImage: string;
  readonly model: string | undefined;
  readonly limits: SessionLimits;
  readonly admissionWaitMs: number;
  readonly pollMs: number;
  readonly endGraceMs: number;
  readonly cols: number;
  readonly rows: number;
}

export interface CliSessionActivityDeps {
  readonly guardedDb: GuardedDb;
  readonly config: CliRuntimeConfig;
  readonly broker: BrokerPort;
  readonly gateway: GatewaySessionPort;
  readonly sandboxSessions: SandboxSessionPort;
  /** sandbox-manager HTTP for WorkspaceService provisioning (same bearer). */
  readonly sandboxHttp: { baseUrl: string; token: string };
  readonly admission?: AdmissionPort | undefined;
  readonly runtimeEvents?: RuntimeEventPort | undefined;
  readonly heartbeat?: ((detail: string) => () => void) | undefined;
  readonly nowMs?: (() => number) | undefined;
  readonly log?: ((msg: string, meta?: Record<string, unknown>) => void) | undefined;
}

export interface CliSessionRef {
  companyId: string;
  agentId: string;
  taskId: string;
  sessionId: string;
}

export interface RunCliSessionResult {
  outcome: CliOutcome;
  endedBy: string;
  exitCode: number | null;
  finalTaskStatus: string;
  requests: number;
  tokensIn: number;
  tokensOut: number;
  terminalSessionId: string;
  workspaceId: string;
}

/** Planning-shaped work gets the light session workspace (no worktree). */
export function workspaceKindForTask(taskKind: string, configured: CliRuntimeConfig["workspaceKind"]): "worktree" | "session" {
  if (configured !== "auto") return configured;
  return taskKind === "goal" || taskKind === "initiative" || taskKind === "epic" ? "session" : "worktree";
}

export function createCliSessionActivities(deps: CliSessionActivityDeps) {
  const { guardedDb, config } = deps;
  const workspaceService = new WorkspaceService(guardedDb);
  const now = deps.nowMs ?? (() => Date.now());
  const log = deps.log ?? ((msg, meta) => console.log(JSON.stringify({ msg, ...meta })));
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  /** The provider row CLI-session llm_calls attribute to (global row; idempotent). */
  async function ensureCliProvider(): Promise<{ id: string }> {
    const [byName] = await guardedDb.select({ id: modelProviders.id }).from(modelProviders).where(eq(modelProviders.name, "claude-cli")).limit(1);
    if (byName) return byName;
    const [anthropic] = await guardedDb.select({ id: modelProviders.id }).from(modelProviders).where(eq(modelProviders.kind, "anthropic")).limit(1);
    if (anthropic) return anthropic;
    await guardedDb.insert(modelProviders).values({ kind: "anthropic", name: "claude-cli", enabled: true }).onConflictDoNothing();
    const [created] = await guardedDb.select({ id: modelProviders.id }).from(modelProviders).where(eq(modelProviders.name, "claude-cli")).limit(1);
    if (!created) throw new Error("cli session: could not ensure the claude-cli model_providers row");
    log("cli session: created model_providers row claude-cli (anthropic) for session-level llm_calls", { providerId: created.id });
    return created;
  }

  const rt = (ref: CliSessionRef, payload: Record<string, unknown>) =>
    deps.runtimeEvents?.emit(ref.companyId, {
      type: "agent.status",
      sessionId: ref.sessionId,
      agentId: ref.agentId,
      taskId: ref.taskId,
      payload: { runtime: "cli", ...payload },
    });

  return {
    async resolveAgentRuntimeActivity(ref: CliSessionRef): Promise<{ kind: "steps" | "cli"; reason: string }> {
      if (config.runtime !== "cli") return { kind: "steps", reason: "ACOS_AGENT_RUNTIME=steps" };
      const ctx = companyContext(ref.companyId);
      const [task] = await guardedDb
        .select({ projectId: tasks.projectId })
        .from(tasks)
        .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, ref.taskId)))
        .limit(1);
      if (!task) return { kind: "steps", reason: "task not found" };
      // a workspace (even the light one) needs a project — project-less tasks
      // keep the steps loop until the workspace model grows a company scope
      if (!task.projectId) return { kind: "steps", reason: "task has no project → no session workspace" };
      return { kind: "cli", reason: "ACOS_AGENT_RUNTIME=cli" };
    },

    async runCliSessionActivity(ref: CliSessionRef): Promise<RunCliSessionResult> {
      const stopBeat = deps.heartbeat?.("cli session") ?? (() => {});
      const ctx = companyContext(ref.companyId);
      try {
        // ---- load the brief's inputs
        const [task] = await guardedDb
          .select({
            number: tasks.number,
            title: tasks.title,
            objective: tasks.objective,
            successCriteria: tasks.successCriteria,
            kind: tasks.kind,
            priority: tasks.priority,
            status: tasks.status,
            parentId: tasks.parentId,
          })
          .from(tasks)
          .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, ref.taskId)))
          .limit(1);
        if (!task) throw new Error(`task ${ref.taskId} not found`);
        const [agent] = await guardedDb
          .select({ name: agents.name, persona: agents.persona, seniority: agents.seniority, positionId: agents.positionId })
          .from(agents)
          .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, ref.agentId)))
          .limit(1);
        if (!agent) throw new Error(`agent ${ref.agentId} not found`);
        const [company] = await guardedDb.select({ name: companies.name }).from(companies).where(eq(companies.id, ctx.companyId)).limit(1);
        const [position] = agent.positionId
          ? await guardedDb.select({ title: positions.title }).from(positions).where(and(eq(positions.companyId, ctx.companyId), eq(positions.id, agent.positionId))).limit(1)
          : [];
        const [parent] = task.parentId
          ? await guardedDb.select({ title: tasks.title }).from(tasks).where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, task.parentId))).limit(1)
          : [];

        // ---- workspace (worktree for coding work, light session for planning work) + live terminal
        const kind = workspaceKindForTask(task.kind, config.workspaceKind);
        const port = createWorkspaceSandboxPort(deps.sandboxHttp, config.workspaceImage, "coding");
        const { workspace } = await workspaceService.provision(
          ctx,
          { taskId: ref.taskId, agentId: ref.agentId, isolationLevel: "coding", image: config.workspaceImage, kind },
          port,
        );
        if (!["ready", "in_use", "idle"].includes(workspace.status)) {
          throw new Error(`workspace ${workspace.id} unusable (status=${workspace.status})`);
        }
        if (workspace.status === "ready" || workspace.status === "idle") {
          await workspaceService.transition(ctx, workspace.id, "in_use", { actor: { kind: "agent", id: ref.agentId } });
        }
        const terminal = await workspaceService.ensureAgentTerminal(ctx, { workspaceId: workspace.id, agentId: ref.agentId });
        const cwd = kind === "worktree" ? "/work" : "/home/node";
        rt(ref, { phase: "starting", workspaceId: workspace.id, terminalSessionId: terminal.id, workspaceKind: kind });

        const brief = buildCliBrief({
          company: { name: company?.name ?? "the company" },
          agent: { name: agent.name, persona: agent.persona, seniority: agent.seniority, positionTitle: position?.title ?? null },
          task: {
            number: task.number,
            title: task.title,
            objective: task.objective,
            successCriteria: task.successCriteria ?? [],
            kind: task.kind,
            priority: task.priority,
            status: task.status,
            parentTitle: parent?.title ?? null,
          },
          workspace: { kind, cwd, branch: workspace.branch ?? null },
        });

        const input: DriveInput = {
          companyId: ref.companyId,
          agentId: ref.agentId,
          taskId: ref.taskId,
          agentSessionId: ref.sessionId,
          terminalSessionId: terminal.id,
          workspaceId: workspace.id,
          cwd,
          brief,
          model: config.model,
          sessionMode: config.sessionMode,
          limits: config.limits,
          cols: terminal.cols,
          rows: terminal.rows,
        };
        const result = await driveSession(
          {
            admission: deps.admission ?? ALWAYS_ADMIT,
            broker: deps.broker,
            gateway: deps.gateway,
            sandbox: deps.sandboxSessions,
            task: {
              status: async () => {
                const [row] = await guardedDb
                  .select({ status: tasks.status })
                  .from(tasks)
                  .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, ref.taskId)))
                  .limit(1);
                return row?.status ?? "UNKNOWN";
              },
            },
          },
          input,
          {
            pollMs: config.pollMs,
            admissionWaitMs: config.admissionWaitMs,
            endGraceMs: config.endGraceMs,
            nowMs: now,
            sleep,
            log,
          },
        );
        rt(ref, { phase: "ended", endedBy: result.endedBy, outcome: result.outcome, exitCode: result.exitCode });

        // ---- session-level llm_calls from the broker's metered usage (idempotent ids)
        let tokensIn = 0;
        let tokensOut = 0;
        const requests = result.usage?.requests ?? [];
        if (requests.length > 0) {
          // llm_calls.provider_id is NOT NULL: the CLI session's spend is attributed
          // to the `claude-cli` provider row, created once if the stack never seeded
          // it (live finding 2026-08-21: the scripted e2e stack has only the
          // `scripted` provider, so session-level rows were silently skipped).
          const provider = await ensureCliProvider();
          for (const r of requests) {
            const tin = (r.usage?.inputTokens ?? 0) + (r.usage?.cacheCreationInputTokens ?? 0);
            const tout = r.usage?.outputTokens ?? 0;
            tokensIn += tin;
            tokensOut += tout;
            await guardedDb
              .insert(llmCalls)
              .values({
                id: uuidv5(`cli:${r.requestId}`, ref.sessionId),
                companyId: ctx.companyId,
                agentId: ref.agentId,
                taskId: ref.taskId,
                agentSessionId: ref.sessionId,
                purpose: "reasoning",
                providerId: provider.id,
                model: r.model ?? "claude-cli",
                tokensIn: tin,
                tokensOut: tout,
                tokensCached: r.usage?.cacheReadInputTokens ?? 0,
                costCents: 0, // claude-cli pricing is T5's open card; subscription spend is metered, not priced
                latencyMs: r.durationMs,
                status: r.status === 200 ? "ok" : r.status === 429 ? "rate_limited" : "error",
                correlationId: ref.sessionId,
                contextTelemetry: { runtime: "cli", brokerRequestId: r.requestId, httpStatus: r.status },
              })
              .onConflictDoNothing();
          }
          await guardedDb
            .update(agentSessions)
            .set({ tokensIn, tokensOut, stepsCount: requests.length })
            .where(and(eq(agentSessions.companyId, ctx.companyId), eq(agentSessions.id, ref.sessionId)));
        }

        // the worktree stays for review/merge; the container goes idle for the GC
        await workspaceService.transition(ctx, workspace.id, "idle", { actor: { kind: "agent", id: ref.agentId } }).catch(() => {});

        return {
          outcome: result.outcome,
          endedBy: result.endedBy,
          exitCode: result.exitCode,
          finalTaskStatus: result.finalTaskStatus,
          requests: requests.length,
          tokensIn,
          tokensOut,
          terminalSessionId: terminal.id,
          workspaceId: workspace.id,
        };
      } finally {
        stopBeat();
      }
    },
  };
}
