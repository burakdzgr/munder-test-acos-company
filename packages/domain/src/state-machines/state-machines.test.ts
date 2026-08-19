import { describe, expect, it } from "vitest";
import { defineStateMachine, type StateMachine } from "./machine.js";
import { authorizeTaskTransition, taskMachine, type TaskActor } from "./task.js";
import {
  agentMachine,
  agentSessionMachine,
  approvalMachine,
  experimentMachine,
  memoryMachine,
  projectMachine,
  workspaceMachine,
} from "./lifecycles.js";
import { DomainError } from "../errors.js";

/**
 * Exhaustive (state, state) enumeration: for every machine we assert
 * canTransition against the expected adjacency for EVERY ordered pair
 * (T10 acceptance: property tests over every (state,event) pair).
 */
function assertExhaustive<S extends string>(
  machine: StateMachine<S>,
  expected: Readonly<Record<S, readonly S[]>>,
): void {
  for (const from of machine.states) {
    for (const to of machine.states) {
      const want = expected[from].includes(to);
      expect(machine.canTransition(from, to), `${machine.name}: ${from} → ${to}`).toBe(want);
      if (want) {
        expect(() => machine.assertTransition(from, to)).not.toThrow();
      } else {
        expect(() => machine.assertTransition(from, to)).toThrow(DomainError);
      }
    }
  }
}

describe("defineStateMachine", () => {
  it("rejects tables referencing unknown states", () => {
    expect(() =>
      defineStateMachine("broken", { a: ["b"], b: ["c" as "a" | "b"] } as never),
    ).toThrow("unknown state");
  });

  it("exposes terminal states and outgoing transitions", () => {
    expect(taskMachine.isTerminal("DONE")).toBe(true);
    expect(taskMachine.isTerminal("QA")).toBe(false);
    expect(taskMachine.terminalStates).toEqual(["DONE", "FAILED", "CANCELLED"]);
    expect(taskMachine.transitionsFrom("APPROVAL")).toEqual(["DONE", "REJECTED"]);
  });
});

describe("task machine (07 §4)", () => {
  it("matches the canonical transition table exhaustively", () => {
    assertExhaustive(taskMachine, {
      DRAFT: ["BACKLOG", "CANCELLED"],
      BACKLOG: ["PLANNED", "CANCELLED"],
      PLANNED: ["ASSIGNED", "CANCELLED"],
      ASSIGNED: ["IN_PROGRESS", "CANCELLED"],
      IN_PROGRESS: ["WAITING", "BLOCKED", "REVIEW", "CANCELLED", "FAILED"],
      WAITING: ["IN_PROGRESS", "CANCELLED"],
      BLOCKED: ["IN_PROGRESS", "CANCELLED", "FAILED"],
      REVIEW: ["CHANGES_REQUESTED", "QA", "CANCELLED"],
      CHANGES_REQUESTED: ["IN_PROGRESS"],
      QA: ["QA_FAILED", "APPROVAL", "DONE", "CANCELLED"],
      QA_FAILED: ["IN_PROGRESS", "FAILED"],
      APPROVAL: ["DONE", "REJECTED"],
      REJECTED: ["IN_PROGRESS", "FAILED"],
      DONE: [],
      FAILED: [],
      CANCELLED: [],
    });
  });

  it("terminal states are immutable", () => {
    for (const terminal of ["DONE", "FAILED", "CANCELLED"] as const) {
      for (const to of taskMachine.states) {
        expect(taskMachine.canTransition(terminal, to)).toBe(false);
      }
    }
  });
});

describe("lifecycle machines (_DECISIONS §19)", () => {
  it("agent: draft → active ⇄ paused → offboarded", () => {
    assertExhaustive(agentMachine, {
      draft: ["active"],
      active: ["paused", "offboarded"],
      paused: ["active", "offboarded"],
      offboarded: [],
    });
  });

  it("agent session: starting → running ⇄ waiting → terminals", () => {
    assertExhaustive(agentSessionMachine, {
      starting: ["running", "failed", "cancelled"],
      running: ["waiting", "completed", "failed", "cancelled"],
      waiting: ["running", "completed", "failed", "cancelled"],
      completed: [],
      failed: [],
      cancelled: [],
    });
  });

  it("project: yeni yaşam döngüsü (LIFECYCLE TASK 2) + miras durumlar", () => {
    assertExhaustive(projectMachine, {
      draft: ["repository_setup", "cancelled"],
      repository_setup: ["indexing", "failed", "cancelled"],
      indexing: ["ready", "failed", "cancelled"],
      ready: ["planning", "archived", "cancelled"],
      planning: ["staffing_review", "waiting_for_founder", "executing", "failed", "cancelled"],
      staffing_review: ["waiting_for_founder", "executing", "planning", "cancelled"],
      waiting_for_founder: ["planning", "staffing_review", "executing", "failed", "cancelled"],
      executing: ["paused", "completed", "failed", "archived", "cancelled"],
      failed: ["repository_setup", "indexing", "planning", "cancelled"],
      proposed: ["intake", "cancelled"],
      intake: ["active", "cancelled"],
      active: ["paused", "completed", "archived", "cancelled"],
      paused: ["executing", "active", "completed", "archived", "cancelled"],
      completed: [],
      archived: [],
      cancelled: [],
    });
  });

  it("approval: pending → {approved, rejected, needs_review → pending, expired}", () => {
    assertExhaustive(approvalMachine, {
      pending: ["approved", "rejected", "needs_review", "expired"],
      needs_review: ["pending"],
      approved: [],
      rejected: [],
      expired: [],
    });
  });

  it("workspace: provisioning → ready → in_use ⇄ idle → outcomes → destroyed", () => {
    assertExhaustive(workspaceMachine, {
      provisioning: ["ready", "failed"],
      ready: ["in_use"],
      in_use: ["idle", "merged", "discarded", "failed"],
      idle: ["in_use", "merged", "discarded", "failed"],
      merged: ["destroyed"],
      discarded: ["destroyed"],
      failed: ["destroyed"],
      destroyed: [],
    });
  });

  it("experiment: designed → baseline → running → analyzing → verdicts", () => {
    assertExhaustive(experimentMachine, {
      designed: ["baseline"],
      baseline: ["running"],
      running: ["analyzing"],
      analyzing: ["adopted", "rejected", "inconclusive"],
      adopted: [],
      rejected: [],
      inconclusive: [],
    });
  });

  it("memory: candidate → active → {superseded, archived, rejected}", () => {
    assertExhaustive(memoryMachine, {
      candidate: ["active", "rejected"],
      active: ["superseded", "archived", "rejected"],
      superseded: [],
      archived: [],
      rejected: [],
    });
  });
});

