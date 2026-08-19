// Fixture tests for net 2 + net 3 (T02 acceptance: a deliberate violation
// fails, removing it passes). The real repo must always pass.
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { checkManifest, checkRepo, type ManifestInput } from "./check-deps.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function manifest(overrides: Partial<ManifestInput> & { name: string }): ManifestInput {
  return {
    packageJson: { name: `@acos/${overrides.name}` },
    tsconfigReferences: [],
    ...overrides,
  };
}

describe("check-deps (net 2: manifests, net 3: project references)", () => {
  it("the actual repository conforms to the matrix", () => {
    const result = checkRepo(REPO_ROOT);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("flags an internal dep outside the allow-matrix (db -> llm)", () => {
    const errors = checkManifest(
      manifest({
        name: "db",
        packageJson: {
          name: "@acos/db",
          dependencies: { "@acos/domain": "workspace:*", "@acos/llm": "workspace:*" },
        },
        tsconfigReferences: ["../../packages/domain", "../../packages/events", "../../packages/config"],
      }),
    );
    expect(errors.some((e) => e.includes('"@acos/llm" violates the dependency matrix'))).toBe(true);
  });

  it("flags app -> app dependencies (agent-worker -> server)", () => {
    const errors = checkManifest(
      manifest({
        name: "agent-worker",
        packageJson: { name: "@acos/agent-worker", dependencies: { "@acos/server": "workspace:*" } },
      }),
    );
    expect(errors.some((e) => e.includes('"@acos/server" violates the dependency matrix'))).toBe(true);
  });

  it("flags execution-worker depending on db (S/02 §3: execution plane holds no domain state)", () => {
    const errors = checkManifest(
      manifest({
        name: "execution-worker",
        packageJson: { name: "@acos/execution-worker", dependencies: { "@acos/db": "workspace:*" } },
      }),
    );
    expect(errors.some((e) => e.includes('"@acos/db" violates the dependency matrix'))).toBe(true);
  });

  it("blacklists Redis clients (ADR-006)", () => {
    const errors = checkManifest(
      manifest({
        name: "server",
        packageJson: { name: "@acos/server", dependencies: { ioredis: "^5.0.0" } },
      }),
    );
    expect(errors.some((e) => e.includes('"ioredis" is blacklisted'))).toBe(true);
  });

  it("blacklists agent frameworks (ADR-004), including scoped packages", () => {
    for (const dep of ["langchain", "crewai", "langgraph", "@langchain/core"]) {
      const errors = checkManifest(
        manifest({
          name: "llm",
          packageJson: { name: "@acos/llm", dependencies: { [dep]: "*" } },
        }),
      );
      expect(errors.some((e) => e.includes(`"${dep}" is blacklisted`))).toBe(true);
    }
  });

  it("flags tsconfig reference drift in both directions (net 3)", () => {
    // missing required reference
    const missing = checkManifest(
      manifest({
        name: "events",
        packageJson: { name: "@acos/events", dependencies: { "@acos/domain": "workspace:*" } },
        tsconfigReferences: [],
      }),
    );
    expect(missing.some((e) => e.includes("missing a project reference to packages/domain"))).toBe(true);

    // extra disallowed reference
    const extra = checkManifest(
      manifest({
        name: "domain",
        packageJson: { name: "@acos/domain" },
        tsconfigReferences: ["../../packages/db"],
      }),
    );
    expect(extra.some((e) => e.includes('references "db" which is not an allowed dep'))).toBe(true);
  });

  it("passes a conforming manifest (violation removed)", () => {
    const errors = checkManifest(
      manifest({
        name: "db",
        packageJson: {
          name: "@acos/db",
          dependencies: {
            "@acos/domain": "workspace:*",
            "@acos/events": "workspace:*",
            "@acos/config": "workspace:*",
          },
        },
        tsconfigReferences: ["../../packages/domain", "../../packages/events", "../../packages/config"],
      }),
    );
    expect(errors).toEqual([]);
  });
});
