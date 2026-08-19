import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button, Card, Dialog, Field, Input, Select, OrganizationIcon, CommandIcon } from "@acos/ui";
import { api, keys, queryClient } from "../../lib/api.js";

const CURRENCIES = [
  { value: "USD", label: "USD — Amerikan Doları" },
  { value: "EUR", label: "EUR — Euro" },
  { value: "TRY", label: "TRY — Türk Lirası" },
];

function CompanyForm({
  name,
  slug,
  currency,
  onNameChange,
  onSlugChange,
  onCurrencyChange,
  onSubmit,
  isPending,
  isError,
  error,
  submitLabel,
}: {
  name: string;
  slug: string;
  currency: string;
  onNameChange: (value: string) => void;
  onSlugChange: (value: string) => void;
  onCurrencyChange: (value: string) => void;
  onSubmit: () => void;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  submitLabel: string;
}) {
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <Field label="Şirket adı">
        <Input
          name="companyName"
          placeholder="ör. Acme A.Ş."
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          required
        />
      </Field>
      <Field label="Slug (kebab-case)">
        <Input
          name="companySlug"
          placeholder="ör. acme"
          value={slug}
          pattern="[a-z0-9][a-z0-9-]*"
          onChange={(e) => onSlugChange(e.target.value)}
          required
        />
      </Field>
      <Field label="Para birimi">
        <Select
          name="companyCurrency"
          value={currency}
          onChange={(e) => onCurrencyChange(e.target.value)}
        >
          {CURRENCIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </Select>
      </Field>
      {isError && <p className="text-sm text-danger">{String(error)}</p>}
      <Button type="submit" disabled={isPending} className="w-full justify-center">
        {isPending ? "Oluşturuluyor…" : submitLabel}
      </Button>
    </form>
  );
}

export function CompanySelectPage() {
  const navigate = useNavigate();
  const companies = useQuery({ queryKey: keys.companies, queryFn: api.companies.list });
  const [open, setOpen] = useState(false);

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [currency, setCurrency] = useState("USD");

  const [wizardName, setWizardName] = useState("");
  const [wizardSlug, setWizardSlug] = useState("");
  const [wizardCurrency, setWizardCurrency] = useState("USD");

  const create = useMutation({
    mutationFn: () => api.companies.create({ name, slug, currency }),
    onSuccess: async (company) => {
      await queryClient.invalidateQueries({ queryKey: keys.companies });
      setOpen(false);
      setName("");
      setSlug("");
      setCurrency("USD");
      await navigate({ to: "/c/$companyId", params: { companyId: company.id } });
    },
  });

  const createFromWizard = useMutation({
    mutationFn: () => api.companies.create({ name: wizardName, slug: wizardSlug, currency: wizardCurrency }),
    onSuccess: async (company) => {
      await queryClient.invalidateQueries({ queryKey: keys.companies });
      await navigate({ to: "/c/$companyId", params: { companyId: company.id } });
    },
  });

  const isLoading = companies.isLoading;
  const hasCompanies = (companies.data?.length ?? 0) > 0;

  // A) Yükleme bitti ve hiç şirket yoksa: tam ekran kurulum sihirbazı.
  if (!isLoading && !hasCompanies) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-acos-bg0 p-6">
        <div className="w-full max-w-md space-y-6">
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-card border border-acos-line bg-acos-bg1">
              <CommandIcon className="h-7 w-7 text-accent-400" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-acos-fg0">ACOS'a hoş geldiniz</h1>
              <p className="mt-1 text-sm text-acos-fg1">
                İlk şirketinizi oluşturarak başlayın — kuracağınız yapıya bir isim, kısa bir kimlik
                ve bir para birimi verin.
              </p>
            </div>
          </div>
          <Card title="Şirket oluştur" data-testid="company-wizard">
            <CompanyForm
              name={wizardName}
              slug={wizardSlug}
              currency={wizardCurrency}
              onNameChange={setWizardName}
              onSlugChange={setWizardSlug}
              onCurrencyChange={setWizardCurrency}
              onSubmit={() => createFromWizard.mutate()}
              isPending={createFromWizard.isPending}
              isError={createFromWizard.isError}
              error={createFromWizard.error}
              submitLabel="Şirketi oluştur ve başla"
            />
          </Card>
          <p className="text-center text-xs text-acos-fg2">
            Devam ederek ACOS içinde tek bir kuruluş alanı oluşturmuş olursunuz; daha sonra ek
            şirketler ekleyebilirsiniz.
          </p>
        </div>
      </main>
    );
  }

  // B) Şirket varken: başlık + grid + "yeni şirket ekle" dialog'u.
  return (
    <main className="mx-auto max-w-4xl space-y-6 p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-acos-fg0">Şirketleriniz</h1>
          <p className="mt-0.5 text-sm text-acos-fg1">
            Yönetmek istediğiniz şirketi seçin veya yeni bir şirket ekleyin.
          </p>
        </div>
        <Button onClick={() => setOpen(true)}>Yeni şirket ekle</Button>
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

      <Dialog open={open} title="Şirket oluştur" onClose={() => setOpen(false)}>
        <CompanyForm
          name={name}
          slug={slug}
          currency={currency}
          onNameChange={setName}
          onSlugChange={setSlug}
          onCurrencyChange={setCurrency}
          onSubmit={() => create.mutate()}
          isPending={create.isPending}
          isError={create.isError}
          error={create.error}
          submitLabel="Oluştur"
        />
      </Dialog>
    </main>
  );
}
