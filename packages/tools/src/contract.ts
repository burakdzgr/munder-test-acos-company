// Tool definition contract (17 §2, _DECISIONS §12; T39). Pure and IO-free:
// Zod schemas + risk/scope/sandbox metadata shared by the Tool Gateway
// (validation + authorization) and the agent runtime (Working-Set tool list).
import type { z } from "zod";
import type { RiskClass } from "@acos/domain";
import type { FounderOnlyCategory } from "@acos/domain/policies";

export type ToolScope = "fs" | "git" | "network" | "db" | "money" | "publish";

/** Minimum isolation the tool's execution requires (17 §2). `none` runs in
 *  the apps/server process (adapters) — no agent code executes there. */
export type ToolSandboxLevel =
  | "none"
  | "analysis"
  | "coding"
  | "testing"
  | "browser"
  | "media"
  | "deploy";

export interface ToolCostEstimate {
  amountCents: number;
  confidence: "exact" | "estimate";
}

export interface ToolRateLimit {
  perAgentPerMin: number;
  perCompanyPerMin: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ToolDefinition<In extends z.ZodTypeAny = any, Out extends z.ZodTypeAny = any> {
  /** Dot-namespaced: "fs.read", "git.merge". */
  name: string;
  /** Bumped on breaking schema change. */
  version: number;
  /** Shown to the LLM in the Working-Set tool list. */
  description: string;
  /** Validated at the gateway BEFORE authorization. */
  input: In;
  /** Validated on result; mismatch = tool failure. */
  output: Out;
  /** Static base class; taint may ELEVATE it at runtime (17 §7.4, S5). */
  risk: RiskClass;
  scopes: ToolScope[];
  sandboxLevel: ToolSandboxLevel;
  /** true ⇒ safe to retry without an idempotency key. */
  sideEffectFree: boolean;
  estimateCost(input: z.infer<In>): ToolCostEstimate;
  /** Hard end-to-end execution timeout, gateway-enforced. */
  timeoutMs: number;
  /** Overrides the per-risk-class defaults (17 §6). */
  rateLimit?: ToolRateLimit;
  /** Secret names resolved SERVER-SIDE at dispatch only (S2). */
  credentialRefs?: string[];
  /** S6: hard platform category — ALWAYS require_approval(founder). */
  founderCategory?: FounderOnlyCategory;
}

/** Default per-agent/company rate limits by risk class (17 §6). */
export const DEFAULT_RATE_LIMITS: Readonly<Record<RiskClass, ToolRateLimit>> = {
  R0: { perAgentPerMin: 60, perCompanyPerMin: 600 },
  R1: { perAgentPerMin: 30, perCompanyPerMin: 300 },
  R2: { perAgentPerMin: 6, perCompanyPerMin: 30 },
  R3: { perAgentPerMin: 2, perCompanyPerMin: 6 },
};

export function rateLimitFor(def: ToolDefinition): ToolRateLimit {
  return def.rateLimit ?? DEFAULT_RATE_LIMITS[def.risk];
}

/**
 * Grant/policy pattern matching (17 §4.1): exact tool name, or a prefix glob
 * ending in ".*" ("git.*" covers "git.commit"), or the full wildcard "*".
 */
export function matchesToolPattern(pattern: string, toolName: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return toolName.startsWith(pattern.slice(0, -1));
  return pattern === toolName;
}

/** Taint → risk elevation (17 §7.4, S5): one class up, capped at R3. */
export function elevateRisk(risk: RiskClass): RiskClass {
  switch (risk) {
    case "R0":
      return "R1";
    case "R1":
      return "R2";
    default:
      return "R3";
  }
}

const SECRET_ENV_PATTERN = /TOKEN|KEY|SECRET|PASS/i;

/**
 * S2 scrubbing: strips env-var keys that look like credentials BEFORE
 * validation and audit — secrets can never enter `tool_invocations.input`,
 * the workspace env, or the prompt by construction.
 */
export function scrubSecretEnv(env: Record<string, string>): {
  env: Record<string, string>;
  scrubbed: string[];
} {
  const clean: Record<string, string> = {};
  const scrubbed: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (SECRET_ENV_PATTERN.test(key)) scrubbed.push(key);
    else clean[key] = value;
  }
  return { env: clean, scrubbed };
}
