// Görsel QA: ofis başlığındaki direktif düğmesi ve CEO kartı.
//
// Pikseller assert edilmiyor (GPU sürücüsüne bağlı olurdu); ekran görüntüsü
// test artefaktı olarak bırakılıyor. Bu oturumda hafıza galaksisinde tam bu
// boşluk yüzünden bütün düğümler siyah çıktığı hâlde testler yeşil kalmıştı.
import { test } from "@playwright/test";
import { login, openCompany } from "./helpers";

test("ofis: CEO'ya görev ver düğmesi ve ajan kartı", async ({ page }) => {
  test.setTimeout(120_000);

  await login(page);
  await openCompany(page, "Acme");
  await page.getByTestId("nav-office").click();
  await page.getByTestId("office-directive-button").waitFor({ timeout: 20_000 });
  await page.waitForTimeout(2000); // sprite atlası + ilk kareler

  const shot = test.info().outputPath("office-directive.png");
  await page.screenshot({ path: shot });
  await test.info().attach("office-directive", { path: shot, contentType: "image/png" });

  // Yakın kare: CEO halkası genel görünümde birkaç piksel; doğru yerde olup
  // olmadığı ancak bu ölçekte anlaşılıyor.
  const canvas = page.locator("canvas").first();
  await canvas.hover();
  for (let i = 0; i < 7; i += 1) await page.mouse.wheel(0, -240);
  await page.waitForTimeout(900);
  const zoom = test.info().outputPath("office-ceo-zoom.png");
  await canvas.screenshot({ path: zoom });
  await test.info().attach("office-ceo-zoom", { path: zoom, contentType: "image/png" });
});
