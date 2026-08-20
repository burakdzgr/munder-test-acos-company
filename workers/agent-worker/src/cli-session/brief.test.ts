import { describe, expect, it } from "vitest";
import { buildCliBrief } from "./brief.js";
import { workspaceKindForTask } from "./activities.js";

const base = {
  company: { name: "Acme" },
  agent: { name: "Nadia", persona: "Pragmatic backend engineer.", seniority: "senior", positionTitle: "Backend Engineer" },
  task: { number: 42, title: "Add rate limiter", objective: "Limit /api to 100 rps.", successCriteria: ["p99 < 50ms", "429 on overflow"], kind: "task", priority: "P1", status: "IN_PROGRESS", parentTitle: "API hardening" },
  workspace: { kind: "worktree" as const, cwd: "/work", branch: "task/42-add-rate-limiter" },
};

describe("buildCliBrief — the session's first prompt", () => {
  it("names the agent/role/company, the task, the worktree, and the MCP-only contract", () => {
    const b = buildCliBrief(base);
    expect(b).toContain("You are Nadia, Backend Engineer (senior) at Acme");
    expect(b).toContain("TASK-42: Add rate limiter");
    expect(b).toContain('parent="API hardening"');
    expect(b).toContain("Limit /api to 100 rps.");
    expect(b).toContain("- 429 on overflow");
    expect(b).toContain("`acos` MCP tools");
    expect(b).toContain("complete_task");
    expect(b).toContain("/work");
    expect(b).toContain("task/42-add-rate-limiter");
    expect(b).not.toContain("planning session");
  });

  it("planning session variant explains there is no worktree; language directive is appended", () => {
    const b = buildCliBrief({
      ...base,
      workspace: { kind: "session", cwd: "/home/node", branch: null },
      languageDirective: "Respond in Turkish.",
    });
    expect(b).toContain("planning session");
    expect(b).toContain("/home/node");
    expect(b.trim().endsWith("Respond in Turkish.")).toBe(true);
  });

  it("truncates huge descriptions and tolerates missing ones", () => {
    const huge = buildCliBrief({ ...base, task: { ...base.task, objective: "x".repeat(20_000) } });
    expect(huge).toContain("(truncated)");
    expect(huge.length).toBeLessThan(14_000);
    const none = buildCliBrief({ ...base, task: { ...base.task, objective: null, successCriteria: [], parentTitle: null } });
    expect(none).toContain("(no objective)");
    expect(none).not.toContain("parent=");
  });
});

describe("workspaceKindForTask", () => {
  it("planning-shaped kinds get the light session workspace; coding kinds get the worktree; config overrides", () => {
    expect(workspaceKindForTask("goal", "auto")).toBe("session");
    expect(workspaceKindForTask("epic", "auto")).toBe("session");
    expect(workspaceKindForTask("task", "auto")).toBe("worktree");
    expect(workspaceKindForTask("subtask", "auto")).toBe("worktree");
    expect(workspaceKindForTask("task", "session")).toBe("session");
    expect(workspaceKindForTask("goal", "worktree")).toBe("worktree");
  });
});
