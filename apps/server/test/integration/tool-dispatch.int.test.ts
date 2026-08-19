// T40 acceptance (Docker-gated): a scripted agent's terminal.run("npm test")
// executes in a REAL task workspace — gateway authorize → dispatch arm →
// sandbox-manager (spawned as a real child process, exactly the compose
// topology) → bare repo + worktree volume + hardened container → npm test —
// and the result + cost are recorded (tool_invocations succeeded row,
// cost_entries kind=tool, workspace/terminal records with their events).
// Skips cleanly without a Docker daemon or without built dists.
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { and, eq } from "drizzle-orm";
import {
  companyContext,
  createDb,
  createGuardedDb,
  runMigrations,
  type CompanyContext,
  type Db,
  type GuardedDb,
} from "@acos/db";
import {
  agents,
  companies,
  costEntries,
  events,
  orgUnits,
  positions,
  projects,
  tasks,
  terminalSessions,
  toolInvocations,
  toolPermissions,
  users,
  workspaces,
} from "@acos/db/schema";
import { ToolGateway } from "../../src/modules/tools/gateway.js";
import { createSandboxDispatchPort } from "../../src/modules/tools/dispatch.js";
import { startPostgres, type StartedPostgreSqlContainer } from "./helpers";

const INTERNAL_TOKEN = "dispatch-test-token-0123456789";
const SANDBOX_PORT = 3300 + Math.floor(Math.random() * 500);
const SANDBOX_URL = `http://127.0.0.1:${SANDBOX_PORT}`;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SANDBOX_DIST = join(REPO_ROOT, "services/sandbox-manager/dist/main.js");

let dockerUp = false;
try {
  execSync("docker info", { stdio: "ignore" });
  dockerUp = true;
} catch {
  dockerUp = false;
}
const runnable = dockerUp && existsSync(SANDBOX_DIST);

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let guardedDb: GuardedDb;
let ctx: CompanyContext;
let gateway: ToolGateway;
let sandboxProc: ChildProcess | null = null;
let companyId = "";
let DEV = "";
let taskId = "";
let projectId = "";

async function waitForHealthz(url: string, attempts = 60): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(`${url}/healthz`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`sandbox-manager child did not become healthy at ${url}`);
}

beforeAll(async () => {
  if (!runnable) return;
  // the internal workspaces network is a compose prerequisite (27 §12) — when
  // absent, create it EXACTLY as compose.yaml defines it (subnet = squid ACL)
  // with the compose label so a later `compose up` adopts it
  try {
    execSync("docker network inspect acos-workspaces", { stdio: "ignore" });
  } catch {
    execSync(
      "docker network create --internal --subnet 172.30.0.0/16 " +
        "--label com.docker.compose.network=acos-workspaces acos-workspaces",
      { stdio: "ignore" },
    );
  }

  container = await startPostgres();
  await runMigrations(container.getConnectionUri());
  pool = new Pool({ connectionString: container.getConnectionUri() });
  pool.on("error", () => {}); // teardown race: idle-client FATAL when the container stops
  db = createDb(pool);
  guardedDb = createGuardedDb(pool);

  // sandbox-manager as a REAL separate process — the compose topology (S1)
  sandboxProc = spawn(process.execPath, [SANDBOX_DIST], {
    env: {
      ...process.env,
      SANDBOX_MANAGER_PORT: String(SANDBOX_PORT),
      INTERNAL_API_TOKEN: INTERNAL_TOKEN,
      NATS_URL: "nats://127.0.0.1:1", // unavailable — frames disabled, boot survives
      DATA_DIR: mkdtempSync(join(tmpdir(), "acos-sbx-")),
    },
    stdio: "ignore",
  });
  await waitForHealthz(SANDBOX_URL);

  gateway = new ToolGateway({
    db: guardedDb,
    dispatch: createSandboxDispatchPort({
      guardedDb,
      sandboxManagerUrl: SANDBOX_URL,
      internalApiToken: INTERNAL_TOKEN,
      // node+npm image so `npm test` is real; the canonical acos/workspace-node
      // image adds git on top (built via pnpm build:workspace-images)
      defaultImage: "node:22-alpine",
    }),
  });

  const [founder] = await db
    .insert(users)
    .values({ email: "founder@t40d.local", passwordHash: "x", displayName: "F" })
    .returning();
  const [company] = await db
    .insert(companies)
    .values({ name: "DispatchCo", slug: "dispatchco", createdByUserId: founder!.id })
    .returning();
  companyId = company!.id;
  ctx = companyContext(companyId);
  const [unit] = await db
    .insert(orgUnits)
    .values({ companyId, kind: "team", name: "Backend", slug: "backend" })
    .returning();
  const [position] = await db
    .insert(positions)
    .values({ companyId, title: "Dev", seniorityTrack: ["mid"], defaultRole: "member" })
    .returning();
  const [agent] = await db
    .insert(agents)
    .values({
      companyId,
      employeeNumber: 1,
      name: "Dana Dev",
      status: "active",
      positionId: position!.id,
      orgUnitId: unit!.id,
      seniority: "mid",
      autonomyLevel: 2,
      persona: "Dev.",
    })
    .returning();
  DEV = agent!.id;
  const [project] = await db
    .insert(projects)
    .values({
      companyId,
      slug: "webshop",
      name: "Webshop",
      objectiveMd: "Ship it",
      createdByUserId: founder!.id,
    })
    .returning();
  projectId = project!.id;
  const [task] = await db
    .insert(tasks)
    .values({
      companyId,
      projectId,
      number: 81,
      kind: "task",
      title: "Add OAuth login",
      objective: "x",
      status: "IN_PROGRESS",
      ownerAgentId: DEV,
    })
    .returning();
  taskId = task!.id;

  for (const tool of ["fs.write", "fs.edit", "terminal.run"]) {
    await db.insert(toolPermissions).values({
      companyId,
      toolName: tool,
      subjectKind: "agent",
      subjectId: DEV,
    });
  }
}, 600_000);

