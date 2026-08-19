// Typed client SDK (21 §6) — hand-authored from the same Zod source, NOT an
// OpenAPI round-trip. apps/web consumes ONLY this client + @acos/ui.
import { z } from "zod";
import { HealthResponseSchema, type HealthResponse } from "../health.js";
import { ProblemJsonSchema, type ProblemJson } from "../errors.js";
import {
  LoginResponseSchema,
  TotpRequiredResponseSchema,
  OkSchema,
  PatCreatedSchema,
  PatListItemSchema,
  SetupStatusSchema,
  SessionUserSchema,
  type SessionUser,
} from "../auth.js";
import { CompanySchema, CompanySettingsSchema, type Company, type CompanySettings } from "../companies.js";
import {
  ArchiveOrgUnitResponseSchema,
  EscalationChainSchema,
  OrgEdgeSchema,
  OrgUnitSchema,
  PositionSchema,
  TeamRosterEntrySchema,
  type EscalationChain,
  type OrgEdge,
  type OrgUnit,
  type Position,
} from "../org.js";
import {
  AgentSchema,
  AgentSessionSchema,
  AgentStepSchema,
  CompanyAgentSessionSchema,
  ModelBindingSchema,
  type Agent,
  type ModelBinding,
} from "../agents.js";
import {
  EventSchema,
  EventListResponseSchema,
  EventReplayResponseSchema,
  type Event,
  type EventListResponse,
  type EventReplayResponse,
} from "../events.js";
import { ChannelSchema, MessageSchema } from "../comms.js";
import {
  ApprovalSchema,
  ApprovalDetailSchema,
  type Approval,
  type ApprovalDetail,
  type ApprovalVerdictRequest,
} from "../approvals.js";
import {
  ToolDefinitionSchema,
  ToolPermissionItemSchema,
  type ToolDefinition,
  type ToolPermissionItem,
  type GrantToolPermissionRequest,
} from "../tools.js";
import {
  TaskSchema,
  TaskAssignmentSchema,
  TaskDependenciesResponseSchema,
  TaskDependencySchema,
  TaskTreeNodeSchema,
  TopExecutiveResponseSchema,
  type Task,
  type TaskAssignment,
  type TaskTreeNode,
} from "../tasks.js";
import { TerminalListResponseSchema, type TerminalListResponse } from "../terminals.js";
import { OfficeLayoutSchema, type OfficeLayout } from "../office.js";
import {
  ArtifactDtoSchema,
  ProjectDtoSchema,
  ProjectListResponseSchema,
  type ArtifactDto,
  type CreateProjectRequest,
  type ProjectDto,
  type ProjectListResponse,
} from "../projects.js";
import {
  ReviewDiffResponseSchema,
  ReviewListResponseSchema,
  type ReviewDiffResponse,
  type ReviewListResponse,
} from "../reviews.js";
import {
  PromoteSkillResponseSchema,
  SkillCandidatesResponseSchema,
  SkillMatrixResponseSchema,
  type PromoteSkillRequest,
  type PromoteSkillResponse,
  type SkillCandidatesResponse,
  type SkillMatrixResponse,
} from "../skills.js";
import {
  ContradictionQueueResponseSchema,
  FounderMemoryPatchResponseSchema,
  MemoryDetailResponseSchema,
  MemoryGraphResponseSchema,
  MemoryListResponseSchema,
  type ContradictionQueueResponse,
  type FounderMemoryPatch,
  type FounderMemoryPatchResponse,
  type MemoryDetailResponse,
  type MemoryGraphResponse,
  type MemoryListResponse,
  type ResolveContradictionRequest,
} from "../memories.js";
import {
  CostEntriesResponseSchema,
  CostForecastResponseSchema,
  CostSummaryResponseSchema,
  LlmUsageResponseSchema,
  ReportListResponseSchema,
  type CostEntriesResponse,
  type CostForecastResponse,
  type LlmUsageResponse,
  type CostSummaryResponse,
  type ReportListResponse,
} from "../costs.js";

