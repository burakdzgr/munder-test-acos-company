// D1 — teslimat kaydı (14 §5).
//
// Tablo ve `project.deployment.*` olayları şemada/katalogda baştan beri
// vardı, kodda hiçbir yazan yoktu ("dark in MVP"). Bir iş merge edilip
// bittiğinde "nereye, ne zaman, hangi commit'le gitti" sorusunun cevabı
// yoktu.
//
// Kapsam dokümanın çizdiği yer: MVP yalnız `sandbox` türü ortamlar; dış
// hedefler Phase 3. Test bu sınırın GERÇEKTEN uygulandığını da tutuyor —
// aksi hâlde "MVP kapsamı" yalnız bir yorum olurdu.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { and, eq } from "drizzle-orm";
import {
  DeploymentsService,
  companyContext,
  createDb,
  createGuardedDb,
  runMigrations,
  type CompanyContext,
  type Db,
  type GuardedDb,
} from "../../src/index.js";
import {
  companies,
  environments,
  events,
  projects,
  users,
} from "../../src/schema/index.js";
import { startPostgres, type StartedPostgreSqlContainer } from "./helpers";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let guardedDb: GuardedDb;
let ctx: CompanyContext;
let service: DeploymentsService;
let companyId = "";
let projectId = "";
let sandboxEnvId = "";
let productionEnvId = "";
let gatedEnvId = "";

const SYSTEM = { kind: "system" as const, id: null };

async function eventsOfType(type: string) {
  return db
    .select()
    .from(events)
    .where(and(eq(events.companyId, companyId), eq(events.type, type)));
}

beforeAll(async () => {
  container = await startPostgres();
  await runMigrations(container.getConnectionUri());
  pool = new Pool({ connectionString: container.getConnectionUri() });
  pool.on("error", () => {});
  db = createDb(pool);
  guardedDb = createGuardedDb(pool);
  service = new DeploymentsService(guardedDb);

  const [founder] = await db
    .insert(users)
    .values({ email: "founder@deploy.local", passwordHash: "x", displayName: "F" })
    .returning();
  const [company] = await db
    .insert(companies)
    .values({ name: "DeployCo", slug: "deployco", createdByUserId: founder!.id })
    .returning();
  companyId = company!.id;
  ctx = companyContext(companyId);
  const [project] = await db
    .insert(projects)
    .values({
      companyId,
      slug: "shop",
      name: "Shop",
      objectiveMd: "x",
      createdByUserId: founder!.id,
    })
    .returning();
  projectId = project!.id;

  const [sandbox] = await db
    .insert(environments)
    .values({ companyId, projectId, name: "local", config: {} })
    .returning();
  sandboxEnvId = sandbox!.id;
  const [production] = await db
    .insert(environments)
    .values({ companyId, projectId, name: "production", config: {} })
    .returning();
  productionEnvId = production!.id;
  const [gated] = await db
    .insert(environments)
    .values({
      companyId,
      projectId,
      name: "staging",
      config: { kind: "sandbox", approvalGated: true },
    })
    .returning();
  gatedEnvId = gated!.id;
}, 600_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("teslimat kaydı (14 §5)", { timeout: 60_000 }, () => {
  it("sandbox ortamına teslimat: satır + started/completed olayları", async () => {
    const started = await service.start(ctx, {
      projectId,
      environmentId: sandboxEnvId,
      gitRef: "a".repeat(40),
      actor: SYSTEM,
    });
    expect(started.status).toBe("running");
    expect(started.startedAt).not.toBeNull();
    expect((await eventsOfType("project.deployment.started")).length).toBe(1);

    const finished = await service.finish(ctx, started.id, {
      status: "succeeded",
      detail: "healthy",
      logsUri: "artifact://logs/1",
      actor: SYSTEM,
    });
    expect(finished.status).toBe("succeeded");
    expect(finished.finishedAt).not.toBeNull();
    expect(finished.logsUri).toBe("artifact://logs/1");

    const completed = await eventsOfType("project.deployment.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]!.payload).toMatchObject({
      deploymentId: started.id,
      environment: "local",
      statusDetail: "healthy",
    });

    // pano listesi (14 §6)
    const listed = await service.list(ctx, projectId);
    expect(listed.map((d) => d.id)).toContain(started.id);
  });

  it("başarısız teslimat failed olayını düşürür", async () => {
    const started = await service.start(ctx, {
      projectId,
      environmentId: sandboxEnvId,
      gitRef: "b".repeat(40),
      actor: SYSTEM,
    });
    await service.finish(ctx, started.id, {
      status: "failed",
      detail: "health check timed out",
      actor: SYSTEM,
    });
    const failed = await eventsOfType("project.deployment.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload).toMatchObject({ statusDetail: "health check timed out" });
  });

  // 14 §5: "MVP scope: deployments to sandbox-kind environments only …
  // external environments are Phase 3". Bu sınır kodda uygulanmazsa yalnız
  // bir yorum olur.
  it("sandbox olmayan ortama teslimat reddedilir (dış hedefler Phase 3)", async () => {
    await expect(
      service.start(ctx, {
        projectId,
        environmentId: productionEnvId,
        gitRef: "c".repeat(40),
        actor: SYSTEM,
      }),
    ).rejects.toThrow(/Phase 3|sandbox/i);
    // hiçbir olay düşmedi
    expect((await eventsOfType("project.deployment.started")).length).toBe(2);
  });

  it("onay kapılı ortam Approval Engine kararı olmadan geçmez", async () => {
    await expect(
      service.start(ctx, {
        projectId,
        environmentId: gatedEnvId,
        gitRef: "d".repeat(40),
        actor: SYSTEM,
      }),
    ).rejects.toThrow(/approval/i);

    // karar varken geçer
    const ok = await service.start(ctx, {
      projectId,
      environmentId: gatedEnvId,
      gitRef: "d".repeat(40),
      approvalId: "01a0052e-0000-7000-8000-0000000000aa",
      actor: SYSTEM,
    });
    expect(ok.status).toBe("running");
  });

  it("aynı sonuca ikinci kapanış idempotent, farklı sonuca değil", async () => {
    const started = await service.start(ctx, {
      projectId,
      environmentId: sandboxEnvId,
      gitRef: "e".repeat(40),
      actor: SYSTEM,
    });
    await service.finish(ctx, started.id, { status: "succeeded", actor: SYSTEM });
    await expect(
      service.finish(ctx, started.id, { status: "succeeded", actor: SYSTEM }),
    ).resolves.toMatchObject({ status: "succeeded" });
    await expect(
      service.finish(ctx, started.id, { status: "failed", actor: SYSTEM }),
    ).rejects.toThrow(/already succeeded/i);
  });
});
