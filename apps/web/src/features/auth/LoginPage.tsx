import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Button, Card, Field, Input } from "@acos/ui";
import { api } from "../../lib/api.js";

export function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const setupStatus = useQuery({ queryKey: ["setup-status"], queryFn: api.auth.setupStatus });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.auth.login({
        email,
        password,
        ...(totpCode !== "" && { totpCode }),
      });
      if (result.totpRequired) {
        setNeedsTotp(true);
        return;
      }
      await navigate({ to: "/" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "giriş başarısız");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-ink-50 p-4">
      <div className="w-full max-w-sm space-y-4">
        <h1 className="text-center text-2xl font-bold text-ink-900">ACOS</h1>
        <Card title="Giriş yap">
          <form onSubmit={submit} className="space-y-3">
            <Field label="E-posta">
              <Input
                name="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                required
              />
            </Field>
            <Field label="Parola">
              <Input
                name="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </Field>
            {needsTotp && (
              <Field label="Doğrulayıcı kodu">
                <Input
                  name="totpCode"
                  inputMode="numeric"
                  pattern="\d{6}"
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value)}
                  required
                />
              </Field>
            )}
            {error && <p className="text-sm text-danger">{error}</p>}
            <Button type="submit" disabled={busy} className="w-full justify-center">
              {busy ? "Giriş yapılıyor…" : "Giriş yap"}
            </Button>
          </form>
        </Card>
        {setupStatus.data?.needed && (
          <p className="text-center text-sm text-ink-600">
            İlk kurulum mu?{" "}
            <a href="/setup" className="text-accent-600 underline">
              Founder hesabını oluştur
            </a>
          </p>
        )}
      </div>
    </main>
  );
}
