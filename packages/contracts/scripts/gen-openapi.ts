// pnpm --filter @acos/contracts gen:openapi  (21 §6)
// Builds the server app (no IO — stub checkers), extracts the OpenAPI 3.1
// document and writes packages/contracts/openapi.json (committed; the server
// snapshot test drift-checks it in CI).
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../../../apps/server/src/app.js";

const noop = async () => {};

const app = await buildApp({
  healthCheckers: { postgres: noop, nats: noop, temporal: noop },
  version: "0.0.0",
  logger: false,
});
await app.ready();
const document = app.swagger();
await app.close();

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "openapi.json");
writeFileSync(out, JSON.stringify(document, null, 2) + "\n");
console.log(`openapi.json written (${Object.keys((document as { paths: object }).paths).length} paths)`);
