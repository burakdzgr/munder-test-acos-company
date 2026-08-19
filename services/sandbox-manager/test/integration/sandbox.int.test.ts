// T37 acceptance (Docker-gated): a real create → exec → destroy round-trip;
// the resource-limit matrix + S8 hardening applied at container create (a
// fork bomb dies at the pids cap while the container survives); the
// `analysis` level has no network. Skips cleanly where no Docker daemon is
// reachable (the CI integration stage has one — Testcontainers needs it too).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Docker from "dockerode";
import { WORKSPACE_NETWORK } from "@acos/tools";
import { DockerSandbox } from "../../src/docker.js";
import type { TerminalLogSink, TerminalTransport } from "../../src/terminal.js";

const docker = new Docker();

// probed at module load (top-level await) so describe.skipIf — evaluated at
// COLLECTION time, before any hook — sees the right value
let dockerUp = false;
try {
  await docker.ping();
  dockerUp = true;
} catch {
  dockerUp = false;
}

const transport: TerminalTransport = { publish: () => {} };
const logSink: TerminalLogSink = { append: () => {} };
let sandbox: DockerSandbox;
const created: string[] = [];

// alpine + the acos-workspaces network are prerequisites the compose stack
// provides; in a bare int run we ensure both up front
async function ensureNetwork(): Promise<void> {
  const nets = await docker.listNetworks({ filters: { name: [WORKSPACE_NETWORK] } });
  if (nets.length === 0) {
    // mirror compose.yaml exactly (subnet = squid ACL) + the compose label so
    // a later `compose up` adopts the network instead of refusing it
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

describe.skipIf(!dockerUp)("DockerSandbox round-trip (T37)", () => {
  it("create → applies the S8 hardened HostConfig + coding limits → exec → destroy", async () => {
    const workspaceId = randomUUID();
    created.push(workspaceId);
    const ws = await sandbox.createWorkspace({
      workspaceId,
      isolation: "coding",
      env: {},
      mounts: [],
      labels: { "acos.company_id": "test" },
    });
    expect(ws.status).toBe("running");

    // limits + hardening are on the real container (27 §11 + S8)
    const info = await docker.getContainer(ws.containerId).inspect();
    expect(info.HostConfig.PidsLimit).toBe(512);
    expect(info.HostConfig.Memory).toBe(4 * 1024 ** 3);
    expect(info.HostConfig.NanoCpus).toBe(2 * 1e9);
    expect(info.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(info.HostConfig.SecurityOpt).toContain("no-new-privileges");
    expect(info.HostConfig.ReadonlyRootfs).toBe(true);
    expect(info.HostConfig.NetworkMode).toBe(WORKSPACE_NETWORK);
    // O10: agent code must not run as root. The rest of the stack already
    // assumed uid 1000 (provisionWorktree chowns the worktree to it), but the
    // container spec did not say so — so workspaces ran as root over a
    // volume owned by 1000.
    expect(info.Config.User).toBe("1000:1000");

    // exec a command → real exit code + stdout
    const result = await sandbox.exec(workspaceId, {
      command: ["echo", "hello-sandbox"],
      env: {},
      timeoutMs: 30_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello-sandbox");
    expect(result.timedOut).toBe(false);

    // it shows up in the listing, then is gone after destroy
    expect((await sandbox.list()).some((w) => w.workspaceId === workspaceId)).toBe(true);
    await sandbox.destroyWorkspace(workspaceId);
    expect((await sandbox.list()).some((w) => w.workspaceId === workspaceId)).toBe(false);
  }, 180_000);

  it("a fork bomb dies at the pids cap; the container survives", async () => {
    const workspaceId = randomUUID();
    created.push(workspaceId);
    const ws = await sandbox.createWorkspace({
      workspaceId,
      isolation: "analysis", // pids 256, no network
      env: {},
      mounts: [],
      labels: {},
    });

    // spawn far more background procs than the 256 pid cap allows: once the
    // ceiling is hit the kernel refuses new forks and the shell reports it
    // (proof the cap fires — past the cap even `ps` cannot be spawned)
    const bomb = await sandbox.exec(workspaceId, {
      command: [
        "/bin/sh",
        "-c",
        "i=0; while [ $i -lt 600 ]; do sleep 5 & i=$((i+1)); done; echo attempted=$i",
      ],
      env: {},
      timeoutMs: 60_000,
    });
    expect(bomb.stderr).toMatch(/can'?t fork|fork|resource temporarily unavailable/i);

    // the container is NOT killed by the bomb — the daemon still sees it
    // running (a daemon-side check needs no in-container fork)
    const info = await docker.getContainer(ws.containerId).inspect();
    expect(info.State.Running).toBe(true);
  }, 180_000);

  it("analysis workspaces have no network egress", async () => {
    const workspaceId = randomUUID();
    created.push(workspaceId);
    const ws = await sandbox.createWorkspace({
      workspaceId,
      isolation: "analysis",
      env: {},
      mounts: [],
      labels: {},
    });
    const info = await docker.getContainer(ws.containerId).inspect();
    expect(info.HostConfig.NetworkMode).toBe("none");

    // only loopback exists — no outbound interface (27 §11 network: none)
    const net = await sandbox.exec(workspaceId, {
      command: ["/bin/sh", "-c", "ip -o addr show 2>/dev/null | awk '{print $2}' | sort -u"],
      env: {},
      timeoutMs: 30_000,
    });
    const ifaces = net.stdout.trim().split("\n").filter(Boolean);
    expect(ifaces).toEqual(["lo"]);
  }, 180_000);

  it("in-container timeout kills a runaway command at the wall clock", async () => {
    const workspaceId = randomUUID();
    created.push(workspaceId);
    await sandbox.createWorkspace({
      workspaceId,
      isolation: "analysis",
      env: {},
      mounts: [],
      labels: {},
    });
    const result = await sandbox.exec(workspaceId, {
      command: ["sleep", "30"],
      env: {},
      timeoutMs: 1_000,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(137); // busybox timeout -s KILL
  }, 180_000);
});
