// E4/T31 (Docker-gated): the agent CLI session IS the PTY process. Uses the
// default minimal image with an entrypoint override so the PTY plumbing +
// env injection + exit tracking + deterministic end are proven without the
// 320 MB claude image; the real-image run (claude → broker → API → MCP) is the
// manual proof recorded in PROGRESS.md and the nightly live suite.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Docker from "dockerode";
import type { SandboxTerminalFrame } from "@acos/contracts";
import { WORKSPACE_NETWORK } from "@acos/tools";
import { DockerSandbox } from "../../src/docker.js";
import type { TerminalLogSink, TerminalTransport } from "../../src/terminal.js";

const docker = new Docker();
let dockerUp = false;
try {
  await docker.ping();
  dockerUp = true;
} catch {
  dockerUp = false;
}

const frames: Array<{ sessionId: string; text: string }> = [];
const transport: TerminalTransport = {
  publish: (sessionId, frame: SandboxTerminalFrame) =>
    frames.push({ sessionId, text: Buffer.from(frame.data, "base64").toString("utf8") }),
};
const logSink: TerminalLogSink = { append: () => {} };
let sandbox: DockerSandbox;
const created: string[] = [];

async function ensureNetwork(): Promise<void> {
  const nets = await docker.listNetworks({ filters: { name: [WORKSPACE_NETWORK] } });
  if (nets.length === 0) {
    await docker.createNetwork({
      Name: WORKSPACE_NETWORK,
      Internal: true,
      IPAM: { Config: [{ Subnet: "172.30.0.0/16" }] },
      Labels: { "com.docker.compose.network": WORKSPACE_NETWORK },
    });
  }
}

beforeAll(async () => {
  if (!dockerUp) return;
  await ensureNetwork();
  sandbox = new DockerSandbox({ docker, transport, logSink, nowMs: () => Date.now() });
}, 180_000);

afterAll(async () => {
  for (const id of created) await sandbox?.destroyWorkspace(id).catch(() => {});
});

const textFor = (sessionId: string) => frames.filter((f) => f.sessionId === sessionId).map((f) => f.text).join("");
const until = async (pred: () => boolean, ms: number) => {
  const deadline = Date.now() + ms;
  while (!pred() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  return pred();
};

describe.skipIf(!dockerUp)("agent CLI session = PTY process (E4/T31)", () => {
  it("runs the entry as the PTY process with injected env, streams frames, records the exit code; re-open is idempotent only while live", async () => {
    const workspaceId = randomUUID();
    created.push(workspaceId);
    await sandbox.createWorkspace({ workspaceId, isolation: "analysis", env: {}, mounts: [], labels: {} });
    const sessionId = randomUUID();

    const r = await sandbox.openAgentSession({
      workspaceId,
      sessionId,
      cols: 80,
      rows: 24,
      cwd: "/",
      env: { ANTHROPIC_BASE_URL: "http://broker:1", ANTHROPIC_AUTH_TOKEN: "acos-sess-test", ACOS_PROMPT: "hello brief" },
      entrypoint: ["/bin/sh", "-c", 'echo "tok=$ANTHROPIC_AUTH_TOKEN prompt=$ACOS_PROMPT home=$HOME"; exit 7'],
    });
    expect(r.opened).toBe(true);
    expect(await until(() => sandbox.agentSessionStatus(sessionId)?.running === false, 20_000)).toBe(true);
    const status = sandbox.agentSessionStatus(sessionId)!;
    expect(status.exitCode).toBe(7);
    const text = textFor(sessionId);
    expect(text).toContain("tok=acos-sess-test prompt=hello brief home=/home/node");
    expect(text).toContain("[acos: agent session ended (exit 7)]");

    // ended → a new open for the same sessionId starts a fresh process
    const again = await sandbox.openAgentSession({
      workspaceId,
      sessionId,
      cols: 80,
      rows: 24,
      cwd: "/",
      env: {},
      entrypoint: ["/bin/sh", "-c", "exit 0"],
    });
    expect(again.opened).toBe(true);
    expect(await until(() => sandbox.agentSessionStatus(sessionId)?.exitCode === 0, 20_000)).toBe(true);
  }, 120_000);

  it("endAgentSession stops a live session (Ctrl-C → TERM → close) and keystrokes reach the PTY while live", async () => {
    const workspaceId = randomUUID();
    created.push(workspaceId);
    await sandbox.createWorkspace({ workspaceId, isolation: "analysis", env: {}, mounts: [], labels: {} });
    const sessionId = randomUUID();
    await sandbox.openAgentSession({
      workspaceId,
      sessionId,
      cols: 80,
      rows: 24,
      cwd: "/",
      env: {},
      // a long-lived foreground process that ignores SIGINT: proves the
      // escalation beyond Ctrl-C (pid file → SIGTERM) rather than the easy path
      entrypoint: [
        "/bin/sh",
        "-c",
        'mkdir -p /home/node/.acos && echo $$ > /home/node/.acos/session.pid; trap "" INT; read line; echo "got:$line"; sleep 300',
      ],
    });
    expect(sandbox.agentSessionStatus(sessionId)?.running).toBe(true);
    // live PTY accepts keystrokes through the shared shell registry
    expect(sandbox.writeShell(sessionId, Buffer.from("ping\n").toString("base64"))).toBe(true);
    expect(await until(() => textFor(sessionId).includes("got:ping"), 10_000)).toBe(true);

    const t0 = Date.now();
    const final = await sandbox.endAgentSession(sessionId, 2_000);
    expect(final?.running).toBe(false);
    expect(Date.now() - t0).toBeLessThan(15_000);
    // idempotent
    expect((await sandbox.endAgentSession(sessionId, 500))?.running).toBe(false);
    expect(sandbox.hasShell(sessionId)).toBe(false);
  }, 120_000);
});
