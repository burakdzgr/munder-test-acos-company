// T38 acceptance (control plane, real PG): workspace records ride the
// canonical state machine with `workspace.*` events on the outbox; two tasks
// on one project provision ISOLATED worktree records (distinct branches +
// volumes off one repository); soft locks WARN on overlapping paths and
// never block; terminal session records open/close with their events.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  companyContext,
  CompanyRepository,
  createDb,
  createGuardedDb,
  runMigrations,
  WorkspaceService,
  worktreeVolumeName,
  type CompanyContext,
  type Db,
  type GuardedDb,
  type SandboxPort,
} from "../../src/index.js";
import { users } from "../../src/schema/identity.js";
import { projects, repositories } from "../../src/schema/projects.js";
import { tasks } from "../../src/schema/tasks.js";
import { events } from "../../src/schema/events.js";
import { terminalSessions, workspaceLocks, workspaces } from "../../src/schema/workspaces-costs.js";
import { startPostgres, type StartedPostgreSqlContainer } from "./helpers";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let system: Db;
let guarded: GuardedDb;
let ctx: CompanyContext;
let service: WorkspaceService;

let projectId: string;
let task81: { id: string; number: number };
let task82: { id: string; number: number };

/** Deterministic fake of the sandbox-manager seam — records every call. */
function fakePort(overrides: Partial<SandboxPort> = {}): SandboxPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    ensureRepo: async (pid) => {
      calls.push(`ensureRepo:${pid}`);
      return { barePath: `/data/repos/${pid}.git`, headCommit: "c".repeat(40) };
    },
    provisionWorktree: async (input) => {
      calls.push(`worktree:${input.volumeName}:${input.branch}`);
      return { baseCommit: "c".repeat(40) };
    },
    createContainer: async (input) => {
      calls.push(`container:${input.workspaceId}`);
      return { containerId: `ctr-${input.workspaceId.slice(0, 8)}` };
    },
    destroyContainer: async () => {},
    removeWorktree: async () => {},
    ...overrides,
  };
}

async function eventsOfType(type: string) {
  return system
    .select()
    .from(events)
    .where(and(eq(events.companyId, ctx.companyId), eq(events.type, type)))
    .orderBy(events.seq);
}

