// Ofis görsel QA (23 §5, 36 §U04/U15). Davranışı 05-office-live doğruluyor;
// buradaki tek iş, sahnenin GERÇEKTEN çizdiğini gözle görülebilir kılmak:
// pikseller assert edilmiyor (GPU sürücüsüne bağlı olurdu), ekran görüntüsü
// test artefaktı olarak bırakılıyor. Hafıza galaksisinde tam bu boşluk
// yüzünden tüm düğümler siyah çıktığı hâlde testler yeşil kalmıştı.
import { test, expect } from "@playwright/test";
import { login, openCompany } from "./helpers";

test("ofis: zemin + odalar + avatarlar çizildi", async ({ page }) => {
  test.setTimeout(120_000);

  await login(page);
  await openCompany(page, "Acme");
  // E1 tek ekran: nav sekme satırı yok — görünümler panel açıcıdan gelir.
  await page.getByTestId("panel-launcher").click();
  await page.getByTestId("nav-office").click();
  await expect(page.getByTestId("office-agent-count")).toBeVisible({ timeout: 20_000 });
  await page.waitForFunction(() => (window.__acosOffice?.agentCount ?? 0) > 0, undefined, {
    timeout: 20_000,
  });

  // sprite atlası + ilk kareler yerleşsin
  await page.waitForTimeout(2500);

  const shot = test.info().outputPath("office.png");
  await page.screenshot({ path: shot });
  await test.info().attach("office", { path: shot, contentType: "image/png" });

  // Yakın kare: genel görünümde bir masa ~40px ve piksel sanatının doğru
  // hizalanıp hizalanmadığı o ölçekte anlaşılmıyor. Tekerlekle yakınlaşıp
  // ikinci bir kare bırakıyoruz — kusur ancak burada görülüyor.
  const canvas = page.locator("canvas").first();
  await canvas.hover();
  for (let i = 0; i < 6; i += 1) await page.mouse.wheel(0, -240);
  await page.waitForTimeout(800);
  const zoom = test.info().outputPath("office-zoom.png");
  await canvas.screenshot({ path: zoom });
  await test.info().attach("office-zoom", { path: zoom, contentType: "image/png" });
});
