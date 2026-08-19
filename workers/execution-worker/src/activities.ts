// The canonical execution-queue activities (09 §2/§4, 08 §12, T40):
// runCommandActivity / gitOperationActivity / runTestsActivity /
// buildActivity. Activities-only — this worker registers NO workflows; the
// activities are children of workflows on agent-tasks/intake. Every one
// routes through the Tool Gateway (S3) and HEARTBEATS while the command
// runs so a worker crash reschedules on another worker (08 §12).
//
// Result semantics (08 §12): a non-zero exit code is a RESULT the calling
// workflow reasons about — never an activity failure. Only infra problems
// (gateway unreachable / 5xx) throw, and only those retry.
import { heartbeat } from "@temporalio/activity";
import type { ToolInvokeWireResponse } from "@acos/contracts";
import type { InvokeGateway } from "./gateway-client.js";

export interface ExecutionContext {
  companyId: string;
  agentId: string;
  taskId: string;
  agentSessionId?: string | undefined;
  /** Deterministic key from the caller (e.g. step id) — exactly-once effect. */
  idempotencyKey?: string | undefined;
  /** S5 taint bit — propagated to the gateway for risk elevation. */
  tainted?: boolean | undefined;
}

export interface CommandResult {
  decision: ToolInvokeWireResponse["decision"];
  status: ToolInvokeWireResponse["status"];
  exitCode: number | null;
  stdoutTail: string;
  stderrTail: string;
  durationMs: number | null;
  terminalSessionId: string | null;
  costCents: number;
  reason: string | null;
  error: string | null;
}

const HEARTBEAT_EVERY_MS = 10_000;

/** Runs `fn` with a liveness heartbeat (08 §12: 15s PTY heartbeat class). */
async function withHeartbeat<T>(detail: string, fn: () => Promise<T>): Promise<T> {
  const safeBeat = () => {
    try {
      heartbeat(detail);
    } catch {
      /* outside an activity context (direct call in tests) — fine */
    }
  };
  safeBeat();
  const timer = setInterval(safeBeat, HEARTBEAT_EVERY_MS);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

function toCommandResult(res: ToolInvokeWireResponse): CommandResult {
  const output = (res.output ?? {}) as {
    exitCode?: number;
    stdoutTail?: string;
    stderrTail?: string;
    durationMs?: number;
    terminalSessionId?: string;
  };
  return {
    decision: res.decision,
    status: res.status,
    exitCode: output.exitCode ?? null,
    stdoutTail: output.stdoutTail ?? "",
    stderrTail: output.stderrTail ?? "",
    durationMs: output.durationMs ?? null,
    terminalSessionId: output.terminalSessionId ?? null,
    costCents: res.costCents ?? 0,
    reason: res.reason,
    error: res.error ?? null,
  };
}

export interface ExecutionActivityDeps {
  invokeGateway: InvokeGateway;
}

export function createExecutionActivities(deps: ExecutionActivityDeps) {
  const invokeTerminal = async (
    ctx: ExecutionContext,
    command: string,
    opts: { cwd?: string; timeoutSec?: number; env?: Record<string, string> } = {},
  ): Promise<CommandResult> => {
    const res = await withHeartbeat(`terminal.run: ${command.slice(0, 80)}`, () =>
      deps.invokeGateway({
        companyId: ctx.companyId,
        agentId: ctx.agentId,
        taskId: ctx.taskId,
        ...(ctx.agentSessionId && { agentSessionId: ctx.agentSessionId }),
        ...(ctx.idempotencyKey && { idempotencyKey: ctx.idempotencyKey }),
        ...(ctx.tainted !== undefined && { tainted: ctx.tainted }),
        toolName: "terminal.run",
        input: {
          command,
          ...(opts.cwd && { cwd: opts.cwd }),
          ...(opts.timeoutSec && { timeoutSec: opts.timeoutSec }),
          ...(opts.env && { env: opts.env }),
        },
      }),
    );
    return toCommandResult(res);
  };

  return {
    /** Arbitrary shell command in the task workspace (terminal.run). */
    async runCommandActivity(
      input: ExecutionContext & {
        command: string;
        cwd?: string;
        timeoutSec?: number;
        env?: Record<string, string>;
      },
    ): Promise<CommandResult> {
      return invokeTerminal(input, input.command, {
        ...(input.cwd !== undefined && { cwd: input.cwd }),
        ...(input.timeoutSec !== undefined && { timeoutSec: input.timeoutSec }),
        ...(input.env !== undefined && { env: input.env }),
      });
    },

    /** Test run — default 600s window (08 §12 terminal/test class). */
    async runTestsActivity(
      input: ExecutionContext & { command?: string; timeoutSec?: number },
    ): Promise<CommandResult> {
      return invokeTerminal(input, input.command ?? "npm test", {
        timeoutSec: input.timeoutSec ?? 600,
      });
    },

    /** Build run — default 1800s window (08 §12 build class). */
    async buildActivity(
      input: ExecutionContext & { command?: string; timeoutSec?: number },
    ): Promise<CommandResult> {
      return invokeTerminal(input, input.command ?? "npm run build", {
        timeoutSec: input.timeoutSec ?? 1800,
      });
    },

    /** Git plumbing via the git.* tools (diff/commit now; push/merge T43). */
    async gitOperationActivity(
      input: ExecutionContext &
        (
          | { op: "diff"; against?: string; paths?: string[]; stat?: boolean }
          | { op: "commit"; message: string; paths?: string[]; allowEmpty?: boolean }
        ),
    ): Promise<ToolInvokeWireResponse> {
      const toolName = input.op === "diff" ? "git.diff" : "git.commit";
      const toolInput =
        input.op === "diff"
          ? {
              ...(input.against !== undefined && { against: input.against }),
              ...(input.paths !== undefined && { paths: input.paths }),
              ...(input.stat !== undefined && { stat: input.stat }),
            }
          : {
              message: input.message,
              ...(input.paths !== undefined && { paths: input.paths }),
              ...(input.allowEmpty !== undefined && { allowEmpty: input.allowEmpty }),
            };
      return withHeartbeat(`${toolName}`, () =>
        deps.invokeGateway({
          companyId: input.companyId,
          agentId: input.agentId,
          taskId: input.taskId,
          ...(input.agentSessionId && { agentSessionId: input.agentSessionId }),
          ...(input.idempotencyKey && { idempotencyKey: input.idempotencyKey }),
          ...(input.tainted !== undefined && { tainted: input.tainted }),
          toolName,
          input: toolInput,
        }),
      );
    },
  };
}

export type ExecutionActivities = ReturnType<typeof createExecutionActivities>;
