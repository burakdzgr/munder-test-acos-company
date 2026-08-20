// T25/#2 (god kararı, Jim'in CANLI koşusundan, 2026-08-20) —
// İNSANIN ONAYLADIĞI SİHİRBAZ PLANI KADRONUN TEMELİDİR.
//
// Gözlenen gerçek davranış: sihirbazda insan devops takımını BİLEREK sildi
// (headcount 0), applyPlan tam olarak istenen kadroyu kurdu — ve hemen
// ardından planlama devamı gereksinim analizi artefaktından gap'i YENİDEN
// türetip "eksik kadro: devops x1" diye İKİNCİ bir Founder onayı açtı. Yani
// insan aynı kadroyu iki kez onaylamak zorunda kaldı, ikincisinde de az önce
// kaldırdığı takım için, ve iş o onay gelene kadar başlamadı.
//
// Kullanıcının vizyonu: sihirbaz KARAR NOKTASIDIR → kur → iş başlar. İkinci
// onay yok. Bu yüzden onaylanmış öneri, analizci listesini filtrelemez —
// onun YERİNE geçer.
//
// Sözleşme (bu test): (1) silinen takım için ikinci onay AÇILMAZ ve proje
// executing'e geçer, (2) insanın EKLEDİĞİ (analizcinin hiç önermediği) takım
// temele dahildir, (3) onaylanmış plan yoksa eski yol aynen işler —
// gereksinim analizi gap üretir ve Founder onayı açılır.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { and, eq, sql } from "drizzle-orm";
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
  approvals,
  artifacts,
  companies,
  companyMembers,
  orgUnits,
  positions,
  projects,
  users,
} from "@acos/db/schema";
import { continueProjectPlanning } from "../../src/modules/staffing/service.js";
import {
  applyProposal,
  confirmProposal,
  editProposal,
  upsertProposal,
} from "../../src/modules/staffing/proposal.js";
import { startPostgres, type StartedPostgreSqlContainer } from "./helpers";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let guardedDb: GuardedDb;
let ctx: CompanyContext;
let companyId = "";
let founderUserId = "";

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

/** Requirement Analyzer çıktısı — sihirbazın ÖNCESİNDEKİ dünya. */
async function seedAnalysis(projectId: string, capabilities: string[]): Promise<void> {
  await db.insert(artifacts).values({
    companyId,
    projectId,
    kind: "document",
    title: "requirement analysis",
    contentMd: JSON.stringify({ goal: "saglik ucu", required_capabilities: capabilities }),
    meta: { type: "requirement_analysis" },
  });
}

const pendingHireApprovals = async (projectScopedNote?: string) =>
  db
    .select({ id: approvals.id, title: approvals.title, requestMd: approvals.requestMd })
    .from(approvals)
    .where(
      and(
        eq(approvals.companyId, companyId),
        eq(approvals.kind, "hire"),
        eq(approvals.status, "pending"),
      ),
    )
    .then((rows) =>
      projectScopedNote
        ? rows.filter((r) => `${r.title} ${r.requestMd}`.includes(projectScopedNote))
        : rows,
    );

beforeAll(async () => {
  container = await startPostgres();
  await runMigrations(container.getConnectionUri());
  pool = new Pool({ connectionString: container.getConnectionUri() });
  pool.on("error", () => {});
  db = createDb(pool);
  guardedDb = createGuardedDb(pool);

  const [founder] = await db
    .insert(users)
    .values({ email: "founder@baseline.local", passwordHash: "x", displayName: "F" })
    .returning();
  founderUserId = founder!.id;
  const [company] = await db
    .insert(companies)
    .values({ name: "BaselineCo", slug: "baselineco", createdByUserId: founderUserId })
    .returning();
  companyId = company!.id;
  ctx = companyContext(companyId);
  await db.insert(companyMembers).values({ companyId, userId: founderUserId, role: "founder" });

  const [exec] = await db
    .insert(orgUnits)
    .values({ companyId, kind: "department", name: "Executive", slug: "executive" })
    .returning();
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
}, 300_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
}, 120_000);

