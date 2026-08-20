// E2/W3 (T19) — DÜZENLENEBİLİR kadro önerisi.
//
// Önce: plan `tasks.context.staffingPlan` içinde donuyordu, Founder'ın tek
// seçeneği İKİLİ onaydı. "Bir takım daha ekle" / "backend 3 kişi olsun" diye
// bir yüzey YOKTU — sihirbazın eksik parçası buydu.
//
// Sözleşme (bu test): (1) öneri açılır ve türetilmiş alanları SUNUCU hesaplar,
// (2) insan takım ekleyip kadro değiştirebilir ve version artar, (3) bayat
// version reddedilir (iyimser kilit), (4) onaylanan öneri Agent Factory'ye
// TAM OLARAK uygulanır ve takımlar projeye bağlanır (T17), (5) uygulama
// idempotenttir — ikinci çağrı ikinci kadro kurmaz.
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
  users,
} from "@acos/db/schema";
import {
  applyProposal,
  confirmProposal,
  editProposal,
  getOpenProposal,
  openDraftProposal,
  ProposalError,
  upsertProposal,
} from "../../src/modules/staffing/proposal.js";
import { listProjectTeams } from "../../src/modules/projects/team-links.js";
import { startPostgres, type StartedPostgreSqlContainer } from "./helpers";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let guardedDb: GuardedDb;
let ctx: CompanyContext;
let companyId = "";
let founderUserId = "";
let projectId = "";

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

beforeAll(async () => {
  container = await startPostgres();
  await runMigrations(container.getConnectionUri());
  pool = new Pool({ connectionString: container.getConnectionUri() });
  pool.on("error", () => {});
  db = createDb(pool);
  guardedDb = createGuardedDb(pool);

  const [founder] = await db
    .insert(users)
    .values({ email: "founder@proposal.local", passwordHash: "x", displayName: "F" })
    .returning();
  founderUserId = founder!.id;
  const [company] = await db
    .insert(companies)
    .values({ name: "ProposalCo", slug: "proposalco", createdByUserId: founderUserId })
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
    employeeNumber: 901, // AgentsService'in sayacıyla çakışmasın
    name: "Aylin Vural",
    status: "active",
    positionId: ceoPosition!.id,
    orgUnitId: exec!.id,
    seniority: "expert",
    autonomyLevel: 5,
    persona: "CEO",
  });

  projectId = await mkProject("wizard");
}, 300_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
}, 120_000);

