// Flat ESLint config — net 1 of the three dependency-rule enforcement nets
// (28-REPOSITORY-STRUCTURE.md §3, 35-CLAUDE-CODE-HANDOFF.md §4):
//   - eslint-plugin-boundaries: the package dependency matrix, encoded per element type
//   - eslint-plugin-import/no-internal-modules: deep-import ban (exports maps are the API)
//   - no-restricted-imports: agent-framework ban (ADR-004, 29-MVP-PLAN.md §6)
// Nets 2 and 3 are scripts/check-deps.ts and TypeScript project references.
import tseslint from "typescript-eslint";
import boundaries from "eslint-plugin-boundaries";
import importPlugin from "eslint-plugin-import";

// The binding dependency matrix (35 §4). Importer -> allowed internal deps.
const MATRIX = {
  domain: [],
  config: [],
  events: ["domain"],
  tools: ["domain"],
  db: ["domain", "events", "config"],
  llm: ["domain", "config"],
  contracts: ["domain", "events"],
  ui: [],
  server: ["domain", "db", "events", "contracts", "llm", "tools", "config"],
  web: ["contracts", "ui"],
  desktop: [],
  "agent-worker": ["domain", "db", "events", "llm", "tools", "config"],
  "execution-worker": ["domain", "tools", "config", "contracts"],
  "sandbox-manager": ["config", "contracts", "tools"],
  "identity-broker": [],
};

const ELEMENT_DIRS = {
  domain: "packages/domain",
  config: "packages/config",
  events: "packages/events",
  tools: "packages/tools",
  db: "packages/db",
  llm: "packages/llm",
  contracts: "packages/contracts",
  ui: "packages/ui",
  server: "apps/server",
  web: "apps/web",
  desktop: "apps/desktop",
  "agent-worker": "workers/agent-worker",
  "execution-worker": "workers/execution-worker",
  "sandbox-manager": "services/sandbox-manager",
  "identity-broker": "services/identity-broker",
};

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.d.ts", "docs/**"],
  },
  ...tseslint.configs.recommended,
  {
    plugins: { boundaries, import: importPlugin },
    settings: {
      "import/resolver": {
        typescript: { project: "./tsconfig.eslint.json", alwaysTryTypes: true },
      },
      "boundaries/elements": Object.entries(ELEMENT_DIRS).map(([type, dir]) => ({
        type,
        pattern: `${dir}/**/*`,
        partialMatch: false,
      })),
    },
    rules: {
      "boundaries/element-types": [
        "error",
        {
          default: "disallow",
          message:
            "{{file.type}} may not import {{dependency.type}} (dependency matrix, 35-CLAUDE-CODE-HANDOFF.md §4)",
          policies: [
            ...Object.entries(MATRIX)
              .filter(([, allowed]) => allowed.length > 0)
              .map(([from, allowed]) => ({
                from: { element: { type: from } },
                allow: allowed.map((to) => ({ to: { element: { type: to } } })),
              })),
            // ui: type-only imports from contracts are allowed (28 §2)
            {
              from: { element: { type: "ui" } },
              allow: [{ to: { element: { type: "contracts" } }, dependency: { kind: "type" } }],
            },
          ],
        },
      ],
      // Deep imports are banned; packages expose only their exports map (28 §2).
      // Public subpath exports (@acos/domain/state-machines, @acos/domain/policies,
      // @acos/contracts/client, @acos/db/schema) resolve via exports maps and are
      // not "internal"; internals live under src/ and dist/.
      "import/no-internal-modules": [
        "error",
        { forbid: ["@acos/*/src/**", "@acos/*/dist/**"] },
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["crewai", "crewai/*"], message: "Agent frameworks are banned in core (ADR-004)." },
            { group: ["langchain", "langchain/*"], message: "Agent frameworks are banned in core (ADR-004)." },
            { group: ["langgraph", "langgraph/*"], message: "Agent frameworks are banned in core (ADR-004)." },
            { group: ["@langchain/*"], message: "Agent frameworks are banned in core (ADR-004)." },
          ],
        },
      ],
    },
  },
  // ADR-015 boundary: no AI SDK type/function crosses the adapter layer —
  // only packages/llm/src/adapters/** may import `ai` / `@ai-sdk/*`.
  {
    files: ["**/*.ts", "**/*.tsx"],
    ignores: ["packages/llm/src/adapters/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["crewai", "crewai/*"], message: "Agent frameworks are banned in core (ADR-004)." },
            { group: ["langchain", "langchain/*"], message: "Agent frameworks are banned in core (ADR-004)." },
            { group: ["langgraph", "langgraph/*"], message: "Agent frameworks are banned in core (ADR-004)." },
            { group: ["@langchain/*"], message: "Agent frameworks are banned in core (ADR-004)." },
            { group: ["ai", "ai/*", "@ai-sdk/*"], message: "AI SDK stays inside packages/llm adapters — use the @acos/llm port (ADR-015)." },
          ],
        },
      ],
    },
  },
  // Office lint rule (29-MVP-PLAN.md §6.3, 23-VIRTUAL-OFFICE.md §4.1): the
  // office module renders exclusively projector instructions — no fake motion.
  // Animation APIs (rAF, timers, Pixi imports) are banned everywhere in the
  // module except the Pixi bridge and the headless engine it drives.
  {
    files: ["apps/web/src/features/office/**/*"],
    ignores: [
      "apps/web/src/features/office/OfficeCanvas.tsx",
      "apps/web/src/features/office/sceneState.ts",
      "apps/web/src/features/office/*.test.ts",
    ],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "requestAnimationFrame", message: "Office motion originates ONLY from projector instructions (no fake animation — 23 §4.1). Animate in the Pixi bridge." },
        { name: "setInterval", message: "No timer-driven office motion (23 §4.1)." },
        { name: "setTimeout", message: "No timer-driven office motion (23 §4.1)." },
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["pixi.js", "pixi.js/*", "@pixi/*", "gsap", "gsap/*"], message: "Only the Pixi bridge (OfficeCanvas) may touch rendering/animation APIs (23 §7)." },
          ],
        },
      ],
    },
  },
);
