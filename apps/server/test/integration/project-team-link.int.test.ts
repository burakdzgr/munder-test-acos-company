// E2/W1 (T17) KEYSTONE — Company > Project > Team GERÇEK ilişki.
//
// Önce: bağ yalnız İŞTEN türüyordu (tasks.projectId × tasks.orgUnitId), yani
// henüz görev dağıtılmamış bir projenin takımı YOKTU — sihirbazın kurduğu ekip
// ilk görev düşene kadar görünmüyordu.
//
// Sözleşme (bu test): (1) kalıcı bağ okunur ve `source:"link"` der, (2) bağı
// olmayan proje TÜREVE düşer ve `source:"derived"` der — göç öncesi projeler
// boş görünmez, (3) bağlama/çözme idempotenttir ve yumuşak siler,
// (4) Agent Factory bir proje için kadro kurduğunda takımı KENDİ bağlar.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
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
  companyMembers,
  orgUnits,
  positions,
  projects,
  tasks,
  users,
} from "@acos/db/schema";
import {
  linkProjectTeam,
  listProjectTeams,
  unlinkProjectTeam,
} from "../../src/modules/projects/team-links.js";
import { StaffingService } from "../../src/modules/staffing/service.js";
import { startPostgres, type StartedPostgreSqlContainer } from "./helpers";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let guardedDb: GuardedDb;
let ctx: CompanyContext;
let companyId = "";
let founderUserId = "";
let backendUnitId = "";
let designUnitId = "";
let linkedProjectId = "";
let derivedProjectId = "";
let emptyProjectId = "";
let counter = 0;

async function mkProject(slug: string): Promise<string> {
  const [project] = await db
    .insert(projects)
    .values({
      companyId,
      slug,
      name: slug,
      objectiveMd: "o",
      status: "planning",
      createdByUserId: founderUserId,
    })
    .returning();
  return project!.id;
}

async function mkTask(projectId: string, orgUnitId: string): Promise<void> {
  counter += 1;
  await db.insert(tasks).values({
    companyId,
    number: 900 + counter, // TasksService'in sayacıyla çakışmasın
    kind: "task",
    title: `T${counter}`,
    objective: "o",
    status: "PLANNED",
    projectId,
    orgUnitId,
  });
}

beforeAll(async () => {
  container = await startPostgres();
  await runMigrations(container.getConnectionUri());
  pool = new Pool({ connectionString: container.getConnectionUri() });
  pool.on("error", () => {});
  db = createDb(pool);
  guardedDb = createGuardedDb(pool);

  const [founder] = await db
    .insert(users)
    .values({ email: "founder@teamlink.local", passwordHash: "x", displayName: "F" })
    .returning();
  founderUserId = founder!.id;
  const [company] = await db
    .insert(companies)
    .values({ name: "LinkCo", slug: "linkco", createdByUserId: founderUserId })
    .returning();
  companyId = company!.id;
  ctx = companyContext(companyId);
  await db.insert(companyMembers).values({ companyId, userId: founderUserId, role: "founder" });

  const [exec] = await db
    .insert(orgUnits)
    .values({ companyId, kind: "department", name: "Executive", slug: "executive" })
    .returning();
  const [backend] = await db
    .insert(orgUnits)
    .values({ companyId, kind: "team", name: "Backend", slug: "backend" })
    .returning();
  backendUnitId = backend!.id;
  const [design] = await db
    .insert(orgUnits)
    .values({ companyId, kind: "team", name: "Design", slug: "design" })
    .returning();
  designUnitId = design!.id;

  const [ceoPosition] = await db
    .insert(positions)
    .values({ companyId, title: "CEO", seniorityTrack: ["expert"], defaultRole: "executive" })
    .returning();
  await db.insert(agents).values({
    companyId,
    employeeNumber: 901,
    name: "Aylin Vural",
    status: "active",
    positionId: ceoPosition!.id,
    orgUnitId: exec!.id,
    seniority: "expert",
    autonomyLevel: 5,
    persona: "CEO",
  });

  linkedProjectId = await mkProject("linked");
  derivedProjectId = await mkProject("derived");
  emptyProjectId = await mkProject("empty");
}, 300_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
}, 120_000);

