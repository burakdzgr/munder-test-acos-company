// OpenAPI snapshot üretici (21 §6 drift check'inin diğer yarısı): app.test.ts
// üretilen spec'i packages/contracts/openapi.json ile birebir karşılaştırır;
// yüzey bilinçli değiştiğinde snapshot BURADAN yenilenir:
//   pnpm --filter @acos/server exec tsx scripts/gen-openapi.ts
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/app.js";

const ok = async () => {};
const app = await buildApp({
  healthCheckers: { postgres: ok, nats: ok, temporal: ok },
  version: "0.0.0",
  logger: false,
});
await app.ready();
const spec = app.swagger();
const out = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/contracts/openapi.json",
);
writeFileSync(out, JSON.stringify(spec, null, 2) + "\n");
await app.close();
console.log("openapi.json written:", Object.keys((spec as { paths: object }).paths).length, "paths");
