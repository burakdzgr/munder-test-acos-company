// Agents module (05 §1–4, §7; _DECISIONS §6): hire in ONE transaction
// (04 §6.1), lifecycle via the canonical state machine, model bindings as the
// ONLY agent↔model linkage (sacred invariant), sessions read API.
import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import { agentMachine, formatEmployeeNumber } from "@acos/domain";
import {
  nextSequenceValue,
  SkillsService,
  type CompanyContext,
  type GuardedDb,
} from "@acos/db";
import {
  agentModelBindings,
  agentSessions,
  agentSteps,
  agents,
  modelProfiles,
  modelProviders,
  orgEdges,
  orgUnits,
  positions,
  projectMembers,
  projects,
  tasks,
} from "@acos/db/schema";
import { OrgService, orgLockInTx } from "../org/service.js";
import { emitDomainEvent } from "../events/emit.js";

export type AgentRow = typeof agents.$inferSelect;
export type BindingRow = typeof agentModelBindings.$inferSelect;
export type AgentStatus = "draft" | "active" | "paused" | "offboarded";
export type BindingPurpose =
  | "primary"
  | "default"
  | "coding"
  | "planning"
  | "review"
  | "fast"
  | "embedding";

export class AgentLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentLifecycleError";
  }
}

/** model_profiles purposes → binding purposes (05 §7 resolution order). */
const PROFILE_TO_BINDING: Record<string, BindingPurpose> = {
  reasoning: "primary",
  fast: "fast",
  embedding: "embedding",
};

export class AgentsService {
  constructor(
    private readonly db: GuardedDb,
    private readonly org: OrgService,
  ) {}

  /**
   * 04 §6.1: allocate employee_number → insert agent → member_of +
   * reports_to (+ inverse manages) edges → seed bindings from company
   * profiles → agent.hired (+ org.edge.created ×N) — all one transaction.
   */
  /** TASK 11: binding seçim kaynağı — şirketin etkin model profilleri. */
  async modelRegistry(ctx: CompanyContext) {
    const { modelProfiles, modelProviders } = await import("@acos/db/schema");
    const { and, eq } = await import("drizzle-orm");
    const rows = await this.db
      .select({
        purpose: modelProfiles.purpose,
        model: modelProfiles.model,
        priority: modelProfiles.priority,
        provider: modelProviders.name,
        providerId: modelProviders.id,
      })
      .from(modelProfiles)
      .innerJoin(modelProviders, eq(modelProfiles.providerId, modelProviders.id))
      .where(and(eq(modelProfiles.companyId, ctx.companyId), eq(modelProfiles.enabled, true)))
      .orderBy(modelProfiles.priority);
    return { profiles: rows };
  }

