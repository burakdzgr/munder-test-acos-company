// E2/W3+W5 (T19) — kadro önerisinin REST yüzeyi.
//
// Founder ucu: öneriyi oku, DÜZENLE (takım ekle / kişi sayısı değiştir),
// onayla ya da iptal et. Onay, planlamayı BEKLEYEN iş akışını uyandırır
// (W5 sinyali) — sinyal gidemezse (worker kapalı) uygulama yerinde yapılır,
// yani Founder'ın onayı hiçbir koşulda kaybolmaz.
//
// Internal uç: worker'ın öneri aktivitesi (W4) buraya yazar. Aynı desen
// `/internal/v1/staffing/continue` ile birebir aynı (Bearer internal token).
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { companyContext, ProjectsService, type GuardedDb } from "@acos/db";
import { ApiError } from "../../app.js";
import type { CompanyService } from "../companies/service.js";
import {
  applyProposal,
  cancelProposal,
  confirmProposal,
  editProposal,
  getOpenProposal,
  getProposal,
  ProposalError,
  upsertProposal,
} from "./proposal.js";

export type ProposalSignaller = (input: {
  workflowId: string;
  proposalId: string;
  decision: "confirmed" | "cancelled";
}) => Promise<void>;

export interface ProposalRoutesDeps {
  guardedDb: () => GuardedDb;
  companiesSvc: () => CompanyService;
  internalApiToken: () => string;
  /** main.ts bağlar; Temporal yoksa null (uygulama yerinde yapılır). */
  proposalSignaller: () => ProposalSignaller | null;
}

const TeamInputSchema = z.object({
  key: z.string().max(60).optional(),
  capability: z.string().min(2).max(60),
  teamName: z.string().min(1).max(80).optional(),
  headcount: z.number().int().min(0).max(50),
  rationale: z.string().max(500).optional(),
});

function mapError(err: unknown): never {
  if (err instanceof ProposalError) {
    if (err.code === "not_found") throw new ApiError("not_found", err.message);
    if (err.code === "stale_version") throw new ApiError("conflict", err.message);
    throw new ApiError("validation_failed", err.message);
  }
  throw err;
}

