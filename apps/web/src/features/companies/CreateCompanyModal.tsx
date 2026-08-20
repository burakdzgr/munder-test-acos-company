// E2/W2 — "Yeni şirket aç" (2026-08-20, Founder isteği).
//
// Neden var: sunucuda POST /api/v1/companies HAZIRDI ama arayüzde hiçbir
// giriş yoktu — şirket ancak seed ile doğuyordu. Founder "yeni şirket açacak
// ekran yok" dedi; eksik olan tek parça buydu.
//
// İkinci yarısı daha önemli: yeni şirket BOŞ doğar (provisionCompanyDefaults
// yalnız model yönlendirme + bütçe + arama kimliği kurar; org birimi, pozisyon
// ve ajan YOK). Bu yüzden tepe yönetici sorgusu 404 döner ve E1'de eklediğim
// üst çubuk düğmesi pasif kalır — Founder yeni şirkete GÖREV VEREMEZ. Burada
// isteğe bağlı KURUCU CEO açılışı var: üç mevcut uçla (org birimi → pozisyon
// → ajan) tek akışta yönetim birimi, defaultRole=executive pozisyonu ve
// YÖNETİCİSİ OLMAYAN bir ajan yaratılır. topExecutive tam olarak bunu arar
// (ProjectsService.topExecutive: aktif + executive + reports_to kenarı yok).
import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AcosApiError } from "@acos/contracts/client";
import { Button, Dialog, Field, Input, Select } from "@acos/ui";
import { api, keys } from "../../lib/api.js";

const TR_MAP: Record<string, string> = {
  "ç": "c",
  "Ç": "c",
  "ğ": "g",
  "Ğ": "g",
  "ı": "i",
  "I": "i",
  "İ": "i",
  "ö": "o",
  "Ö": "o",
  "ş": "s",
  "Ş": "s",
  "ü": "u",
  "Ü": "u",
};

