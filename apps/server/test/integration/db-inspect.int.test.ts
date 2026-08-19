// B3' / Y2 — db.inspect'in "salt okunur" iddiası.
//
// Araç R0 + sideEffectFree işaretli, yani otonomi matrisinden en düşük
// denetimle geçiyor. Eski koruma tek bir önek regex'iydi ve Postgres onun
// etrafından rahatça dolaşıyordu (yazan CTE, EXPLAIN ANALYZE). Şema katmanı
// artık sıkı (packages/tools testleri) ama ASIL garanti burada sınanıyor:
// dispatch sorguyu READ ONLY transaction'da ve statement_timeout ile koşuyor,
// yani şema katmanını atlatan bir yazma bile veritabanında ölüyor.
//
// Bu yüzden testlerin bir kısmı bilerek gateway'i atlayıp doğrudan dispatch
// portunu çağırıyor: kanıtlanmak istenen şey ikinci savunma hattının tek
// başına ayakta olduğu.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
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
  environments,
  orgUnits,
  positions,
  projects,
  tasks,
  toolPermissions,
  users,
} from "@acos/db/schema";
import { getTool } from "@acos/tools";
import { ToolGateway } from "../../src/modules/tools/gateway.js";
import {
  createSandboxDispatchPort,
  type SandboxDispatchOptions,
} from "../../src/modules/tools/dispatch.js";
import { startPostgres, type StartedPostgreSqlContainer } from "./helpers";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let projectPool: Pool;
let db: Db;
let guardedDb: GuardedDb;
let ctx: CompanyContext;
let gateway: ToolGateway;
let dispatchPort: ReturnType<typeof createSandboxDispatchPort>;
let platformUrl = "";
let projectUrl = "";
let companyId = "";
let DEV = "";
let taskId = "";
let projectId = "";

const dispatchOptions = (): SandboxDispatchOptions => ({
  guardedDb,
  sandboxManagerUrl: "http://127.0.0.1:1", // db.inspect sandbox'a hiç uğramaz
  internalApiToken: "unused-in-this-suite-0123456789",
  platformDatabaseUrl: platformUrl,
});

beforeAll(async () => {
  container = await startPostgres();
  platformUrl = container.getConnectionUri();
  await runMigrations(platformUrl);
  pool = new Pool({ connectionString: platformUrl });
  pool.on("error", () => {});
  db = createDb(pool);
  guardedDb = createGuardedDb(pool);

  // Projenin KENDİ veritabanı — platform veritabanından ayrı. db.inspect'in
  // hedefi 17 §3.1'e göre budur.
  await pool.query("CREATE DATABASE projectdb");
  projectUrl = platformUrl.replace(/\/[^/?]+(\?|$)/, "/projectdb$1");
  projectPool = new Pool({ connectionString: projectUrl });
  projectPool.on("error", () => {});
  await projectPool.query(
    "CREATE TABLE customers (id int primary key, email text not null, plan text not null)",
  );
  await projectPool.query(
    "INSERT INTO customers VALUES (1,'a@x.io','pro'),(2,'b@x.io','free'),(3,'c@x.io','pro')",
  );

  dispatchPort = createSandboxDispatchPort(dispatchOptions());
  gateway = new ToolGateway({ db: guardedDb, dispatch: dispatchPort });

  const [founder] = await db
    .insert(users)
    .values({ email: "founder@dbinspect.local", passwordHash: "x", displayName: "F" })
    .returning();
  const [company] = await db
    .insert(companies)
    .values({ name: "InspectCo", slug: "inspectco", createdByUserId: founder!.id })
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
      name: "Deniz Dev",
      status: "active",
      positionId: position!.id,
      orgUnitId: unit!.id,
      seniority: "mid",
      autonomyLevel: 2,
      persona: "x",
    })
    .returning();
  DEV = agent!.id;
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
  await db.insert(environments).values({
    companyId,
    projectId,
    name: "local",
    config: { databaseUrl: projectUrl },
  });
  const [task] = await db
    .insert(tasks)
    .values({
      companyId,
      projectId,
      number: 1,
      kind: "task",
      title: "Analyse churn",
      objective: "x",
      status: "IN_PROGRESS",
      ownerAgentId: DEV,
    })
    .returning();
  taskId = task!.id;
  await db
    .insert(toolPermissions)
    .values({ companyId, toolName: "db.inspect", subjectKind: "agent", subjectId: DEV });
}, 600_000);