afterAll(async () => {
  if (sandboxProc) sandboxProc.kill("SIGTERM");
  // reap the workspace container + volumes this suite created
  if (runnable && taskId) {
    try {
      const [ws] = await db.select().from(workspaces).where(eq(workspaces.taskId, taskId));
      if (ws) execSync(`docker rm -f acos-ws-${ws.id}`, { stdio: "ignore" });
      if (ws?.volumePath) execSync(`docker volume rm -f ${ws.volumePath}`, { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  }
  await pool?.end();
  await container?.stop();
});

describe.skipIf(!runnable)("gateway → dispatch → real workspace (T40 acceptance)", () => {
  it("fs.write seeds package.json into the freshly provisioned worktree (workspace.* events fire)", async () => {
    const pkg = JSON.stringify({
      name: "acceptance",
      scripts: { test: "node -e \"console.log('2 passing'); process.exit(0)\"" },
    });
    const res = await gateway.invoke(ctx, {
      agentId: DEV,
      toolName: "fs.write",
      input: { path: "package.json", content: pkg },
      taskId,
    });
    expect(res.decision).toBe("allow");
    expect(res.status, `dispatch error: ${res.error ?? res.reason ?? "none"}`).toBe("succeeded");
    expect((res.output as { created: boolean }).created).toBe(true);

    // T38 control plane did the provisioning: row + branch + events
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.taskId, taskId));
    expect(ws).toBeDefined();
    expect(ws!.status).toBe("in_use");
    expect(ws!.branch).toBe("task/81-add-oauth-login");
    const provisioned = await db
      .select()
      .from(events)
      .where(and(eq(events.companyId, companyId), eq(events.type, "workspace.provisioned")));
    expect(provisioned).toHaveLength(1);
  }, 600_000);

  it("terminal.run('npm test') executes IN the workspace container; result + cost recorded", async () => {
    const res = await gateway.invoke(ctx, {
      agentId: DEV,
      toolName: "terminal.run",
      input: { command: "npm test", timeoutSec: 120 },
      taskId,
    });
    expect(res.decision).toBe("allow");
    expect(res.status, `dispatch error: ${res.error ?? res.reason ?? "none"}`).toBe("succeeded");
    const output = res.output as {
      exitCode: number;
      stdoutTail: string;
      terminalSessionId: string;
    };
    expect(output.exitCode).toBe(0);
    expect(output.stdoutTail).toContain("2 passing"); // the real npm test output
    expect(res.costCents).toBeGreaterThanOrEqual(1);

    // result recorded on the audit row…
    const [row] = await db
      .select()
      .from(toolInvocations)
      .where(and(eq(toolInvocations.companyId, companyId), eq(toolInvocations.id, res.invocationId!)));
    expect(row!.status).toBe("succeeded");
    expect(row!.costCents).toBe(res.costCents);
    expect(row!.durationMs).toBeGreaterThan(0);

    // …cost in the ledger (26 §1)…
    const costs = await db
      .select()
      .from(costEntries)
      .where(and(eq(costEntries.companyId, companyId), eq(costEntries.kind, "tool")));
    expect(costs.some((c) => c.ref === "terminal.run" && c.amountCents === res.costCents)).toBe(
      true,
    );

    // …and the terminal session record opened + closed around the run (T38)
    const sessions = await db
      .select()
      .from(terminalSessions)
      .where(eq(terminalSessions.id, output.terminalSessionId));
    expect(sessions[0]!.status).toBe("closed");
  }, 600_000);

  // Yaşayan ajan terminali (2026-08-19 runtime, Munder davranışı): oturum
  // bağlamıyla gelen terminal.run komut başına oturum AÇ-KAPA yapmaz —
  // ajan+workspace başına TEK aktif oturumda birikir, Founder tek akışta
  // izler; oturum workspace teardown'una (ya da açılış süpürmesine) dek açık.
  it("terminal.run with an agent session reuses ONE living terminal across commands", async () => {
    const agentSessionId = "01a01a00-0000-7000-8000-00000000aaaa";
    const first = await gateway.invoke(ctx, {
      agentId: DEV,
      toolName: "terminal.run",
      input: { command: "echo living-one", timeoutSec: 60 },
      taskId,
      agentSessionId,
    });
    expect(first.status, `dispatch error: ${first.error ?? first.reason ?? "none"}`).toBe(
      "succeeded",
    );
    const firstOut = first.output as { terminalSessionId: string; stdoutTail: string };
    expect(firstOut.stdoutTail).toContain("living-one");

    const second = await gateway.invoke(ctx, {
      agentId: DEV,
      toolName: "terminal.run",
      input: { command: "echo living-two", timeoutSec: 60 },
      taskId,
      agentSessionId,
    });
    expect(second.status).toBe("succeeded");
    const secondOut = second.output as { terminalSessionId: string };
    expect(secondOut.terminalSessionId).toBe(firstOut.terminalSessionId);

    const [row] = await db
      .select()
      .from(terminalSessions)
      .where(eq(terminalSessions.id, firstOut.terminalSessionId));
    expect(row!.status).toBe("active"); // yaşıyor — komut değil, teardown kapatır
    expect(row!.title).toBe("agent-live");
  }, 600_000);

  // Y3 (B4'): the payload used to travel as a base64 ARGV entry, and Linux
  // caps one argv entry at MAX_ARG_STRLEN = 128 KB. Base64 inflates by a
  // third, so ~96 KB of source was the real ceiling — while fs.write's schema
  // promises 2 MB and fs.edit rewrites the whole file, so a three-line change
  // in a 100 KB file blew up too. The failure surfaced as a bare `E2BIG` in
  // stderr, which the agent could not act on, so it retried the same call.
  // Bytes now ride stdin, which has no such limit.
  it("fs.write handles a file far past the 128 KB argv ceiling (Y3)", async () => {
    // 300 KB of distinguishable text — ~400 KB once base64'd, i.e. more than
    // triple the old ceiling
    const line = "const x = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';\n";
    // a unique first line so the fs.edit below has an unambiguous anchor
    const big = `const UNIQUE_ANCHOR = 'edit-me';\n${line.repeat(Math.ceil(300_000 / line.length))}`;
    const res = await gateway.invoke(ctx, {
      agentId: DEV,
      toolName: "fs.write",
      input: { path: "src/big.ts", content: big },
      taskId,
    });
    expect(res.status, `dispatch error: ${res.error ?? res.reason ?? "none"}`).toBe("succeeded");
    expect((res.output as { byteSize: number }).byteSize).toBe(Buffer.byteLength(big, "utf8"));

    // the bytes really landed — checked in the container, not from our own echo
    const check = await gateway.invoke(ctx, {
      agentId: DEV,
      toolName: "terminal.run",
      input: { command: "wc -c < src/big.ts", timeoutSec: 60 },
      taskId,
    });
    const out = check.output as { exitCode: number; stdoutTail: string };
    expect(out.exitCode).toBe(0);
    expect(out.stdoutTail.trim()).toBe(String(Buffer.byteLength(big, "utf8")));

    // and fs.edit — which rewrites the WHOLE file — survives at that size
    const edited = await gateway.invoke(ctx, {
      agentId: DEV,
      toolName: "fs.edit",
      input: {
        path: "src/big.ts",
        oldText: "const UNIQUE_ANCHOR = 'edit-me';",
        newText: "const marker = 'edited-at-scale';",
      },
      taskId,
    });
    expect(edited.status, `dispatch error: ${edited.error ?? edited.reason ?? "none"}`).toBe(
      "succeeded",
    );
    const grep = await gateway.invoke(ctx, {
      agentId: DEV,
      toolName: "terminal.run",
      input: { command: "grep -c edited-at-scale src/big.ts", timeoutSec: 60 },
      taskId,
    });
    expect((grep.output as { stdoutTail: string }).stdoutTail.trim()).toBe("1");
  }, 600_000);

  it("a failing command comes back as a RESULT (exit != 0), still succeeded + audited", async () => {
    const res = await gateway.invoke(ctx, {
      agentId: DEV,
      toolName: "terminal.run",
      input: { command: "node -e \"process.exit(3)\"", timeoutSec: 60 },
      taskId,
    });
    // dispatch worked; the EXIT CODE is the result
    expect(res.status, `dispatch error: ${res.error ?? res.reason ?? "none"}`).toBe("succeeded");
    expect((res.output as { exitCode: number }).exitCode).toBe(3);
  }, 600_000);

  // 2026-08-16 canlı arıza: bir ajan `pnpm --filter … typecheck` çalıştırdı,
  // corepack "pnpm indirilsin mi? [Y/n]" diye sordu ve komut zaman aşımına
  // kadar orada bekledi. Terminal salt-okunur (24 §6.9) — cevap verecek kimse
  // yok, olmamalı da. Bu testler etkileşimsiz ortamı kilitliyor.
  it("komutlar etkileşimsiz koşar (CI + corepack/git/npx istem kapalı)", async () => {
    const res = await gateway.invoke(ctx, {
      agentId: DEV,
      toolName: "terminal.run",
      input: {
        command:
          'echo "CI=$CI COREPACK=$COREPACK_ENABLE_DOWNLOAD_PROMPT GIT=$GIT_TERMINAL_PROMPT NPM=$npm_config_yes"',
        timeoutSec: 60,
      },
      taskId,
    });
    expect(res.status, `dispatch error: ${res.error ?? res.reason ?? "none"}`).toBe("succeeded");
    const out = (res.output as { stdoutTail: string }).stdoutTail;
    expect(out).toContain("CI=1");
    expect(out).toContain("COREPACK=0");
    expect(out).toContain("GIT=0");
    expect(out).toContain("NPM=true");
  }, 600_000);

  it("zaman aşımı ajana AÇIKÇA bildirilir (sessiz exit=137 değil)", async () => {
    const res = await gateway.invoke(ctx, {
      agentId: DEV,
      toolName: "terminal.run",
      // Kendi başına bitmeyen komut. (İlk denemede `read -r answer` kullandım
      // ve test kırıldı: sandbox'ta stdin hemen EOF verdiği için `read`
      // anında dönüyor. Takılmayı taklit etmenin doğru yolu beklemek.)
      input: { command: "sleep 30", timeoutSec: 2 },
      taskId,
    });
    expect(res.status).toBe("succeeded"); // araç çalıştı; sonuç zaman aşımı
    const out = res.output as { timedOut: boolean; note?: string };
    expect(out.timedOut).toBe(true);
    // Açıklama ÇIKTIDA olmalı, resultSummary'de değil: resultSummary yalnız
    // tool_invocations satırına ve olaya yazılıyor, çağırana dönmüyor — ajan
    // onu hiç görmüyor. (İlk denemede oraya yazmıştım; test yakaladı.)
    expect(out.note).toContain("TIMED OUT");
    expect(out.note).toContain("NON-INTERACTIVELY");
  }, 600_000);
});