describe("wizard plan is the staffing baseline (T25/#2)", { timeout: 300_000 }, () => {
  it("insanın SİLDİĞİ takım için ikinci onay açılmaz; proje doğrudan executing'e geçer", async () => {
    const projectId = await mkProject("silinen-takim");
    // analizci iki uzmanlık istedi
    await seedAnalysis(projectId, ["backend x1", "devops x1"]);

    // CEO önerdi…
    const proposed = await upsertProposal(guardedDb, ctx, {
      projectId,
      source: "llm",
      teams: [
        { capability: "backend", headcount: 1 },
        { capability: "devops", headcount: 1 },
      ],
    });
    // …insan devops'u BİLEREK sildi
    const edited = await editProposal(guardedDb, ctx, {
      proposalId: proposed.id,
      version: proposed.version,
      teams: [{ key: "backend", capability: "backend", headcount: 1 }],
    });
    expect(edited.teams.map((t) => t.capability)).toEqual(["backend"]);

    await confirmProposal(guardedDb, ctx, edited.id);
    const applied = await applyProposal(guardedDb, ctx, edited.id);
    expect(applied.proposal.status).toBe("applied");

    // …ve planlama devam ediyor
    const started: Array<{ agentId: string; taskId: string }> = [];
    const result = await continueProjectPlanning(
      { guardedDb, startAgentWorkflow: async (i) => (started.push(i), true) },
      companyId,
      projectId,
    );

    // ÖNCEDEN: state 'waiting_for_founder' + "eksik kadro: devops x1" onayı
    expect(result.state).toBe("executing");
    expect(result.missing).toEqual([]);
    expect(await pendingHireApprovals("silinen-takim")).toHaveLength(0);
    // CEO'nun döngüsü gerçekten başladı — iş ikinci bir onayı beklemiyor
    expect(started.length).toBeGreaterThan(0);

    const [project] = await db
      .select({ status: projects.status })
      .from(projects)
      .where(and(eq(projects.companyId, companyId), eq(projects.id, projectId)));
    expect(project!.status).toBe("executing");
  });

  it("insanın EKLEDİĞİ (analizcinin önermediği) takım temele dahildir", async () => {
    const projectId = await mkProject("eklenen-takim");
    await seedAnalysis(projectId, ["backend x1"]);

    const proposed = await upsertProposal(guardedDb, ctx, {
      projectId,
      source: "llm",
      teams: [{ capability: "backend", headcount: 1 }],
    });
    // insan analizcinin hiç düşünmediği bir takım ekliyor
    const edited = await editProposal(guardedDb, ctx, {
      proposalId: proposed.id,
      version: proposed.version,
      teams: [
        { key: "backend", capability: "backend", headcount: 1 },
        { capability: "design", headcount: 2 },
      ],
    });
    await confirmProposal(guardedDb, ctx, edited.id);
    const applied = await applyProposal(guardedDb, ctx, edited.id);

    // Agent Factory design takımını GERÇEKTEN kurdu (lider + 2 üye)
    expect(applied.createdUnits).toContain("design");
    const [{ n }] = (
      await db.execute(sql`
        SELECT count(*)::int AS n FROM agents a
          JOIN org_units u ON u.id = a.org_unit_id
         WHERE a.company_id = ${companyId} AND u.slug = 'design' AND a.status = 'active'
      `)
    ).rows as [{ n: number }];
    expect(Number(n)).toBeGreaterThanOrEqual(3);

    // ve gap temeli artık onun planı: ikinci onay yok
    const result = await continueProjectPlanning({ guardedDb }, companyId, projectId);
    expect(result.state).toBe("executing");
    expect(await pendingHireApprovals("eklenen-takim")).toHaveLength(0);
  });

  it("onaylanmış plan YOKSA eski yol aynen işler (gap onayı üretilir)", async () => {
    const projectId = await mkProject("sihirbazsiz");
    await seedAnalysis(projectId, ["mobile x2"]); // şirkette mobile yok

    const result = await continueProjectPlanning({ guardedDb }, companyId, projectId);
    expect(result.state).toBe("waiting_for_founder");
    expect(result.missing.map((m) => m.capability)).toContain("mobile");
    expect(await pendingHireApprovals("sihirbazsiz")).toHaveLength(1);
  });

  it("İPTAL edilen öneri temel sayılmaz — eski yol işler", async () => {
    const projectId = await mkProject("iptal-oneri");
    await seedAnalysis(projectId, ["security x1"]);
    const proposed = await upsertProposal(guardedDb, ctx, {
      projectId,
      source: "llm",
      teams: [{ capability: "security", headcount: 1 }],
    });
    const { cancelProposal } = await import("../../src/modules/staffing/proposal.js");
    await cancelProposal(guardedDb, ctx, proposed.id);

    const result = await continueProjectPlanning({ guardedDb }, companyId, projectId);
    expect(result.state).toBe("waiting_for_founder");
    expect(result.missing.map((m) => m.capability)).toContain("security");
  });
});
