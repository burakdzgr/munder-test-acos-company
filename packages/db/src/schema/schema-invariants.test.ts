// Sacred invariant (03 §2, INV-9): no table other than agent_model_bindings,
// model_providers, model_profiles and llm_calls may carry a model/provider
// column — agent identity is fully decoupled from any LLM.
import { describe, expect, it } from "vitest";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "./index.js";

const ALLOWED_MODEL_TABLES = new Set([
  "agent_model_bindings",
  "model_providers",
  "model_profiles",
  "llm_calls",
]);

// embedding_model records WHICH embedder produced a vector (ADR-020 per-row
// dimension bookkeeping) — it references no agent and is explicitly allowed.
const ALLOWED_EMBEDDING_COLUMNS = new Set(["embedding_model", "embedding_dim"]);

describe("agent identity ⊥ model (INV-9, CI-enforced)", () => {
  it("model/provider columns exist only in the four allowed tables", () => {
    const offenders: string[] = [];
    for (const exported of Object.values(schema)) {
      if (!is(exported, PgTable)) continue;
      const config = getTableConfig(exported);
      if (ALLOWED_MODEL_TABLES.has(config.name)) continue;
      for (const column of config.columns) {
        if (ALLOWED_EMBEDDING_COLUMNS.has(column.name)) continue;
        if (/(^|_)(model|provider)(_|$)/.test(column.name)) {
          offenders.push(`${config.name}.${column.name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the agents table itself carries no model coupling at all", () => {
    const config = getTableConfig(schema.agents);
    const names = config.columns.map((c) => c.name).join(",");
    expect(names).not.toMatch(/model|provider|llm/);
  });
});