beforeAll(async () => {
  container = await startPostgres();
  await runMigrations(container.getConnectionUri());
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 10 });
  pool.on("error", () => {}); // teardown race: idle-client FATAL when the container stops
  system = createDb(pool);
  guarded = createGuardedDb(pool);
  service = new WorkspaceService(guarded);

  const [founder] = await system
    .insert(users)
    .values({ email: "founder@acme.local", passwordHash: "x", displayName: "Founder" })
    .returning();
  const companyRepo = new CompanyRepository(system);
  const company = await system.transaction((tx) =>
    companyRepo.insert(tx, { name: "Acme", slug: "acme", createdByUserId: founder!.id }),
  );
  ctx = companyContext(company.id);

  const [project] = await system
    .insert(projects)
    .values({
      companyId: ctx.companyId,
      slug: "webshop",
      name: "Webshop",
      objectiveMd: "Ship the webshop",
      createdByUserId: founder!.id,
    })
    .returning();
  projectId = project!.id;

  const [t81] = await system
    .insert(tasks)
    .values({
      companyId: ctx.companyId,
      projectId,
      number: 81,
      kind: "task",
      title: "Add OAuth login",
      objective: "OAuth2 login flow",
      status: "ASSIGNED",
    })
    .returning();
  const [t82] = await system
    .insert(tasks)
    .values({
      companyId: ctx.companyId,
      projectId,
      number: 82,
      kind: "task",
      title: "Fix signup form",
      objective: "Signup form bugs",
      status: "ASSIGNED",
    })
    .returning();
  task81 = { id: t81!.id, number: 81 };
  task82 = { id: t82!.id, number: 82 };
}, 240_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("WorkspaceService provisioning (T38)", () => {
  it("two tasks on one project get isolated worktree records off ONE repository", async () => {
    const port = fakePort();
    const ws81 = await service.provision(ctx, { taskId: task81.id }, port);
    const ws82 = await service.provision(ctx, { taskId: task82.id }, port);

    expect(ws81.created).toBe(true);
    expect(ws82.created).toBe(true);
    expect(ws81.workspace.status).toBe("ready");
    expect(ws82.workspace.status).toBe("ready");
    expect(ws81.baseCommit).toBe("c".repeat(40));

    // branch `task/<n>-<slug>` + per-task volume — never shared
    expect(ws81.workspace.branch).toBe("task/81-add-oauth-login");
    expect(ws82.workspace.branch).toBe("task/82-fix-signup-form");
    expect(ws81.workspace.volumePath).toBe(worktreeVolumeName(81, task81.id));
    expect(ws82.workspace.volumePath).toBe(worktreeVolumeName(82, task82.id));
    expect(ws81.workspace.volumePath).not.toBe(ws82.workspace.volumePath);

    // one repository row for the project, both workspaces reference it
    const repos = await system
      .select()
      .from(repositories)
      .where(eq(repositories.projectId, projectId));
    expect(repos).toHaveLength(1);
    expect(repos[0]!.barePath).toBe(`/data/repos/${projectId}.git`);
    expect(ws81.workspace.repositoryId).toBe(repos[0]!.id);
    expect(ws82.workspace.repositoryId).toBe(repos[0]!.id);

    // the port was driven with exactly the branch/volume the row records
    expect(port.calls).toContain(
      `worktree:${ws81.workspace.volumePath}:task/81-add-oauth-login`,
    );
    expect(port.calls).toContain(
      `worktree:${ws82.workspace.volumePath}:task/82-fix-signup-form`,
    );

    // events: provisioned ×2 + status.changed provisioning→ready ×2
    const provisioned = await eventsOfType("workspace.provisioned");
    expect(provisioned).toHaveLength(2);
    const changed = await eventsOfType("workspace.status.changed");
    expect(
      changed.map((e) => (e.payload as { from: string; to: string }).to),
    ).toEqual(["ready", "ready"]);
  });

  it("provisioning is idempotent per (task, level) — the live row is returned", async () => {
    const port = fakePort();
    const again = await service.provision(ctx, { taskId: task81.id }, port);
    expect(again.created).toBe(false);
    expect(port.calls).toHaveLength(0); // no second clone/container
  });

  // C2/Y5: the lookup used to be keyed on (taskId, isolationLevel) while the
  // volume name comes from the task alone — so fs.read (analysis) and
  // fs.write (coding) built TWO workspaces over the SAME worktree volume, and
  // callers querying by taskId picked an arbitrary one. Since `analysis` runs
  // with network:none, work could silently land in the wrong container.
  it("a stronger level upgrades the SAME workspace instead of opening a second one", async () => {
    const [t84] = await system
      .insert(tasks)
      .values({
        companyId: ctx.companyId,
        projectId,
        number: 84,
        kind: "task",
        title: "Read then write",
        objective: "x",
        status: "IN_PROGRESS",
      })
      .returning();

    // fs.read → analysis
    const analysisPort = fakePort();
    const first = await service.provision(
      ctx,
      { taskId: t84!.id, isolationLevel: "analysis" },
      analysisPort,
    );
    expect(first.created).toBe(true);
    expect(first.workspace.isolationLevel).toBe("analysis");

    // fs.write → coding: same row, same volume, container recreated
    const codingPort = fakePort();
    const second = await service.provision(
      ctx,
      { taskId: t84!.id, isolationLevel: "coding" },
      codingPort,
    );
    expect(second.workspace.id).toBe(first.workspace.id);
    expect(second.workspace.isolationLevel).toBe("coding");
    expect(second.workspace.volumePath).toBe(first.workspace.volumePath);
    expect(second.created).toBe(false);
    // the worktree is NOT cloned a second time; only the container is replaced
    expect(codingPort.calls.filter((c) => c.startsWith("worktree:"))).toHaveLength(0);
    expect(codingPort.calls.filter((c) => c.startsWith("container:"))).toHaveLength(1);

    // and the task really owns ONE workspace
    const rows = await system
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.companyId, ctx.companyId), eq(workspaces.taskId, t84!.id)));
    expect(rows).toHaveLength(1);

    // going back DOWN (terminal.run at coding, then another fs.read) must not
    // weaken the container the agent is already working in
    const backDown = await service.provision(
      ctx,
      { taskId: t84!.id, isolationLevel: "analysis" },
      fakePort(),
    );
    expect(backDown.workspace.isolationLevel).toBe("coding");
    expect(backDown.workspace.id).toBe(first.workspace.id);
  });

  it("a port failure lands the row in failed with workspace.failed", async () => {
    const [t83] = await system
      .insert(tasks)
      .values({
        companyId: ctx.companyId,
        projectId,
        number: 83,
        kind: "task",
        title: "Doomed task",
        objective: "x",
        status: "ASSIGNED",
      })
      .returning();
    const port = fakePort({
      provisionWorktree: async () => {
        throw new Error("volume error");
      },
    });
    await expect(service.provision(ctx, { taskId: t83!.id }, port)).rejects.toMatchObject({
      code: "WORKSPACE_PROVISION_FAILED",
    });
    const [row] = await system
      .select()
      .from(workspaces)
      .where(eq(workspaces.taskId, t83!.id));
    expect(row!.status).toBe("failed");
    const failedEvents = await eventsOfType("workspace.failed");
    expect(
      failedEvents.some((e) => (e.payload as { reason: string }).reason === "volume error"),
    ).toBe(true);

    // failed → destroyed is the only legal exit; destroyedAt is stamped
    const destroyed = await service.transition(ctx, row!.id, "destroyed", {
      reason: "cleanup after diagnostics",
    });
    expect(destroyed.destroyedAt).not.toBeNull();
    expect((await eventsOfType("workspace.destroyed")).length).toBe(1);
  });

  it("the state machine rejects illegal jumps (ready → merged) with a typed error", async () => {
    const [row] = await system
      .select()
      .from(workspaces)
      .where(eq(workspaces.taskId, task81.id));
    expect(row!.status).toBe("ready");
    await expect(service.transition(ctx, row!.id, "merged")).rejects.toMatchObject({
      code: "WORKSPACE_INVALID_TRANSITION",
    });
  });
});