describe("project <-> team link (E2/W1)", { timeout: 120_000 }, () => {
  it("kalıcı bağ okunur ve kaynağını 'link' olarak bildirir", async () => {
    await linkProjectTeam(guardedDb, ctx, {
      projectId: linkedProjectId,
      orgUnitId: backendUnitId,
      addedBy: "founder",
    });
    const { groups } = await listProjectTeams(guardedDb, ctx);
    const group = groups.find((g) => g.projectId === linkedProjectId);
    expect(group?.source).toBe("link");
    expect(group?.teams.map((t) => t.slug)).toEqual(["backend"]);
    // takım HİÇ görev almamış olsa bile görünür — keystone'un tüm amacı bu
    expect(group?.teams[0]?.taskCount).toBe(0);
  });

  it("bağı olmayan proje TÜREVE düşer (göç öncesi projeler boş görünmez)", async () => {
    await mkTask(derivedProjectId, designUnitId);
    const { groups } = await listProjectTeams(guardedDb, ctx);
    const group = groups.find((g) => g.projectId === derivedProjectId);
    expect(group?.source).toBe("derived");
    expect(group?.teams.map((t) => t.slug)).toEqual(["design"]);
    expect(group?.teams[0]?.taskCount).toBe(1);
  });

  it("hiç işi ve bağı olmayan proje boş grup döner", async () => {
    const { groups, idleTeams } = await listProjectTeams(guardedDb, ctx);
    const group = groups.find((g) => g.projectId === emptyProjectId);
    expect(group).toBeDefined();
    expect(group!.teams).toHaveLength(0);
    // backend bağlı, design türevden geldi → ikisi de idle DEĞİL
    expect(idleTeams.map((t) => t.slug)).not.toContain("backend");
    expect(idleTeams.map((t) => t.slug)).not.toContain("design");
  });

  it("bağlama idempotent, çözme yumuşak ve geri açılabilir", async () => {
    const first = await linkProjectTeam(guardedDb, ctx, {
      projectId: linkedProjectId,
      orgUnitId: designUnitId,
    });
    expect(first.linked).toBe(true);
    // ikinci kez: yeni satır YOK, hata da yok
    const second = await linkProjectTeam(guardedDb, ctx, {
      projectId: linkedProjectId,
      orgUnitId: designUnitId,
    });
    expect(second.linked).toBe(false);
    const rows = await db.execute(sql`
      SELECT count(*)::int AS n FROM project_team_memberships
       WHERE project_id = ${linkedProjectId} AND org_unit_id = ${designUnitId}
    `);
    expect(Number((rows.rows[0] as { n: number }).n)).toBe(1);

    expect(
      (
        await unlinkProjectTeam(guardedDb, ctx, {
          projectId: linkedProjectId,
          orgUnitId: designUnitId,
        })
      ).unlinked,
    ).toBe(true);
    const after = await listProjectTeams(guardedDb, ctx);
    expect(
      after.groups.find((g) => g.projectId === linkedProjectId)?.teams.map((t) => t.slug),
    ).toEqual(["backend"]);
    // satır SİLİNMEZ, yalnız kapatılır — geçmiş durur
    const kept = await db.execute(sql`
      SELECT count(*)::int AS n FROM project_team_memberships
       WHERE project_id = ${linkedProjectId} AND org_unit_id = ${designUnitId}
         AND removed_at IS NOT NULL
    `);
    expect(Number((kept.rows[0] as { n: number }).n)).toBe(1);
    // geri açılabilir
    expect(
      (
        await linkProjectTeam(guardedDb, ctx, {
          projectId: linkedProjectId,
          orgUnitId: designUnitId,
        })
      ).linked,
    ).toBe(true);
    await unlinkProjectTeam(guardedDb, ctx, {
      projectId: linkedProjectId,
      orgUnitId: designUnitId,
    });
  });

  it("Agent Factory proje için kadro kurunca takımı KENDİ bağlar", async () => {
    const projectId = await mkProject("factory");
    const staffing = new StaffingService(guardedDb);
    await staffing.applyPlan(ctx, [{ capability: "mobile", count: 1 }], { projectId });
    const { groups } = await listProjectTeams(guardedDb, ctx);
    const group = groups.find((g) => g.projectId === projectId);
    expect(group?.source).toBe("link");
    expect(group?.teams.map((t) => t.slug)).toEqual(["mobile"]);
    // hiç görev dağıtılmadan takım projede görünüyor + ajanları sayılıyor
    expect(group!.teams[0]!.agentCount).toBeGreaterThanOrEqual(2); // lider + üye
  });
});
