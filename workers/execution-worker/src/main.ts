// workers/execution-worker boot (T40; 09 §3): the activities-only Temporal
// worker on the `execution` queue. Unprivileged — it holds NO Docker socket
// (S1) and NO database access (check-deps enforced); every tool effect goes
// through the Tool Gateway's internal HTTP API (S3). Concurrency is capped
// at 16, bounded by workspace container capacity.
import { createServer } from "node:http";
import { Worker, NativeConnection } from "@temporalio/worker";
import { createGatewayClient } from "./gateway-client.js";
import { createExecutionActivities } from "./activities.js";
import { createIntakeExecutionActivities, createIntakeSandboxClient } from "./intake.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    console.error(`execution-worker: missing required env ${name}`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const healthPort = Number(process.env.HEALTH_PORT ?? 3021);
  const temporalAddress = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const serverUrl = process.env.SERVER_INTERNAL_URL ?? "http://server:3000";
  const internalApiToken = requireEnv("INTERNAL_API_TOKEN");

  let ready = false;
  const health = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: ready ? "ok" : "starting", service: "execution-worker" }));
      return;
    }
    res.writeHead(404).end();
  }).listen(healthPort, "0.0.0.0");

  // intake sandbox activities (T42, 14 §3.1): pre-agent SYSTEM operations —
  // the doc routes these to sandbox-manager directly; agent tools stay
  // gateway-only (S3)
  const sandboxManagerUrl = process.env.SANDBOX_MANAGER_URL ?? "http://sandbox-manager:3010";

  const connection = await NativeConnection.connect({ address: temporalAddress });
  const worker = await Worker.create({
    connection,
    namespace: "acos",
    taskQueue: "execution",
    // activities-only (09 §4.1): sandboxed tool activities are always
    // children of workflows running on agent-tasks/intake
    activities: {
      ...createExecutionActivities({
        invokeGateway: createGatewayClient({ serverUrl, internalApiToken }),
      }),
      ...createIntakeExecutionActivities({
        sandbox: createIntakeSandboxClient({ sandboxManagerUrl, internalApiToken }),
      }),
    },
    maxConcurrentActivityTaskExecutions: 16,
    shutdownGraceTime: "30s",
  });

  ready = true;
  console.log(
    JSON.stringify({ msg: "execution-worker up", taskQueue: "execution", temporalAddress }),
  );

  const shutdown = () => {
    ready = false;
    worker.shutdown();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  try {
    await worker.run();
  } finally {
    health.close();
    await connection.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error("execution-worker boot failed:", err);
  process.exit(1);
});
