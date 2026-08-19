import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGETS, NATS_SUBJECT_PREFIX, TASK_QUEUES } from "./constants.js";

describe("shared constants", () => {
  it("Temporal task queue names are canonical (09 §4, 28 §2)", () => {
    expect(TASK_QUEUES).toEqual({
      agentTasks: "agent-tasks",
      execution: "execution",
      memory: "memory",
      intake: "intake",
    });
  });

  it("NATS subjects are co.<companyId>.<eventType> (_DECISIONS §21)", () => {
    expect(NATS_SUBJECT_PREFIX).toBe("co.");
  });

  it("default company daily budget matches 27 §13", () => {
    expect(DEFAULT_BUDGETS.companyDailyCents).toBe(5000);
  });
});
