// P1-1 (2026-08-19, Founder onaylı) — PROJE HEDEF KAPISI.
//
// Gözlenen gerçek davranış (golden path 5fbdb3e, kanıt T5-gate-map):
//   (a) create-time objective planlamayı OTOMATİK başlatıyordu; proje READY'de
//       durmuyor, dokümanın "READY → Founder hedefi → PLANNING" adımı
//       ERİŞİLMEZ kalıyordu (stage 04 yalnız fail-closed maskesiyle geçti).
//   (b) İlk hedef projeyi `executing`'e kilitleyince İKİNCİ Founder hedefi
//       409 alıyordu: "proje executing durumunda — hedef READY'de verilir"
//       (stage 14 BREAK) — şirket ikinci işi hiç alamıyordu.
//   (c) Kapı açılsa bile routeIntake proje başına TEK goal tutuyordu: ikinci
//       hedef sessizce BİRİNCİ görevi geri döndürüyor, yeni iş doğmuyordu.
//
// Beklenen (bu test): hedef kapısı yaşam döngüsüne uyar — indekslenmemiş
// proje reddedilir, READY hedefi PLANNING'e alır, KOŞAN proje ikinci hedefi
// kabul eder ve durumu geri sarmaz, aynı hedef metni replay'de aynı görevi
// döndürürken YENİ hedef YENİ goal ağacı açar.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { and, eq } from "drizzle-orm";
import {
  companyContext,
  createDb,
  createGuardedDb,
  runMigrations,
  ProjectsService,
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
import { buildApp, type App } from "../../src/app.js";
import { startPostgres, type StartedPostgreSqlContainer } from "./helpers";

const MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
const ok = async () => {};

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let guardedDb: GuardedDb;
let app: App;
let companyId = "";
let founderUserId = "";
let sessionCookie = "";
let csrfToken = "";
/** goalStarter çağrıları — planlamanın TEK kapıdan girdiğinin kanıtı. */
const goalStarts: Array<{ projectId: string; objective: string }> = [];

const authHeaders = () => ({
  cookie: `acos_session=${sessionCookie}; acos_csrf=${csrfToken}`,
  "x-csrf-token": csrfToken,
});

async function mkProject(slug: string, status: string, objective: string): Promise<string> {
  const [row] = await db
    .insert(projects)
    .values({
      companyId,
      slug,
      name: slug,
      objectiveMd: objective,
      status,
      createdByUserId: founderUserId,
    })
    .returning();
  return row!.id;
}

const postGoal = (projectId: string, objective: string) =>
  app.inject({
    method: "POST",
    url: `/api/v1/companies/${companyId}/projects/${projectId}/goal`,
    headers: authHeaders(),
    payload: { objective },
  });

beforeAll(async () => {
  container = await startPostgres();
  await runMigrations(container.getConnectionUri());
  pool = new Pool({ connectionString: container.getConnectionUri() });
  pool.on("error", () => {});
  db = createDb(pool);
  guardedDb = createGuardedDb(pool);
  app = await buildApp({
    healthCheckers: { postgres: ok, nats: ok, temporal: ok },
    logger: false,
    db,
    guardedDb,
    masterKey: MASTER_KEY,
  });
  app.goalStarter = async ({ projectId, objective }) => {
    goalStarts.push({ projectId, objective });
  };
  await app.ready();

  const setup = await app.inject({
    method: "POST",
    url: "/api/v1/auth/setup",
    payload: { email: "founder@p11.local", password: "correct-horse-battery", displayName: "F" },
  });
  for (const c of setup.cookies) {
    if (c.name === "acos_session") sessionCookie = c.value;
    if (c.name === "acos_csrf") csrfToken = c.value;
  }
  const [founder] = await db.select({ id: users.id }).from(users);
  founderUserId = founder!.id;
  const [company] = await db
    .insert(companies)
    .values({ name: "GoalGateCo", slug: "goalgateco", createdByUserId: founderUserId })
    .returning();
  companyId = company!.id;
  await db.insert(companyMembers).values({ companyId, userId: founderUserId, role: "founder" });
  const [unit] = await db
    .insert(orgUnits)
    .values({ companyId, kind: "department", name: "Executive", slug: "executive" })
    .returning();
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
    orgUnitId: unit!.id,
    seniority: "expert",
    autonomyLevel: 3,
    persona: "CEO",
  });
}, 300_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe("Founder hedef kapısı (P1-1)", { timeout: 120_000 }, () => {
  it("indekslenmemiş proje hedef ALMAZ — READY beklenir", async () => {
    const projectId = await mkProject("p11-indexing", "indexing", "ilk fikir");
    const res = await postGoal(projectId, "Saglik ucunu ekle ve testini yaz.");
    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.json())).toContain("indeks");
  });

  it("READY projede hedef PLANNING'i başlatır (create-time objective değil, AÇIK hedef)", async () => {
    const projectId = await mkProject("p11-ready", "ready", "create-time fikir");
    const res = await postGoal(projectId, "Saglik ucunu /health olarak ekle.");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ started: true, state: "planning" });

    const [row] = await db
      .select({ status: projects.status, objectiveMd: projects.objectiveMd })
      .from(projects)
      .where(and(eq(projects.companyId, companyId), eq(projects.id, projectId)));
    expect(row!.status).toBe("planning");
    // hedef metni projeye yazıldı ve planlama TEK kapıdan (goalStarter) girdi
    expect(row!.objectiveMd).toContain("/health");
    expect(goalStarts.at(-1)).toMatchObject({ projectId });
  });

  // stage 14'ün kapısı: ilk döngü koşarken gelen İKİNCİ hedef
  it("KOŞAN (executing) proje ikinci hedefi kabul eder ve durumu geri sarmaz", async () => {
    const projectId = await mkProject("p11-executing", "executing", "ilk hedef");
    const res = await postGoal(projectId, "Saglik ucuna surum alani ekle ve testini guncelle.");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ started: true, state: "executing" });

    const [row] = await db
      .select({ status: projects.status })
      .from(projects)
      .where(and(eq(projects.companyId, companyId), eq(projects.id, projectId)));
    expect(row!.status).toBe("executing"); // planning'e geri sarılmadı
    expect(goalStarts.at(-1)).toMatchObject({ projectId });
  });

  it("kapanmış proje hedef almaz", async () => {
    const projectId = await mkProject("p11-archived", "archived", "bitti");
    const res = await postGoal(projectId, "Yeni bir sey yap.");
    expect(res.statusCode).toBe(409);
  });

  // stage 14'ün ikinci yarısı: kapı açılsa bile YENİ İŞ doğmalı
  it("routeIntake: aynı hedef replay'de aynı görevi, YENİ hedef YENİ goal ağacını verir", async () => {
    const ctx = companyContext(companyId);
    const projectsService = new ProjectsService(guardedDb);
    const projectId = await mkProject("p11-route", "planning", "ilk hedef metni");

    const first = await projectsService.routeIntake(ctx, projectId, {
      objective: "Saglik ucunu ekle.",
      reportArtifactId: null,
      findingsSummary: "ilk",
    });
    expect(first.created).toBe(true);

    // INVARIANT 15 — retry replay: aynı hedef metni YENİ görev doğurmaz
    const replay = await projectsService.routeIntake(ctx, projectId, {
      objective: "Saglik ucunu ekle.",
      reportArtifactId: null,
      findingsSummary: "ilk (replay)",
    });
    expect(replay.created).toBe(false);
    expect(replay.goalTaskId).toBe(first.goalTaskId);

    // P1-1: GERÇEKTEN yeni hedef → YENİ goal görevi
    const second = await projectsService.routeIntake(ctx, projectId, {
      objective: "Surum alani ekle.",
      reportArtifactId: null,
      findingsSummary: "ikinci",
    });
    expect(second.created).toBe(true);
    expect(second.goalTaskId).not.toBe(first.goalTaskId);

    const goals = await db
      .select({ id: tasks.id, objective: tasks.objective })
      .from(tasks)
      .where(
        and(
          eq(tasks.companyId, companyId),
          eq(tasks.projectId, projectId),
          eq(tasks.kind, "goal"),
        ),
      );
    expect(goals).toHaveLength(2);
    expect(goals.map((g) => g.objective).sort()).toEqual(
      ["Saglik ucunu ekle.", "Surum alani ekle."].sort(),
    );
  });
});
