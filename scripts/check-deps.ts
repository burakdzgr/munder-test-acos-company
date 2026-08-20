// Net 2 of the dependency-rule enforcement (28-REPOSITORY-STRUCTURE.md §3):
// diffs every workspace manifest against the binding allow-matrix
// (35-CLAUDE-CODE-HANDOFF.md §4), blacklists Redis clients and agent
// frameworks (29-MVP-PLAN.md §6, ADR-004/006), and asserts that each
// workspace's tsconfig `references` equal exactly its allowed deps (net 3).
// CI-blocking: exits 1 with named errors on any drift.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface WorkspaceSpec {
  dir: string;
  name: string; // short name; package is @acos/<name>
  allowed: string[]; // allowed internal deps (short names) — binding matrix 35 §4
}

// Importer -> allowed internal deps. Binding (35 §4, _DECISIONS.md §3).
export const WORKSPACES: WorkspaceSpec[] = [
  { dir: "packages/domain", name: "domain", allowed: [] },
  { dir: "packages/config", name: "config", allowed: [] },
  { dir: "packages/events", name: "events", allowed: ["domain"] },
  { dir: "packages/tools", name: "tools", allowed: ["domain"] },
  { dir: "packages/db", name: "db", allowed: ["domain", "events", "config"] },
  { dir: "packages/llm", name: "llm", allowed: ["domain", "config"] },
  { dir: "packages/contracts", name: "contracts", allowed: ["domain", "events"] },
  { dir: "packages/ui", name: "ui", allowed: [] },
  { dir: "apps/server", name: "server", allowed: ["domain", "db", "events", "contracts", "llm", "tools", "config"] },
  { dir: "apps/web", name: "web", allowed: ["contracts", "ui"] },
  // U13 (36 §11): Electron shell over the built apps/web bundle — zero @acos deps.
  { dir: "apps/desktop", name: "desktop", allowed: [] },
  { dir: "workers/agent-worker", name: "agent-worker", allowed: ["domain", "db", "events", "llm", "tools", "config"] },
  { dir: "workers/execution-worker", name: "execution-worker", allowed: ["domain", "tools", "config", "contracts"] },
  { dir: "services/sandbox-manager", name: "sandbox-manager", allowed: ["config", "contracts", "tools"] },
  // E4/T31 (ADR-022 §4): host-side identity broker — zero @acos deps by design (holds the subscription credential, nothing else).
  { dir: "services/identity-broker", name: "identity-broker", allowed: [] },
];

// ui may see contracts TYPES only (28 §2): devDependency permitted, runtime dependency not.
export const TYPE_ONLY_DEV_DEPS: Record<string, string[]> = { ui: ["contracts"] };

