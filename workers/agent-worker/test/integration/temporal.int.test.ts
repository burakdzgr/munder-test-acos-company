import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Connection } from "@temporalio/client";
import { startTemporal, type StartedTemporal } from "./helpers";

let temporal: StartedTemporal;
let connection: Connection;

async function connectWithRetry(address: string, attempts = 15): Promise<Connection> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await Connection.connect({ address, connectTimeout: 5_000 });
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  throw lastError;
}

beforeAll(async () => {
  temporal = await startTemporal();
  connection = await connectWithRetry(temporal.address);
}, 180_000);

afterAll(async () => {
  await connection?.close();
  await temporal?.container.stop();
});

describe("temporal dev-server testcontainer (T07 harness smoke)", () => {
  it("answers getSystemInfo over gRPC", async () => {
    const info = await connection.workflowService.getSystemInfo({});
    expect(info.serverVersion).toBeTruthy();
  });

  it("has the acos namespace registered (_DECISIONS §1)", async () => {
    const ns = await connection.workflowService.describeNamespace({ namespace: "acos" });
    expect(ns.namespaceInfo?.name).toBe("acos");
  }, 30_000);
});