export interface EventListFilters {
  types?: string[];
  actorKind?: "agent" | "founder" | "system";
  actorId?: string;
  taskId?: string;
  projectId?: string;
  agentId?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

export class AcosApiError extends Error {
  constructor(public readonly problem: ProblemJson) {
    super(`${problem.code}: ${problem.detail ?? problem.title}`);
    this.name = "AcosApiError";
  }
}

export interface AcosClientOptions {
  baseUrl: string;
  /** PAT bearer; session-cookie auth needs no token (browser sends the cookie). */
  token?: string;
  fetch?: typeof fetch;
}

const LoginResultSchema = z.union([LoginResponseSchema, TotpRequiredResponseSchema]);

function readCsrfCookie(): string | null {
  // contracts compiles without DOM libs; the browser document is probed lazily.
  const doc = (globalThis as { document?: { cookie: string } }).document;
  if (!doc) return null;
  const match = /(?:^|;\s*)acos_csrf=([^;]+)/.exec(doc.cookie);
  return match?.[1] ?? null;
}

export function createAcosClient(options: AcosClientOptions) {
  const fetchImpl = options.fetch ?? fetch;

  async function request(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (method !== "GET") {
      const csrf = readCsrfCookie();
      if (csrf) headers["x-csrf-token"] = csrf;
    }
    const response = await fetchImpl(`${options.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
      credentials: "include",
    });
    const text = await response.text();
    const json: unknown = text === "" ? null : JSON.parse(text);
    if (!response.ok) {
      const problem = ProblemJsonSchema.safeParse(json);
      if (problem.success) throw new AcosApiError(problem.data);
      throw new Error(`HTTP ${response.status} at ${path}`);
    }
    return json;
  }

  const get = (path: string) => request("GET", path);
  const post = (path: string, body?: unknown) => request("POST", path, body);
  const patch = (path: string, body?: unknown) => request("PATCH", path, body);
  const del = (path: string) => request("DELETE", path);

  return {
    health: {
      get: async (): Promise<HealthResponse> => HealthResponseSchema.parse(await get("/api/health")),
    },
    auth: {
      setupStatus: async () => SetupStatusSchema.parse(await get("/api/v1/auth/setup")),
      setup: async (body: { email: string; password: string; displayName: string }) =>
        LoginResponseSchema.parse(await post("/api/v1/auth/setup", body)),
      login: async (body: { email: string; password: string; totpCode?: string }) =>
        LoginResultSchema.parse(await post("/api/v1/auth/login", body)),
      logout: async () => OkSchema.parse(await post("/api/v1/auth/logout")),
      me: async (): Promise<SessionUser> => SessionUserSchema.parse(await get("/api/v1/auth/me")),
      createPat: async (body: { name: string; scopes: string[]; expiresAt?: string }) =>
        PatCreatedSchema.parse(await post("/api/v1/auth/pats", body)),
      listPats: async () => z.array(PatListItemSchema).parse(await get("/api/v1/auth/pats")),
    },
    companies: {
      list: async (): Promise<Company[]> => z.array(CompanySchema).parse(await get("/api/v1/companies")),
      create: async (body: { name: string; slug: string; currency?: string }): Promise<Company> =>
        CompanySchema.parse(await post("/api/v1/companies", body)),
      get: async (companyId: string): Promise<Company> =>
        CompanySchema.parse(await get(`/api/v1/companies/${companyId}`)),
      settings: async (companyId: string): Promise<CompanySettings> =>
        CompanySettingsSchema.parse(await get(`/api/v1/companies/${companyId}/settings`)),
      updateSettings: async (companyId: string, body: Partial<CompanySettings>) =>
        CompanySettingsSchema.parse(await request("PATCH", `/api/v1/companies/${companyId}/settings`, body)),
    },
    org: {
      listUnits: async (companyId: string): Promise<OrgUnit[]> =>
        z.array(OrgUnitSchema).parse(await get(`/api/v1/companies/${companyId}/org/units`)),
      createUnit: async (
        companyId: string,
        body: { name: string; slug: string; kind: "department" | "team" | "office" | "division"; parentId?: string | null },
      ): Promise<OrgUnit> =>
        OrgUnitSchema.parse(await post(`/api/v1/companies/${companyId}/org/units`, body)),
      moveUnit: async (companyId: string, unitId: string, parentId: string | null): Promise<OrgUnit> =>
        OrgUnitSchema.parse(
          await request("PATCH", `/api/v1/companies/${companyId}/org/units/${unitId}`, { parentId }),
        ),
      archiveUnit: async (companyId: string, unitId: string): Promise<{ id: string; archivedAt: string }> =>
        ArchiveOrgUnitResponseSchema.parse(
          await post(`/api/v1/companies/${companyId}/org/units/${unitId}/archive`, {}),
        ),
      listPositions: async (companyId: string): Promise<Position[]> =>
        z.array(PositionSchema).parse(await get(`/api/v1/companies/${companyId}/org/positions`)),
      updatePositionRole: async (
        companyId: string,
        positionId: string,
        defaultRole: string,
      ): Promise<Position> =>
        PositionSchema.parse(
          await patch(`/api/v1/companies/${companyId}/org/positions/${positionId}`, {
            defaultRole,
          }),
        ),
      archivePosition: async (companyId: string, positionId: string): Promise<{ id: string; archivedAt: string }> =>
        ArchiveOrgUnitResponseSchema.parse(
          await post(`/api/v1/companies/${companyId}/org/positions/${positionId}/archive`, {}),
        ),
      createPosition: async (
        companyId: string,
        body: { title: string; seniorityTrack: string[]; defaultRole: string; description?: string },
      ): Promise<Position> =>
        PositionSchema.parse(await post(`/api/v1/companies/${companyId}/org/positions`, body)),
      listEdges: async (companyId: string): Promise<OrgEdge[]> =>
        z.array(OrgEdgeSchema).parse(await get(`/api/v1/companies/${companyId}/org/edges`)),
      createEdge: async (
        companyId: string,
        body: { fromAgentId: string; kind: string; toAgentId?: string; toUnitId?: string },
      ): Promise<OrgEdge> =>
        OrgEdgeSchema.parse(await post(`/api/v1/companies/${companyId}/org/edges`, body)),
      chain: async (companyId: string, agentId: string): Promise<EscalationChain> =>
        EscalationChainSchema.parse(
          await get(`/api/v1/companies/${companyId}/org/agents/${agentId}/chain`),
        ),
      roster: async (companyId: string, unitId: string) =>
        z
          .array(TeamRosterEntrySchema)
          .parse(await get(`/api/v1/companies/${companyId}/org/units/${unitId}/roster`)),
    },
    agents: {
      list: async (companyId: string, opts: { include?: "active" | "all" } = {}): Promise<Agent[]> =>
        z
          .array(AgentSchema)
          .parse(
            await get(
              `/api/v1/companies/${companyId}/agents${opts.include ? `?include=${opts.include}` : ""}`,
            ),
          ),
      get: async (companyId: string, agentId: string): Promise<Agent> =>
        AgentSchema.parse(await get(`/api/v1/companies/${companyId}/agents/${agentId}`)),
      hire: async (
        companyId: string,
        body: {
          name: string;
          positionId: string;
          orgUnitId: string;
          seniority: string;
          autonomyLevel: number;
          persona: string;
          managerAgentId?: string | null;
          leadsUnit?: boolean;
          activate?: boolean;
          avatarId?: string;
          expertise?: string[];
          projectId?: string;
          modelBinding?: { provider: string; model: string };
        },
      ): Promise<Agent> =>
        AgentSchema.parse(await post(`/api/v1/companies/${companyId}/agents`, body)),
      changePlacement: async (
        companyId: string,
        agentId: string,
        body: {
          orgUnitId?: string;
          positionId?: string;
          seniority?: string;
          managerAgentId?: string | null;
        },
      ): Promise<Agent> =>
        AgentSchema.parse(
          await request("PATCH", `/api/v1/companies/${companyId}/agents/${agentId}/placement`, body),
        ),
      lifecycle: async (
        companyId: string,
        agentId: string,
        action: "activate" | "pause" | "resume" | "offboard",
        body?: { reason?: string; topLevel?: boolean },
      ): Promise<Agent> =>
        AgentSchema.parse(
          await post(`/api/v1/companies/${companyId}/agents/${agentId}/${action}`, body ?? {}),
        ),
      // TASK 11: binding seçim kaynağı
      modelRegistry: async (
        companyId: string,
      ): Promise<{ profiles: Array<{ purpose: string; model: string; priority: number; provider: string; providerId: string }> }> =>
        (await get(`/api/v1/companies/${companyId}/model-registry`)) as {
          profiles: Array<{ purpose: string; model: string; priority: number; provider: string; providerId: string }>;
        },
      setBinding: async (
        companyId: string,
        agentId: string,
        body: { purpose: string; providerId: string; model: string; priority?: number },
      ): Promise<ModelBinding> =>
        ModelBindingSchema.parse(
          await request("PUT", `/api/v1/companies/${companyId}/agents/${agentId}/model-bindings`, body),
        ),
      listBindings: async (companyId: string, agentId: string): Promise<ModelBinding[]> =>
        z
          .array(ModelBindingSchema)
          .parse(await get(`/api/v1/companies/${companyId}/agents/${agentId}/model-bindings`)),
      listSessions: async (companyId: string, agentId: string) =>
        z
          .array(AgentSessionSchema)
          .parse(await get(`/api/v1/companies/${companyId}/agents/${agentId}/sessions`)),
      // Komuta merkezi oturum hücreleri: şirket genelindeki canlı (+ yeni
      // bitmiş) ajan oturumları — ajan adı ve görev etiketiyle zenginleşmiş.
      companySessions: async (companyId: string, opts: { limit?: number } = {}) => {
        const search = new URLSearchParams();
        if (opts.limit) search.set("limit", String(opts.limit));
        const qs = search.toString();
        return z
          .array(CompanyAgentSessionSchema)
          .parse(await get(`/api/v1/companies/${companyId}/agent-sessions${qs ? `?${qs}` : ""}`));
      },
      steps: async (
        companyId: string,
        agentId: string,
        opts: { sessionId?: string; limit?: number } = {},
      ) => {
        const search = new URLSearchParams();
        if (opts.sessionId) search.set("sessionId", opts.sessionId);
        if (opts.limit) search.set("limit", String(opts.limit));
        const qs = search.toString();
        return z
          .array(AgentStepSchema)
          .parse(
            await get(`/api/v1/companies/${companyId}/agents/${agentId}/steps${qs ? `?${qs}` : ""}`),
          );
      },
    },
    tasks: {
      list: async (
        companyId: string,
        filters: Record<string, string | string[] | undefined> = {},
      ): Promise<Task[]> => {
        const search = new URLSearchParams();
        for (const [key, value] of Object.entries(filters)) {
          if (value === undefined) continue;
          for (const v of Array.isArray(value) ? value : [value]) search.append(key, v);
        }
        const qs = search.toString();
        return z
          .array(TaskSchema)
          .parse(await get(`/api/v1/companies/${companyId}/tasks${qs ? `?${qs}` : ""}`));
      },
      create: async (
        companyId: string,
        body: {
          kind: string;
          title: string;
          objective: string;
          parentId?: string;
          projectId?: string;
          priority?: string;
          risk?: string;
          successCriteria?: string[];
          budgetCents?: number;
          deadline?: string;
          orgUnitId?: string;
        },
      ): Promise<Task> =>
        TaskSchema.parse(await post(`/api/v1/companies/${companyId}/tasks`, body)),
      get: async (companyId: string, taskId: string): Promise<Task> =>
        TaskSchema.parse(await get(`/api/v1/companies/${companyId}/tasks/${taskId}`)),
      update: async (companyId: string, taskId: string, body: Record<string, unknown>): Promise<Task> =>
        TaskSchema.parse(
          await request("PATCH", `/api/v1/companies/${companyId}/tasks/${taskId}`, body),
        ),
      transition: async (
        companyId: string,
        taskId: string,
        body: { to: string; reason?: string },
      ): Promise<Task> =>
        TaskSchema.parse(
          await post(`/api/v1/companies/${companyId}/tasks/${taskId}/transitions`, body),
        ),
      /** Şirketin tepe yöneticisi (CEO) — arayüzün "kim patron" cevabı. */
      topExecutive: async (companyId: string) =>
        TopExecutiveResponseSchema.parse(
          await get(`/api/v1/companies/${companyId}/tasks/top-executive`),
        ),
      /** Founder direktifi: hedefi tek istekte CEO'ya ver. */
      directive: async (
        companyId: string,
        body: {
          title: string;
          objective: string;
          priority?: string;
          successCriteria?: string[];
          projectId?: string;
        },
      ): Promise<Task> =>
        TaskSchema.parse(await post(`/api/v1/companies/${companyId}/directives`, body)),
      /** Panodan kaldır / geri getir — silmez, satır ve olaylar yerinde kalır. */
      // "Rafa kaldır" (2026-08-19): tüm görevleri (veya bir projeninkileri)
      // yasal geçişlerle iptal edip arşivler — silme yok, anılar kalır.
      shelve: async (
        companyId: string,
        projectId?: string,
      ): Promise<{ scanned: number; cancelled: number; archived: number; cancelFailed: string[] }> =>
        (await post(`/api/v1/companies/${companyId}/tasks/shelve`, projectId ? { projectId } : {})) as {
          scanned: number;
          cancelled: number;
          archived: number;
          cancelFailed: string[];
        },
      archive: async (companyId: string, taskId: string, archived: boolean): Promise<Task> =>
        TaskSchema.parse(
          await post(`/api/v1/companies/${companyId}/tasks/${taskId}/archive`, { archived }),
        ),
      tree: async (companyId: string, taskId: string): Promise<{ root: TaskTreeNode }> =>
        z
          .object({ root: TaskTreeNodeSchema })
          .parse(await get(`/api/v1/companies/${companyId}/tasks/${taskId}/tree`)),
      dependencies: async (companyId: string, taskId: string) =>
        TaskDependenciesResponseSchema.parse(
          await get(`/api/v1/companies/${companyId}/tasks/${taskId}/dependencies`),
        ),
      dag: async (companyId: string) =>
        z
          .object({ edges: z.array(TaskDependencySchema) })
          .parse(await get(`/api/v1/companies/${companyId}/tasks/dag`)),
      addDependency: async (companyId: string, taskId: string, dependsOnTaskId: string) =>
        TaskDependencySchema.parse(
          await post(`/api/v1/companies/${companyId}/tasks/${taskId}/dependencies`, {
            dependsOnTaskId,
          }),
        ),
      assignments: async (companyId: string, taskId: string): Promise<TaskAssignment[]> =>
        z
          .array(TaskAssignmentSchema)
          .parse(await get(`/api/v1/companies/${companyId}/tasks/${taskId}/assignments`)),
      assign: async (
        companyId: string,
        taskId: string,
        body: { agentId: string; role?: "owner" | "reviewer" | "qa" | "collaborator"; reason?: string },
      ): Promise<Task> =>
        TaskSchema.parse(
          await post(`/api/v1/companies/${companyId}/tasks/${taskId}/assignments`, body),
        ),
    },
    comms: {
      listChannels: async (companyId: string, kind?: string) =>
        z
          .array(ChannelSchema)
          .parse(await get(`/api/v1/companies/${companyId}/channels${kind ? `?kind=${kind}` : ""}`)),
      openDm: async (companyId: string, agentId: string) =>
        ChannelSchema.parse(
          await post(`/api/v1/companies/${companyId}/channels`, { kind: "dm", agentId }),
        ),
      messages: async (
        companyId: string,
        channelId: string,
        opts: { beforeId?: string; limit?: number } = {},
      ) => {
        const search = new URLSearchParams();
        if (opts.beforeId) search.set("beforeId", opts.beforeId);
        if (opts.limit) search.set("limit", String(opts.limit));
        const qs = search.toString();
        return z
          .array(MessageSchema)
          .parse(
            await get(
              `/api/v1/companies/${companyId}/channels/${channelId}/messages${qs ? `?${qs}` : ""}`,
            ),
          );
      },
      send: async (
        companyId: string,
        channelId: string,
        body: { kind?: string; body: string; mentions?: string[]; refs?: Array<{ kind: string; id: string }> },
      ) =>
        MessageSchema.parse(
          await post(`/api/v1/companies/${companyId}/channels/${channelId}/messages`, body),
        ),
      markRead: async (companyId: string, channelId: string) =>
        z
          .object({ ok: z.boolean() })
          .parse(await post(`/api/v1/companies/${companyId}/channels/${channelId}/read`)),
    },
    events: {
      list: async (companyId: string, filters: EventListFilters = {}): Promise<EventListResponse> => {
        const search = new URLSearchParams();
        for (const type of filters.types ?? []) search.append("types", type);
        for (const key of ["actorKind", "actorId", "taskId", "projectId", "agentId", "from", "to", "cursor"] as const) {
          const value = filters[key];
          if (value !== undefined) search.set(key, value);
        }
        if (filters.limit !== undefined) search.set("limit", String(filters.limit));
        const qs = search.toString();
        return EventListResponseSchema.parse(
          await get(`/api/v1/companies/${companyId}/events${qs ? `?${qs}` : ""}`),
        );
      },
      replay: async (
        companyId: string,
        afterSeq: number,
        limit?: number,
      ): Promise<EventReplayResponse> =>
        EventReplayResponseSchema.parse(
          await get(
            `/api/v1/companies/${companyId}/events/replay?afterSeq=${afterSeq}${limit !== undefined ? `&limit=${limit}` : ""}`,
          ),
        ),
      get: async (companyId: string, eventId: string): Promise<Event> =>
        EventSchema.parse(await get(`/api/v1/companies/${companyId}/events/${eventId}`)),
    },
    reviews: {
      listForTask: async (companyId: string, taskId: string): Promise<ReviewListResponse> =>
        ReviewListResponseSchema.parse(
          await get(`/api/v1/companies/${companyId}/tasks/${taskId}/reviews`),
        ),
      diff: async (companyId: string, reviewId: string): Promise<ReviewDiffResponse> =>
        ReviewDiffResponseSchema.parse(
          await get(`/api/v1/companies/${companyId}/reviews/${reviewId}/diff`),
        ),
    },
    skills: {
      matrix: async (companyId: string): Promise<SkillMatrixResponse> =>
        SkillMatrixResponseSchema.parse(await get(`/api/v1/companies/${companyId}/skills/matrix`)),
      candidates: async (companyId: string): Promise<SkillCandidatesResponse> =>
        SkillCandidatesResponseSchema.parse(
          await get(`/api/v1/companies/${companyId}/skills/candidates`),
        ),
      promote: async (companyId: string, body: PromoteSkillRequest): Promise<PromoteSkillResponse> =>
        PromoteSkillResponseSchema.parse(
          await post(`/api/v1/companies/${companyId}/skills/candidates/promote`, body),
        ),
    },
    costs: {
      llmUsage: async (companyId: string): Promise<LlmUsageResponse> =>
        LlmUsageResponseSchema.parse(await get(`/api/v1/companies/${companyId}/llm/usage`)),
      summary: async (
        companyId: string,
        filters: { groupBy?: "kind" | "agent" | "project" | "task"; from?: string; to?: string } = {},
      ): Promise<CostSummaryResponse> => {
        const params = new URLSearchParams(
          Object.entries(filters).filter(([, v]) => v !== undefined) as string[][],
        ).toString();
        return CostSummaryResponseSchema.parse(
          await get(`/api/v1/companies/${companyId}/costs${params ? `?${params}` : ""}`),
        );
      },
      entries: async (
        companyId: string,
        filters: { taskId?: string; projectId?: string; limit?: number } = {},
      ): Promise<CostEntriesResponse> => {
        const params = new URLSearchParams(
          Object.entries(filters)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, String(v)]),
        ).toString();
        return CostEntriesResponseSchema.parse(
          await get(`/api/v1/companies/${companyId}/costs/entries${params ? `?${params}` : ""}`),
        );
      },
      forecast: async (companyId: string): Promise<CostForecastResponse> =>
        CostForecastResponseSchema.parse(
          await get(`/api/v1/companies/${companyId}/costs/forecast`),
        ),
    },
    reports: {
      list: async (companyId: string): Promise<ReportListResponse> =>
        ReportListResponseSchema.parse(await get(`/api/v1/companies/${companyId}/reports`)),
    },
    memories: {
      list: async (
        companyId: string,
        filters: { scope?: string; type?: string; status?: string; q?: string } = {},
      ): Promise<MemoryListResponse> => {
        const params = new URLSearchParams(
          Object.entries(filters).filter(([, v]) => v !== undefined && v !== "") as string[][],
        ).toString();
        return MemoryListResponseSchema.parse(
          await get(`/api/v1/companies/${companyId}/memories${params ? `?${params}` : ""}`),
        );
      },
      detail: async (companyId: string, memoryId: string): Promise<MemoryDetailResponse> =>
        MemoryDetailResponseSchema.parse(
          await get(`/api/v1/companies/${companyId}/memories/${memoryId}`),
        ),
      graph: async (companyId: string): Promise<MemoryGraphResponse> =>
        MemoryGraphResponseSchema.parse(await get(`/api/v1/companies/${companyId}/memories/graph`)),
      contradictions: async (companyId: string): Promise<ContradictionQueueResponse> =>
        ContradictionQueueResponseSchema.parse(
          await get(`/api/v1/companies/${companyId}/memories/contradictions`),
        ),
      resolveContradiction: async (
        companyId: string,
        relationId: string,
        body: ResolveContradictionRequest,
      ): Promise<{ loserMemoryId: string }> =>
        (await post(
          `/api/v1/companies/${companyId}/memories/contradictions/${relationId}/resolve`,
          body,
        )) as { loserMemoryId: string },
      founderPatch: async (
        companyId: string,
        memoryId: string,
        body: FounderMemoryPatch,
      ): Promise<FounderMemoryPatchResponse> =>
        FounderMemoryPatchResponseSchema.parse(
          await patch(`/api/v1/companies/${companyId}/memories/${memoryId}`, body),
        ),
    },
    projects: {
      list: async (companyId: string): Promise<ProjectListResponse> =>
        ProjectListResponseSchema.parse(await get(`/api/v1/companies/${companyId}/projects`)),
      create: async (companyId: string, body: CreateProjectRequest): Promise<ProjectDto> =>
        ProjectDtoSchema.parse(await post(`/api/v1/companies/${companyId}/projects`, body)),
      get: async (companyId: string, projectId: string): Promise<ProjectDto> =>
        ProjectDtoSchema.parse(
          await get(`/api/v1/companies/${companyId}/projects/${projectId}`),
        ),
      report: async (companyId: string, projectId: string): Promise<ArtifactDto> =>
        ArtifactDtoSchema.parse(
          await get(`/api/v1/companies/${companyId}/projects/${projectId}/report`),
        ),
      // TASK 18/20: understanding + hedef + gözlemlenebilirlik
      understanding: async (companyId: string, projectId: string): Promise<Record<string, unknown>> =>
        (await get(`/api/v1/companies/${companyId}/projects/${projectId}/understanding`)) as Record<string, unknown>,
      setGoal: async (
        companyId: string,
        projectId: string,
        objective: string,
      ): Promise<{ started: boolean; state: string }> =>
        (await post(`/api/v1/companies/${companyId}/projects/${projectId}/goal`, { objective })) as {
          started: boolean;
          state: string;
        },
      overview: async (companyId: string, projectId: string): Promise<Record<string, unknown>> =>
        (await get(`/api/v1/companies/${companyId}/projects/${projectId}/overview`)) as Record<string, unknown>,
      continuePlanning: async (
        companyId: string,
        projectId: string,
      ): Promise<{ state: string }> =>
        (await post(
          `/api/v1/companies/${companyId}/projects/${projectId}/planning/continue`,
          {},
        )) as { state: string },
      // proje rafa kalkar: görevleri iptal+arşiv, proje archived/cancelled
      shelve: async (
        companyId: string,
        projectId: string,
      ): Promise<{
        projectId: string;
        projectStatus: string;
        scanned: number;
        cancelled: number;
        archived: number;
        cancelFailed: string[];
      }> =>
        (await post(`/api/v1/companies/${companyId}/projects/${projectId}/shelve`, {})) as {
          projectId: string;
          projectStatus: string;
          scanned: number;
          cancelled: number;
          archived: number;
          cancelFailed: string[];
        },
    },
    office: {
      layout: async (companyId: string): Promise<OfficeLayout> =>
        OfficeLayoutSchema.parse(await get(`/api/v1/companies/${companyId}/office/layout`)),
    },
    terminals: {
      list: async (
        companyId: string,
        filters: { status?: "active" | "closed"; limit?: number } = {},
      ): Promise<TerminalListResponse> => {
        const search = new URLSearchParams();
        if (filters.status !== undefined) search.set("status", filters.status);
        if (filters.limit !== undefined) search.set("limit", String(filters.limit));
        const qs = search.toString();
        return TerminalListResponseSchema.parse(
          await get(`/api/v1/companies/${companyId}/terminals${qs ? `?${qs}` : ""}`),
        );
      },
      /** Full scrollback download URL (REST, founder/admin). */
      logUrl: (companyId: string, sessionId: string): string =>
        `${options.baseUrl}/api/v1/companies/${companyId}/terminals/${sessionId}/log`,
      // Interactive shell (REVISION TASK 2): takeover/return + PTY input
      control: async (
        companyId: string,
        sessionId: string,
        holder: "agent" | "human",
      ): Promise<{ sessionId: string; holder: "agent" | "human" }> =>
        (await post(`/api/v1/companies/${companyId}/terminals/${sessionId}/control`, {
          holder,
        })) as { sessionId: string; holder: "agent" | "human" },
      getControl: async (
        companyId: string,
        sessionId: string,
      ): Promise<{ sessionId: string; holder: "agent" | "human" }> =>
        (await get(`/api/v1/companies/${companyId}/terminals/${sessionId}/control`)) as {
          sessionId: string;
          holder: "agent" | "human";
        },
      openShell: async (
        companyId: string,
        sessionId: string,
        size: { cols: number; rows: number },
      ): Promise<{ sessionId: string; opened: boolean }> =>
        (await post(`/api/v1/companies/${companyId}/terminals/${sessionId}/shell/open`, size)) as {
          sessionId: string;
          opened: boolean;
        },
      write: async (companyId: string, sessionId: string, dataBase64: string): Promise<void> => {
        await post(`/api/v1/companies/${companyId}/terminals/${sessionId}/write`, { dataBase64 });
      },
      resize: async (
        companyId: string,
        sessionId: string,
        size: { cols: number; rows: number },
      ): Promise<void> => {
        await post(`/api/v1/companies/${companyId}/terminals/${sessionId}/resize`, size);
      },
      // Preview Gateway (REVISION TASK 3): workspace'te dinleyen portlar
      workspacePorts: async (
        companyId: string,
        workspaceId: string,
      ): Promise<{ workspaceId: string; ports: Array<{ port: number; previewUrl: string }> }> =>
        (await get(`/api/v1/companies/${companyId}/workspaces/${workspaceId}/ports`)) as {
          workspaceId: string;
          ports: Array<{ port: number; previewUrl: string }>;
        },
    },
    approvals: {
      list: async (companyId: string, filters: { status?: "pending" | "approved" | "rejected" | "expired" } = {}): Promise<Approval[]> => {
        const qs = new URLSearchParams();
        if (filters.status) qs.set("status", filters.status);
        return z
          .array(ApprovalSchema)
          .parse(await get(`/api/v1/companies/${companyId}/approvals${qs ? `?${qs}` : ""}`));
      },
      get: async (companyId: string, approvalId: string): Promise<ApprovalDetail> =>
        ApprovalDetailSchema.parse(
          await get(`/api/v1/companies/${companyId}/approvals/${approvalId}`),
        ),
      verdict: async (
        companyId: string,
        approvalId: string,
        body: ApprovalVerdictRequest,
      ): Promise<Approval> =>
        ApprovalSchema.parse(
          await post(`/api/v1/companies/${companyId}/approvals/${approvalId}/verdict`, body),
        ),
    },
    integrations: {
      github: {
        connections: async (
          companyId: string,
        ): Promise<
          Array<{ id: string; owner: string; scopes: string[]; status: string; lastValidatedAt: string | null }>
        > =>
          (await get(`/api/v1/companies/${companyId}/github/connections`)) as Array<{
            id: string;
            owner: string;
            scopes: string[];
            status: string;
            lastValidatedAt: string | null;
          }>,
        status: async (companyId: string): Promise<{ connected: boolean; owner: string | null }> =>
          (await get(`/api/v1/companies/${companyId}/settings/github`)) as {
            connected: boolean;
            owner: string | null;
          },
        connect: async (
          companyId: string,
          token: string,
        ): Promise<{ connected: boolean; owner: string | null }> =>
          (await request("PUT", `/api/v1/companies/${companyId}/settings/github`, { token })) as {
            connected: boolean;
            owner: string | null;
          },
        disconnect: async (companyId: string): Promise<void> => {
          await del(`/api/v1/companies/${companyId}/settings/github`);
        },
        publishProject: async (
          companyId: string,
          projectId: string,
        ): Promise<{ published: boolean; remoteUrl: string | null }> =>
          (await post(`/api/v1/companies/${companyId}/projects/${projectId}/github/publish`, {})) as {
            published: boolean;
            remoteUrl: string | null;
          },
      },
    },
    tools: {
      list: async (): Promise<ToolDefinition[]> =>
        z.array(ToolDefinitionSchema).parse(await get("/api/v1/tools")),
      // 2026-08-18: izin CRUD'u şirket kapsamına taşındı (sunucu yüzeyiyle birlikte)
      permissions: {
        list: async (companyId: string): Promise<ToolPermissionItem[]> =>
          z
            .array(ToolPermissionItemSchema)
            .parse(await get(`/api/v1/companies/${companyId}/tools/permissions`)),
        grant: async (
          companyId: string,
          body: GrantToolPermissionRequest,
        ): Promise<{ id: string }> =>
          (await post(`/api/v1/companies/${companyId}/tools/permissions`, body)) as { id: string },
        revoke: async (companyId: string, permissionId: string): Promise<void> => {
          await del(`/api/v1/companies/${companyId}/tools/permissions/${permissionId}`);
        },
      },
    },
  };
}

export type AcosClient = ReturnType<typeof createAcosClient>;