describe("staffing proposal (E2/W3)", { timeout: 180_000 }, () => {
  it("öneri açılır; türetilmiş alanları SUNUCU hesaplar", async () => {
    const proposal = await upsertProposal(guardedDb, ctx, {
      projectId,
      workflowId: "goal.test.1",
      source: "llm",
      rationaleMd: "Küçük bir servis; backend ağırlıklı ekip yeter.",
      teams: [
        { capability: "backend", teamName: "Backend", headcount: 2, rationale: "API ve testler" },
        { capability: "qa", headcount: 1 },
      ],
    });
    expect(proposal.status).toBe("awaiting_human");
    expect(proposal.source).toBe("llm");
    expect(proposal.version).toBe(1);
    expect(proposal.workflowId).toBe("goal.test.1");
    const backend = proposal.teams.find((t) => t.capability === "backend");
    expect(backend?.headcount).toBe(2);
    // şirkette hiç backend yok → hepsi işe alınacak; maliyet buradan türer
    expect(backend?.existingCount).toBe(0);
    expect(backend?.hireCount).toBe(2);
    expect(proposal.estimatedCostCents).toBe(3 * 500);
    // her satırın kararlı bir anahtarı var (arayüzün düzenleme kimliği)
    expect(proposal.teams.map((t) => t.key).sort()).toEqual(["backend", "qa"]);
  });

  it("ikinci giriş YENİ öneri üretmez (idempotent replay)", async () => {
    const first = await getOpenProposal(guardedDb, ctx, projectId);
    const again = await upsertProposal(guardedDb, ctx, {
      projectId,
      source: "deterministic",
      teams: [{ capability: "design", headcount: 5 }],
    });
    expect(again.id).toBe(first!.id);
    expect(again.teams.map((t) => t.capability)).not.toContain("design");
  });

  it("insan takım EKLER ve kadro DEĞİŞTİRİR; version artar, kaynak human olur", async () => {
    const current = (await getOpenProposal(guardedDb, ctx, projectId))!;
    const edited = await editProposal(guardedDb, ctx, {
      proposalId: current.id,
      version: current.version,
      teams: [
        // kadro değişti 2 → 3
        { key: "backend", capability: "backend", teamName: "Backend", headcount: 3 },
        // qa satırı ÇIKARILDI (dizide yok = takım silindi)
        // YENİ takım eklendi
        { capability: "frontend", teamName: "Arayüz", headcount: 1 },
      ],
    });
    expect(edited.version).toBe(current.version + 1);
    expect(edited.source).toBe("human");
    expect(edited.teams.map((t) => t.capability).sort()).toEqual(["backend", "frontend"]);
    expect(edited.teams.find((t) => t.capability === "backend")?.headcount).toBe(3);
    expect(edited.estimatedCostCents).toBe(4 * 500);
  });

  it("headcount 0 satırı düşürür ve bayat version reddedilir", async () => {
    const current = (await getOpenProposal(guardedDb, ctx, projectId))!;
    await expect(
      editProposal(guardedDb, ctx, {
        proposalId: current.id,
        version: current.version - 1, // bayat
        teams: [{ capability: "backend", headcount: 1 }],
      }),
    ).rejects.toMatchObject({ code: "stale_version" });

    const dropped = await editProposal(guardedDb, ctx, {
      proposalId: current.id,
      version: current.version,
      teams: [
        { key: "backend", capability: "backend", headcount: 2 },
        { capability: "frontend", headcount: 0 }, // "bu takımı çıkar"
      ],
    });
    expect(dropped.teams.map((t) => t.capability)).toEqual(["backend"]);
  });

  it("onaylanan öneri Agent Factory'ye uygulanır ve takım projeye BAĞLANIR (T17)", async () => {
    const current = (await getOpenProposal(guardedDb, ctx, projectId))!;
    const confirmed = await confirmProposal(guardedDb, ctx, current.id);
    expect(confirmed.status).toBe("confirmed");
    // onaylanmış öneri artık düzenlenemez
    await expect(
      editProposal(guardedDb, ctx, {
        proposalId: current.id,
        version: confirmed.version,
        teams: [{ capability: "backend", headcount: 9 }],
      }),
    ).rejects.toMatchObject({ code: "not_editable" });

    const applied = await applyProposal(guardedDb, ctx, current.id);
    expect(applied.proposal.status).toBe("applied");
    // hedef 2 kişi + inceleme-yetkin lider (15 §2.2)
    expect(applied.hiredAgentIds.length).toBeGreaterThanOrEqual(3);

    const { groups } = await listProjectTeams(guardedDb, ctx);
    const group = groups.find((g) => g.projectId === projectId);
    expect(group?.source).toBe("link");
    expect(group?.teams.map((t) => t.slug)).toEqual(["backend"]);
  });

  it("ikinci uygulama İKİNCİ KADRO kurmaz (idempotent)", async () => {
    const [before] = (
      await db.execute(sql`
        SELECT count(*)::int AS n FROM agents WHERE company_id = ${companyId} AND status = 'active'
      `)
    ).rows as [{ n: number }];
    const proposalId = (
      await db.execute(sql`
        SELECT id FROM staffing_proposals WHERE company_id = ${companyId} AND status = 'applied' LIMIT 1
      `)
    ).rows[0] as { id: string };
    const again = await applyProposal(guardedDb, ctx, proposalId.id);
    expect(again.hiredAgentIds).toHaveLength(0);
    const [after] = (
      await db.execute(sql`
        SELECT count(*)::int AS n FROM agents WHERE company_id = ${companyId} AND status = 'active'
      `)
    ).rows as [{ n: number }];
    expect(Number(after.n)).toBe(Number(before.n));
  });

  // ------------------------------------------------------------------
  // T20 geri bildirimi (2026-08-20): GET'in 404'ü İKİ ayrı şeyi anlatıyordu —
  // "uç/proje yok" ve "CEO hâlâ düşünüyor". Satır artık akışın BAŞINDA açılır.
  // Sözleşme değişmedi: `draft` zaten ilan edilmiş bir durumdu.
  // ------------------------------------------------------------------

  it("boş taslak açılır ('CEO düşünüyor') ve GET onu AÇIK öneri sayar", async () => {
    const other = await mkProject("taslak");
    const draft = await openDraftProposal(guardedDb, ctx, {
      projectId: other,
      workflowId: "goal.taslak.1",
    });
    expect(draft.status).toBe("draft");
    expect(draft.teams).toHaveLength(0);
    const seen = await getOpenProposal(guardedDb, ctx, other);
    expect(seen?.id).toBe(draft.id); // 404 DEĞİL — arayüz ilerleme gösterebilir
    // ikinci açış aynı satırı döner
    expect((await openDraftProposal(guardedDb, ctx, { projectId: other })).id).toBe(draft.id);
  });

  it("öneri gelince taslak DOLDURULUR — ikinci satır açılmaz", async () => {
    const other = await mkProject("taslak-dolar");
    const draft = await openDraftProposal(guardedDb, ctx, { projectId: other });
    const filled = await upsertProposal(guardedDb, ctx, {
      projectId: other,
      source: "llm",
      rationaleMd: "Küçük ekip yeter.",
      teams: [{ capability: "devops", headcount: 1 }],
    });
    expect(filled.id).toBe(draft.id); // AYNI satır
    expect(filled.status).toBe("awaiting_human");
    expect(filled.source).toBe("llm");
    expect(filled.teams.map((t) => t.capability)).toEqual(["devops"]);
  });

  it("önerilecek bir şey çıkmazsa taslak KAPANIR (sonsuz 'düşünüyor' yok)", async () => {
    const other = await mkProject("onerisiz");
    const draft = await openDraftProposal(guardedDb, ctx, { projectId: other });
    const closed = await upsertProposal(guardedDb, ctx, {
      projectId: other,
      source: "deterministic",
      teams: [], // LLM de yedeği de boş döndü
    });
    expect(closed.id).toBe(draft.id);
    expect(closed.status).toBe("cancelled");
    // kapandı → artık AÇIK öneri değil
    expect(await getOpenProposal(guardedDb, ctx, other)).toBeNull();
  });

  it("insanın dokunduğu taslak LLM tarafından EZİLMEZ", async () => {
    const other = await mkProject("insan-taslagi");
    const draft = await openDraftProposal(guardedDb, ctx, { projectId: other });
    const mine = await editProposal(guardedDb, ctx, {
      proposalId: draft.id,
      version: draft.version,
      teams: [{ capability: "security", headcount: 2 }],
    });
    expect(mine.source).toBe("human");
    const late = await upsertProposal(guardedDb, ctx, {
      projectId: other,
      source: "llm",
      teams: [{ capability: "marketing", headcount: 4 }],
    });
    expect(late.teams.map((t) => t.capability)).toEqual(["security"]);
    expect(late.source).toBe("human");
  });

  it("boş plan onaylanamaz", async () => {
    const other = await mkProject("bos-plan");
    const proposal = await upsertProposal(guardedDb, ctx, {
      projectId: other,
      source: "deterministic",
      teams: [{ capability: "backend", headcount: 0 }], // hepsi düşer
    });
    expect(proposal.teams).toHaveLength(0);
    await expect(confirmProposal(guardedDb, ctx, proposal.id)).rejects.toBeInstanceOf(ProposalError);
  });
});
