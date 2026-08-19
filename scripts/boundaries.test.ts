// Fixture tests for net 1 (eslint-plugin-boundaries + no-internal-modules +
// agent-framework ban). T02 acceptance: a deliberate violation fails lint,
// removing it passes. Files are linted as virtual paths inside real packages.
import { beforeAll, describe, expect, it } from "vitest";
import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let eslint: ESLint;
beforeAll(() => {
  eslint = new ESLint({ cwd: REPO_ROOT });
});

async function ruleIdsFor(code: string, virtualPath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, {
    filePath: join(REPO_ROOT, virtualPath),
    warnIgnored: false,
  });
  return (result?.messages ?? []).map((m) => m.ruleId ?? "<parse-error>");
}

describe("eslint boundaries (net 1)", () => {
  it("domain may import nothing internal (domain -> db fails)", async () => {
    const rules = await ruleIdsFor(
      'import { packageName } from "@acos/db";\nexport const x = packageName;\n',
      "packages/domain/src/fixture-violation.ts",
    );
    expect(rules).toContain("boundaries/element-types");
  });

  it("web may import only contracts + ui (web -> db fails)", async () => {
    const rules = await ruleIdsFor(
      'import { packageName } from "@acos/db";\nexport const x = packageName;\n',
      "apps/web/src/fixture-violation.ts",
    );
    expect(rules).toContain("boundaries/element-types");
  });

  it("apps never import each other (agent-worker -> server fails)", async () => {
    const rules = await ruleIdsFor(
      'import { packageName } from "@acos/server";\nexport const x = packageName;\n',
      "workers/agent-worker/src/fixture-violation.ts",
    );
    expect(rules).toContain("boundaries/element-types");
  });

  it("execution-worker never imports db (execution plane holds no domain state)", async () => {
    const rules = await ruleIdsFor(
      'import { packageName } from "@acos/db";\nexport const x = packageName;\n',
      "workers/execution-worker/src/fixture-violation.ts",
    );
    expect(rules).toContain("boundaries/element-types");
  });

  it("allowed imports pass (db -> domain, web -> contracts)", async () => {
    expect(
      await ruleIdsFor(
        'import { packageName } from "@acos/domain";\nexport const x = packageName;\n',
        "packages/db/src/fixture-ok.ts",
      ),
    ).toEqual([]);
    expect(
      await ruleIdsFor(
        'import { packageName } from "@acos/contracts";\nexport const x = packageName;\n',
        "apps/web/src/fixture-ok.ts",
      ),
    ).toEqual([]);
  });

  it("ui: type-only import from contracts passes, value import fails", async () => {
    expect(
      await ruleIdsFor(
        'import type { packageName } from "@acos/contracts";\nexport type T = typeof packageName;\n',
        "packages/ui/src/fixture-type-only.ts",
      ),
    ).toEqual([]);
    expect(
      await ruleIdsFor(
        'import { packageName } from "@acos/contracts";\nexport const x = packageName;\n',
        "packages/ui/src/fixture-value.ts",
      ),
    ).toContain("boundaries/element-types");
  });

  it("deep imports are banned (exports maps are the API surface)", async () => {
    const rules = await ruleIdsFor(
      'import "@acos/domain/dist/index.js";\n',
      "apps/server/src/fixture-deep.ts",
    );
    expect(rules).toContain("import/no-internal-modules");
  });

  it("agent frameworks are banned everywhere (ADR-004)", async () => {
    for (const specifier of ["langchain", "@langchain/core", "crewai", "langgraph"]) {
      const rules = await ruleIdsFor(
        `import "${specifier}";\n`,
        "packages/llm/src/fixture-framework.ts",
      );
      expect(rules, specifier).toContain("no-restricted-imports");
    }
  });
});
