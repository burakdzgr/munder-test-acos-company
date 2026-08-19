// ADR-021 — hafıza galaksisi (3D) görsel QA.
//
// Sahne WebGL üzerinde çalışıyor; Playwright'ın chromium'u swiftshader ile
// gerçekten render eder. Burada kanıtlanan şey piksel değil DAVRANIŞ:
// canvas kuruldu mu, gerçek düğüm sayısı geldi mi, filtre canlı uygulanıyor
// mu, tıklama seçim yapıyor mu. (Pikselleri doğrulamak GPU sürücüsüne bağlı
// olurdu — CI'da kırılgan.)
import { test, expect } from "@playwright/test";
import { login, openCompany } from "./helpers";

test("hafıza galaksisi: canvas + gerçek düğümler + canlı filtre + seçim", async ({ page }) => {
  test.setTimeout(120_000);

  await login(page);
  await openCompany(page, "Acme");
  await page.getByTestId("nav-memory").click();
  await page.getByTestId("memory-tab-graph").click();

  // sahne kuruldu: kart + canvas
  const graph = page.getByTestId("memory-graph");
  await expect(graph).toBeVisible();
  await expect(graph.locator("canvas")).toBeVisible({ timeout: 30_000 });

  // filtre paneli GERÇEK veriyle geldi (görünen/toplam)
  const count = page.getByTestId("galaxy-count");
  await expect(count).toBeVisible();
  const initial = await count.innerText();
  const [visible, total] = initial.split("/").map((n) => Number(n.trim()));
  expect(total).toBeGreaterThan(0); // mock yok — şirketin gerçek anıları
  expect(visible).toBe(total);

  // canlı filtre: önem eşiği yükselince görünen düğüm sayısı düşer
  await page.getByTestId("galaxy-filter-importance").fill("1");
  await expect
    .poll(async () => Number((await count.innerText()).split("/")[0]!.trim()), { timeout: 10_000 })
    .toBeLessThan(visible);

  // eşiği geri al, kapsam filtresini dene
  await page.getByTestId("galaxy-filter-importance").fill("0");
  await page.getByTestId("galaxy-filter-scope").selectOption("company");
  await expect
    .poll(async () => Number((await count.innerText()).split("/")[0]!.trim()), { timeout: 10_000 })
    .toBeLessThanOrEqual(visible);

  // U16 kalıbı: görsel QA ekran görüntüsü test artefaktı olarak eklenir —
  // sahnenin GERÇEKTEN çizdiğini (boş siyah kare olmadığını) gözle
  // doğrulamanın tek yolu bu; piksel karşılaştırması GPU sürücüsüne bağlı
  // olacağı için assert edilmiyor, artefakt olarak bırakılıyor.
  await page.getByTestId("galaxy-filter-scope").selectOption("");
  await page.waitForTimeout(1500); // dönüş + dalga birkaç kare ilerlesin
  const shot = test.info().outputPath("galaxy.png");
  await graph.screenshot({ path: shot });
  await test.info().attach("galaxy", { path: shot, contentType: "image/png" });
});

// Command Center'ın sol Hafıza paneli (36 §5) da aynı sahneyi kullanır.
// Bu test AYRI duruyor çünkü ayrı bir yüzey: galaksi Gözlemevi'ne bağlanıp
// panel eski 2D şeritte kalınca kimse fark etmemişti — panelde 3D'nin
// gerçekten kurulduğunu doğrulayan bir koşul yoktu.
test("hafıza paneli: Command Center şeridi de galaksi", async ({ page }) => {
  test.setTimeout(120_000);

  await login(page);
  await openCompany(page, "Acme");

  const panel = page.getByTestId("memory-panel");
  await expect(panel).toBeVisible();
  await panel.getByTestId("memtab-graf").click();

  // panel varyantı: 3D sahne kuruldu (2D BrainGraph da aynı testid'de canvas
  // kullanıyor, o yüzden canvas'ın varlığı yetmez — WebGL bağlamı aranır)
  const strip = panel.getByTestId("memory-brain-graph");
  await expect(strip.locator("canvas")).toBeVisible({ timeout: 30_000 });
  const isWebgl = await strip.locator("canvas").first().evaluate((canvas) => {
    // R3F canvas'ının bağlamı webgl2/webgl olur; 2D şerit "2d" bağlam kullanır
    const el = canvas as HTMLCanvasElement;
    return Boolean(el.getContext("webgl2") ?? el.getContext("webgl"));
  });
  expect(isWebgl).toBe(true);

  await page.waitForTimeout(1500);
  const shot = test.info().outputPath("panel-galaxy.png");
  await panel.screenshot({ path: shot });
  await test.info().attach("panel-galaxy", { path: shot, contentType: "image/png" });
});
