import { describe, expect, it } from "vitest";
import { createCompany } from "./company.js";
import { createOrgUnit } from "./org-unit.js";
import { createPosition } from "./position.js";
import { createOrgEdge, endOrgEdge } from "./org-edge.js";
import { createAgent, formatEmployeeNumber } from "./agent.js";
import { createTask, formatTaskNumber } from "./task.js";
import { createProject, taskBranchName } from "./project.js";
import { createMemory } from "./memory.js";
import { createApproval } from "./approval.js";
import { isUuidv7 } from "../ids.js";

const NOW = new Date("2026-08-11T00:00:00Z");
const deps = { now: NOW };
const cid = "company-1";

describe("createCompany", () => {
  it("creates a company with a UUIDv7 id", () => {
    const company = createCompany({ name: "Acme Technologies", slug: "acme", currency: "USD" });
    expect(isUuidv7(company.id)).toBe(true);
    expect(company.name).toBe("Acme Technologies");
  });

  it("validates name, slug, currency", () => {
    expect(() => createCompany({ name: " ", slug: "acme", currency: "USD" })).toThrow("name");
    expect(() => createCompany({ name: "A", slug: "Acme!", currency: "USD" })).toThrow("kebab-case");
    expect(() => createCompany({ name: "A", slug: "acme", currency: "usd" })).toThrow("3-letter");
  });
});

describe("createOrgUnit / createPosition", () => {
  it("creates units with optional parent", () => {
    const dept = createOrgUnit({ companyId: cid, name: "Engineering", kind: "department" }, deps);
    const team = createOrgUnit(
      { companyId: cid, name: "Backend", kind: "team", parentUnitId: dept.id },
      deps,
    );
    expect(dept.parentUnitId).toBeNull();
    expect(team.parentUnitId).toBe(dept.id);
  });

  it("rejects empty names and unknown kinds", () => {
    expect(() => createOrgUnit({ companyId: cid, name: "", kind: "team" })).toThrow("name");
    expect(() =>
      createOrgUnit({ companyId: cid, name: "X", kind: "squad" as never }),
    ).toThrow("kind");
    expect(() =>
      createPosition({ companyId: cid, title: " ", seniorityTrack: "eng", defaultRole: "member" }),
    ).toThrow("title");
  });

  it("creates positions", () => {
    const position = createPosition(
      { companyId: cid, title: "Backend Engineer", seniorityTrack: "engineering", defaultRole: "member" },
      deps,
    );
    expect(position.title).toBe("Backend Engineer");
  });
});

describe("createOrgEdge (invariants of 03 §3.1)", () => {
  it("agent-edges target agents, unit-edges target units", () => {
    const reports = createOrgEdge(
      { companyId: cid, fromAgentId: "a1", kind: "reports_to", toAgentId: "a2" },
      deps,
    );
    expect(reports.toAgentId).toBe("a2");
    expect(reports.endedAt).toBeNull();

    const member = createOrgEdge(
      { companyId: cid, fromAgentId: "a1", kind: "member_of", toUnitId: "u1" },
      deps,
    );
    expect(member.toUnitId).toBe("u1");
  });

  it("rejects zero or two targets (CHECK exactly one)", () => {
    expect(() =>
      createOrgEdge({ companyId: cid, fromAgentId: "a1", kind: "reports_to" }),
    ).toThrow("exactly one");
    expect(() =>
      createOrgEdge(
        { companyId: cid, fromAgentId: "a1", kind: "reports_to", toAgentId: "a2", toUnitId: "u1" },
      ),
    ).toThrow("exactly one");
  });

  it("rejects kind/target mismatches", () => {
    expect(() =>
      createOrgEdge({ companyId: cid, fromAgentId: "a1", kind: "member_of", toAgentId: "a2" }),
    ).toThrow("must target an org unit");
    expect(() =>
      createOrgEdge({ companyId: cid, fromAgentId: "a1", kind: "manages", toUnitId: "u1" }),
    ).toThrow("must target an agent");
  });

  it("rejects self-reporting and out-of-range strength", () => {
    expect(() =>
      createOrgEdge({ companyId: cid, fromAgentId: "a1", kind: "reports_to", toAgentId: "a1" }),
    ).toThrow("report to itself");
    expect(() =>
      createOrgEdge(
        { companyId: cid, fromAgentId: "a1", kind: "collaborates_with", toAgentId: "a2", strength: 1.2 },
      ),
    ).toThrow("[0,1]");
  });

  it("end-dates edges exactly once (never deleted)", () => {
    const edge = createOrgEdge(
      { companyId: cid, fromAgentId: "a1", kind: "mentors", toAgentId: "a2" },
      deps,
    );
    const ended = endOrgEdge(edge, NOW);
    expect(ended.endedAt).toBe(NOW);
    expect(() => endOrgEdge(ended, NOW)).toThrow("already ended");
  });
});

