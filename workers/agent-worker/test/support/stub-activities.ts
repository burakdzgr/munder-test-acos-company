// Canonical CANNED activity set for the agent-task workflow (T41 structural
// completion, 2026-08-21).
//
// The patched workflow (E4/T31, ADR-022) calls some activities UNCONDITIONALLY
// — resolveAgentRuntimeActivity at turn entry, reportWorkflowCrashActivity on
// the crash path — so a Worker whose activity map misses one dies with
// "Activity function X is not registered on this Worker" and the real failure
// under test is swallowed. Production registers createAgentTaskActivities (which
// carries every name); a TestWorkflowEnvironment suite or the golden-history
// generator that hand-rolls stubs must start from THIS base and override only
// what the test drives — "all real registrations + my overrides", never "the
// few I remembered to list". The regression guard
// (src/activities/agent-task.workflow-coverage.test.ts) asserts that every
// activity the workflow source proxies exists here AND in the production set.
import { ApplicationFailure } from "@temporalio/common";

export type StubActivityMap = Record<string, (...args: never[]) => unknown>;

/** Canned guard snapshot: no budget, no deadline, nothing spent. */
export const STUB_GUARD_SNAPSHOT = {
  budgetCents: null as number | null,
  spentCents: 0,
  remainingCents: null as number | null,
  estimatedNextStepCents: 0,
  deadline: null as string | null,
};

function notStubbed(name: string): never {
  throw ApplicationFailure.nonRetryable(
    `${name} is not stubbed — pass it in buildStubActivities({ ${name} }) (the base resolver answers "steps", so CLI-session activities are never reached by default)`,
    "StubNotProvided",
  );
}

/**
 * Full canned base for every activity agentTaskWorkflow can proxy, with
 * `overrides` layered on top. Defaults are inert: the turn runs the steps
 * loop, the guard snapshot is empty, actions "succeed", inbox is ignored.
 * callModelActivity has NO sensible default (it is the script under test) and
 * fails LOUDLY if a suite forgets to override it.
 */
export function buildStubActivities<O extends StubActivityMap>(overrides: O = {} as O) {
  const base = {
    // ── runtime selection (E4/T31) ─────────────────────────────────────────
    async resolveAgentRuntimeActivity() {
      return { kind: "steps" as const, reason: "stub" };
    },
    async runCliSessionActivity(): Promise<never> {
      return notStubbed("runCliSessionActivity");
    },
    // ── session lifecycle + crash path (08 §1, 33 §2.2) ────────────────────
    async startAgentSessionActivity() {},
    async closeAgentSessionActivity() {},
    async reportWorkflowCrashActivity() {},
    // ── the steps loop ─────────────────────────────────────────────────────
    async getGuardSnapshotActivity() {
      return { ...STUB_GUARD_SNAPSHOT };
    },
    async buildWorkingSetActivity(input: { stepNo?: number }) {
      return { messages: [{ role: "user", content: `step ${input?.stepNo ?? 0}` }], digest: "d" };
    },
    async callModelActivity(): Promise<never> {
      return notStubbed("callModelActivity");
    },
    async executeActionActivity() {
      return { ok: true, exitCode: 0 };
    },
    async persistStepActivity() {
      return { inserted: true };
    },
    async resumeFromWaitActivity() {},
    async expireApprovalActivity() {
      return { status: "expired" };
    },
    async guardEscalateActivity() {},
    // ── inbox (08 §6) ──────────────────────────────────────────────────────
    async triageInboxActivity() {
      return { verdict: "ignore" as const };
    },
    async markInboxReadActivity() {},
    // ── the trivial control-plane activity (src/activities/index.ts) ───────
    async echoActivity(note: string) {
      return `echo:${note}`;
    },
  };
  return { ...base, ...overrides } as typeof base & O;
}

/** Names the canned base registers — what a hand-built Worker gets "for free". */
export const STUB_ACTIVITY_NAMES: readonly string[] = Object.keys(buildStubActivities());
