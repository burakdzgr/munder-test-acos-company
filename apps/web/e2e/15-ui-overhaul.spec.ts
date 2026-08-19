// U16 (36 §12/§13): UI-overhaul visual QA — preset screenshots, office
// spawn animation smoke through the __acosOffice debug hook (EVERY visible
// animation must trace to a causeEventId — N2/DoD), FPS smoke, responsive
// degrade under 1100px (N7) and the no-WebGL DOM fallback (23 §15).
import { expect, test } from "@playwright/test";
import { login, openCompany } from "./helpers";

declare global {
  interface Window {
    __acosOffice?: {
      lastAppliedEventId: string | null;
      agentCount: number;
      interactionCount: number;
      snapshotCount: number;
      debugRing: unknown[];
    };
  }
}

async function landCommandCenter(page: import("@playwright/test").Page): Promise<string> {
  await login(page);
  await openCompany(page, "Acme Technologies");
  await expect(page.getByTestId("command-center")).toBeVisible({ timeout: 15_000 });
  return page.url().match(/\/c\/([0-9a-f-]{36})/)![1]!;
}

test("layout presets build their arrangements (screenshots attached)", async ({ page }, testInfo) => {
  await landCommandCenter(page);
  await page.waitForTimeout(2000);
  await testInfo.attach("preset-default", {
    body: await page.screenshot(),
    contentType: "image/png",
  });

  // Operations: office-centric
  await page.getByTestId("layout-presets").getByText("Ops", { exact: true }).click();
  await expect(page.getByTestId("office-panel")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1200);
  await testInfo.attach("preset-operations", {
    body: await page.screenshot(),
    contentType: "image/png",
  });

  // Engineering: terminals + tasks big (tasks on its own row)
  await page.getByTestId("layout-presets").getByText("Eng", { exact: true }).click();
  await expect(page.getByTestId("task-board")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1200);
  await testInfo.attach("preset-engineering", {
    body: await page.screenshot(),
    contentType: "image/png",
  });

  // Overview: costs + approvals + reports front and center
  await page.getByTestId("layout-presets").getByText("Genel", { exact: true }).click();
  await expect(page.getByTestId("costs-total")).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1200);
  await testInfo.attach("preset-overview", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});

test("office spawn smoke: hire walks in; every instruction carries a causeEventId", async ({
  page,
}) => {
  const companyId = await landCommandCenter(page);
  await expect(page.getByTestId("office-canvas")).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(2500); // presence snapshot + sprite atlas

  const before = await page.evaluate(() => ({
    agents: window.__acosOffice?.agentCount ?? 0,
    ring: window.__acosOffice?.debugRing.length ?? 0,
  }));

  // hire through the API — the projector emits the walk-in choreography
  const csrf = (await page.context().cookies()).find((c) => c.name === "acos_csrf")?.value ?? "";
  const headers = { "x-csrf-token": csrf };
  const units = (await (
    await page.request.get(`/api/v1/companies/${companyId}/org/units`)
  ).json()) as Array<{ id: string; kind: string }>;
  const positions = (await (
    await page.request.get(`/api/v1/companies/${companyId}/org/positions`)
  ).json()) as Array<{ id: string }>;
  const hired = await page.request.post(`/api/v1/companies/${companyId}/agents`, {
    headers,
    data: {
      name: `Spawn Smoke ${Date.now() % 100000}`,
      positionId: positions[0]!.id,
      orgUnitId: (units.find((u) => u.kind === "team") ?? units[0]!).id,
      seniority: "mid",
      autonomyLevel: 2,
      persona: "U16 spawn smoke.",
      activate: true,
      avatarId: "av09",
    },
  });
  expect(hired.ok()).toBe(true);

  // the avatar spawns + at least one office.* instruction arrives live
  await expect
    .poll(() => page.evaluate(() => window.__acosOffice?.agentCount ?? 0), { timeout: 20_000 })
    .toBeGreaterThan(before.agents);
  await expect
    .poll(() => page.evaluate(() => window.__acosOffice?.debugRing.length ?? 0), {
      timeout: 20_000,
    })
    .toBeGreaterThan(before.ring);

  // N2 audit: EVERY instruction in the debug ring traces to a causeEventId
  const ring = (await page.evaluate(() => window.__acosOffice?.debugRing ?? [])) as Array<{
    type?: string;
    causeEventId?: unknown;
  }>;
  expect(ring.length).toBeGreaterThan(0);
  for (const instruction of ring) {
    expect(typeof instruction.causeEventId).toBe("string");
    expect((instruction.causeEventId as string).length).toBeGreaterThan(0);
  }
  expect(await page.evaluate(() => window.__acosOffice?.lastAppliedEventId)).toBeTruthy();
});

test("office FPS smoke stays interactive", async ({ page }) => {
  await landCommandCenter(page);
  await expect(page.getByTestId("office-canvas")).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(2000);
  const fps = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let frames = 0;
        const start = performance.now();
        const tick = () => {
          frames += 1;
          if (performance.now() - start < 2000) requestAnimationFrame(tick);
          else resolve(frames / 2);
        };
        requestAnimationFrame(tick);
      }),
  );
  // smoke floor; the 60fps budget is the target. CI runners are 2-core with
  // software GL and legitimately hover ~26fps — the floor there only guards
  // against real regressions (single-digit fps), not runner variance.
  expect(fps).toBeGreaterThan(process.env.CI ? 18 : 30);
});

test("degrades to a usable layout under 1100px (N7)", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await landCommandCenter(page);
  await expect(page.getByTestId("me-name")).toBeVisible();
  await expect(page.getByTestId("topbar-hire")).toBeVisible();
  await expect(page.getByTestId("status-bar")).toBeVisible();
  // no horizontal document overflow — panels manage their own scrolling
  const fits = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 2,
  );
  expect(fits).toBe(true);
});

test("no-WebGL still renders the office (Pixi canvas degrade, 23 §15)", async ({ page }) => {
  // kill webgl/webgl2 + webgpu: Pixi v8 degrades to its Canvas2D renderer —
  // the floor still renders (verified: the created context is "2d")
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type: string, ...args: unknown[]) {
      if (typeof type === "string" && type.includes("webgl")) return null;
      return original.call(this, type as never, ...(args as never[]));
    } as typeof original;
    Object.defineProperty(navigator, "gpu", { get: () => undefined });
  });
  await landCommandCenter(page);
  await expect(page.locator('[data-testid="office-canvas"] canvas')).toBeVisible({
    timeout: 20_000,
  });
  const contextIs2d = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      '[data-testid="office-canvas"] canvas',
    );
    return canvas !== null && canvas.getContext("2d") !== null;
  });
  expect(contextIs2d).toBe(true);
});

test("total canvas failure falls back to the DOM office list (23 §15)", async ({ page }) => {
  // no context of ANY kind → Pixi init throws → OfficeCanvas catch → DOM list
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type: string, ...args: unknown[]) {
      if (typeof type === "string" && (type.includes("webgl") || type === "2d")) return null;
      return original.call(this, type as never, ...(args as never[]));
    } as typeof original;
    Object.defineProperty(navigator, "gpu", { get: () => undefined });
  });
  await landCommandCenter(page);
  await expect(page.getByTestId("office-fallback")).toBeVisible({ timeout: 20_000 });
});