// Banned everywhere (any dependency field, any workspace + root).
// Redis clients: ADR-006 (no Redis in MVP). Agent frameworks: ADR-004.
export const BANNED: { pattern: RegExp; reason: string }[] = [
  { pattern: /^(redis|ioredis)$/, reason: "Redis client — no Redis in MVP (ADR-006)" },
  { pattern: /^@(redis|node-redis|ioredis)\//, reason: "Redis client — no Redis in MVP (ADR-006)" },
  { pattern: /^(crewai|langchain|langgraph|metagpt|openhands)$/, reason: "agent framework — banned in core (ADR-004)" },
  { pattern: /^@(langchain|langgraph|crewai)\//, reason: "agent framework — banned in core (ADR-004)" },
];

export interface ManifestInput {
  name: string; // short workspace name
  packageJson: {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  tsconfigReferences: string[]; // resolved reference paths, e.g. "../../packages/domain"
}

const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

const dirOf = Object.fromEntries(WORKSPACES.map((w) => [w.name, w.dir]));

function shortName(pkgName: string): string | null {
  return pkgName.startsWith("@acos/") ? pkgName.slice("@acos/".length) : null;
}

export function checkManifest(input: ManifestInput): string[] {
  const errors: string[] = [];
  const spec = WORKSPACES.find((w) => w.name === input.name);
  if (!spec) return [`unknown workspace "${input.name}" — not in the canonical 13 (28 §1)`];

  if (input.packageJson.name !== `@acos/${input.name}`) {
    errors.push(`${spec.dir}: package name must be "@acos/${input.name}", got "${input.packageJson.name}"`);
  }

  for (const field of DEP_FIELDS) {
    for (const dep of Object.keys(input.packageJson[field] ?? {})) {
      const banned = BANNED.find((b) => b.pattern.test(dep));
      if (banned) {
        errors.push(`${spec.dir}: ${field} "${dep}" is blacklisted (${banned.reason})`);
        continue;
      }
      const internal = shortName(dep);
      if (internal === null) continue;
      const allowedHere =
        spec.allowed.includes(internal) ||
        (field === "devDependencies" && (TYPE_ONLY_DEV_DEPS[input.name] ?? []).includes(internal));
      if (!allowedHere) {
        errors.push(
          `${spec.dir}: ${field} "@acos/${internal}" violates the dependency matrix (35 §4) — allowed: [${spec.allowed.join(", ") || "none"}]`,
        );
      }
    }
  }

  // Net 3 (structural): tsconfig references must equal exactly the allowed deps (35 §15.4).
  // Optional extras: type-only dev deps (ui -> contracts) may also be referenced.
  const optional = new Set(TYPE_ONLY_DEV_DEPS[input.name] ?? []);
  const refNames = input.tsconfigReferences.map((r) => {
    const norm = r.replace(/\\/g, "/").replace(/\/+$/, "");
    const match = WORKSPACES.find((w) => norm.endsWith(w.dir));
    return match ? match.name : norm;
  });
  const refSet = new Set(refNames);
  for (const a of spec.allowed) {
    if (!refSet.has(a)) {
      errors.push(`${spec.dir}: tsconfig.json is missing a project reference to ${dirOf[a]} (must list exactly its allowed deps)`);
    }
  }
  for (const r of refSet) {
    if (!spec.allowed.includes(r) && !optional.has(r)) {
      errors.push(`${spec.dir}: tsconfig.json references "${r}" which is not an allowed dep (35 §4)`);
    }
  }

  return errors;
}

export function checkRepo(root: string): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const w of WORKSPACES) {
    let pkg: ManifestInput["packageJson"];
    let refs: string[];
    try {
      pkg = JSON.parse(readFileSync(join(root, w.dir, "package.json"), "utf8"));
    } catch {
      errors.push(`${w.dir}: missing or unreadable package.json`);
      continue;
    }
    try {
      const tsconfig = JSON.parse(readFileSync(join(root, w.dir, "tsconfig.json"), "utf8"));
      refs = (tsconfig.references ?? []).map((r: { path: string }) => r.path);
    } catch {
      errors.push(`${w.dir}: missing or unreadable tsconfig.json`);
      continue;
    }
    errors.push(...checkManifest({ name: w.name, packageJson: pkg, tsconfigReferences: refs }));
  }

  // Root manifest: blacklist applies there too.
  try {
    const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    for (const field of DEP_FIELDS) {
      for (const dep of Object.keys(rootPkg[field] ?? {})) {
        const banned = BANNED.find((b) => b.pattern.test(dep));
        if (banned) errors.push(`<root>: ${field} "${dep}" is blacklisted (${banned.reason})`);
      }
    }
  } catch {
    errors.push("<root>: missing or unreadable package.json");
  }

  return { ok: errors.length === 0, errors };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const root = process.argv[2] ?? process.cwd();
  const { ok, errors } = checkRepo(root);
  if (!ok) {
    console.error(`check-deps: ${errors.length} violation(s):\n`);
    for (const e of errors) console.error(`  ✗ ${e}`);
    process.exit(1);
  }
  console.log(`check-deps: ${WORKSPACES.length} workspaces conform to the dependency matrix (35 §4).`);
}
