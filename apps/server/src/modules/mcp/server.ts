// E4/A (T30) — Tool Gateway'in MCP yüzü.
//
// Ajan turu artık konteynerde koşan bir `claude` süreci olabiliyor. O sürecin
// ACOS'a bir yolu olmalı, ama o yol kontrol düzlemini BAYPAS ETMEMELİ: onaylar,
// kadro, roll-up, INV-10 (atamayı Scheduler yapar), INV-14 (incelemeci ≠ yazar),
// WIP tavanları, grant'lar ve bütçe kesicisi CLI oturumu için de aynen işlemeli.
//
// Bu yüzden MCP sunucusu Tool Gateway'in ÜSTÜNE oturur, yanına değil: her araç
// çağrısı ToolGateway.invoke()'a girer — aynı doğrulama, aynı yetkilendirme,
// aynı denetim satırı. Kimlik jetondan türer (bkz. sessions.ts); hiçbir aracın
// argümanında agentId/companyId/taskId yoktur.
//
// Protokol: JSON-RPC 2.0 / MCP. Desteklenen metotlar initialize,
// notifications/initialized, ping, tools/list, tools/call.
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { companyContext, type GuardedDb } from "@acos/db";
import { agents, environments, positions, tasks } from "@acos/db/schema";
import { listTools, type ToolDefinition } from "@acos/tools";
import type { ToolGateway } from "../tools/gateway.js";
import { ACTION_TOOL_NAMES, callActionTool, listActionTools, type ActionToolDeps } from "./actions.js";
import type { McpIdentity } from "./sessions.js";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_SERVER_NAME = "acos";

/** CEO/lider yetenekleri — prompt kataloğundaki rol kapısının aynısı. */
const ORG_TOOLS = new Set([
  "org.team.create",
  "agent.hire",
  "agent.assign_project",
  "model.bind",
  "github.repo.ensure",
]);
const ORG_TOOL_ROLES = new Set(["executive", "manager", "lead"]);

/**
 * MCP araç adları `^[a-z0-9_]{1,64}$` ile sınırlı; kayıttaki noktalı adlar
 * mekanik olarak alt çizgiye çevrilir. Noktalı ad `tool_invocations`'ta,
 * grant'larda ve policy kalıplarında kanonik kalır — düzleştirme yalnız MCP
 * sınırında yaşar.
 */
export function toMcpToolName(toolName: string): string {
  return toolName.replace(/\./g, "_");
}

export interface McpToolListing {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function jsonSchemaOf(tool: ToolDefinition): Record<string, unknown> {
  try {
    const schema = z.toJSONSchema(tool.input as z.ZodType, { io: "input" }) as Record<
      string,
      unknown
    >;
    // MCP `inputSchema` bir nesne şeması olmalı; kayıt bunu zaten sağlıyor,
    // sağlamayan bir tanım gelirse boş nesneye düşülür (araç kaybolmasın).
    return schema.type === "object" ? schema : { type: "object" };
  } catch {
    return { type: "object" };
  }
}

/** Oturuma göre ilan edilen araç kümesi (rol kapısı + proje veritabanı). */
export async function listMcpTools(
  db: GuardedDb,
  identity: McpIdentity,
): Promise<McpToolListing[]> {
  const ctx = companyContext(identity.companyId);
  const [agentRow] = await db
    .select({ defaultRole: positions.defaultRole })
    .from(agents)
    .leftJoin(positions, eq(agents.positionId, positions.id))
    .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, identity.agentId)));
  const role = agentRow?.defaultRole ?? "member";

  let hasProjectDatabase = false;
  if (identity.taskId) {
    const [task] = await db
      .select({ projectId: tasks.projectId })
      .from(tasks)
      .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, identity.taskId)));
    if (task?.projectId) {
      const envRows = await db
        .select({ config: environments.config })
        .from(environments)
        .where(
          and(eq(environments.companyId, ctx.companyId), eq(environments.projectId, task.projectId)),
        );
      hasProjectDatabase = envRows.some((row) => {
        const config = (row.config ?? {}) as Record<string, unknown>;
        return typeof (config.databaseUrl ?? config.database_url) === "string";
      });
    }
  }

  // Family B (şirket fiilleri) HER oturumda ilan edilir: CLI'ın yerleşik
  // araçlarında karşılığı yoktur ve olmamalıdır — görev açmak, iş devretmek,
  // inceleme istemek yalnız buradan geçer.
  const actionTools = listActionTools();
  return actionTools.concat(
    listTools()
    .filter((tool) => {
      if (tool.name === "db.inspect") return hasProjectDatabase;
      if (ORG_TOOLS.has(tool.name)) return ORG_TOOL_ROLES.has(role);
      return true;
    })
    .map((tool) => ({
      name: toMcpToolName(tool.name),
      description: tool.description,
      inputSchema: jsonSchemaOf(tool),
    })),
  );
}

/** Sözleşmedeki tekdüze zarf — Kevin `structuredContent`'i okur, metni değil. */
export interface McpEnvelope {
  ok: boolean;
  decision: "allow" | "deny" | "require_approval";
  status: "denied" | "awaiting_approval" | "dispatched" | "succeeded" | "failed";
  result: unknown;
  reason: string | null;
  /** Family B (escalate) doldurur; kayıt araçlarında onay satırını çağıranın
   *  escalate makinesi açar (17 §"recorded deviations"), bu yüzden null. */
  approvalId: string | null;
  /** `require_approval` kararında ONAYI KİMİN vereceği (founder/manager/…). */
  approver: string | null;
  riskClass: string;
  elevatedFrom: string | null;
  costCents: number;
  retryAfterSec: number | null;
  outputFlagged: boolean;
  invocationId: string | null;
}