/** Ad → sunucunun kabul ettiği slug (^[a-z0-9][a-z0-9-]*$). */
export function slugify(name: string): string {
  return name
    .split("")
    .map((ch) => TR_MAP[ch] ?? ch)
    .join("")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

type Step = "form" | "company" | "org" | "done";

export function CreateCompanyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [currency, setCurrency] = useState("USD");
  const [withCeo, setWithCeo] = useState(true);
  const [ceoName, setCeoName] = useState("Aylin Vural");
  const [step, setStep] = useState<Step>("form");
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; name: string; ceo: string | null } | null>(
    null,
  );

  useEffect(() => {
    if (!slugTouched) setSlug(slugify(name));
  }, [name, slugTouched]);

  const submit = useMutation({
    mutationFn: async () => {
      setError(null);
      setWarning(null);
      setStep("company");
      const company = await api.companies.create({
        name: name.trim(),
        slug: slug.trim(),
        currency,
      });
      let ceo: string | null = null;
      if (withCeo && ceoName.trim()) {
        setStep("org");
        try {
          const unit = await api.org.createUnit(company.id, {
            name: "Yönetim",
            slug: "yonetim",
            kind: "department",
          });
          const position = await api.org.createPosition(company.id, {
            title: "CEO",
            seniorityTrack: ["expert"],
            defaultRole: "executive",
            description: "Şirketin tepe yöneticisi; hedefi ekibine kırar ve delege eder.",
          });
          const agent = await api.agents.hire(company.id, {
            name: ceoName.trim(),
            positionId: position.id,
            orgUnitId: unit.id,
            seniority: "expert",
            autonomyLevel: 3,
            persona:
              "Kararlı bir CEO; Founder hedefini alır, yöneticilerine delege eder, tek tek işleri kendisi yapmaz.",
            leadsUnit: true,
            activate: true,
          });
          ceo = agent.name;
        } catch (err) {
          // şirket AÇILDI; CEO adımı ayrı bir hata — kullanıcı yarı yolda kalmasın
          setWarning(
            `Şirket açıldı ama kurucu CEO işe alınamadı: ${
              err instanceof AcosApiError ? err.problem.detail : String(err)
            } — "+ Ajan Ekle" ile elle işe alabilirsiniz.`,
          );
        }
      }
      return { company, ceo };
    },
    onSuccess: async ({ company, ceo }) => {
      setStep("done");
      setCreated({ id: company.id, name: company.name, ceo });
      await queryClient.invalidateQueries({ queryKey: keys.companies });
    },
    onError: (err) => {
      setStep("form");
      setError(
        err instanceof AcosApiError ? `${err.problem.code}: ${err.problem.detail}` : String(err),
      );
    },
  });

  if (!open) return null;

  const slugValid = /^[a-z0-9][a-z0-9-]*$/.test(slug);
  const busy = submit.isPending;

  function finish(companyId: string) {
    onClose();
    setCreated(null);
    setName("");
    setSlug("");
    setSlugTouched(false);
    void navigate({ to: "/c/$companyId", params: { companyId } });
  }

  return (
    <Dialog open onClose={busy ? () => undefined : onClose} title="Yeni şirket aç">
      <div className="space-y-3" data-testid="create-company-modal">
        {created ? (
          <div
            className="rounded-md border border-acos-line bg-acos-bg2 p-3 text-xs text-acos-fg1"
            data-testid="company-created"
          >
            <p className="font-medium text-acos-fg0">{created.name} açıldı.</p>
            <p className="mt-1 text-acos-fg2">
              {created.ceo
                ? `${created.ceo} CEO olarak işe alındı — üst çubuktaki kişi ikonundan ilk hedefi verebilirsiniz.`
                : "Şirket boş: görev verebilmek için önce bir CEO işe alın (+ Ajan Ekle)."}
            </p>
            {warning && <p className="mt-2 text-[11px] text-acos-fg1">{warning}</p>}
            <div className="mt-3 flex gap-2">
              <Button onClick={() => finish(created.id)} data-testid="company-created-open">
                Şirkete geç
              </Button>
              <Button variant="ghost" onClick={onClose}>
                Kapat
              </Button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-xs text-acos-fg2">
              Şirket kendi ajanları, projeleri ve bütçesiyle ayrı bir dünyadır. Kurucu CEO'yu
              şimdi işe alırsanız hedef vermeye hemen başlayabilirsiniz.
            </p>
            <Field label="Şirket adı">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                name="companyName"
                placeholder="Örn. Webicrea"
                data-testid="company-name"
              />
            </Field>
            <Field label="Kısa ad (slug)">
              <Input
                value={slug}
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(e.target.value);
                }}
                name="companySlug"
                placeholder="webicrea"
                data-testid="company-slug"
              />
              {!slugValid && slug.length > 0 && (
                <p className="mt-1 text-[10px] text-danger">
                  Yalnız küçük harf, rakam ve tire; harf veya rakamla başlamalı.
                </p>
              )}
            </Field>
            <div className="w-32">
              <Field label="Para birimi">
                <Select
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  name="companyCurrency"
                >
                  {["USD", "EUR", "TRY", "GBP"].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </Select>
              </Field>
            </div>

            <label className="flex items-center gap-2 text-[11.5px] text-acos-fg1">
              <input
                type="checkbox"
                checked={withCeo}
                onChange={(e) => setWithCeo(e.target.checked)}
                data-testid="company-with-ceo"
              />
              Kurucu CEO&apos;yu da işe al (önerilir)
            </label>
            {withCeo && (
              <Field label="CEO adı">
                <Input
                  value={ceoName}
                  onChange={(e) => setCeoName(e.target.value)}
                  name="companyCeoName"
                  data-testid="company-ceo-name"
                />
              </Field>
            )}

            {error && (
              <p
                className="rounded bg-danger/10 px-2 py-1 text-xs text-danger"
                data-testid="company-create-error"
              >
                {error}
              </p>
            )}

            <div className="flex items-center justify-end gap-2">
              {busy && (
                <span className="mr-auto text-[10.5px] text-acos-fg2">
                  {step === "company" ? "şirket açılıyor…" : "kurucu CEO işe alınıyor…"}
                </span>
              )}
              <Button variant="ghost" onClick={onClose} disabled={busy}>
                Vazgeç
              </Button>
              <Button
                disabled={!name.trim() || !slugValid || busy}
                onClick={() => submit.mutate()}
                data-testid="company-create-submit"
              >
                {busy ? "Açılıyor…" : "Şirketi aç"}
              </Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