export async function registerProposalRoutes(
  app: FastifyInstance,
  deps: ProposalRoutesDeps,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  const requireFounder = async (userId: string, companyId: string, what: string) => {
    const role = await deps.companiesSvc().membership(userId, companyId);
    if (!role) throw new ApiError("not_found", "company not found");
    if (role !== "founder") throw new ApiError("forbidden", what);
  };

  // --- Founder: oku -------------------------------------------------------
  typed.get(
    "/api/v1/companies/:companyId/projects/:projectId/staffing-proposal",
    {
      schema: {
        params: z.object({ companyId: z.uuid(), projectId: z.uuid() }),
        tags: ["staffing"],
      },
    },
    async (request) => {
      const user = request.requireUser();
      const { companyId, projectId } = request.params;
      const role = await deps.companiesSvc().membership(user.id, companyId);
      if (!role) throw new ApiError("not_found", "company not found");
      const proposal = await getOpenProposal(
        deps.guardedDb(),
        companyContext(companyId),
        projectId,
      );
      if (!proposal) throw new ApiError("not_found", "bu proje için açık kadro önerisi yok");
      return proposal;
    },
  );

  // --- Founder: DÜZENLE (W3'ün asıl amacı) --------------------------------
  typed.patch(
    "/api/v1/companies/:companyId/staffing-proposals/:proposalId",
    {
      schema: {
        params: z.object({ companyId: z.uuid(), proposalId: z.uuid() }),
        body: z.object({
          version: z.number().int().min(1),
          teams: z.array(TeamInputSchema).max(20),
          rationaleMd: z.string().max(4000).optional(),
        }),
        tags: ["staffing"],
      },
    },
    async (request) => {
      const user = request.requireUser();
      const { companyId, proposalId } = request.params;
      await requireFounder(user.id, companyId, "kadro planını yalnız Founder düzenler");
      try {
        return await editProposal(deps.guardedDb(), companyContext(companyId), {
          proposalId,
          version: request.body.version,
          teams: request.body.teams,
          ...(request.body.rationaleMd !== undefined && { rationaleMd: request.body.rationaleMd }),
        });
      } catch (err) {
        return mapError(err);
      }
    },
  );

  // --- Founder: ONAYLA ----------------------------------------------------
  typed.post(
    "/api/v1/companies/:companyId/staffing-proposals/:proposalId/confirm",
    {
      schema: {
        params: z.object({ companyId: z.uuid(), proposalId: z.uuid() }),
        tags: ["staffing"],
      },
    },
    async (request) => {
      const user = request.requireUser();
      const { companyId, proposalId } = request.params;
      await requireFounder(user.id, companyId, "kadroyu yalnız Founder onaylar");
      const ctx = companyContext(companyId);
      const db = deps.guardedDb();
      let proposal;
      try {
        proposal = await confirmProposal(db, ctx, proposalId);
      } catch (err) {
        return mapError(err);
      }

      // W5: bekleyen iş akışını uyandır. Sinyal gidebilirse UYGULAMAYI O yapar
      // (tek yazar; replay güvenli). Gidemezse — worker kapalı, iş akışı zaman
      // aşımına uğramış, ya da öneri hiç iş akışından doğmamış — Founder'ın
      // onayı kaybolmasın diye burada uygulanır. applyProposal idempotenttir,
      // applyPlan da HEDEF sayıya tamamlar; çifte uygulama ikinci kadro kurmaz.
      let signalled = false;
      const signaller = deps.proposalSignaller();
      if (signaller && proposal.workflowId) {
        signalled = await signaller({
          workflowId: proposal.workflowId,
          proposalId,
          decision: "confirmed",
        })
          .then(() => true)
          .catch(() => false);
      }
      if (signalled) return { ...proposal, resumed: "workflow" as const };

      const applied = await applyProposal(db, ctx, proposalId);
      return { ...applied.proposal, resumed: "inline" as const, hired: applied.hiredAgentIds.length };
    },
  );

  // --- Founder: İPTAL -----------------------------------------------------
  typed.post(
    "/api/v1/companies/:companyId/staffing-proposals/:proposalId/cancel",
    {
      schema: {
        params: z.object({ companyId: z.uuid(), proposalId: z.uuid() }),
        tags: ["staffing"],
      },
    },
    async (request) => {
      const user = request.requireUser();
      const { companyId, proposalId } = request.params;
      await requireFounder(user.id, companyId, "kadro önerisini yalnız Founder iptal eder");
      const ctx = companyContext(companyId);
      let proposal;
      try {
        proposal = await getProposal(deps.guardedDb(), ctx, proposalId);
      } catch (err) {
        return mapError(err);
      }
      const signaller = deps.proposalSignaller();
      if (signaller && proposal.workflowId) {
        await signaller({
          workflowId: proposal.workflowId,
          proposalId,
          decision: "cancelled",
        }).catch(() => {
          /* iş akışı zaten bitmiş olabilir; durum yazımı yeterli */
        });
      }
      return cancelProposal(deps.guardedDb(), ctx, proposalId);
    },
  );

  // --- internal: worker'ın öneri aktivitesi (W4) yazar --------------------
  typed.post(
    "/internal/v1/staffing/proposal",
    {
      schema: {
        body: z.object({
          companyId: z.uuid(),
          projectId: z.uuid(),
          goalTaskId: z.uuid().nullish(),
          workflowId: z.string().max(200).nullish(),
          source: z.enum(["llm", "deterministic"]),
          rationaleMd: z.string().max(4000).optional(),
          teams: z.array(TeamInputSchema).max(20),
        }),
        tags: ["staffing"],
        hide: true,
      },
    },
    async (request, reply) => {
      if (request.headers.authorization !== `Bearer ${deps.internalApiToken()}`) {
        return reply
          .status(401)
          .send({ code: "unauthenticated", message: "internal token required" });
      }
      const { companyId, projectId } = request.body;
      const ctx = companyContext(companyId);
      const db = deps.guardedDb();
      const proposal = await upsertProposal(db, ctx, {
        projectId,
        goalTaskId: request.body.goalTaskId ?? null,
        workflowId: request.body.workflowId ?? null,
        source: request.body.source,
        ...(request.body.rationaleMd !== undefined && { rationaleMd: request.body.rationaleMd }),
        teams: request.body.teams,
      });
      // proje İNSANI bekler — durum bunu dürüstçe söylesin
      await new ProjectsService(db)
        .transition(ctx, projectId, "waiting_for_founder" as never, { kind: "system", id: null })
        .catch(() => {
          /* zaten o durumdaysa ya da geçiş yasaksa öneri yine de duruyor */
        });
      return proposal;
    },
  );

  typed.post(
    "/internal/v1/staffing/proposal/apply",
    {
      schema: {
        body: z.object({ companyId: z.uuid(), proposalId: z.uuid() }),
        tags: ["staffing"],
        hide: true,
      },
    },
    async (request, reply) => {
      if (request.headers.authorization !== `Bearer ${deps.internalApiToken()}`) {
        return reply
          .status(401)
          .send({ code: "unauthenticated", message: "internal token required" });
      }
      const { companyId, proposalId } = request.body;
      try {
        const result = await applyProposal(deps.guardedDb(), companyContext(companyId), proposalId);
        return {
          proposalId: result.proposal.id,
          status: result.proposal.status,
          hired: result.hiredAgentIds.length,
          createdUnits: result.createdUnits,
        };
      } catch (err) {
        return mapError(err);
      }
    },
  );
}
