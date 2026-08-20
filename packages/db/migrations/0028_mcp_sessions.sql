-- E4/A (T30): MCP oturum jetonu — ajan konteynerine ASLA şirket anahtarı girmez.
--
-- Claude Code CLI ajanın turunu konteynerde koşturuyor ve ACOS eylemlerine MCP
-- üzerinden ulaşıyor. Ulaşırken bir kimlik taşıması gerek. En ucuz yol
-- INTERNAL_API_TOKEN'ı konteynere vermekti; o jeton ŞİRKET ÇAPINDA ana
-- anahtardır — kutudan bir kaçış, o ajanın workspace'ini değil BÜTÜN kontrol
-- düzlemini teslim ederdi.
--
-- Bunun yerine kısa ömürlü, TEK oturuma bağlı bir jeton basılır: (şirket, ajan,
-- görev, oturum) dörtlüsüne mühürlenir, düz metni yalnız basım cevabında
-- görünür, tabloda SHA-256 özeti durur ve oturum kapanınca kendiliğinden
-- iptal olur. Kimlik hiçbir MCP aracının argümanında yolculuk etmez — sunucu
-- her çağrıda bu satırdan türetir.
CREATE TABLE "mcp_sessions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE RESTRICT,
  "task_id" uuid REFERENCES "tasks"("id") ON DELETE RESTRICT,
  -- sahibi olan canlı oturum; o satır kapanınca bu jeton da iptal edilir
  "agent_session_id" uuid REFERENCES "agent_sessions"("id") ON DELETE CASCADE,
  -- düz metin HİÇBİR yerde saklanmaz (S2 ile aynı ilke)
  "token_hash" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  "last_used_at" timestamptz,
  "call_count" integer NOT NULL DEFAULT 0
);

-- doğrulama yolu: özetle tek satır bul (jeton başına tek kayıt)
CREATE UNIQUE INDEX "mcp_sessions_token_hash_uq" ON "mcp_sessions" ("token_hash");
-- canlı jeton taraması + oturum kapanışında toplu iptal
CREATE INDEX "mcp_sessions_live_idx"
  ON "mcp_sessions" ("company_id", "agent_session_id")
  WHERE "revoked_at" IS NULL;
