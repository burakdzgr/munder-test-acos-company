// T38 acceptance (Docker-gated): two tasks on ONE project get fully isolated
// worktree volumes — each on its own `task/<n>-<slug>` branch cloned from the
// same bare repo — and a file written in one workspace is invisible in the
// other. Uses a suite-scoped repos volume so the real `acos-repos` volume is
// never touched. Skips cleanly where no Docker daemon is reachable.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Docker from "dockerode";
import { WORKSPACE_NETWORK } from "@acos/tools";
import { DockerSandbox } from "../../src/docker.js";
import { DockerGitRunner, GitWorkspaces } from "../../src/git.js";
import type { TerminalLogSink, TerminalTransport } from "../../src/terminal.js";

const docker = new Docker();
let dockerUp = false;
try {
  await docker.ping();
  dockerUp = true;
} catch {
  dockerUp = false;
}

const transport: TerminalTransport = { publish: () => {} };
const logSink: TerminalLogSink = { append: () => {} };

// suite-scoped names — parallel CI runs cannot collide
const REPOS_TEST_VOLUME = `acos-repos-test-${randomUUID().slice(0, 8)}`;
const projectId = randomUUID();
const VOL_81 = "ws-81-11111111";
const VOL_82 = "ws-82-22222222";

let sandbox: DockerSandbox;
let git: GitWorkspaces;
const containers: string[] = [];

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
  // fixed worktree names: a crashed earlier run may have left them behind
  // (possibly still referenced by its workspace containers) — stale content
  // would flip created=false and pollute the assertions
  for (const vol of [VOL_81, VOL_82]) {
    const holders = await docker
      .listContainers({ all: true, filters: { volume: [vol] } })
      .catch(() => []);
    for (const holder of holders) {
      await docker.getContainer(holder.Id).remove({ force: true }).catch(() => {});
    }
    await docker
      .getVolume(vol)
      .remove({ force: true })
      .catch(() => {});
  }
  sandbox = new DockerSandbox({ docker, transport, logSink, nowMs: () => Date.now() });
  git = new GitWorkspaces(new DockerGitRunner({ docker }), { reposVolume: REPOS_TEST_VOLUME });
}, 240_000);

afterAll(async () => {
  if (!dockerUp) return;
  for (const id of containers) await sandbox.destroyWorkspace(id).catch(() => {});
  for (const vol of [VOL_81, VOL_82, REPOS_TEST_VOLUME]) {
    await docker
      .getVolume(vol)
      .remove({ force: true })
      .catch(() => {});
  }
});

describe.skipIf(!dockerUp)("Git model: bare repo + per-task worktrees (T38)", () => {
  it("ensureBareRepo seeds main and is idempotent", async () => {
    const first = await git.ensureBareRepo(projectId);
    expect(first.created).toBe(true);
    expect(first.barePath).toBe(`/data/repos/${projectId}.git`);
    expect(first.headCommit).toMatch(/^[0-9a-f]{40}$/);

    const second = await git.ensureBareRepo(projectId);
    expect(second.created).toBe(false);
    expect(second.headCommit).toBe(first.headCommit); // same seeded root commit
  }, 240_000);

  it("two tasks on one project get ISOLATED worktrees on their own branches", async () => {
    const wt81 = await git.provisionWorktree({
      projectId,
      volumeName: VOL_81,
      branch: "task/81-add-oauth-login",
    });
    const wt82 = await git.provisionWorktree({
      projectId,
      volumeName: VOL_82,
      branch: "task/82-fix-signup-form",
    });
    // both cloned from the same origin head
    expect(wt81.baseCommit).toBe(wt82.baseCommit);
    expect(wt81.created).toBe(true);
    expect(wt82.created).toBe(true);

    // mount each worktree volume rw at /work in a hardened workspace container
    const ws81 = randomUUID();
    const ws82 = randomUUID();
    containers.push(ws81, ws82);
    for (const [id, vol] of [
      [ws81, VOL_81],
      [ws82, VOL_82],
    ] as const) {
      await sandbox.createWorkspace({
        workspaceId: id,
        isolation: "coding",
        env: {},
        mounts: [{ source: vol, target: "/work", readonly: false, type: "volume" }],
        labels: {},
      });
    }

    // each workspace sits on its own task branch (HEAD file needs no git binary)
    const head81 = await sandbox.exec(ws81, {
      command: ["cat", "/work/.git/HEAD"],
      env: {},
      timeoutMs: 30_000,
    });
    const head82 = await sandbox.exec(ws82, {
      command: ["cat", "/work/.git/HEAD"],
      env: {},
      timeoutMs: 30_000,
    });
    expect(head81.stdout.trim()).toBe("ref: refs/heads/task/81-add-oauth-login");
    expect(head82.stdout.trim()).toBe("ref: refs/heads/task/82-fix-signup-form");

    // a write in workspace 81 is INVISIBLE in workspace 82 (worktree isolation)
    const write = await sandbox.exec(ws81, {
      command: ["/bin/sh", "-c", "echo oauth > /work/only-in-81.txt && cat /work/only-in-81.txt"],
      env: {},
      timeoutMs: 30_000,
    });
    expect(write.exitCode, `write stderr: ${write.stderr}`).toBe(0);
    expect(write.stdout.trim()).toBe("oauth");

    const probe = await sandbox.exec(ws82, {
      command: ["/bin/sh", "-c", "test -e /work/only-in-81.txt && echo LEAKED || echo ISOLATED"],
      env: {},
      timeoutMs: 30_000,
    });
    expect(probe.stdout.trim()).toBe("ISOLATED");
  }, 300_000);

  it("re-provisioning an existing worktree is idempotent (created=false, same base)", async () => {
    const again = await git.provisionWorktree({
      projectId,
      volumeName: VOL_81,
      branch: "task/81-add-oauth-login",
    });
    expect(again.created).toBe(false);
    expect(again.baseCommit).toMatch(/^[0-9a-f]{40}$/);
  }, 240_000);

  it("provisioning against a project with no bare repo fails typed (REPO_NOT_FOUND)", async () => {
    await expect(
      git.provisionWorktree({
        projectId: randomUUID(),
        volumeName: "ws-99-33333333",
        branch: "task/99-missing",
      }),
    ).rejects.toMatchObject({ code: "REPO_NOT_FOUND" });
    await docker
      .getVolume("ws-99-33333333")
      .remove({ force: true })
      .catch(() => {});
  }, 240_000);
});
