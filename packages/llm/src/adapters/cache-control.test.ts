// B3 (26 §3) — prompt cache breakpoint'inin TELDE göründüğünü kanıtlar.
//
// Ajan döngüsü her adımda aynı öneki (kimlik + persona + kurallar + aksiyon
// kataloğu) yeniden gönderiyor. `cachedInputPerMTokCents` fiyat tablosunda,
// `cachedInputTokens` usage okumasında hep vardı; eksik olan tek şey
// sağlayıcıya sabit önekin nerede bittiğini SÖYLEMEKTİ.
//
// Test gerçek adapter'ı sahte bir Anthropic ucuna bağlıyor ve giden HTTP
// gövdesine bakıyor: iddia "cache_control gerçekten isteğe kondu", "olması
// gereken yere kondu" ve "işaretlenmemiş mesajlar dokunulmadan geçti".
import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createAnthropicAdapter, createOpenAiAdapter } from "./ai-sdk.js";

interface CapturedBody {
  system?: Array<{ type: string; text: string; cache_control?: { type: string; ttl?: string } }>;
  messages?: Array<{
    role: string;
    content: Array<{ type: string; text: string; cache_control?: { type: string } }>;
  }>;
}

/** Anthropic Messages API'sinin en küçük geçerli yanıtı. */
async function withFakeProvider(
  run: (baseUrl: string) => Promise<void>,
): Promise<CapturedBody> {
  let captured: CapturedBody = {};
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += String(c)));
    req.on("end", () => {
      captured = JSON.parse(body || "{}") as CapturedBody;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 7 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
  return captured;
}

describe("prompt cache breakpoint (B3, 26 §3)", () => {
  it("cacheable işaretli mesaj isteğe cache_control ile gider", async () => {
    const captured = await withFakeProvider(async (baseUrl) => {
      const adapter = createAnthropicAdapter({ apiKey: "test-key", baseUrl });
      await adapter.complete({
        model: "claude-sonnet-4-5",
        messages: [
          { role: "system", content: "SABİT ÖNEK: kimlik + persona + katalog", cacheable: true },
          { role: "user", content: "değişken adım içeriği" },
        ],
        maxTokens: 16,
      });
    });

    // Anthropic'te system ayrı bir alan; breakpoint oraya düşmeli
    const systemBlocks = captured.system ?? [];
    expect(systemBlocks.length).toBeGreaterThan(0);
    expect(systemBlocks[0]!.text).toContain("SABİT ÖNEK");
    expect(systemBlocks[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });

    // …ve değişken kısım İŞARETSİZ kalmalı: her adımda değişen bir bloğu
    // cache'lemek sonrasındaki her şeyi geçersiz kılar, tasarruf değil maliyet
    const userBlocks = captured.messages?.[0]?.content ?? [];
    expect(userBlocks[0]?.cache_control).toBeUndefined();
  });

  it("işaret yoksa istek bugünkü hâliyle aynen gider", async () => {
    const captured = await withFakeProvider(async (baseUrl) => {
      const adapter = createAnthropicAdapter({ apiKey: "test-key", baseUrl });
      await adapter.complete({
        model: "claude-sonnet-4-5",
        messages: [{ role: "user", content: "işaretsiz" }],
        maxTokens: 16,
      });
    });
    const userBlocks = captured.messages?.[0]?.content ?? [];
    expect(userBlocks[0]?.cache_control).toBeUndefined();
    expect(captured.system).toBeUndefined();
  });

  it("cache okuması usage'a ve dolayısıyla faturaya yansır", async () => {
    let usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
    await withFakeProvider(async (baseUrl) => {
      const adapter = createAnthropicAdapter({ apiKey: "test-key", baseUrl });
      const result = await adapter.complete({
        model: "claude-sonnet-4-5",
        messages: [{ role: "system", content: "sabit", cacheable: true }],
        maxTokens: 16,
      });
      usage = result.usage;
    });
    // sahte uç 7 token'ı cache'ten okunmuş bildiriyor
    expect(usage.cachedInputTokens).toBe(7);
  });

  it("cache'i olmayan sağlayıcıda işaret sessizce yok sayılır", async () => {
    // OpenAI uzun önekleri kendiliğinden cache'ler; işaret göndermek hata olurdu
    const captured = await withFakeProvider(async (baseUrl) => {
      const adapter = createOpenAiAdapter({ apiKey: "test-key", baseUrl });
      await adapter
        .complete({
          model: "gpt-4o-mini",
          messages: [{ role: "system", content: "sabit", cacheable: true }],
          maxTokens: 16,
        })
        .catch(() => {
          /* sahte uç Anthropic şeklinde yanıt veriyor — gövde yakalandı, yeter */
        });
    });
    const raw = JSON.stringify(captured);
    expect(raw).not.toContain("cache_control");
  });
});