export interface McpCallResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: McpEnvelope;
  isError: boolean;
}

function describe(envelope: McpEnvelope, toolName: string): string {
  switch (envelope.status) {
    case "awaiting_approval":
      // Onay bekleyişi HATA DEĞİLDİR. Hata olarak dönseydi model döngüye girip
      // aynı çağrıyı tekrarlardı; burada ne olduğu ve ne yapacağı açıkça yazılı.
      return `${toolName}: ONAY bekliyor (onaylayacak: ${envelope.approver ?? "founder"}). Karar gelene kadar bu çağrı ÇALIŞMADI — başka işe geç, karar sonra düşer.`;
    case "denied":
      return `${toolName} REDDEDİLDİ: ${envelope.reason ?? "izin yok"}`;
    case "failed":
      return `${toolName} BAŞARISIZ: ${envelope.reason ?? "bilinmeyen hata"}`;
    case "dispatched":
      return `${toolName} çalıştırıldı.`;
    default:
      return `${toolName} tamam.`;
  }
}

export interface McpServerDeps extends ActionToolDeps {
  db: () => GuardedDb;
  gateway: () => ToolGateway;
}

/** Bir MCP araç çağrısı → Tool Gateway. Kimlik ARGÜMANDAN DEĞİL jetondan. */
export async function callMcpTool(
  deps: McpServerDeps,
  identity: McpIdentity,
  mcpToolName: string,
  args: unknown,
): Promise<McpCallResult> {
  // Family B: gövde @acos/agent-actions'ta — worker ile AYNI kod, tek yazar.
  if (ACTION_TOOL_NAMES.includes(mcpToolName)) {
    return callActionTool(deps, identity, mcpToolName, (args ?? {}) as Record<string, unknown>);
  }
  const tool = listTools().find((t) => toMcpToolName(t.name) === mcpToolName);
  if (!tool) {
    const envelope: McpEnvelope = {
      ok: false,
      decision: "deny",
      status: "denied",
      result: null,
      reason: `unknown tool: ${mcpToolName}`,
      approvalId: null,
      approver: null,
      riskClass: "R0",
      elevatedFrom: null,
      costCents: 0,
      retryAfterSec: null,
      outputFlagged: false,
      invocationId: null,
    };
    return {
      content: [{ type: "text", text: `Bilinmeyen araç: ${mcpToolName}` }],
      structuredContent: envelope,
      isError: true,
    };
  }

  const response = await deps.gateway().invoke(companyContext(identity.companyId), {
    agentId: identity.agentId,
    toolName: tool.name,
    input: args ?? {},
    ...(identity.taskId && { taskId: identity.taskId }),
    ...(identity.agentSessionId && { agentSessionId: identity.agentSessionId }),
  });

  const envelope: McpEnvelope = {
    ok: response.status === "succeeded" || response.status === "dispatched",
    decision: response.decision,
    status: response.status,
    result: response.output ?? null,
    reason: response.reason ?? response.error ?? null,
    approvalId: null,
    approver: response.approver ?? null,
    riskClass: response.riskClass,
    elevatedFrom: response.elevatedFrom ?? null,
    costCents: response.costCents ?? 0,
    retryAfterSec: response.retryAfterSec ?? null,
    outputFlagged: response.outputFlagged ?? false,
    invocationId: response.invocationId,
  };
  // `awaiting_approval` bilinçli olarak isError DEĞİL (sözleşme §5).
  const isError = envelope.status === "denied" || envelope.status === "failed";
  return {
    content: [{ type: "text", text: describe(envelope, tool.name) }],
    structuredContent: envelope,
    isError,
  };
}

// ---------- JSON-RPC 2.0 ----------

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: string | number | null; result: unknown }
  | {
      jsonrpc: "2.0";
      id: string | number | null;
      error: { code: number; message: string; data?: unknown };
    };

const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

/**
 * Tek bir JSON-RPC isteğini işler. Bildirim (id yok) ise null döner — çağıran
 * 202 ile karşılık verir.
 */
export async function handleMcpRpc(
  deps: McpServerDeps,
  identity: McpIdentity,
  request: JsonRpcRequest,
): Promise<JsonRpcResponse | null> {
  const id = request.id ?? null;
  const isNotification = request.id === undefined || request.id === null;

  switch (request.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, version: "1.0.0" },
          instructions:
            "ACOS kontrol düzlemi. Şirket kararları (görev açma, devretme, inceleme, işe alım) bu araçlardan geçer; kimlik oturum jetonundan türetilir, araç argümanlarında kimlik alanı YOKTUR.",
        },
      };
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return isNotification ? null : { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: await listMcpTools(deps.db(), identity) } };
    case "tools/call": {
      const name = request.params?.name;
      if (typeof name !== "string") {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: INVALID_PARAMS, message: "params.name is required" },
        };
      }
      const result = await callMcpTool(deps, identity, name, request.params?.arguments ?? {});
      return { jsonrpc: "2.0", id, result };
    }
    default:
      if (isNotification) return null;
      return {
        jsonrpc: "2.0",
        id,
        error: { code: METHOD_NOT_FOUND, message: `unsupported method: ${request.method}` },
      };
  }
}
