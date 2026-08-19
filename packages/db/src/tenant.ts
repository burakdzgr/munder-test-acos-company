// The tenancy guard (S4, 20 §1.1): a Drizzle wrapper that REFUSES any query
// touching a tenant table without a company_id predicate. The tenant-table
// list is generated from schema metadata; repositories are the primary
// enforcement (they always scope by CompanyContext) — this guard is the net
// that catches anything else.
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool, PoolClient, QueryResult } from "pg";
import * as schema from "./schema/index.js";

export class TenancyViolationError extends Error {
  constructor(table: string, sqlText: string) {
    super(
      `tenancy violation: query touches tenant table "${table}" without a company_id predicate (S4). SQL: ${sqlText.slice(0, 200)}`,
    );
    this.name = "TenancyViolationError";
  }
}

function collectTables(): { tenant: string[]; platform: string[] } {
  const tenant: string[] = [];
  const platform: string[] = [];
  for (const exported of Object.values(schema)) {
    if (!is(exported, PgTable)) continue;
    const config = getTableConfig(exported);
    const hasCompanyId = config.columns.some((c) => c.name === "company_id");
    (hasCompanyId ? tenant : platform).push(config.name);
  }
  return { tenant: tenant.sort(), platform: platform.sort() };
}

const tables = collectTables();

/** Every table whose rows are tenant-owned (has company_id). */
export const TENANT_TABLES: readonly string[] = tables.tenant;
/** Platform tables (users, sessions, PATs, model_providers, tools, rate_limits). */
export const PLATFORM_TABLES: readonly string[] = tables.platform;

const TENANT_TABLE_PATTERNS = TENANT_TABLES.map(
  (t) => [t, new RegExp(`(?:^|[\\s,("])"?${t}"?(?:$|[\\s,()";])`, "i")] as const,
);

/**
 * Throws TenancyViolationError when guarded SQL touches a tenant table
 * without a company_id predicate. A bare `company_id` in the select list does
 * NOT count — INSERTs must carry it in the column list, everything else must
 * filter on it (WHERE/ON/USING).
 */
export function assertTenantSafe(sqlText: string): void {
  const lowered = sqlText.toLowerCase();
  if (!/^\s*(select|insert|update|delete|with)\b/.test(lowered)) return; // DDL/tx control

  const touchesTenantTable = TENANT_TABLE_PATTERNS.some(([, pattern]) => pattern.test(sqlText));
  if (!touchesTenantTable) return;

  const scoped = /^\s*insert\b/.test(lowered)
    ? /\([^)]*"?company_id"?[^)]*\)\s*values/.test(lowered)
    : /\b(where|on|using)\b[\s\S]*"?company_id"?/.test(lowered);
  if (scoped) return;

  const offending = TENANT_TABLE_PATTERNS.find(([, pattern]) => pattern.test(sqlText))!;
  throw new TenancyViolationError(offending[0], sqlText);
}

type QueryArgs = Parameters<Pool["query"]>;

function guardClient(client: PoolClient): PoolClient {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "query") {
        return (...args: QueryArgs): Promise<QueryResult> => {
          const first = args[0];
          const text = typeof first === "string" ? first : ((first as { text?: string }).text ?? "");
          assertTenantSafe(text);
          return (target.query as (...a: QueryArgs) => Promise<QueryResult>)(...args);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function guardPool(pool: Pool): Pool {
  return new Proxy(pool, {
    get(target, prop) {
      if (prop === "query") {
        return (...args: QueryArgs): Promise<QueryResult> => {
          const first = args[0];
          const text = typeof first === "string" ? first : ((first as { text?: string }).text ?? "");
          assertTenantSafe(text);
          return (target.query as (...a: QueryArgs) => Promise<QueryResult>)(...args);
        };
      }
      if (prop === "connect") {
        return async () => guardClient(await target.connect());
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...a: never[]) => unknown).bind(target) : value;
    },
  });
}

export type GuardedDb = NodePgDatabase<typeof schema>;

/**
 * Drizzle instance whose every statement passes the tenancy guard.
 * Platform modules and the migrator use createDb (unguarded) instead.
 */
export function createGuardedDb(pool: Pool): GuardedDb {
  return drizzle(guardPool(pool), { schema });
}
