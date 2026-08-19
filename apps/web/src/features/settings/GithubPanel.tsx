// GitHub bağlantısı (2026-08-18, Founder kararı): PAT'i şirkete bağla —
// ajanların merge ettiği her iş, Founder'ın hesabındaki private repoya
// otomatik yayınlanır (repo yoksa açılır). Token sunucuda MASTER_KEY ile
// mühürlenir (S2); bu panel tokenı asla geri OKUMAZ, yalnız durumu gösterir.
import { useState } from "react";
import { useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Field, Input } from "@acos/ui";
import { api } from "../../lib/api.js";

export function GithubPanel() {
  const { companyId } = useParams({ from: "/c/$companyId" });
  const queryClient = useQueryClient();
  const [token, setToken] = useState("");
  const [note, setNote] = useState<string | null>(null);

  const status = useQuery({
    queryKey: [companyId, "github"],
    queryFn: () => api.integrations.github.status(companyId),
  });

  const connect = useMutation({
    mutationFn: () => api.integrations.github.connect(companyId, token.trim()),
    onSuccess: (s) => {
      setToken("");
      setNote(`Bağlandı: ${s.owner} — bundan sonra merge edilen işler otomatik yayınlanır.`);
      void queryClient.invalidateQueries({ queryKey: [companyId, "github"] });
    },
    onError: (err) => setNote(`Bağlanamadı: ${String(err)}`),
  });

  const disconnect = useMutation({
    mutationFn: () => api.integrations.github.disconnect(companyId),
    onSuccess: () => {
      setNote("Bağlantı kesildi.");
      void queryClient.invalidateQueries({ queryKey: [companyId, "github"] });
    },
  });

  const s = status.data;
  return (
    <Card title="GitHub">
      {s?.connected ? (
        <div className="space-y-3">
          <p className="text-sm text-acos-fg0">
            <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-[#2ec26a]" />
            Bağlı: <span className="font-mono font-semibold">{s.owner}</span>
          </p>
          <p className="text-xs text-acos-fg2">
            Ajanların merge ettiği her iş, bu hesapta projenin private reposuna otomatik itilir
            (repo yoksa açılır). Elle yayın: Projeler sekmesindeki proje detayından.
          </p>
          <Button
            variant="danger"
            onClick={() => disconnect.mutate()}
            disabled={disconnect.isPending}
            data-testid="github-disconnect"
          >
            Bağlantıyı kes
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-acos-fg2">
            Tam yetki için <span className="font-mono">repo</span> scope'lu bir{" "}
            <a
              href="https://github.com/settings/tokens"
              target="_blank"
              rel="noreferrer"
              className="text-dept-engineering underline"
            >
              Personal Access Token
            </a>{" "}
            oluşturup yapıştır. Token sunucuda şifrelenerek saklanır, bir daha görüntülenmez.
          </p>
          <Field label="Personal Access Token">
            <Input
              type="password"
              value={token}
              onChange={(e) => {
                setToken(e.target.value);
                setNote(null);
              }}
              placeholder="ghp_… / github_pat_…"
              data-testid="github-token-input"
            />
          </Field>
          <Button
            onClick={() => connect.mutate()}
            disabled={token.trim().length < 20 || connect.isPending}
            data-testid="github-connect"
          >
            {connect.isPending ? "Doğrulanıyor…" : "Bağla"}
          </Button>
        </div>
      )}
      {note && <p className="mt-3 text-xs text-acos-fg1">{note}</p>}
    </Card>
  );
}