  async hire(
    ctx: CompanyContext,
    input: {
      name: string;
      positionId: string;
      orgUnitId: string;
      seniority: string;
      autonomyLevel: number;
      persona: string;
      avatarUrl?: string | null | undefined;
      managerAgentId?: string | null | undefined;
      leadsUnit?: boolean | undefined;
      activate?: boolean | undefined;
      // U10 (36 §8) — additive params, same single transaction
      avatarId?: string | undefined;
      expertise?: string[] | undefined;
      projectId?: string | undefined;
      modelBinding?: { provider: string; model: string } | undefined;
    },
  ): Promise<AgentRow> {
    return this.db.transaction(async (tx) => {
      await orgLockInTx(tx, ctx);
      const employeeNumber = await nextSequenceValue(tx, ctx, "employee_number");
      const [agent] = await tx
        .insert(agents)
        .values({
          companyId: ctx.companyId,
          employeeNumber,
          name: input.name,
          // avatarId = PixelLab library pick (U15/U10) — persisted identity
          avatarUrl: input.avatarId ? `pixel:${input.avatarId}` : (input.avatarUrl ?? null),
          status: input.activate ? "active" : "draft",
          positionId: input.positionId,
          orgUnitId: input.orgUnitId,
          seniority: input.seniority,
          autonomyLevel: input.autonomyLevel,
          persona: input.persona,
          employment: { hired_at: new Date().toISOString() },
        })
        .returning();

      await this.org.createEdgeInTx(tx, ctx, {
        fromAgentId: agent!.id,
        kind: "member_of",
        toUnitId: input.orgUnitId,
      });
      if (input.managerAgentId) {
        await this.org.createEdgeInTx(tx, ctx, {
          fromAgentId: agent!.id,
          kind: "reports_to",
          toAgentId: input.managerAgentId,
        });
      }
      if (input.leadsUnit) {
        await this.org.createEdgeInTx(tx, ctx, {
          fromAgentId: agent!.id,
          kind: "leads",
          toUnitId: input.orgUnitId,
        });
      }

      // Seed bindings from the company's default model profiles (04 §6.1).
      const profiles = await tx
        .select()
        .from(modelProfiles)
        .where(and(eq(modelProfiles.companyId, ctx.companyId), eq(modelProfiles.enabled, true)))
        .orderBy(asc(modelProfiles.priority));
      const seeded = new Set<BindingPurpose>();
      for (const profile of profiles) {
        const purpose = PROFILE_TO_BINDING[profile.purpose];
        if (!purpose || seeded.has(purpose)) continue;
        seeded.add(purpose);
        await tx.insert(agentModelBindings).values({
          companyId: ctx.companyId,
          agentId: agent!.id,
          purpose,
          providerId: profile.providerId,
          model: profile.model,
          params: profile.params ?? {},
        });
      }

      // U10: explicit engine/model pick overrides the seeded primary binding
      // (identity stays fully decoupled from the model — INV-9).
      if (input.modelBinding) {
        const [provider] = await tx
          .select({ id: modelProviders.id })
          .from(modelProviders)
          .where(eq(modelProviders.name, input.modelBinding.provider));
        if (!provider) {
          throw new AgentLifecycleError(
            `unknown model provider "${input.modelBinding.provider}" — provision it first`,
          );
        }
        await tx
          .delete(agentModelBindings)
          .where(
            and(
              eq(agentModelBindings.companyId, ctx.companyId),
              eq(agentModelBindings.agentId, agent!.id),
              eq(agentModelBindings.purpose, "primary"),
            ),
          );
        await tx.insert(agentModelBindings).values({
          companyId: ctx.companyId,
          agentId: agent!.id,
          purpose: "primary",
          providerId: provider.id,
          model: input.modelBinding.model,
          params: {},
        });
        await emitDomainEvent(tx, ctx, {
          type: "agent.model.binding.changed",
          actor: { kind: "founder", id: null },
          agentId: agent!.id,
          payload: {
            agentId: agent!.id,
            diff: { purpose: "primary", model: input.modelBinding.model },
          },
        });
      }

      // U10: expertise tags → initial agent_skills seed through the ONE T47
      // evidence writer (deterministic level, real evidence rows).
      if (input.expertise && input.expertise.length > 0) {
        const skillsService = new SkillsService(this.db);
        for (const tag of input.expertise) {
          const name = tag.trim();
          if (name === "") continue;
          await skillsService.appendEvidenceInTx(tx, ctx, {
            agentId: agent!.id,
            skillName: name,
            category: "expertise",
            kind: "manager_eval",
            ref: `hire:${agent!.id}`,
            note: "hire:expertise",
          });
        }
      }

      // U10: project placement → project_members (T42) + catalogued event.
      if (input.projectId) {
        const [project] = await tx
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.companyId, ctx.companyId), eq(projects.id, input.projectId)));
        if (!project) throw new AgentLifecycleError("project not found");
        await tx.insert(projectMembers).values({
          companyId: ctx.companyId,
          projectId: input.projectId,
          agentId: agent!.id,
          role: "engineer",
        });
        await emitDomainEvent(tx, ctx, {
          type: "project.member.added",
          actor: { kind: "founder", id: null },
          agentId: agent!.id,
          projectId: input.projectId,
          payload: { agentId: agent!.id, role: "engineer" },
        });
      }

