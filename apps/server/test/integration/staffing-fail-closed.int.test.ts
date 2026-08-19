// P0-1 (canlı break-point haritası, 2026-08-19) — STAFFING FAIL-CLOSED.
//
// Gözlenen gerçek davranış: analyzeRequirementsActivity degrade-safe olduğu
// için requirement_analysis artefaktı hiç üretilmeyebiliyor; boş yetenek
// listesi "kadro tam" sayılıyor ve TEK KİŞİLİK (yalnız CEO) şirket doğrudan
// executing'e geçiyordu — approvals 0 satır, Agent Factory dalı ölü kod.
//
// Beklenen (bu test): analiz yok/boşken continueProjectPlanning kadroyu TAM
// SAYMAZ — deterministik asgari mühendislik gereksinimini degraded artefakt
// olarak yazar, staffing gap normal yolundan TEK Founder onayı üretir ve proje
// waiting_for_founder'da BEKLER. Kadro gerçekten tamsa (fullstack mevcut)
// akış eskisi gibi executing'e gider.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { and, eq, sql } from "drizzle-orm";
import {
  companyContext,
  createDb,
  createGuardedDb,
  runMigrations,
  type Db,
  type GuardedDb,
} from "@acos/db";
import {
  agents,
  approvals,
  artifacts,
  companies,
  companyMembers,
  orgUnits,
  positions,
  projects,
  tasks,
  users,
} from "@acos/db/schema";
import { continueProjectPlanning } from "../../src/modules/staffing/service.js";
import { startPostgres, type StartedPostgreSqlContainer } from "./helpers";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let guardedDb: GuardedDb;
let companyId = "";
let founderUserId = "";
let unitId = "";
const started: Array<{ agentId: string; taskId: string }> = [];

beforeAll(async () => {
  container = await startPostgres();
  await runMigrations(container.getConnectionUri());
  pool = new Pool({ connectionString: container.getConnectionUri() });
  pool.on("error", () => {});
  db = createDb(pool);
  guardedDb = createGuardedDb(pool);

  const [founder] = await db
    .insert(users)
    .values({ email: "founder@p01.local", passwordHash: "x", displayName: "F" })
    .returning();
  founderUserId = founder!.id;
  const [company] = await db
    .insert(companies)
    .values({ name: "FailClosedCo", slug: "failclosedco", createdByUserId: founderUserId })
    .returning();
  companyId = company!.id;
  await db.insert(companyMembers).values({ companyId, userId: founderUserId, role: "founder" });
  const [unit] = await db
    .insert(orgUnits)
    .values({ companyId, kind: "department", name: "Executive", slug: "executive" })
    .returning();
  unitId = unit!.id;
  const [ceoPosition] = await db
    .insert(positions)
    .values({ companyId, title: "CEO", seniorityTrack: ["expert"], defaultRole: "executive" })
    .returning();
  await db.insert(agents).values({
    companyId,
    employeeNumber: 1,
    name: "Aylin Vural",
    status: "active",
    positionId: ceoPosition!.id,
    orgUnitId: unitId,
    seniority: "expert",
    autonomyLevel: 3,
    persona: "CEO",
  });
}, 300_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
}, 120_000);

async function mkProject(slug: string): Promise<string> {
  const [project] = await db
    .insert(projects)
    .values({
      companyId,
      slug,
      name: slug,
      objectiveMd: "Bir HTTP saglik ucu olan kucuk bir Node servisi kur.",
      status: "planning",
      createdByUserId: founderUserId,
    })
    .returning();
  return project!.id;
}

describe("continueProjectPlanning fail-closed (P0-1)", { timeout: 120_000 }, () => {
  it("no requirement analysis + CEO-only org → degraded artifact + ONE staffing approval + project waits", async () => {
    const projectId = await mkProject("p01-empty");
    const result = await continueProjectPlanning(
      { guardedDb, startAgentWorkflow: async (i) => (started.push(i), true) },
      companyId,
      projectId,
    );

    // kadro tam SAYILMADI: onay üretildi, proje Founder'ı bekliyor
    expect(result.state).toBe("waiting_for_founder");
    expect(result.approvalId).not.toBeNull();
    expect(result.missing.length).toBeGreaterThan(0);
    expect(started).toHaveLength(0); // CEO döngüsü başlatılmadı

    // degraded requirement_analysis artefaktı yazıldı (karar izlenebilir)
    const arts = await db
      .select({ contentMd: artifacts.contentMd })
      .from(artifacts)
      .where(
        sql`${artifacts.companyId} = ${companyId} AND ${artifacts.projectId} = ${projectId}
            AND ${artifacts.kind} = 'document' AND ${artifacts.meta}->>'type' = 'requirement_analysis'`,
      );
    expect(arts).toHaveLength(1);
    const parsed = JSON.parse(arts[0]!.contentMd ?? "{}") as {
      degraded?: boolean;
      required_capabilities?: string[];
    };
    expect(parsed.degraded).toBe(true);
    expect(parsed.required_capabilities?.length).toBeGreaterThan(0);

    // approval satırı gerçekten pending
    const [approval] = await db
      .select({ status: approvals.status })
      .from(approvals)
      .where(and(eq(approvals.companyId, companyId), eq(approvals.id, result.approvalId!)));
    expect(approval?.status).toBe("pending");

    // proje executing'e GEÇMEDİ
    const [project] = await db
      .select({ status: projects.status })
      .from(projects)
      .where(and(eq(projects.companyId, companyId), eq(projects.id, projectId)));
    expect(project!.status).toBe("waiting_for_founder");

    // idempotent: ikinci çağrı ikinci onay üretmez
    const again = await continueProjectPlanning({ guardedDb }, companyId, projectId);
    expect(again.state).toBe("waiting_for_founder");
    const pendings = await db
      .select({ id: approvals.id })
      .from(approvals)
      .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")));
    expect(pendings).toHaveLength(1);
  });

  it("org with a fullstack dev → gap empty, project executes (fail-closed does not over-block)", async () => {
    const [devPosition] = await db
      .insert(positions)
      .values({
        companyId,
        title: "Fullstack Developer",
        seniorityTrack: ["mid"],
        defaultRole: "member",
      })
      .returning();
    await db.insert(agents).values({
      companyId,
      employeeNumber: 2,
      name: "Deniz Dev",
      status: "active",
      positionId: devPosition!.id,
      orgUnitId: unitId,
      seniority: "mid",
      autonomyLevel: 3,
      persona: "Fullstack",
    });

    const projectId = await mkProject("p01-staffed");
    started.length = 0;
    const result = await continueProjectPlanning(
      { guardedDb, startAgentWorkflow: async (i) => (started.push(i), true) },
      companyId,
      projectId,
    );
    expect(result.state).toBe("executing");
    expect(result.approvalId).toBeNull();
    expect(started).toHaveLength(1); // CEO döngüsü başladı

    const [project] = await db
      .select({ status: projects.status })
      .from(projects)
      .where(and(eq(projects.companyId, companyId), eq(projects.id, projectId)));
    expect(project!.status).toBe("executing");
  });
});
