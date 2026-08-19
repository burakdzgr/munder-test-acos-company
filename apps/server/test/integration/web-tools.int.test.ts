// B2' — web.fetch / web.search (17 §3.1, S5, 27 §12).
//
// İki şey kanıtlanıyor:
// 1. Çıkış trafiği DOĞRUDAN gitmiyor — istek egress allowlist proxy'sinden
//    geçiyor. Test gerçek bir proxy süreci çalıştırıp isteğin oraya
//    uğradığını görüyor; proxy yapılandırılmamışsa araç soket bile açmadan
//    tipli bir hata veriyor.
// 2. Yanıt `provenance: "web"` ile dönüyor. Bu opsiyonel bir alan değil:
//    ajan döngüsü (renderStep) dış içeriği S5 çitine bu alana bakarak
//    sarıyor — alan düşerse zehirli içerik Working Set'e çıplak girer.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, request as httpRequest, type Server } from "node:http";
import { connect as netConnect } from "node:net";
import { Pool } from "pg";
import {
  companyContext,
  createDb,
  createGuardedDb,
  runMigrations,
  type CompanyContext,
  type Db,
  type GuardedDb,
} from "@acos/db";
import { agents, companies, orgUnits, positions, toolPermissions, users } from "@acos/db/schema";
import { getTool } from "@acos/tools";
import { createSandboxDispatchPort } from "../../src/modules/tools/dispatch.js";
import { ToolGateway } from "../../src/modules/tools/gateway.js";
import { startPostgres, type StartedPostgreSqlContainer } from "./helpers";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let guardedDb: GuardedDb;
let ctx: CompanyContext;
let gateway: ToolGateway;
let originServer: Server;
let proxyServer: Server;
let originUrl = "";
let proxyUrl = "";
let companyId = "";
let DEV = "";

/** Proxy'den geçen istekler — "gerçekten oradan mı geçti" kanıtı. */
const proxied: string[] = [];

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });

