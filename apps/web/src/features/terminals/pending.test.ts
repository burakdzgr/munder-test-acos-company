import { describe, expect, it } from "vitest";
import type { CompanyAgentSession, Task } from "@acos/contracts";
import { pendingRows } from "./pending.js";

const A1 = "018f0000-0000-7000-8000-0000000000a1";
const A2 = "018f0000-0000-7000-8000-0000000000a2";
const A3 = "018f0000-0000-7000-8000-0000000000a3";
const NAMES = new Map([
  [A1, "Dev A"],
  [A2, "Dev B"],
  [A3, "Lead"],
]);

function task(partial: Partial<Task> & { number: number; status: string }): Task {
  return {
    id: `018f0000-0000-7000-8000-00000000t${partial.number}`,
    displayNumber: `TASK-${partial.number}`,
    kind: "task",
    parentId: null,
    projectId: null,
    title: `iş ${partial.number}`,
    objective: "",
    priority: "normal",
    successCriteria: [],
    risk: "low",
    budgetCents: null,
    spentCents: 0,
    deadline: null,
    ownerAgentId: null,
    creatorAgentId: null,
    orgUnitId: null,
    delegationDepth: 0,
    reassignmentCount: 0,
    createdAt: "2026-08-21T00:00:00.000Z",
    closedAt: null,
    ...partial,
  } as unknown as Task;
}

function session(agentId: string, status: string): CompanyAgentSession {
  return {
    id: `018f0000-0000-7000-8000-0000000000s${agentId.slice(-1)}`,
    agentId,
    taskId: null,
    workflowId: "wf",
    status,
    currentActivity: "WORKING",
    startedAt: "2026-08-21T00:00:00.000Z",
    endedAt: null,
    stepsCount: 3,
    costCents: 0,
    agentName: NAMES.get(agentId) ?? null,
    taskNumber: null,
    taskTitle: null,
  } as unknown as CompanyAgentSession;
}

describe("sıradaki ajanlar (tavan dolu → dördüncü ajan ekrandan kaybolmasın)", () => {
  it("canlı oturumu olan ajan listede YOKTUR (hücresi zaten var)", () => {
    const rows = pendingRows(
      [task({ number: 1, status: "IN_PROGRESS", ownerAgentId: A1 })],
      [session(A1, "running")],
      NAMES,
    );
    expect(rows).toHaveLength(0);
  });

  it("görevi ASSIGNED ama oturumu olmayan ajan 'sırada' görünür", () => {
    const rows = pendingRows(
      [task({ number: 4, status: "ASSIGNED", ownerAgentId: A2 })],
      [session(A1, "running")],
      NAMES,
    );
    expect(rows).toEqual([
      expect.objectContaining({ agentId: A2, agentName: "Dev B", taskNumber: 4, kind: "queued" }),
    ]);
  });

  it("WAITING görev 'beklemede'dir — sıradakiyle karıştırılmaz", () => {
    const rows = pendingRows([task({ number: 7, status: "WAITING", ownerAgentId: A3 })], [], NAMES);
    expect(rows[0]).toMatchObject({ kind: "parked" });
    expect(rows[0]?.label).toContain("cevap");
  });

  it("oturumu bitmiş ama IN_PROGRESS kalan görev 'kopuk' olarak görünür", () => {
    const rows = pendingRows(
      [task({ number: 9, status: "IN_PROGRESS", ownerAgentId: A1 })],
      [session(A1, "completed")],
      NAMES,
    );
    expect(rows[0]).toMatchObject({ kind: "detached" });
  });

  it("kapanmış görevler (DONE/CANCELLED) hiç sayılmaz", () => {
    const rows = pendingRows(
      [
        task({ number: 2, status: "DONE", ownerAgentId: A1 }),
        task({ number: 3, status: "CANCELLED", ownerAgentId: A2 }),
        task({ number: 5, status: "BACKLOG", ownerAgentId: A3 }),
      ],
      [],
      NAMES,
    );
    expect(rows).toHaveLength(0);
  });

  it("bir ajanın iki açık görevi varsa tek satır çıkar ve BEKLEYEN olan kazanır", () => {
    const rows = pendingRows(
      [
        task({ number: 11, status: "ASSIGNED", ownerAgentId: A1 }),
        task({ number: 12, status: "WAITING", ownerAgentId: A1 }),
      ],
      [],
      NAMES,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "parked", taskNumber: 12 });
  });

  it("sıralama: bekleyenler → sıradakiler → kopuklar", () => {
    const rows = pendingRows(
      [
        task({ number: 21, status: "IN_PROGRESS", ownerAgentId: A1 }),
        task({ number: 22, status: "ASSIGNED", ownerAgentId: A2 }),
        task({ number: 23, status: "WAITING", ownerAgentId: A3 }),
      ],
      [],
      NAMES,
    );
    expect(rows.map((r) => r.kind)).toEqual(["parked", "queued", "detached"]);
  });
});
