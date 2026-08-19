// Deterministic fake ModelRouter (32 §6, T30). LLM_MODE=scripted loads
// scripted AgentAction sequences per (role, taskFixture) from YAML. Every
// step is validated against the REAL AgentAction union at load — a script
// that drifts from the action schema fails immediately, keeping fakes
// honest. Branching (when / onSignal) is deliberately minimal; anything
// smarter belongs in a custom fake, not YAML.
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { AgentActionSchema, CONTEXT_SENTINEL_UUID, type AgentAction } from "../agent-action.js";
import type { ProviderAdapter } from "../router.js";
import type { LlmUsage } from "../types.js";
import { pseudoEmbedding } from "./embeddings.js";

// ---------- script format (32 §6.1 canonical) ----------

const StepSchema = z.object({
  action: z.string(),
  args: z.record(z.string(), z.unknown()).default({}),
  when: z
    .object({ lastToolResult: z.object({ exitCode: z.enum(["zero", "nonzero"]) }) })
    .optional(),
  onSignal: z.record(z.string(), z.string()).optional(),
});

export const ScriptSchema = z.object({
  // agentName narrows a (role, taskFixture) tie — seed agents share roles
  // (CEO and CTO are both `executive`), so the delegation-cascade scripts
  // (T36) key on the stable seed names.
  match: z.object({ role: z.string(), taskFixture: z.string(), agentName: z.string().optional() }),
  steps: z.array(StepSchema).min(1),
});
export type Script = z.infer<typeof ScriptSchema>;
export type ScriptStep = z.infer<typeof StepSchema>;

export class ScriptLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptLoadError";
  }
}

/** Context sentinel doubles as the load-time placeholder: an id a script
 *  does not know is resolved by the worker's action dispatch (T36). */
const PLACEHOLDER_UUID = CONTEXT_SENTINEL_UUID;

/**
 * Script args are shorthand (32 §6.1: `{status: IN_PROGRESS}`, not the full
 * action payload) — this normalizer expands them into a full AgentAction.
 * Runtime ids come from the substitution context; load-time validation uses
 * deterministic placeholders so schema drift still explodes at load.
 */
