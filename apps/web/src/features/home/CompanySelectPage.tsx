// Şirket seçimi / ilk kurulum ekranı.
//
// E2/W2 (2026-08-20): şirket açmanın TEK yüzeyi artık CreateCompanyModal.
// Burada eskiden ayrı bir form vardı ve yalnız POST /companies çağırıyordu —
// oradan açılan şirket KURUCU CEO'SUZ doğuyor, dolayısıyla üst çubuktaki
// "Founder ikonundan CEO'ya görev ver" düğmesi pasif kalıyor ve kullanıcı
// yeni şirkette hiçbir şey yapamıyordu (aynı boşluğun ikinci kapısı). İki
// giriş de aynı modale bağlandı: tek kod yolu, tek davranış.
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Button, Card, OrganizationIcon, CommandIcon } from "@acos/ui";
import { api, keys } from "../../lib/api.js";
import { CreateCompanyModal } from "../companies/CreateCompanyModal.js";

export function CompanySelectPage() {
  const companies = useQuery({ queryKey: keys.companies, queryFn: api.companies.list });
  const [open, setOpen] = useState(false);

  const isLoading = companies.isLoading;
  const hasCompanies = (companies.data?.length ?? 0) > 0;

  // A) Yükleme bitti ve hiç şirket yoksa: tam ekran karşılama + tek eylem.
  //
  // NOT: modal HER İKİ dalın DIŞINDA, tek bir yerde render edilir. Aksi hâlde
  // şirket açılır açılmaz liste dolduğu için sayfa B dalına geçiyor, modal
  // farklı bir konumda yeniden monte ediliyor ve "şirket açıldı / şirkete geç"
  // onay paneli kullanıcının gözü önünde kayboluyordu.
  const body = !isLoading && !hasCompanies ? (
      <main className="flex min-h-screen items-center justify-center bg-acos-bg0 p-6">
        <div className="w-full max-w-md space-y-6">
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-card border border-acos-line bg-acos-bg1">
              <CommandIcon className="h-7 w-7 text-accent-400" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-acos-fg0">ACOS&apos;a hoş geldiniz</h1>
              <p className="mt-1 text-sm text-acos-fg1">
                İlk şirketinizi oluşturarak başlayın — bir isim, kısa bir kimlik, para birimi ve
                işi devralacak kurucu CEO.
              </p>
            </div>
          </div>
          <Card title="Şirket oluştur" data-testid="company-wizard">
            <p className="text-sm text-acos-fg1">
              Şirketi açarken kurucu CEO&apos;yu da işe alırsanız ilk hedefinizi hemen
              verebilirsiniz; aksi hâlde şirket boş doğar ve önce bir yönetici işe almanız
              gerekir.
            </p>
            <Button
              onClick={() => setOpen(true)}
              className="mt-4 w-full justify-center"
              data-testid="company-create-open"
            >
              Şirketi oluştur ve başla
            </Button>
          </Card>
          <p className="text-center text-xs text-acos-fg2">
            Devam ederek ACOS içinde tek bir kuruluş alanı oluşturmuş olursunuz; daha sonra ek
            şirketler ekleyebilirsiniz.
          </p>
        </div>
      </main>
    ) : (
      // B) Şirket varken: başlık + grid + "yeni şirket ekle".
      <main className="mx-auto max-w-4xl space-y-6 p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-acos-fg0">Şirketleriniz</h1>
          <p className="mt-0.5 text-sm text-acos-fg1">
            Yönetmek istediğiniz şirketi seçin veya yeni bir şirket ekleyin.
          </p>
        </div>
        <Button onClick={() => setOpen(true)} data-testid="company-create-open">
          Yeni şirket ekle
        </Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-acos-fg2">Yükleniyor…</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="company-list">
          {companies.data?.map((company) => (
            <Link key={company.id} to="/c/$companyId" params={{ companyId: company.id }}>
              <Card className="h-full transition-colors hover:border-accent-400 hover:bg-acos-bg2">
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-acos-line bg-acos-bg2">
                    <OrganizationIcon className="h-5 w-5 text-accent-400" />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-acos-fg0">{company.name}</p>
                    <p className="truncate text-sm text-acos-fg1">/{company.slug}</p>
                  </div>
                </div>
                <div className="mt-4 flex items-center gap-2 border-t border-acos-line pt-3 text-xs text-acos-fg2">
                  <span className="rounded-full border border-acos-line bg-acos-bg2 px-2 py-0.5">
                    {company.currency}
                  </span>
                  <span className="rounded-full border border-acos-line bg-acos-bg2 px-2 py-0.5">
                    {company.role}
                  </span>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}

    </main>
  );

  return (
    <>
      {body}
      <CreateCompanyModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}
