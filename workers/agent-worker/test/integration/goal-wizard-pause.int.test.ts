// E2/W5 (T19) — planlama İNSANI BEKLER.
//
// Önce projectGoalWorkflow tek nefeste akıyordu: analiz → gap → İKİLİ hire
// onayı → Agent Factory. Founder'ın "bir takım daha ekle / bu ekip 3 kişi
// olsun" diyebileceği bir AN yoktu; workflow'da tek bir condition()/signal
// bekleyişi bulunmuyordu (E2 kapsam raporu Q3-b).
//
// Sözleşme (bu test):
//   1. öneri üretilince akış DURUR — insan kararı gelmeden Agent Factory'ye
//      dokunulmaz ve planlama devam etmez,
//   2. "confirmed" sinyali akışı sürdürür: önce öneri uygulanır, SONRA
//      planlama devam eder (sıra önemli — kadro kurulmadan CEO'ya iş verilmez),
//   3. "cancel" uygulamaz ve akışı waiting_for_founder'da bırakır,
//   4. öneri üretilemezse (LLM yok/bozuk) akış HİÇ durmaz — eski deterministik
//      yol aynen çalışır, yani bir model arızası projeyi kilitlemez.
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Worker } from "@temporalio/worker";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { uuidv7 } from "@acos/domain";

const require = createRequire(import.meta.url);
const intakeWorkflowsPath = require.resolve("../../src/workflows/intake/index.ts");

const COMPANY = "018f0000-0000-7000-8000-0000000000c1";
const PROJECT = "018f0000-0000-7000-8000-00000000091b";

interface Recorder {
  order: string[];
  proposalId: string | null;
  applied: string[];
}

function makeStub(opts: { proposal: boolean }): {
  activities: Record<string, unknown>;
  calls: Recorder;
} {
  const calls: Recorder = { order: [], proposalId: null, applied: [] };
  const activities = {
    async analyzeRequirementsActivity() {
      calls.order.push("analyze");
      return { requiredCapabilities: ["backend x2", "qa"] };
    },
    async proposeStaffingActivity() {
      calls.order.push("propose");
      if (!opts.proposal) return null;
      calls.proposalId = uuidv7();
      return { proposalId: calls.proposalId, teamCount: 2 };
    },
    async applyStaffingProposalActivity(input: { proposalId: string }) {
      calls.order.push("apply");
      calls.applied.push(input.proposalId);
      return { hired: 3 };
    },
    async continueProjectPlanningActivity() {
      calls.order.push("continue");
      return { state: "executing" };
    },
  };
  return { activities, calls };
}

const INPUT = {
  companyId: COMPANY,
  projectId: PROJECT,
  projectName: "Sihirbaz Projesi",
  objective: "Bir HTTP saglik ucu ekle.",
  constraints: null,
};

describe("projectGoalWorkflow insan duraklaması (E2/W5)", { timeout: 300_000 }, () => {
  let env: TestWorkflowEnvironment;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  }, 300_000);

  afterAll(async () => {
    await env?.teardown();
  });

  it("öneri varken DURUR; onay sinyali gelince önce uygular, sonra planlamayı sürdürür", async () => {
    const stub = makeStub({ proposal: true });
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: "intake",
      workflowsPath: intakeWorkflowsPath,
      activities: stub.activities as never,
    });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start("projectGoalWorkflow", {
        taskQueue: "intake",
        workflowId: `goal-pause-${uuidv7()}`,
        args: [INPUT],
      });

      // öneri yazıldı → akış İNSANI bekliyor: ne uygulama ne devam
      await vi_waitFor(() => stub.calls.order.includes("propose"));
      expect(stub.calls.order).toEqual(["analyze", "propose"]);

      await handle.signal("staffingProposalDecided", {
        proposalId: stub.calls.proposalId,
        decision: "confirmed",
      });
      const result = (await handle.result()) as { state: string };

      expect(result.state).toBe("executing");
      // SIRA önemli: kadro kurulmadan planlama devam etmez
      expect(stub.calls.order).toEqual(["analyze", "propose", "apply", "continue"]);
      expect(stub.calls.applied).toEqual([stub.calls.proposalId]);
    });
  });

  it("başka bir önerinin geç sinyali akışı ilerletmez", async () => {
    const stub = makeStub({ proposal: true });
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: "intake",
      workflowsPath: intakeWorkflowsPath,
      activities: stub.activities as never,
    });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start("projectGoalWorkflow", {
        taskQueue: "intake",
        workflowId: `goal-stale-${uuidv7()}`,
        args: [INPUT],
      });
      await vi_waitFor(() => stub.calls.order.includes("propose"));

      // ESKİ bir önerinin kararı — bu akışı ilgilendirmez
      await handle.signal("staffingProposalDecided", {
        proposalId: uuidv7(),
        decision: "confirmed",
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(stub.calls.order).toEqual(["analyze", "propose"]); // hâlâ bekliyor

      await handle.signal("staffingProposalDecided", {
        proposalId: stub.calls.proposalId,
        decision: "confirmed",
      });
      await handle.result();
      expect(stub.calls.order).toContain("apply");
    });
  });

  it("iptal uygulamaz ve akış Founder beklemesinde biter", async () => {
    const stub = makeStub({ proposal: true });
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: "intake",
      workflowsPath: intakeWorkflowsPath,
      activities: stub.activities as never,
    });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start("projectGoalWorkflow", {
        taskQueue: "intake",
        workflowId: `goal-cancel-${uuidv7()}`,
        args: [INPUT],
      });
      await vi_waitFor(() => stub.calls.order.includes("propose"));
      await handle.signal("staffingProposalDecided", {
        proposalId: stub.calls.proposalId,
        decision: "cancelled",
      });
      const result = (await handle.result()) as { state: string };
      expect(result.state).toBe("waiting_for_founder");
      expect(stub.calls.order).toEqual(["analyze", "propose"]); // apply YOK
    });
  });

  it("öneri üretilemezse HİÇ durmaz — eski deterministik yol aynen akar", async () => {
    const stub = makeStub({ proposal: false });
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: "intake",
      workflowsPath: intakeWorkflowsPath,
      activities: stub.activities as never,
    });
    await worker.runUntil(async () => {
      const result = (await env.client.workflow.execute("projectGoalWorkflow", {
        taskQueue: "intake",
        workflowId: `goal-nolllm-${uuidv7()}`,
        args: [INPUT],
      })) as { state: string };
      expect(result.state).toBe("executing");
      expect(stub.calls.order).toEqual(["analyze", "propose", "continue"]);
    });
  });
});

/** Küçük bekleyici — stub aktivite kaydı görünene kadar yokla. */
async function vi_waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}
