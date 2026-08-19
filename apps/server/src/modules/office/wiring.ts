// Projector wiring (23 §3): company data loader (SQL), NATS instruction
// publisher on co.<companyId>.office.* (ephemeral choreography — re-derivable,
// never written to the events table).
import { sql } from "drizzle-orm";
import type { NatsConnection } from "nats";
import { OfficeLayoutSchema, type OfficeInstruction } from "@acos/contracts";
import type { GuardedDb } from "@acos/db";
import { OfficeProjector, type OfficeCompanyData, type ProjectorDeps } from "./projector.js";

export function createCompanyDataLoader(db: GuardedDb) {
  return async (companyId: string): Promise<OfficeCompanyData> => {
    const units = await db.execute(sql`
      SELECT id, name, kind, parent_id FROM org_units
      WHERE company_id = ${companyId} AND archived_at IS NULL
    `);
    const agents = await db.execute(sql`
      SELECT id, name, status, org_unit_id FROM agents
      WHERE company_id = ${companyId} AND status IN ('active','draft','paused')
    `);
    const edges = await db.execute(sql`
      SELECT from_agent_id, to_agent_id FROM org_edges
      WHERE company_id = ${companyId} AND kind = 'reports_to' AND ended_at IS NULL
    `);
    // 23 §2 names company_settings.office_layout; the canonical wide row
    // (20 §3.3) has no such column, so the presentation-only layout lives
    // under extra.officeLayout (it is UI configuration, not domain logic).
    const settings = await db.execute(sql`
      SELECT extra->'officeLayout' AS office_layout
      FROM company_settings WHERE company_id = ${companyId}
    `);
    const reportsTo: Record<string, string> = {};
    for (const row of edges.rows as Array<{ from_agent_id: string; to_agent_id: string }>) {
      reportsTo[row.from_agent_id] = row.to_agent_id;
    }
    const rawLayout = (settings.rows[0] as { office_layout?: unknown } | undefined)?.office_layout;
    const savedLayout = rawLayout ? OfficeLayoutSchema.safeParse(rawLayout) : null;
    return {
      units: (units.rows as Array<{ id: string; name: string; kind: string; parent_id: string | null }>).map(
        (u) => ({ id: u.id, name: u.name, kind: u.kind, parentId: u.parent_id }),
      ),
      agents: (agents.rows as Array<{ id: string; name: string; status: string; org_unit_id: string }>).map(
        (a) => ({ id: a.id, name: a.name, status: a.status, orgUnitId: a.org_unit_id }),
      ),
      reportsTo,
      savedLayout: savedLayout?.success ? savedLayout.data : null,
    };
  };
}

export function createOfficeProjector(db: GuardedDb): {
  projector: OfficeProjector;
  attachNats(nats: NatsConnection): void;
} {
  let natsConnection: NatsConnection | null = null;
  const deps: ProjectorDeps = {
    loadCompanyData: createCompanyDataLoader(db),
    publish: (companyId: string, instruction: OfficeInstruction) => {
      natsConnection?.publish(
        `co.${companyId}.${instruction.type}`,
        JSON.stringify(instruction),
        { msgID: `office-${companyId}-${instruction.choreoSeq}` } as never,
      );
    },
    now: () => new Date(),
    schedule: (delayMs, fn) => {
      const timer = setTimeout(fn, delayMs);
      timer.unref?.();
      return () => clearTimeout(timer);
    },
  };
  const projector = new OfficeProjector(deps);
  return {
    projector,
    attachNats(nats: NatsConnection) {
      natsConnection = nats;
    },
  };
}
