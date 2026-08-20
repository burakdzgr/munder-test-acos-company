// T31 manual proof (ADR-022): a REAL `claude` interactive session as THE process of
// a sandbox-manager agent session, frames captured through the TerminalSession
// plumbing, the task driven to DONE through the MCP gateway, then the runtime
// ends the session. Needs: Docker, image acos/workspace-node(:tag) with the kit,
// the identity broker on the host, and a Tool Gateway (or the fake one from the
// T31 scratchpad) answering /internal/v1/mcp/* + builtin-audit. Not a CI test —
// it spends real tokens; the nightly live suite is the automated home for it.
//
//   WORKSPACE_NETWORK=bridge BROKER_URL=http://127.0.0.1:3779 BROKER_SECRET=... \
//   GATEWAY_URL=http://127.0.0.1:3780 CONTAINER_GATEWAY_URL=http://host.docker.internal:3780 \
//   GATEWAY_TOKEN=... IMAGE=acos/workspace-node:t31 OUT=pty-proof.log \
//   pnpm --filter @acos/sandbox-manager exec tsx scripts/t31-pty-proof.ts
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import Docker from "dockerode";
import { DockerSandbox } from "../src/docker.js";
import type { TerminalLogSink, TerminalTransport } from "../src/terminal.js";

const BROKER = process.env.BROKER_URL ?? "http://127.0.0.1:3779";
const SECRET = process.env.BROKER_SECRET ?? "";
const GW = process.env.GATEWAY_URL ?? "http://127.0.0.1:3780";
const CONTAINER_GW = process.env.CONTAINER_GATEWAY_URL ?? "http://host.docker.internal:3780";
const GW_TOKEN = process.env.GATEWAY_TOKEN ?? "gw-session-token-xyz";
const IMAGE = process.env.IMAGE ?? "acos/workspace-node:t31";
const OUT = process.env.OUT ?? "pty-proof.log";
const MODEL = process.env.MODEL ?? "sonnet";
const MAX_MS = Number(process.env.MAX_MS ?? 240_000);

const frames: string[] = [];
const transport: TerminalTransport = { publish: (_id, f) => frames.push(Buffer.from(f.data, "base64").toString("utf8")) };
const logSink: TerminalLogSink = { append: () => {} };
const docker = new Docker();
const sandbox = new DockerSandbox({
  docker,
  transport,
  logSink,
  nowMs: () => Date.now(),
  log: (m, meta) => console.log(JSON.stringify({ m, ...meta })),
});

async function main(): Promise<void> {
  if (!SECRET) throw new Error("BROKER_SECRET required");
  const workspaceId = randomUUID();
  const sessionId = randomUUID();
  const ws = await sandbox.createWorkspace({ workspaceId, isolation: "coding", image: IMAGE, env: {}, mounts: [], labels: { "acos.proof": "t31" } });
  console.log("workspace", ws.containerId.slice(0, 12));
  const mint = (await fetch(`${BROKER}/internal/v1/sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
    body: JSON.stringify({ sessionId, companyId: "proof-co", agentId: "proof-agent", taskId: "task-1" }),
  }).then((r) => r.json())) as { token: string; baseUrl: string };
  const brief =
    "You are Kevin-bot, an ACOS engineer. Task TASK-7: create hello.txt containing 'hello from the PTY' in the current directory, " +
    "then call the acos MCP tool complete_task with summary 'TASK-7 done: hello.txt written'. Do nothing else; keep replies to one line.";
  const t0 = Date.now();
  await sandbox.openAgentSession({
    workspaceId,
    sessionId,
    cols: 110,
    rows: 30,
    cwd: "/home/node",
    env: {
      ANTHROPIC_BASE_URL: mint.baseUrl,
      ANTHROPIC_AUTH_TOKEN: mint.token,
      ACOS_GATEWAY_URL: CONTAINER_GW,
      ACOS_GATEWAY_TOKEN: GW_TOKEN,
      ACOS_MODEL: MODEL,
      ACOS_SESSION_MODE: "interactive",
      ACOS_PROMPT: brief,
    },
  });
  let endedBy = "timeout";
  for (;;) {
    const st = sandbox.agentSessionStatus(sessionId);
    if (!st?.running) {
      endedBy = "cli_exit";
      break;
    }
    const gw = (await fetch(`${GW}/__log`).then((r) => r.json())) as { taskStatus?: string };
    if (gw.taskStatus === "DONE") {
      endedBy = "task_terminal";
      break;
    }
    if (Date.now() - t0 > MAX_MS) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  await new Promise((r) => setTimeout(r, 4000)); // let the TUI paint the final turn
  const fin = await sandbox.endAgentSession(sessionId, 8000);
  const usage = (await fetch(`${BROKER}/internal/v1/sessions/${sessionId}`, { method: "DELETE", headers: { authorization: `Bearer ${SECRET}` } }).then((r) => r.json())) as {
    totals?: unknown;
    requestCount?: number;
  };
  const gwlog = await fetch(`${GW}/__log`).then((r) => r.json());
  const text = frames.join("");
  writeFileSync(OUT, text);
  console.log(
    JSON.stringify(
      { endedBy, fin, seconds: Math.round((Date.now() - t0) / 1000), frames: frames.length, bytes: text.length, requests: usage.requestCount, usage: usage.totals, gateway: gwlog },
      null,
      1,
    ),
  );
  await sandbox.destroyWorkspace(workspaceId);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