export function normalizeStep(
  step: ScriptStep,
  ids: { taskId?: string; artifactId?: string; channelId?: string; toAgentId?: string } = {},
): AgentAction {
  const args = step.args;
  const taskId = ids.taskId ?? PLACEHOLDER_UUID;
  const str = (key: string, fallback = ""): string =>
    typeof args[key] === "string" ? (args[key] as string) : fallback;

  let candidate: Record<string, unknown>;
  switch (step.action) {
    case "update_task_status":
      candidate = { type: step.action, taskId, to: args.status ?? args.to, note: str("note", "scripted") };
      break;
    case "use_tool": {
      const { tool, ...input } = args;
      candidate = { type: step.action, tool, input, reason: str("reason", "scripted step") };
      break;
    }
    case "request_review": {
      const hint = str("reviewerHint");
      candidate = {
        type: step.action,
        taskId,
        artifactId: ids.artifactId ?? PLACEHOLDER_UUID,
        // non-uuid hints ("lead") ride in the summary; uuid hints pass through
        ...(z.uuid().safeParse(hint).success && { reviewerHint: hint }),
        summary: str("summary", hint ? `review requested (hint: ${hint})` : "review requested"),
      };
      break;
    }
    case "complete_task":
      candidate = {
        type: step.action,
        result: {
          summary: str("summary", `scripted completion (${str("summaryRef", "no-ref")})`),
          criteria: [],
          artifactIds: [],
          cost: { tokensIn: 0, tokensOut: 0, cents: 0 },
        },
      };
      break;
    case "delegate_task":
      candidate = {
        type: step.action,
        taskId,
        toAgentId: ids.toAgentId ?? str("toAgentId", PLACEHOLDER_UUID),
        note: str("note", "scripted delegation"),
      };
      break;
    case "send_message":
      candidate = {
        type: step.action,
        channelId: ids.channelId ?? str("channelId", PLACEHOLDER_UUID),
        kind: args.kind ?? "text",
        body: str("body", "scripted message"),
      };
      break;
    case "wait_for":
      candidate = { type: step.action, what: args.what ?? "reply", ...(typeof args.timeoutMinutes === "number" && { timeoutMinutes: args.timeoutMinutes }) };
      break;
    case "request_help":
      candidate = {
        type: step.action,
        topic: str("topic", "scripted help"),
        body: str("body", "scripted help request"),
        audience: args.audience ?? "team",
      };
      break;
    case "create_task":
      candidate = {
        type: step.action,
        kind: args.kind,
        // scripts do not know runtime ids — the sentinel resolves to the
        // agent's current task in the worker's action dispatch (T36)
        parentTaskId: str("parentTaskId", PLACEHOLDER_UUID),
        title: str("title", "scripted child task"),
        objective: str("objective", "scripted objective"),
        successCriteria: Array.isArray(args.successCriteria) ? args.successCriteria : ["done"],
        priority: args.priority ?? "P2",
        estimatedEffort: typeof args.estimatedEffort === "number" ? args.estimatedEffort : 1,
        ...(typeof args.risk === "string" && { risk: args.risk }),
      };
      break;
    case "escalate":
      candidate = {
        type: step.action,
        reason: str("reason", "scripted escalation"),
        attempted: Array.isArray(args.attempted) ? args.attempted : [],
        options: [],
        recommendation: str("recommendation", "scripted"),
      };
      break;
    case "think":
      candidate = { type: step.action, thought: str("thought", "scripted thought") };
      break;
    default:
      // everything else must already be full-shape in args
      candidate = { type: step.action, ...args };
  }
  const parsed = AgentActionSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ScriptLoadError(
      `step "${step.action}" drifts from the AgentAction schema: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

/** Parses + validates a YAML script — throws ScriptLoadError on any drift. */
export function loadScript(yamlText: string): Script {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    throw new ScriptLoadError(`invalid YAML: ${String(err)}`);
  }
  const script = ScriptSchema.safeParse(raw);
  if (!script.success) {
    throw new ScriptLoadError(
      `invalid script shape: ${script.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  for (const step of script.data.steps) normalizeStep(step); // load-time union check
  return script.data;
}

// ---------- the scripted session (drives one workflow run) ----------

export interface StepObservation {
  lastToolResult?: { exitCode: number } | undefined;
  signals?: Record<string, string> | undefined;
}

export class ScriptedSession {
  private cursor = 0;

  constructor(
    private readonly script: Script,
    private readonly ids: Parameters<typeof normalizeStep>[1] = {},
  ) {}

  /** Next action given the observed state; branch steps that don't match are skipped. */
  next(observation: StepObservation = {}): AgentAction | null {
    while (this.cursor < this.script.steps.length) {
      const step = this.script.steps[this.cursor]!;
      this.cursor += 1;
      if (step.when) {
        const exit = observation.lastToolResult?.exitCode ?? 0;
        const wanted = step.when.lastToolResult.exitCode;
        const matches = wanted === "zero" ? exit === 0 : exit !== 0;
        if (!matches) continue; // branch not taken
      }
      if (step.onSignal) {
        const matches = Object.entries(step.onSignal).every(
          ([signal, value]) => observation.signals?.[signal] === value,
        );
        if (!matches) continue;
      }
      return normalizeStep(step, this.ids);
    }
    return null; // script exhausted
  }

  get exhausted(): boolean {
    return this.cursor >= this.script.steps.length;
  }
}

// ---------- port-compatible scripted adapter ----------

const SCRIPT_USAGE: LlmUsage = { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0 };

/**
 * A ProviderAdapter whose completions replay scripted sessions. Matching keys
 * are read from message markers `[role:<r>]` and `[taskFixture:<f>]` (the
 * scripted working set carries them); observations ride in markers
 * `[lastExitCode:<n>]` and `[signal:<name>=<value>]`.
 */
export function createScriptedAdapter(
  scripts: readonly Script[],
  ids: Parameters<typeof normalizeStep>[1] = {},
): ProviderAdapter {
  const sessions = new Map<string, ScriptedSession>();
  return {
    providerId: "scripted",
    async complete(input) {
      const text = input.messages.map((m) => m.content).join("\n");
      const role = /\[role:([^\]]+)\]/.exec(text)?.[1];
      const fixture = /\[taskFixture:([^\]]+)\]/.exec(text)?.[1];
      const agentName = /\[agentName:([^\]]+)\]/.exec(text)?.[1];
      const ctxTask = /\[ctxTask:([^\]]+)\]/.exec(text)?.[1] ?? "none";
      const candidates = scripts.filter(
        (s) => s.match.role === role && s.match.taskFixture === fixture,
      );
      // name-scoped script wins over the generic one for the same (role, fixture)
      const script =
        candidates.find((s) => s.match.agentName !== undefined && s.match.agentName === agentName) ??
        candidates.find((s) => s.match.agentName === undefined);
      if (!script) {
        throw new ScriptLoadError(
          `no script matches role=${role} taskFixture=${fixture} agentName=${agentName}`,
        );
      }
      // sessions are per (script, agent, task): two agents sharing a generic
      // script must not interleave one cursor (T36 delegation cascade)
      const key = `${role}::${fixture}::${agentName}::${ctxTask}`;
      let session = sessions.get(key);
      if (!session) {
        session = new ScriptedSession(script, ids);
        sessions.set(key, session);
      }
      const exitCode = Number(/\[lastExitCode:(\d+)\]/.exec(text)?.[1] ?? "0");
      const signals: Record<string, string> = {};
      for (const match of text.matchAll(/\[signal:([^=\]]+)=([^\]]+)\]/g)) {
        signals[match[1]!] = match[2]!;
      }
      const action = session.next({ lastToolResult: { exitCode }, signals });
      if (!action) throw new ScriptLoadError(`script ${key} is exhausted`);
      return { text: JSON.stringify(action), usage: SCRIPT_USAGE, finishReason: "stop" };
    },
    async embed(input) {
      return {
        embedding: pseudoEmbedding(input.text),
        usage: { inputTokens: Math.ceil(input.text.length / 4), outputTokens: 0, cachedInputTokens: 0 },
      };
    },
  };
}