afterAll(async () => {
  await projectPool?.end();
  await pool?.end();
  await container?.stop();
});

/** Şema katmanını bilerek atlayarak yalnız ikinci savunma hattını sınar. */
const rawDispatch = (query: string, port = dispatchPort) =>
  port.dispatch({
    ctx,
    tool: getTool("db.inspect")!,
    input: { query, environment: "local", maxRows: 100 },
    agentId: DEV,
    taskId,
  });

describe("db.inspect salt-okunurluğu (17 §3.1, Y2)", () => {
  it("projenin kendi veritabanından okur ve satırları döndürür", async () => {
    const res = await gateway.invoke(ctx, {
      agentId: DEV,
      toolName: "db.inspect",
      input: { query: "select email, plan from customers order by id", maxRows: 100 },
      taskId,
    });
    expect(res.decision).toBe("allow");
    expect(res.status, `dispatch hatası: ${res.error ?? res.reason ?? "yok"}`).toBe("succeeded");
    const out = res.output as { columns: string[]; rows: unknown[][]; rowCount: number };
    expect(out.columns).toEqual(["email", "plan"]);
    expect(out.rowCount).toBe(3);
    expect(out.rows[0]).toEqual(["a@x.io", "pro"]);
  });

  it("maxRows aşılınca kırpar ve bunu bildirir", async () => {
    const res = await gateway.invoke(ctx, {
      agentId: DEV,
      toolName: "db.inspect",
      input: { query: "select * from customers", maxRows: 2 },
      taskId,
    });
    expect(res.status).toBe("succeeded");
    const out = res.output as { rowCount: number; truncated: boolean };
    expect(out.rowCount).toBe(2);
    expect(out.truncated).toBe(true);
  });

  // Asıl mesele: şema katmanı atlansa bile yazma İMKANSIZ olmalı.
  it("READ ONLY transaction yazmayı veritabanı seviyesinde reddeder", async () => {
    await expect(rawDispatch("INSERT INTO customers VALUES (9,'z@x.io','pro')")).rejects.toThrow(
      /read-only transaction/i,
    );
    await expect(rawDispatch("DELETE FROM customers")).rejects.toThrow(/read-only transaction/i);
    await expect(rawDispatch("DROP TABLE customers")).rejects.toThrow(/read-only transaction/i);

    // Y2'nin iki imza saldırısı — ikisi de yazamadan ölüyor
    await expect(
      rawDispatch("WITH x AS (INSERT INTO customers VALUES (8,'y@x.io','pro') RETURNING *) SELECT * FROM x"),
    ).rejects.toThrow(/read-only transaction/i);
    await expect(rawDispatch("EXPLAIN ANALYZE DELETE FROM customers")).rejects.toThrow(
      /read-only transaction/i,
    );

    // ve gerçekten hiçbir satır değişmedi
    const after = await projectPool.query("SELECT count(*)::int AS n FROM customers");
    expect(after.rows[0].n).toBe(3);
  });

  it("platform veritabanına yöneltilemez (tenant sızıntısı)", async () => {
    // ortamı ACOS'un kendi veritabanına çevir
    await db
      .update(environments)
      .set({ config: { databaseUrl: platformUrl } })
      .where(eq(environments.projectId, projectId));
    await expect(rawDispatch("select 1")).rejects.toThrow(/platform database/i);
    await db
      .update(environments)
      .set({ config: { databaseUrl: projectUrl } })
      .where(eq(environments.projectId, projectId));
  });

  it("veritabanı tanımlı değilse okunur bir hata verir, sessizce boş dönmez", async () => {
    await db
      .update(environments)
      .set({ config: {} })
      .where(eq(environments.projectId, projectId));
    await expect(rawDispatch("select 1")).rejects.toThrow(/no database configured/i);
    await db
      .update(environments)
      .set({ config: { databaseUrl: projectUrl } })
      .where(eq(environments.projectId, projectId));
  });
});
