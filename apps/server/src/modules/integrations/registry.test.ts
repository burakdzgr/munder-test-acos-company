// D2 — Instagram adapter'ının sözleşme testleri (ADR-017, 30 §).
//
// 30 §'in kendi risk azaltması: "Adapter isolation behind `SocialChannelPort`;
// contract tests on recorded fixtures". Gerçek hesap olmadan kanıtlanabilecek
// şey budur: giden isteğin ŞEKLİ, iki adımlı yayın akışı, hata sınıflaması ve
// token'ın ajan girdisinden değil sunucudan gelmesi.
import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { capabilitiesOf } from "@acos/domain";
import { InstagramAdapter, IntegrationError, type IntegrationContext } from "./registry.js";

interface Captured {
  path: string;
  method: string;
  auth: string | undefined;
  body: string;
}

/** Graph API'nin yerine geçen sahte uç; her isteği kaydeder. */
async function withFakeGraph(
  handler: (captured: Captured) => { status: number; payload: unknown },
  run: (adapter: InstagramAdapter, captured: Captured[]) => Promise<void>,
): Promise<void> {
  const captured: Captured[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += String(c)));
    req.on("end", () => {
      const entry: Captured = {
        path: req.url ?? "",
        method: req.method ?? "",
        auth: req.headers.authorization,
        body,
      };
      captured.push(entry);
      const { status, payload } = handler(entry);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const ctx: IntegrationContext = {
    resolveToken: async (connectionId) => (connectionId === "conn-1" ? "server-side-token" : null),
    fetch,
  };
  try {
    await run(new InstagramAdapter(ctx, `http://127.0.0.1:${port}`), captured);
  } finally {
    server.close();
  }
}

describe("Instagram adapter (30 §, ADR-017)", () => {
  it("beyan ettiği yetenekler gerçekten uygulanmış", () => {
    const adapter = new InstagramAdapter({ resolveToken: async () => null, fetch });
    // capabilitiesOf hem supports() beyanına hem metodun varlığına bakar
    expect(capabilitiesOf(adapter).sort()).toEqual(
      ["getAccountMetrics", "getPostMetrics", "publishPost", "publishReel"].sort(),
    );
    // beyan edilmeyen yetenek çağrılabilir olmamalı
    expect(adapter.supports("replyToComment")).toBe(false);
    expect(adapter.replyToComment).toBeUndefined();
  });

  it("yayın iki adımlı: önce konteyner, sonra publish; token sunucudan gelir", async () => {
    await withFakeGraph(
      (req) =>
        req.path.includes("media_publish")
          ? { status: 200, payload: { id: "ig-post-1", permalink: "https://insta/p/1" } }
          : { status: 200, payload: { id: "container-1" } },
      async (adapter, captured) => {
        const result = await adapter.publishPost({
          connectionId: "conn-1",
          caption: "merhaba",
          mediaUrls: ["https://cdn/x.jpg"],
          idempotencyKey: "job-42",
        });
        expect(result).toEqual({ externalId: "ig-post-1", permalink: "https://insta/p/1" });

        expect(captured).toHaveLength(2);
        expect(captured[0]!.path).toContain("/me/media");
        expect(captured[0]!.body).toContain("image_url=");
        // tekrar denemede aynı gönderi oluşmasın diye anahtar platforma gidiyor
        expect(captured[0]!.body).toContain("client_business_id=job-42");
        expect(captured[1]!.path).toContain("/me/media_publish");
        expect(captured[1]!.body).toContain("creation_id=container-1");
        // S2: token ajan girdisinden değil, sunucudan çözüldü
        for (const call of captured) expect(call.auth).toBe("Bearer server-side-token");
      },
    );
  });

  it("reel yayını video akışını kullanır", async () => {
    await withFakeGraph(
      (req) =>
        req.path.includes("media_publish")
          ? { status: 200, payload: { id: "ig-reel-1" } }
          : { status: 200, payload: { id: "container-9" } },
      async (adapter, captured) => {
        await adapter.publishReel({
          connectionId: "conn-1",
          caption: "reel",
          mediaUrls: ["https://cdn/x.mp4"],
          idempotencyKey: "job-9",
        });
        expect(captured[0]!.body).toContain("video_url=");
        expect(captured[0]!.body).toContain("media_type=REELS");
      },
    );
  });

  it("5xx geçici, 4xx kalıcı olarak sınıflanır (kuyruk buna göre yeniden dener)", async () => {
    await withFakeGraph(
      () => ({ status: 503, payload: { error: { message: "try again" } } }),
      async (adapter) => {
        await adapter
          .publishPost({
            connectionId: "conn-1",
            caption: "x",
            mediaUrls: ["https://cdn/x.jpg"],
            idempotencyKey: "j",
          })
          .then(() => expect.fail("hata bekleniyordu"))
          .catch((err: unknown) => {
            expect(err).toBeInstanceOf(IntegrationError);
            expect((err as IntegrationError).retryable).toBe(true);
          });
      },
    );

    await withFakeGraph(
      () => ({ status: 400, payload: { error: { message: "bad media" } } }),
      async (adapter) => {
        await adapter
          .publishPost({
            connectionId: "conn-1",
            caption: "x",
            mediaUrls: ["https://cdn/x.jpg"],
            idempotencyKey: "j",
          })
          .catch((err: unknown) => {
            expect((err as IntegrationError).retryable).toBe(false);
            expect((err as Error).message).toContain("bad media");
          });
      },
    );
  });

  it("bağlantı çözülemezse platforma HİÇ gidilmez", async () => {
    await withFakeGraph(
      () => ({ status: 200, payload: { id: "x" } }),
      async (adapter, captured) => {
        await adapter
          .publishPost({
            connectionId: "yok",
            caption: "x",
            mediaUrls: ["https://cdn/x.jpg"],
            idempotencyKey: "j",
          })
          .catch((err: unknown) => {
            expect((err as IntegrationError).code).toBe("NOT_CONNECTED");
          });
        expect(captured).toHaveLength(0);
      },
    );
  });

  it("metrikler ham anahtar/değer olarak dönüyor", async () => {
    await withFakeGraph(
      () => ({
        status: 200,
        payload: {
          data: [
            { name: "impressions", values: [{ value: 120 }] },
            { name: "reach", values: [{ value: 90 }] },
          ],
        },
      }),
      async (adapter) => {
        const metrics = await adapter.getPostMetrics({
          connectionId: "conn-1",
          externalId: "ig-post-1",
        });
        expect(metrics.values).toEqual({ impressions: 120, reach: 90 });
        expect(metrics.window).toBe("lifetime");
      },
    );
  });
});
