// GitWorkspaces unit tests — the container runner is faked so these run
// anywhere; the real clone/branch behaviour is proven Docker-gated in
// test/integration/git.int.test.ts.
import { describe, expect, it } from "vitest";
import {
  GitError,
  GitWorkspaces,
  REPOS_VOLUME,
  type GitBind,
  type GitRunner,
} from "./git.js";

const PROJECT = "018f0000-0000-7000-8000-00000000aaaa";
const HEAD = "b".repeat(40);

interface Call {
  script: string;
  binds: readonly GitBind[];
}

function fakeRunner(stdout: string, exitCode = 0) {
  const calls: Call[] = [];
  const volumes: string[] = [];
  const removed: string[] = [];
  const runner: GitRunner = {
    run: async (script, binds) => {
      calls.push({ script, binds });
      return { exitCode, stdout, stderr: exitCode === 0 ? "" : "boom" };
    },
    ensureVolume: async (name) => {
      volumes.push(name);
    },
    removeVolume: async (name) => {
      removed.push(name);
    },
  };
  return { runner, calls, volumes, removed };
}

describe("GitWorkspaces (T38)", () => {
  it("ensureBareRepo: parses CREATED + head, mounts only the repos volume", async () => {
    const { runner, calls, volumes } = fakeRunner(`CREATED\n${HEAD}\n`);
    const git = new GitWorkspaces(runner);
    const result = await git.ensureBareRepo(PROJECT);
    expect(result).toEqual({
      barePath: `/data/repos/${PROJECT}.git`,
      headCommit: HEAD,
      created: true,
    });
    expect(volumes).toEqual([REPOS_VOLUME]);
    expect(calls[0]!.binds).toEqual([{ volume: REPOS_VOLUME, target: "/data/repos" }]);
    expect(calls[0]!.script).toContain(`/data/repos/${PROJECT}.git`);
    expect(calls[0]!.script).toContain("--initial-branch=main");
  });

  it("ensureBareRepo: EXISTS → created=false; garbage output → GIT_FAILED", async () => {
    const exists = new GitWorkspaces(fakeRunner(`EXISTS\n${HEAD}\n`).runner);
    await expect(exists.ensureBareRepo(PROJECT)).resolves.toMatchObject({ created: false });

    const garbage = new GitWorkspaces(fakeRunner("fatal: weird\n").runner);
    await expect(garbage.ensureBareRepo(PROJECT)).rejects.toMatchObject({ code: "GIT_FAILED" });
  });

  it("rejects non-uuid project ids before any container runs", async () => {
    const { runner, calls } = fakeRunner("");
    const git = new GitWorkspaces(runner);
    await expect(git.ensureBareRepo("../../etc")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(calls).toHaveLength(0);
  });

  it("provisionWorktree: repos volume mounted READ-ONLY, worktree rw at /work", async () => {
    const { runner, calls, volumes } = fakeRunner(`CREATED\n${HEAD}\n`);
    const git = new GitWorkspaces(runner);
    const result = await git.provisionWorktree({
      projectId: PROJECT,
      volumeName: "ws-81-018f0000",
      branch: "task/81-add-oauth-login",
    });
    expect(result).toEqual({ volumeName: "ws-81-018f0000", baseCommit: HEAD, created: true });
    expect(volumes).toEqual(["ws-81-018f0000"]);
    expect(calls[0]!.binds).toEqual([
      { volume: REPOS_VOLUME, target: "/data/repos", readonly: true },
      { volume: "ws-81-018f0000", target: "/work" },
    ]);
    expect(calls[0]!.script).toContain('checkout -q -b "task/81-add-oauth-login"');
  });

  it("provisionWorktree: exit 44 → REPO_NOT_FOUND; bad branch/volume rejected up front", async () => {
    const missing = new GitWorkspaces(fakeRunner("bare repo missing", 44).runner);
    await expect(
      missing.provisionWorktree({
        projectId: PROJECT,
        volumeName: "ws-81-018f0000",
        branch: "task/81-x",
      }),
    ).rejects.toMatchObject({ code: "REPO_NOT_FOUND" });

    const git = new GitWorkspaces(fakeRunner("").runner);
    await expect(
      git.provisionWorktree({
        projectId: PROJECT,
        volumeName: "ws-81-018f0000",
        branch: "main; rm -rf /",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      git.provisionWorktree({
        projectId: PROJECT,
        volumeName: REPOS_VOLUME,
        branch: "task/81-x",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("removeWorktree: strict name pattern structurally protects the repos volume", async () => {
    const { runner, removed } = fakeRunner("");
    const git = new GitWorkspaces(runner);
    await git.removeWorktree("ws-81-018f0000");
    expect(removed).toEqual(["ws-81-018f0000"]);
    await expect(git.removeWorktree(REPOS_VOLUME)).rejects.toBeInstanceOf(GitError);
    await expect(git.removeWorktree("ws-81")).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