describe("soft file locks — warn, never block (15 §3.8)", () => {
  let ws81Id: string;
  let ws82Id: string;

  beforeAll(async () => {
    const rows = await system
      .select()
      .from(workspaces)
      .where(inArray(workspaces.taskId, [task81.id, task82.id]));
    ws81Id = rows.find((r) => r.taskId === task81.id)!.id;
    ws82Id = rows.find((r) => r.taskId === task82.id)!.id;
    await service.transition(ctx, ws81Id, "in_use");
    await service.transition(ctx, ws82Id, "in_use");
  });

  it("overlapping paths from another task surface a structured warning + event", async () => {
    const first = await service.acquireLock(ctx, {
      workspaceId: ws81Id,
      pathPrefix: "src/auth/",
    });
    expect(first.created).toBe(true);
    expect(first.conflicts).toEqual([]); // nothing else is live yet

    // the second task writes INSIDE the locked subtree → warning, not a block
    const second = await service.acquireLock(ctx, {
      workspaceId: ws82Id,
      pathPrefix: "src/auth/login.ts",
    });
    expect(second.created).toBe(true);
    expect(second.conflicts).toHaveLength(1);
    expect(second.conflicts[0]).toMatchObject({
      workspaceId: ws81Id,
      taskId: task81.id,
      pathPrefix: "src/auth/",
    });

    const conflictEvents = await eventsOfType("workspace.lock.conflict");
    expect(conflictEvents).toHaveLength(1);
    const payload = conflictEvents[0]!.payload as { paths: string[]; taskIds: string[] };
    expect(payload.paths).toEqual(
      expect.arrayContaining(["src/auth/login.ts", "src/auth/"]),
    );
    expect(payload.taskIds).toEqual(expect.arrayContaining([task81.id, task82.id]));
    expect((await eventsOfType("workspace.lock.acquired")).length).toBe(2);
  });

  it("non-overlapping paths raise no warning; re-acquire is idempotent", async () => {
    const docs = await service.acquireLock(ctx, {
      workspaceId: ws82Id,
      pathPrefix: "docs/readme.md",
    });
    expect(docs.conflicts).toEqual([]);

    const again = await service.acquireLock(ctx, {
      workspaceId: ws81Id,
      pathPrefix: "src/auth/",
    });
    expect(again.created).toBe(false); // same live lock, no duplicate event
    expect((await eventsOfType("workspace.lock.acquired")).length).toBe(3);
    expect((await eventsOfType("workspace.lock.conflict")).length).toBe(1);
  });

  it("merge releases the workspace's locks and emits workspace.merged + lock.released", async () => {
    await service.transition(ctx, ws81Id, "merged", { mergeCommit: "d".repeat(40) });

    const merged = await eventsOfType("workspace.merged");
    expect(merged).toHaveLength(1);
    expect(merged[0]!.payload).toMatchObject({
      branch: "task/81-add-oauth-login",
      mergeCommit: "d".repeat(40),
    });

    const live = await system
      .select()
      .from(workspaceLocks)
      .where(
        and(eq(workspaceLocks.workspaceId, ws81Id), sql`${workspaceLocks.releasedAt} IS NULL`),
      );
    expect(live).toHaveLength(0);
    expect((await eventsOfType("workspace.lock.released")).length).toBe(1);

    // ws82's own lock is untouched
    const ws82Live = await system
      .select()
      .from(workspaceLocks)
      .where(
        and(eq(workspaceLocks.workspaceId, ws82Id), sql`${workspaceLocks.releasedAt} IS NULL`),
      );
    expect(ws82Live).toHaveLength(2);
  });
});