describe("createAgent (sacred invariant: no model fields)", () => {
  const base = {
    companyId: cid,
    employeeNumber: 7,
    name: "Alex Demir",
    positionId: "p1",
    orgUnitId: "u1",
    seniority: "senior",
    autonomyLevel: 3,
    persona: "Pragmatic backend engineer.",
  } as const;

  it("creates a draft agent with defaults", () => {
    const agent = createAgent(base, deps);
    expect(agent.status).toBe("draft");
    expect(agent.avatarUrl).toBeNull();
    expect(agent.employment.hiredAt).toBe(NOW.toISOString());
    expect(isUuidv7(agent.id)).toBe(true);
    expect("model" in agent).toBe(false);
    expect("provider" in agent).toBe(false);
  });

  it("validates name, employee number, seniority, autonomy, persona", () => {
    expect(() => createAgent({ ...base, name: " " })).toThrow("name");
    expect(() => createAgent({ ...base, employeeNumber: 0 })).toThrow("positive integer");
    expect(() => createAgent({ ...base, seniority: "intern" as never })).toThrow("seniority");
    expect(() => createAgent({ ...base, autonomyLevel: 9 as never })).toThrow("0–5");
    expect(() => createAgent({ ...base, persona: "" })).toThrow("persona");
  });

  it("formats employee numbers", () => {
    expect(formatEmployeeNumber(7)).toBe("EMP-007");
    expect(formatEmployeeNumber(1234)).toBe("EMP-1234");
  });
});

describe("createTask", () => {
  const base = {
    companyId: cid,
    number: 81,
    kind: "task",
    title: "Implement login",
    objective: "Users can sign in",
    priority: "P1",
    risk: "medium",
  } as const;

  it("creates a DRAFT task with defaults", () => {
    const task = createTask(base, deps);
    expect(task.status).toBe("DRAFT");
    expect(task.parentId).toBeNull();
    expect(task.successCriteria).toEqual([]);
    expect(task.result).toBeNull();
    expect(formatTaskNumber(task.number)).toBe("TASK-81");
  });

  it("validates title, number, kind, priority, risk, budget", () => {
    expect(() => createTask({ ...base, title: "" })).toThrow("title");
    expect(() => createTask({ ...base, number: -1 })).toThrow("positive integer");
    expect(() => createTask({ ...base, kind: "story" as never })).toThrow("kind");
    expect(() => createTask({ ...base, priority: "P9" as never })).toThrow("priority");
    expect(() => createTask({ ...base, risk: "wild" as never })).toThrow("risk");
    expect(() => createTask({ ...base, budgetCents: -5 })).toThrow("non-negative");
    expect(() => createTask({ ...base, budgetCents: 1.5 })).toThrow("non-negative");
  });
});

describe("createProject + branch names", () => {
  it("creates a proposed project", () => {
    const project = createProject({ companyId: cid, name: "Storefront" }, deps);
    expect(project.status).toBe("proposed");
    expect(project.description).toBeNull();
  });

  it("rejects empty names", () => {
    expect(() => createProject({ companyId: cid, name: " " })).toThrow("name");
  });

  it("builds task/<number>-<slug> branch names (_DECISIONS §21)", () => {
    expect(taskBranchName(81, "Implement Login Flow!")).toBe("task/81-implement-login-flow");
    expect(taskBranchName(7, "Çok Önemli İş")).toBe("task/7-cok-onemli-is");
    expect(() => taskBranchName(1, "!!!")).toThrow("empty branch slug");
  });
});

describe("createMemory (scope + provenance invariants)", () => {
  const base = {
    companyId: cid,
    scope: "agent",
    scopeRef: "a1",
    type: "failure",
    title: "npm test fails without pg running",
    content: "…",
    summary: "Start pg first.",
    importance: 0.6,
    confidence: 0.8,
    sourceEventId: "e1",
    embeddingModel: "text-embedding-3-small",
  } as const;

  it("creates a candidate memory", () => {
    const memory = createMemory(base, deps);
    expect(memory.status).toBe("candidate");
    expect(memory.retrievalCount).toBe(0);
    expect(memory.lastVerifiedAt).toBeNull();
  });

  it("company scope must not carry scopeRef; narrower scopes require it", () => {
    expect(() =>
      createMemory({ ...base, scope: "company", scopeRef: "x" }),
    ).toThrow("must not carry a scopeRef");
    expect(() =>
      createMemory({ ...base, scope: "project", scopeRef: null }),
    ).toThrow("requires a scopeRef");
    const companyMemory = createMemory({ ...base, scope: "company", scopeRef: null }, deps);
    expect(companyMemory.scopeRef).toBeNull();
  });

  it("validates ranges, title, provenance", () => {
    expect(() => createMemory({ ...base, importance: 1.2 })).toThrow("[0,1]");
    expect(() => createMemory({ ...base, confidence: -0.1 })).toThrow("[0,1]");
    expect(() => createMemory({ ...base, title: "" })).toThrow("title");
    expect(() => createMemory({ ...base, sourceEventId: " " })).toThrow("provenance");
  });
});

describe("createApproval (structured briefs only)", () => {
  const base = {
    companyId: cid,
    kind: "vendor_signup",
    title: "Sign up for Sentry",
    requestMd: "## Brief\nCost: $29/mo",
    requestedBy: "a1",
    risk: "medium",
  } as const;

  it("creates a pending approval with defaults", () => {
    const approval = createApproval(base, deps);
    expect(approval.status).toBe("pending");
    expect(approval.urgency).toBe("normal");
    expect(approval.chain).toEqual([]);
    expect(approval.decidedBy).toBeNull();
  });

  it("validates brief, kind, title, risk, urgency, cost", () => {
    expect(() => createApproval({ ...base, requestMd: " " })).toThrow("structured brief");
    expect(() => createApproval({ ...base, kind: "" })).toThrow("kind");
    expect(() => createApproval({ ...base, title: "" })).toThrow("title");
    expect(() => createApproval({ ...base, risk: "wild" as never })).toThrow("risk");
    expect(() => createApproval({ ...base, urgency: "asap" as never })).toThrow("urgency");
    expect(() => createApproval({ ...base, costCents: -1 })).toThrow("non-negative");
  });
});
