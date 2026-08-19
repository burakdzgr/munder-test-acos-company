import { describe, expect, it } from "vitest";
import {
  hardenedHostConfig,
  ISOLATION_LIMITS,
  isIsolationLevel,
  WORKSPACE_NETWORK,
  workspaceEnv,
} from "./isolation.js";

describe("isolation matrix (27 §11)", () => {
  it("matches the canonical resource table exactly", () => {
    const GB = 1024 ** 3;
    expect(ISOLATION_LIMITS.analysis).toMatchObject({
      cpus: 1,
      memoryBytes: 1 * GB,
      pidsLimit: 256,
      diskQuotaBytes: 2 * GB,
      network: "none",
    });
    expect(ISOLATION_LIMITS.coding).toMatchObject({
      cpus: 2,
      memoryBytes: 4 * GB,
      pidsLimit: 512,
      diskQuotaBytes: 10 * GB,
      network: "egress",
    });
    expect(ISOLATION_LIMITS.testing).toMatchObject({
      cpus: 4,
      memoryBytes: 8 * GB,
      pidsLimit: 1024,
      diskQuotaBytes: 20 * GB,
      network: "egress",
    });
  });

  it("guards the level enum", () => {
    expect(isIsolationLevel("coding")).toBe(true);
    expect(isIsolationLevel("deploy")).toBe(false); // Phase 3
  });
});

describe("hardened HostConfig (S8)", () => {
  it("drops all caps, forbids privilege escalation, read-only root, size-capped noexec /tmp", () => {
    const hc = hardenedHostConfig("coding");
    expect(hc.CapDrop).toEqual(["ALL"]);
    expect(hc.SecurityOpt).toContain("no-new-privileges");
    expect(hc.ReadonlyRootfs).toBe(true);
    expect(hc.Tmpfs["/tmp"]).toContain("noexec");
    expect(hc.Tmpfs["/tmp"]).toContain(`size=${ISOLATION_LIMITS.coding.scratchBytes}`);
    expect(hc.AutoRemove).toBe(false);
  });

  it("translates the limits into Docker units", () => {
    const hc = hardenedHostConfig("testing");
    expect(hc.NanoCpus).toBe(4 * 1e9);
    expect(hc.Memory).toBe(ISOLATION_LIMITS.testing.memoryBytes);
    expect(hc.PidsLimit).toBe(1024);
  });

  it("analysis is network 'none'; egress levels join the internal workspaces network", () => {
    expect(hardenedHostConfig("analysis").NetworkMode).toBe("none");
    expect(hardenedHostConfig("coding").NetworkMode).toBe(WORKSPACE_NETWORK);
    expect(hardenedHostConfig("testing").NetworkMode).toBe(WORKSPACE_NETWORK);
  });

  it("only mounts what the caller passes — no implicit host mounts", () => {
    expect(hardenedHostConfig("coding").Mounts).toEqual([]);
    const withMount = hardenedHostConfig("coding", [
      { source: "/data/worktrees/w1", target: "/workspace", readonly: false },
    ]);
    expect(withMount.Mounts).toEqual([
      { Type: "bind", Source: "/data/worktrees/w1", Target: "/workspace", ReadOnly: false },
    ]);
  });
});

describe("workspace egress env (27 §12)", () => {
  it("injects proxy env only for egress levels; HOME/npm cache everywhere", () => {
    // 2026-08-18: /home/node exec'li tmpfs — HOME + npm cache her seviyede
    // oraya sabitlenir (readonly rootfs'te ~/.npm yazılamıyordu, npx 126).
    const analysis = workspaceEnv("analysis");
    expect(analysis.HOME).toBe("/home/node");
    expect(analysis.npm_config_cache).toBe("/home/node/.npm");
    expect(analysis.HTTP_PROXY).toBeUndefined();
    const env = workspaceEnv("coding");
    expect(env.HOME).toBe("/home/node");
    expect(env.HTTP_PROXY).toBe("http://egress-proxy:3128");
    expect(env.HTTPS_PROXY).toBe("http://egress-proxy:3128");
    expect(env.NO_PROXY).toContain("127.0.0.1");
    expect(env.GIT_CONFIG_VALUE_0).toBe("/work");
  });
});