      await emitDomainEvent(tx, ctx, {
        type: "agent.hired",
        actor: { kind: "founder", id: null },
        agentId: agent!.id,
        payload: {
          agentId: agent!.id,
          employeeNumber,
          name: agent!.name,
          positionId: agent!.positionId,
          orgUnitId: agent!.orgUnitId,
          seniority: agent!.seniority as never,
        },
      });
      if (input.activate) {
        await emitDomainEvent(tx, ctx, {
          type: "agent.started",
          actor: { kind: "founder", id: null },
          agentId: agent!.id,
          payload: { agentId: agent!.id },
        });
      }
      return agent!;
    });
  }

  // ---------- lifecycle (05 §1, §3) ----------

  private async transition(
    ctx: CompanyContext,
    agentId: string,
    to: AgentStatus,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<AgentRow> {
    return this.db.transaction(async (tx) => {
      const [agent] = await tx
        .select()
        .from(agents)
        .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, agentId)))
        .for("update");
      if (!agent) throw new AgentLifecycleError("AGENT_NOT_FOUND");
      if (!agentMachine.canTransition(agent.status as AgentStatus, to)) {
        throw new AgentLifecycleError(`illegal transition ${agent.status} → ${to}`);
      }
      const [updated] = await tx
        .update(agents)
        .set({ status: to })
        .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, agentId)))
        .returning();
      await emitDomainEvent(tx, ctx, {
        type: eventType,
        actor: { kind: "founder", id: null },
        agentId,
        payload,
      });
      return updated!;
    });
  }

  /** 05 §3.1: requires resolvable primary model + reporting line (or explicit top level). */
  async activate(ctx: CompanyContext, agentId: string, topLevel = false): Promise<AgentRow> {
    const [binding] = await this.db
      .select()
      .from(agentModelBindings)
      .where(
        and(
          eq(agentModelBindings.companyId, ctx.companyId),
          eq(agentModelBindings.agentId, agentId),
          eq(agentModelBindings.purpose, "primary"),
        ),
      );
    if (!binding) {
      const [profile] = await this.db
        .select()
        .from(modelProfiles)
        .where(
          and(
            eq(modelProfiles.companyId, ctx.companyId),
            eq(modelProfiles.purpose, "reasoning"),
            eq(modelProfiles.enabled, true),
          ),
        );
      if (!profile) throw new AgentLifecycleError("MODEL_UNRESOLVABLE: no primary binding or company reasoning profile");
    }
    if (!topLevel) {
      const [edge] = await this.db
        .select()
        .from(orgEdges)
        .where(
          and(
            eq(orgEdges.companyId, ctx.companyId),
            eq(orgEdges.fromAgentId, agentId),
            eq(orgEdges.kind, "reports_to"),
            isNull(orgEdges.endedAt),
          ),
        );
      if (!edge) throw new AgentLifecycleError("NO_REPORTING_LINE: set a manager or activate as top-level");
    }
    return this.transition(ctx, agentId, "active", "agent.started", { agentId });
  }

  async pause(ctx: CompanyContext, agentId: string, reason?: string): Promise<AgentRow> {
    return this.transition(ctx, agentId, "paused", "agent.paused", { reason });
  }

  async resume(ctx: CompanyContext, agentId: string, reason?: string): Promise<AgentRow> {
    return this.transition(ctx, agentId, "active", "agent.resumed", { reason });
  }

  /**
   * Org yerleşim değişikliği (04 §6): unit/position/seniority/manager — one
   * tx under the org advisory lock. Old member_of / reports_to (+ inverse
   * manages) edges are ended and new ones created via createEdgeInTx (cycle
   * check + channel membership sync + org.edge.created included). Emits
   * agent.updated {diff} + org.reorg.applied.
   */
  async changePlacement(
    ctx: CompanyContext,
    agentId: string,
    patch: {
      orgUnitId?: string | undefined;
      positionId?: string | undefined;
      seniority?: string | undefined;
      managerAgentId?: string | null | undefined;
    },
  ): Promise<AgentRow> {
    return this.db.transaction(async (tx) => {
      await orgLockInTx(tx, ctx);
      const [agent] = await tx
        .select()
        .from(agents)
        .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, agentId)))
        .for("update");
      if (!agent) throw new AgentLifecycleError("AGENT_NOT_FOUND");
      if (agent.status === "offboarded") {
        throw new AgentLifecycleError("AGENT_OFFBOARDED: işten çıkarılmış ajan taşınamaz");
      }

      const diff: Record<string, unknown> = {};

      if (patch.orgUnitId !== undefined && patch.orgUnitId !== agent.orgUnitId) {
        const [unit] = await tx
          .select({ id: orgUnits.id })
          .from(orgUnits)
          .where(
            and(
              eq(orgUnits.companyId, ctx.companyId),
              eq(orgUnits.id, patch.orgUnitId),
              isNull(orgUnits.archivedAt),
            ),
          );
        if (!unit) throw new AgentLifecycleError("UNIT_NOT_FOUND: hedef birim yok veya arşivli");
        const endedMember = await tx
          .update(orgEdges)
          .set({ endedAt: sql`now()` })
          .where(
            and(
              eq(orgEdges.companyId, ctx.companyId),
              eq(orgEdges.fromAgentId, agentId),
              eq(orgEdges.kind, "member_of"),
              isNull(orgEdges.endedAt),
            ),
          )
          .returning({ id: orgEdges.id, endedAt: orgEdges.endedAt });
        for (const edge of endedMember) {
          await emitDomainEvent(tx, ctx, {
            type: "org.edge.ended",
            actor: { kind: "founder", id: null },
            agentId,
            payload: {
              edgeId: edge.id,
              endedAt: edge.endedAt?.toISOString(),
              reason: "placement.changed",
            },
          });
        }
        await this.org.createEdgeInTx(tx, ctx, {
          fromAgentId: agentId,
          kind: "member_of",
          toUnitId: patch.orgUnitId,
        });
        diff.orgUnitId = patch.orgUnitId;
      }

      if (patch.positionId !== undefined && patch.positionId !== agent.positionId) {
        const [position] = await tx
          .select({ id: positions.id })
          .from(positions)
          .where(
            and(
              eq(positions.companyId, ctx.companyId),
              eq(positions.id, patch.positionId),
              isNull(positions.archivedAt),
            ),
          );
        if (!position) throw new AgentLifecycleError("POSITION_NOT_FOUND: pozisyon yok veya arşivli");
        diff.positionId = patch.positionId;
      }

      if (patch.seniority !== undefined && patch.seniority !== agent.seniority) {
        diff.seniority = patch.seniority;
      }

      if (patch.managerAgentId !== undefined) {
        if (patch.managerAgentId === agentId) {
          throw new AgentLifecycleError("SELF_MANAGER: ajan kendine raporlayamaz");
        }
        // end current reports_to (from agent) + its inverse manages (to agent)
        const endedReporting = await tx
          .update(orgEdges)
          .set({ endedAt: sql`now()` })
          .where(
            and(
              eq(orgEdges.companyId, ctx.companyId),
              isNull(orgEdges.endedAt),
              or(
                and(eq(orgEdges.fromAgentId, agentId), eq(orgEdges.kind, "reports_to")),
                and(eq(orgEdges.toAgentId, agentId), eq(orgEdges.kind, "manages")),
              ),
            ),
          )
          .returning({ id: orgEdges.id, endedAt: orgEdges.endedAt });
        for (const edge of endedReporting) {
          await emitDomainEvent(tx, ctx, {
            type: "org.edge.ended",
            actor: { kind: "founder", id: null },
            agentId,
            payload: {
              edgeId: edge.id,
              endedAt: edge.endedAt?.toISOString(),
              reason: "placement.changed",
            },
          });
        }
        if (patch.managerAgentId !== null) {
          const [manager] = await tx
            .select({ id: agents.id, status: agents.status })
            .from(agents)
            .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, patch.managerAgentId)));
          if (!manager || manager.status === "offboarded") {
            throw new AgentLifecycleError("MANAGER_NOT_FOUND: yönetici yok veya işten çıkarılmış");
          }
          await this.org.createEdgeInTx(tx, ctx, {
            fromAgentId: agentId,
            kind: "reports_to",
            toAgentId: patch.managerAgentId,
          });
        }
      }

      let updated = agent;
      if (Object.keys(diff).length > 0) {
        const [row] = await tx
          .update(agents)
          .set(diff)
          .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, agentId)))
          .returning();
        updated = row!;
        await emitDomainEvent(tx, ctx, {
          type: "agent.updated",
          actor: { kind: "founder", id: null },
          agentId,
          payload: { diff },
        });
      }
      await emitDomainEvent(tx, ctx, {
        type: "org.reorg.applied",
        actor: { kind: "founder", id: null },
        agentId,
        payload: { operation: "agent.placement.changed", movedIds: [agentId], initiator: "founder" },
      });
      return updated;
    });
  }

  /** 05 §3.3 (v1): end all edges, re-point direct reports, retain memory/history. */
  async offboard(ctx: CompanyContext, agentId: string, reason?: string): Promise<AgentRow> {
    return this.db.transaction(async (tx) => {
      await orgLockInTx(tx, ctx);
      const [agent] = await tx
        .select()
        .from(agents)
        .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, agentId)))
        .for("update");
      if (!agent) throw new AgentLifecycleError("AGENT_NOT_FOUND");
      if (!agentMachine.canTransition(agent.status as AgentStatus, "offboarded")) {
        throw new AgentLifecycleError(`illegal transition ${agent.status} → offboarded`);
      }

      // former manager (for re-pointing direct reports)
      const [managerEdge] = await tx
        .select()
        .from(orgEdges)
        .where(
          and(
            eq(orgEdges.companyId, ctx.companyId),
            eq(orgEdges.fromAgentId, agentId),
            eq(orgEdges.kind, "reports_to"),
            isNull(orgEdges.endedAt),
          ),
        );
      const formerManagerId = managerEdge?.toAgentId ?? null;

      const reports = await tx
        .select()
        .from(orgEdges)
        .where(
          and(
            eq(orgEdges.companyId, ctx.companyId),
            eq(orgEdges.toAgentId, agentId),
            eq(orgEdges.kind, "reports_to"),
            isNull(orgEdges.endedAt),
          ),
        );

      // end ALL active edges touching the agent
      const ended = await tx
        .update(orgEdges)
        .set({ endedAt: sql`now()` })
        .where(
          and(
            eq(orgEdges.companyId, ctx.companyId),
            isNull(orgEdges.endedAt),
            or(eq(orgEdges.fromAgentId, agentId), eq(orgEdges.toAgentId, agentId)),
          ),
        )
        .returning({ id: orgEdges.id, endedAt: orgEdges.endedAt });
      for (const edge of ended) {
        await emitDomainEvent(tx, ctx, {
          type: "org.edge.ended",
          actor: { kind: "founder", id: null },
          agentId,
          payload: { edgeId: edge.id, endedAt: edge.endedAt?.toISOString(), reason: "offboarding" },
        });
      }

      // re-point direct reports to the former manager (explicit new edges)
      if (formerManagerId) {
        for (const report of reports) {
          await this.org.createEdgeInTx(tx, ctx, {
            fromAgentId: report.fromAgentId,
            kind: "reports_to",
            toAgentId: formerManagerId,
          });
        }
      }

      const employment = {
        ...(agent.employment as Record<string, unknown>),
        offboarded_at: new Date().toISOString(),
      };
      const [updated] = await tx
        .update(agents)
        .set({ status: "offboarded", employment })
        .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, agentId)))
        .returning();
      await emitDomainEvent(tx, ctx, {
        type: "agent.offboarded",
        actor: { kind: "founder", id: null },
        agentId,
        payload: { reason, memoryDisposition: "retained" },
      });
      return updated!;
    });
  }

  async update(
    ctx: CompanyContext,
    agentId: string,
    patch: {
      persona?: string | undefined;
      avatarUrl?: string | null | undefined;
      autonomyLevel?: number | undefined;
    },
  ): Promise<AgentRow | undefined> {
    const cleaned = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    if (Object.keys(cleaned).length === 0) return this.get(ctx, agentId);
    return this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(agents)
        .set(cleaned)
        .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, agentId)))
        .returning();
      if (!updated) return undefined;
      await emitDomainEvent(tx, ctx, {
        type: "agent.updated",
        actor: { kind: "founder", id: null },
        agentId,
        payload: { diff: cleaned },
      });
      return updated;
    });
  }

  async get(ctx: CompanyContext, agentId: string): Promise<AgentRow | undefined> {
    const [row] = await this.db
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, agentId)));
    return row;
  }

  /**
   * Walkthrough bulgusu (2026-08-19): işten çıkarılan ajan varsayılan
   * listede GÖRÜNMEZ — satır silinmez (geçmiş, olaylar, anılar kalır),
   * yalnız görünümden düşer. include="all" eski çalışanları da getirir.
   */
  async list(
    ctx: CompanyContext,
    opts: { include?: "active" | "all" | undefined } = {},
  ): Promise<AgentRow[]> {
    return this.db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.companyId, ctx.companyId),
          ...(opts.include === "all" ? [] : [sql`${agents.status} <> 'offboarded'`]),
        ),
      )
      .orderBy(asc(agents.employeeNumber));
  }

  // ---------- model bindings (05 §7 — hot-swap, identity untouched) ----------

  async setBinding(
    ctx: CompanyContext,
    agentId: string,
    input: {
      purpose: BindingPurpose;
      providerId: string;
      model: string;
      params?: Record<string, unknown> | undefined;
      priority?: number | undefined;
    },
  ): Promise<BindingRow> {
    return this.db.transaction(async (tx) => {
      const priority = input.priority ?? 0;
      const [existing] = await tx
        .select()
        .from(agentModelBindings)
        .where(
          and(
            eq(agentModelBindings.companyId, ctx.companyId),
            eq(agentModelBindings.agentId, agentId),
            eq(agentModelBindings.purpose, input.purpose),
            eq(agentModelBindings.priority, priority),
          ),
        );
      const values = {
        providerId: input.providerId,
        model: input.model,
        params: input.params ?? {},
      };
      const [binding] = existing
        ? await tx
            .update(agentModelBindings)
            .set(values)
            .where(eq(agentModelBindings.id, existing.id))
            .returning()
        : await tx
            .insert(agentModelBindings)
            .values({
              companyId: ctx.companyId,
              agentId,
              purpose: input.purpose,
              priority,
              ...values,
            })
            .returning();
      await emitDomainEvent(tx, ctx, {
        type: "agent.model.binding.changed",
        actor: { kind: "founder", id: null },
        agentId,
        payload: { agentId, diff: { purpose: input.purpose, model: input.model, priority } },
      });
      return binding!;
    });
  }

  async listBindings(ctx: CompanyContext, agentId: string): Promise<BindingRow[]> {
    return this.db
      .select()
      .from(agentModelBindings)
      .where(
        and(eq(agentModelBindings.companyId, ctx.companyId), eq(agentModelBindings.agentId, agentId)),
      )
      .orderBy(asc(agentModelBindings.purpose), asc(agentModelBindings.priority));
  }

  // ---------- sessions read API (rows appear with T31) ----------

  async listSessions(ctx: CompanyContext, agentId: string) {
    return this.db
      .select()
      .from(agentSessions)
      .where(and(eq(agentSessions.companyId, ctx.companyId), eq(agentSessions.agentId, agentId)))
      .orderBy(desc(agentSessions.startedAt))
      .limit(50);
  }

  /**
   * Komuta merkezi oturum hücreleri (2026-08-18): şirket genelindeki CANLI
   * ajan oturumları + son 10 dakikada bitenler (hücre "tamamlandı" olarak
   * sönümlenip kaybolsun diye) — ajan adı ve görev etiketiyle zenginleşmiş.
   */
  async listCompanySessions(ctx: CompanyContext, opts: { limit: number }) {
    const rows = await this.db
      .select({
        session: agentSessions,
        agentName: agents.name,
        taskNumber: tasks.number,
        taskTitle: tasks.title,
      })
      .from(agentSessions)
      .leftJoin(agents, eq(agentSessions.agentId, agents.id))
      .leftJoin(tasks, eq(agentSessions.taskId, tasks.id))
      .where(
        and(
          eq(agentSessions.companyId, ctx.companyId),
          or(
            sql`${agentSessions.status} IN ('starting','running','waiting')`,
            sql`${agentSessions.endedAt} >= now() - interval '10 minutes'`,
          ),
        ),
      )
      .orderBy(desc(agentSessions.startedAt))
      .limit(opts.limit);
    return rows.map((r) => ({
      id: r.session.id,
      agentId: r.session.agentId,
      taskId: r.session.taskId,
      workflowId: r.session.workflowId,
      status: r.session.status,
      currentActivity: r.session.currentActivity,
      startedAt: r.session.startedAt.toISOString(),
      endedAt: r.session.endedAt?.toISOString() ?? null,
      stepsCount: r.session.stepsCount,
      costCents: r.session.costCents,
      agentName: r.agentName ?? null,
      taskNumber: r.taskNumber ?? null,
      taskTitle: r.taskTitle ?? null,
    }));
  }

  /** Founder gözlemi: ajanın adım akışı (agent_steps read-model, en yeni önce). */
  async listSteps(
    ctx: CompanyContext,
    agentId: string,
    opts: { sessionId?: string | undefined; limit: number },
  ) {
    const rows = await this.db
      .select()
      .from(agentSteps)
      .where(
        and(
          eq(agentSteps.companyId, ctx.companyId),
          eq(agentSteps.agentId, agentId),
          ...(opts.sessionId ? [eq(agentSteps.agentSessionId, opts.sessionId)] : []),
        ),
      )
      .orderBy(desc(agentSteps.createdAt))
      .limit(opts.limit);
    return rows.map((s) => ({
      agentSessionId: s.agentSessionId,
      stepNo: s.stepNo,
      actionKind: s.actionKind,
      action: s.action,
      observation: s.observation ?? null,
      tokensIn: s.tokensIn,
      tokensOut: s.tokensOut,
      costCents: s.costCents,
      createdAt: s.createdAt.toISOString(),
    }));
  }
}

export { formatEmployeeNumber };