describe("task transition permissions (07 §5)", () => {
  const owner: TaskActor = { kind: "owner", agentId: "a-owner" };
  const reviewer: TaskActor = { kind: "reviewer", agentId: "a-rev" };
  const qa: TaskActor = { kind: "qa", agentId: "a-qa" };
  const manager: TaskActor = { kind: "manager", agentId: "a-mgr" };
  const founder: TaskActor = { kind: "founder", agentId: null };
  const system: TaskActor = { kind: "system", agentId: null };
  const engine: TaskActor = { kind: "approval_engine", agentId: null };
  const task = { ownerAgentId: "a-owner" };

  it("owner submits to review; nobody else can", () => {
    expect(authorizeTaskTransition("IN_PROGRESS", "REVIEW", owner, task).allowed).toBe(true);
    for (const actor of [reviewer, qa, manager, founder, system, engine]) {
      expect(authorizeTaskTransition("IN_PROGRESS", "REVIEW", actor, task).allowed).toBe(false);
    }
  });

  it("author may not review or QA their own work (structural)", () => {
    const ownAsReviewer: TaskActor = { kind: "reviewer", agentId: "a-owner" };
    const verdict = authorizeTaskTransition("REVIEW", "QA", ownAsReviewer, task);
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toContain("own work");
    expect(authorizeTaskTransition("REVIEW", "QA", reviewer, task).allowed).toBe(true);

    const ownAsQa: TaskActor = { kind: "qa", agentId: "a-owner" };
    expect(authorizeTaskTransition("QA", "DONE", ownAsQa, task).allowed).toBe(false);
    expect(authorizeTaskTransition("QA", "DONE", qa, task).allowed).toBe(true);
  });

  it("APPROVAL transitions happen only via the Approval Engine", () => {
    expect(authorizeTaskTransition("APPROVAL", "DONE", engine, task).allowed).toBe(true);
    expect(authorizeTaskTransition("APPROVAL", "REJECTED", engine, task).allowed).toBe(true);
    for (const actor of [owner, reviewer, qa, manager, founder, system]) {
      expect(authorizeTaskTransition("APPROVAL", "DONE", actor, task).allowed).toBe(false);
    }
  });

  it("only manager+ (or Founder) cancels or fails", () => {
    expect(authorizeTaskTransition("IN_PROGRESS", "CANCELLED", manager, task).allowed).toBe(true);
    expect(authorizeTaskTransition("QA", "CANCELLED", founder, task).allowed).toBe(true);
    expect(authorizeTaskTransition("BLOCKED", "FAILED", manager, task).allowed).toBe(true);
    expect(authorizeTaskTransition("IN_PROGRESS", "CANCELLED", owner, task).allowed).toBe(false);
    expect(authorizeTaskTransition("BLOCKED", "FAILED", system, task).allowed).toBe(false);
  });

  it("assignment is manager-only; start is owner or system", () => {
    expect(authorizeTaskTransition("PLANNED", "ASSIGNED", manager, task).allowed).toBe(true);
    expect(authorizeTaskTransition("PLANNED", "ASSIGNED", owner, task).allowed).toBe(false);
    expect(authorizeTaskTransition("ASSIGNED", "IN_PROGRESS", owner, task).allowed).toBe(true);
    expect(authorizeTaskTransition("ASSIGNED", "IN_PROGRESS", system, task).allowed).toBe(true);
    expect(authorizeTaskTransition("ASSIGNED", "IN_PROGRESS", manager, task).allowed).toBe(false);
  });

  it("creator grooms drafts; rework states resume by owner or manager", () => {
    const creator: TaskActor = { kind: "creator", agentId: "a-creator" };
    expect(authorizeTaskTransition("DRAFT", "BACKLOG", creator, task).allowed).toBe(true);
    expect(authorizeTaskTransition("CHANGES_REQUESTED", "IN_PROGRESS", owner, task).allowed).toBe(true);
    expect(authorizeTaskTransition("QA_FAILED", "IN_PROGRESS", manager, task).allowed).toBe(true);
    expect(authorizeTaskTransition("REJECTED", "IN_PROGRESS", owner, task).allowed).toBe(true);
    expect(authorizeTaskTransition("REJECTED", "IN_PROGRESS", reviewer, task).allowed).toBe(false);
  });

  it("illegal machine transitions are rejected regardless of actor", () => {
    const verdict = authorizeTaskTransition("DONE", "IN_PROGRESS", founder, task);
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toContain("illegal transition");
  });
});
