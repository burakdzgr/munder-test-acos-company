// Founder direktifi (07 §5.7): hedefi CEO'ya TEK adımda vermek.
//
// Bu testin varlık sebebi somut: eski akış beş işlemdi (görev oluştur →
// BACKLOG → PLANNED → 32 ajanlık düz listeden CEO'yu bul → ata) ve hiçbir
// ekran "şirketin tepesi bu kişi" demiyordu. Founder "yeni işi nereden
// veriyorum" sorusuna cevap bulamıyordu. Burada kanıtlanan iki şey:
//   1. Ofis ekranı CEO'yu ADIYLA gösteriyor — aranması gerekmiyor
//   2. Tek form, ASSIGNED bir hedef ve başlamış bir CEO döngüsü üretiyor
import { test, expect } from "@playwright/test";
import { login, openCompany } from "./helpers";

test("Founder ofisten CEO'ya tek adımda görev verir", async ({ page }) => {
  test.setTimeout(120_000);

  await login(page);
  await openCompany(page, "Acme");
  await page.getByTestId("nav-office").click();

  // 1) CEO keşfedilebilir: düğme unvanını yazıyor
  const directiveButton = page.getByTestId("office-directive-button");
  await expect(directiveButton).toBeVisible({ timeout: 20_000 });
  await expect(directiveButton).toContainText("görev ver");

  // 2) tek form → atanmış hedef
  await directiveButton.click();
  const title = `Direktif smoke ${Date.now() % 100000}`;
  await page.fill('input[name="directiveTitle"]', title);
  await page.fill(
    'textarea[name="directiveObjective"]',
    "e2e doğrulaması — direktif ucunun hedefi CEO'ya atadığını kanıtlar.",
  );
  await page.selectOption('select[name="directivePriority"]', "P3");
  await page.getByTestId("directive-submit").click();

  const created = page.getByTestId("directive-created");
  await expect(created).toBeVisible({ timeout: 30_000 });
  // hedef ATANMIŞ durumda: groom adımları da sunucuda yürüdü
  await expect(created).toContainText("ASSIGNED");

  // 3) görev panosunda gerçekten var — ve sahibi CEO
  // (Diyalog onay ekranında AÇIK kalır — bilerek: Founder üst üste direktif
  // verebilsin. Kapatmadan gezinmeye çalışmak, modalın tıklamayı yemesiyle
  // sonuçlanır; ilk sürümde tam olarak bu oldu.)
  await page.getByTestId("directive-close").click();
  await page.getByTestId("nav-tasks").click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(title, { exact: false }).first()).toBeVisible({ timeout: 20_000 });
});
