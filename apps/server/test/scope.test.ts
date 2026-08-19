// Out-of-scope guards (29 §6, T50) — lint/CI-enforced refusals, not
// intentions. Guard 5: dark Phase-2/3 tables receive migrations and
// row-level tests ONLY — any route or UI surface referencing them fails
// here (the scope allowlist test). Guard 4: the Docker socket is granted to
// sandbox-manager and NOTHING else (S1) — asserted statically against the
// compose file that ships the platform.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

describe("scope allowlist (29 §6.5) — Phase-2/3 features stay dark", () => {
  // schema-only subsystems (29 §4): marketing assets/experiments/content,
  // deployments, incidents/decisions UI — tables exist, no API surface
  const FORBIDDEN_PATH_MARKERS = [
    "/assets",
    "/experiments",
    "/content",
    "/campaigns",
    "/marketing",
    "/deployments",
    "/incidents",
    "/decisions",
  ];

  it("no OpenAPI path exposes a dark subsystem", () => {
    const spec = JSON.parse(
      readFileSync(join(here, "../../../packages/contracts/openapi.json"), "utf8"),
    ) as { paths: Record<string, unknown> };
    const paths = Object.keys(spec.paths);
    expect(paths.length).toBeGreaterThan(50); // sanity: the real spec loaded
    for (const path of paths) {
      for (const marker of FORBIDDEN_PATH_MARKERS) {
        expect(path.includes(marker), `dark subsystem leaked into the API: ${path}`).toBe(false);
      }
    }
  });

  it("the web nav exposes no dark views", () => {
    const shell = readFileSync(
      join(here, "../../web/src/shell/AppShell.tsx"),
      "utf8",
    );
    // nav items without a path render as dead labels — dark views must not
    // gain a route (SETTINGS is the only remaining placeholder by design)
    expect(shell).not.toMatch(/label: "MARKETING"/);
    expect(shell).not.toMatch(/path: "[^"]*(assets|experiments|campaigns)/);
  });
});

describe("S1 socket exclusivity (29 §6.4) — only sandbox-manager mounts dockerd", () => {
  it("compose grants /var/run/docker.sock to exactly one service: sandbox-manager", () => {
    const compose = readFileSync(
      join(here, "../../../infrastructure/docker/compose.yaml"),
      "utf8",
    );
    const mounts = compose
      .split("\n")
      .filter((line) => line.includes("docker.sock") && !line.trim().startsWith("#"));
    expect(mounts).toHaveLength(1);

    // the single mount sits inside the sandbox-manager service block
    const sandboxBlock = compose.slice(compose.indexOf("\n  sandbox-manager:"));
    const nextService = sandboxBlock.slice(1).search(/\n {2}[a-z-]+:/);
    const block = nextService > 0 ? sandboxBlock.slice(0, nextService + 1) : sandboxBlock;
    expect(block).toContain("docker.sock");
    // and no other service block mentions the socket at all
    const withoutSandbox = compose.replace(block, "");
    expect(withoutSandbox.includes("docker.sock")).toBe(false);
  });
});