beforeAll(async () => {
  // hedef sunucu: dış dünyayı temsil eder
  originServer = createServer((req, res) => {
    if (req.url === "/big") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("X".repeat(50_000));
      return;
    }
    if (req.url?.startsWith("/search")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          web: {
            results: [
              { title: "Fastify", url: "https://fastify.dev", description: "web framework" },
              { title: "Zod", url: "https://zod.dev", description: "schema validation" },
            ],
          },
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html>merhaba dünya</html>");
  });
  const originPort = await listen(originServer);
  originUrl = `http://127.0.0.1:${originPort}`;

  // egress proxy: mutlak-URI isteklerini iletir ve hepsini kaydeder
  proxyServer = createServer((clientReq, clientRes) => {
    proxied.push(clientReq.url ?? "");
    const target = new URL(clientReq.url ?? "");
    const upstream = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: clientReq.method,
        headers: { ...clientReq.headers, host: target.host },
      },
      (upstreamRes) => {
        clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(clientRes);
      },
    );
    upstream.on("error", () => {
      clientRes.writeHead(502);
      clientRes.end();
    });
    clientReq.pipe(upstream);
  });
  // Gerçek proxy'ler (squid dahil) tünel için CONNECT konuşur ve undici'nin
  // ProxyAgent'ı da her isteği böyle gönderir — test proxy'si bu yüzden
  // CONNECT'i de karşılamak zorunda, yoksa ölçtüğü şey gerçek yol olmaz.
  proxyServer.on("connect", (req, clientSocket, head) => {
    proxied.push(req.url ?? "");
    const [host, port] = (req.url ?? "").split(":");
    const upstream = netConnect({ host: host!, port: Number(port ?? 80) }, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
  const proxyPort = await listen(proxyServer);
  proxyUrl = `http://127.0.0.1:${proxyPort}`;

  container = await startPostgres();
  await runMigrations(container.getConnectionUri());
  pool = new Pool({ connectionString: container.getConnectionUri() });
  pool.on("error", () => {});
  db = createDb(pool);
  guardedDb = createGuardedDb(pool);

  gateway = new ToolGateway({
    db: guardedDb,
    dispatch: createSandboxDispatchPort({
      guardedDb,
      sandboxManagerUrl: "http://127.0.0.1:1",
      internalApiToken: "unused-in-this-suite-0123456789",
      egressProxyUrl: proxyUrl,
      searchApiUrl: `${originUrl}/search`,
    }),
    // S2: kimlik bilgisi ajandan değil, sunucudan gelir
    resolveCredential: async (_ctx, name) =>
      name === "search.api_key" ? "test-search-key" : null,
  });

  const [founder] = await db
    .insert(users)
    .values({ email: "founder@web.local", passwordHash: "x", displayName: "F" })
    .returning();
  const [company] = await db
    .insert(companies)
    .values({ name: "WebCo", slug: "webco", createdByUserId: founder!.id })
    .returning();
  companyId = company!.id;
  ctx = companyContext(companyId);
  const [unit] = await db
    .insert(orgUnits)
    .values({ companyId, kind: "team", name: "Research", slug: "research" })
    .returning();
  const [position] = await db
    .insert(positions)
    .values({ companyId, title: "Analyst", seniorityTrack: ["mid"], defaultRole: "member" })
    .returning();
  const [agent] = await db
    .insert(agents)
    .values({
      companyId,
      employeeNumber: 1,
      name: "Aylin Analyst",
      status: "active",
      positionId: position!.id,
      orgUnitId: unit!.id,
      seniority: "mid",
      autonomyLevel: 2,
      persona: "x",
    })
    .returning();
  DEV = agent!.id;
  for (const tool of ["web.fetch", "web.search"]) {
    await db
      .insert(toolPermissions)
      .values({ companyId, toolName: tool, subjectKind: "agent", subjectId: DEV });
  }
}, 600_000);

afterAll(async () => {
  originServer?.close();
  proxyServer?.close();
  await pool?.end();
  await container?.stop();
});

describe("web araçları egress proxy'sinden geçer (17 §3.1, S5)", () => {
  it("web.fetch içeriği proxy üzerinden alır ve provenance:web ile döner", async () => {
    const before = proxied.length;
    const res = await gateway.invoke(ctx, {
      agentId: DEV,
      toolName: "web.fetch",
      input: { url: `${originUrl}/page` },
    });
    expect(res.decision).toBe("allow");
    expect(res.status, `dispatch hatası: ${res.error ?? res.reason ?? "yok"}`).toBe("succeeded");
    const out = res.output as { status: number; body: string; provenance: string };
    expect(out.status).toBe(200);
    expect(out.body).toContain("merhaba dünya");
    // S5 çitinin bağlı olduğu alan
    expect(out.provenance).toBe("web");
    // ve istek gerçekten proxy'den geçti. CONNECT tünelinde proxy yalnız
    // host:port görür — yol tünelin içinde kalır; kanıt da zaten bu: trafik
    // sunucu sürecinden değil, proxy üzerinden çıkıyor.
    expect(proxied.length).toBe(before + 1);
    expect(proxied[proxied.length - 1]).toContain(new URL(originUrl).port);
  });

  it("maxBytes tavanı aşılınca gövde kırpılır (bağlam ve bellek koruması)", async () => {
    const res = await gateway.invoke(ctx, {
      agentId: DEV,
      toolName: "web.fetch",
      input: { url: `${originUrl}/big`, maxBytes: 1_000 },
    });
    expect(res.status).toBe("succeeded");
    const out = res.output as { body: string; truncated: boolean };
    expect(out.truncated).toBe(true);
    expect(out.body.length).toBeLessThanOrEqual(1_000);
  });

  it("web.search yapılandırılmış adaptörden sonuç döndürür", async () => {
    const res = await gateway.invoke(ctx, {
      agentId: DEV,
      toolName: "web.search",
      input: { query: "fastify zod", maxResults: 5 },
    });
    expect(res.status, `dispatch hatası: ${res.error ?? res.reason ?? "yok"}`).toBe("succeeded");
    const out = res.output as {
      results: Array<{ title: string; url: string; snippet: string }>;
      provenance: string;
    };
    expect(out.provenance).toBe("web");
    expect(out.results.map((r) => r.title)).toEqual(["Fastify", "Zod"]);
    // Arama çağrısı da proxy üzerinden gitti — başka çıkış yolu yok. Sayıya
    // değil varlığa bakıyoruz: undici tüneli havuzda tuttuğu için ikinci
    // istek yeni bir CONNECT açmayabilir.
    expect(proxied.some((u) => u.includes(new URL(originUrl).port))).toBe(true);
  });

  it("proxy yapılandırılmamışsa doğrudan çıkmaz — tipli hata verir", async () => {
    const noProxy = new ToolGateway({
      db: guardedDb,
      dispatch: createSandboxDispatchPort({
        guardedDb,
        sandboxManagerUrl: "http://127.0.0.1:1",
        internalApiToken: "unused-in-this-suite-0123456789",
      }),
    });
    const before = proxied.length;
    const res = await noProxy.invoke(ctx, {
      agentId: DEV,
      toolName: "web.fetch",
      input: { url: `${originUrl}/page` },
    });
    expect(res.status).toBe("failed");
    expect(res.error).toContain("EGRESS_PROXY_URL");
    expect(proxied.length).toBe(before); // hiçbir yere gitmedi
  });

  it("arama anahtarı yoksa uydurmaz, durumu söyler", async () => {
    const noKey = new ToolGateway({
      db: guardedDb,
      dispatch: createSandboxDispatchPort({
        guardedDb,
        sandboxManagerUrl: "http://127.0.0.1:1",
        internalApiToken: "unused-in-this-suite-0123456789",
        egressProxyUrl: proxyUrl,
      }),
    });
    const res = await noKey.invoke(ctx, {
      agentId: DEV,
      toolName: "web.search",
      input: { query: "anything" },
    });
    expect(res.status).toBe("failed");
    expect(res.error).toContain("search API key");
  });
});