describe("terminal session records (T38)", () => {
  it("open → row + workspace.terminal.opened; close is idempotent", async () => {
    const [row] = await system
      .select()
      .from(workspaces)
      .where(eq(workspaces.taskId, task82.id));
    const session = await service.openTerminal(ctx, {
      workspaceId: row!.id,
      title: "npm install",
    });
    expect(session.status).toBe("active");
    expect(session.logPath).toBe(`/data/terminals/${session.id}.log`);
    const opened = await eventsOfType("workspace.terminal.opened");
    expect(opened).toHaveLength(1);
    expect(opened[0]!.payload).toMatchObject({ sessionId: session.id, workspaceId: row!.id });

    const closed = await service.closeTerminal(ctx, session.id);
    expect(closed.status).toBe("closed");
    expect(closed.closedAt).not.toBeNull();
    await service.closeTerminal(ctx, session.id); // idempotent — no second event
    expect((await eventsOfType("workspace.terminal.closed")).length).toBe(1);
  });

  /**
   * Açılış mutabakatı (23 §13'ün terminal karşılığı).
   *
   * Bir terminal oturumu onu açan exec ile aynı süreçte yaşar. Sunucu exec
   * sürerken ölürse satır sonsuza kadar `active` kalıyordu: canlı örnekte
   * 08-14'ten kalma bir oturum 17 Ağustos'ta hâlâ açıktı ve Founder'ın
   * panelinde donmuş çıktıyla "1 açık terminal" olarak duruyordu — yapılmış
   * bir düzeltmenin hâlâ bozuk olduğunu düşündürecek kadar ikna edici.
   */
  it("açılışta öksüz oturumlar kapanır ve olayları üretilir", async () => {
    const [row] = await system
      .select()
      .from(workspaces)
      .where(eq(workspaces.taskId, task82.id));
    const orphan = await service.openTerminal(ctx, {
      workspaceId: row!.id,
      title: "öksüz kalan komut",
    });
    expect(orphan.status).toBe("active");
    const closedBefore = (await eventsOfType("workspace.terminal.closed")).length;

    const n = await service.closeOrphanedTerminals([ctx.companyId]);
    expect(n).toBe(1);

    const [after] = await system
      .select()
      .from(terminalSessions)
      .where(eq(terminalSessions.id, orphan.id));
    expect(after!.status).toBe("closed");
    // sessizce kapanmaz — durum değişikliği olaysız olmaz (INV-11)
    expect((await eventsOfType("workspace.terminal.closed")).length).toBe(closedBefore + 1);

    // ikinci koşu boşuna iş yapmaz
    expect(await service.closeOrphanedTerminals([ctx.companyId])).toBe(0);
  });

  // Yaşayan ajan terminali teardown'u (2026-08-19 runtime): workspace terminal
  // duruma geçerken açık oturumları AYNI tx'te kapatır (INV-11). Açılış
  // süpürmesi artık son savunma; ilk savunma transition'ın kendisi — yaşayan
  // oturum modeli (komut başına kapanış yok) bu olmadan aktif satır sızdırırdı.
  it("workspace teardown'u açık terminal oturumlarını transition içinde kapatır", async () => {
    const [row] = await system
      .select()
      .from(workspaces)
      .where(eq(workspaces.taskId, task82.id));
    const living = await service.openTerminal(ctx, {
      workspaceId: row!.id,
      title: "agent-live",
    });
    const closedBefore = (await eventsOfType("workspace.terminal.closed")).length;

    await service.transition(ctx, row!.id, "discarded");

    const [after] = await system
      .select()
      .from(terminalSessions)
      .where(eq(terminalSessions.id, living.id));
    expect(after!.status).toBe("closed");
    expect((await eventsOfType("workspace.terminal.closed")).length).toBe(closedBefore + 1);
  });
});
