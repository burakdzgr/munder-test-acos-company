// E4/A (T30 Family B) — ŞİRKET FİİLLERİNİN MCP yüzü.
//
// CLI oturumunun kendi dosya/kabuk araçları var ama şirketi işleten fiilleri
// YOK: görev açmak, iş devretmek, inceleme istemek, işi kapatmak. O fiiller
// bu sunucudan geçer — ve BURADA YENİDEN YAZILMAZ. Gövde @acos/agent-actions'ta
// (worker'ın executeActionActivity'siyle AYNI kod): görev durumunun tek yazarı
// kalır, INV-13 korunur. Buradaki iş yalnız MCP argümanlarını kanonik
// AgentAction'a çevirmek ve sonucu sözleşmedeki zarfa koymaktır.
//
// Kimlik yine JETONDAN gelir; hiçbir aracın argümanında agentId/taskId yoktur.
import { createActionDispatcher, type ActionDispatcher } from "@acos/agent-actions";
import { AgentActionSchema, type AgentAction } from "@acos/llm";
import { CONTEXT_SENTINEL_UUID, SELF_SENTINEL_UUID } from "@acos/llm/agent-action";
import { uuidv7 } from "@acos/domain";
import type { McpIdentity } from "./sessions.js";
import type { McpCallResult, McpEnvelope, McpToolListing } from "./server.js";

type Args = Record<string, unknown>;

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strArr = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === "string");

interface ActionToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Turu bitirir mi? (CLI oturumunu deterministik kapatabilsin diye.) */
  endsTurn?: boolean;
  build(args: Args, identity: McpIdentity): AgentAction;
}

const obj = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({ type: "object", properties, required, additionalProperties: false });

const S = { type: "string" } as const;
const N = { type: "number" } as const;
const SARR = { type: "array", items: { type: "string" } } as const;

/**
 * Dokuz fiil. Şekiller DONMUŞ sözleşmenin §4'ü ile birebir; eksik bırakılan
 * kimlik alanları oturumun kendi bağlamına (CONTEXT sentinel) düşer.
 */
const ACTION_TOOLS: ActionToolSpec[] = [
  {
    name: "create_task",
    description:
      "Bu görevin altına yeni bir iş aç (07 §2 tür merdiveni: initiative>epic>task>subtask). Sahibi ATANMAZ — dağıtım delegate_task ile Scheduler'ındır.",
    inputSchema: obj(
      {
        kind: { type: "string", enum: ["initiative", "epic", "task", "subtask"] },
        title: S,
        objective: S,
        successCriteria: SARR,
        priority: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
        estimatedEffort: N,
        risk: { type: "string", enum: ["low", "medium", "high", "critical"] },
        requiredCapabilities: SARR,
        parentTaskId: S,
      },
      ["kind", "title", "objective"],
    ),
    build: (args) => ({
      type: "create_task",
      kind: str(args.kind, "task") as "initiative" | "epic" | "task" | "subtask",
      parentTaskId: str(args.parentTaskId) || CONTEXT_SENTINEL_UUID,
      title: str(args.title).slice(0, 200),
      objective: str(args.objective),
      // Kriter uydurulmaz: verilmediyse verilmediği AÇIKÇA yazılır.
      successCriteria: strArr(args.successCriteria).length
        ? strArr(args.successCriteria)
        : [`${str(args.title)} teslim edildi (başarı kriteri belirtilmedi)`],
      priority: (["P0", "P1", "P2", "P3"].includes(str(args.priority))
        ? str(args.priority)
        : "P2") as "P0" | "P1" | "P2" | "P3",
      estimatedEffort:
        typeof args.estimatedEffort === "number" && args.estimatedEffort >= 1
          ? Math.min(Math.round(args.estimatedEffort), 13)
          : 3,
      risk: (["low", "medium", "high", "critical"].includes(str(args.risk))
        ? str(args.risk)
        : "low") as "low" | "medium" | "high" | "critical",
      requiredCapabilities: strArr(args.requiredCapabilities).slice(0, 8),
    }),
  },
  {
    name: "delegate_task",
    description:
      "Bir alt görevi dağıt. toAgentId YALNIZ 'scheduler' (atamayı Scheduler yapar) ya da 'self' (bu dilimi ben üstleniyorum) olabilir — somut ajan adı VERİLEMEZ (INV-10).",
    inputSchema: obj(
      {
        toAgentId: { type: "string", enum: ["scheduler", "self"] },
        note: S,
        taskId: S,
      },
      ["toAgentId", "note"],
    ),
    build: (args) => ({
      type: "delegate_task",
      taskId: str(args.taskId) || CONTEXT_SENTINEL_UUID,
      toAgentId: str(args.toAgentId) === "self" ? SELF_SENTINEL_UUID : CONTEXT_SENTINEL_UUID,
      note: str(args.note).slice(0, 1000),
    }),
  },
  {
    name: "update_task_status",
    description: "Kendi görevinin durumunu taşı (tek yazar + 07 §5 izin matrisi geçerlidir).",
    inputSchema: obj(
      {
        to: { type: "string", enum: ["IN_PROGRESS", "WAITING", "BLOCKED", "REVIEW"] },
        note: S,
        taskId: S,
      },
      ["to"],
    ),
    build: (args) => ({
      type: "update_task_status",
      taskId: str(args.taskId) || CONTEXT_SENTINEL_UUID,
      to: str(args.to, "IN_PROGRESS") as "IN_PROGRESS" | "WAITING" | "BLOCKED" | "REVIEW",
      note: str(args.note).slice(0, 1000),
    }),
  },
  {
    name: "request_review",
    description:
      "İşi incelemeye ver. İncelemeciyi SEN seçmezsin (INV-14: incelemeci ≠ yazar). Bu fiil turu bitirir.",
    inputSchema: obj({ summary: S, artifactId: S, taskId: S }, ["summary"]),
    endsTurn: true,
    build: (args) => ({
      type: "request_review",
      taskId: str(args.taskId) || CONTEXT_SENTINEL_UUID,
      artifactId: str(args.artifactId) || CONTEXT_SENTINEL_UUID,
      summary: str(args.summary).slice(0, 2000),
    }),
  },
  {
    name: "request_help",
    description:
      "Blokajda İLK adres: audience 'manager' seçersen yöneticin uyandırılır ve DM ile yanıt verir.",
    inputSchema: obj(
      {
        topic: S,
        body: S,
        audience: { type: "string", enum: ["peer", "team", "lead", "manager", "specialist"] },
      },
      ["topic", "body", "audience"],
    ),
    build: (args) => ({
      type: "request_help",
      topic: str(args.topic).slice(0, 200),
      body: str(args.body).slice(0, 4000),
      audience: str(args.audience, "manager") as
        | "peer"
        | "team"
        | "lead"
        | "manager"
        | "specialist",
    }),
  },
  {
    name: "escalate",
    description:
      "Founder'a resmî onay talebi. SON ÇAREDİR: önce request_help(manager). Karar gelene kadar iş İLERLEMEZ.",
    inputSchema: obj(
      {
        reason: S,
        attempted: SARR,
        options: {
          type: "array",
          items: obj({ option: S, risk: S, cost: S }, ["option", "risk", "cost"]),
        },
        recommendation: S,
      },
      ["reason", "recommendation"],
    ),
    build: (args) => ({
      type: "escalate",
      reason: str(args.reason).slice(0, 2000),
      attempted: strArr(args.attempted),
      options: arr(args.options).map((o) => {
        const option = (o ?? {}) as Args;
        return { option: str(option.option), risk: str(option.risk), cost: str(option.cost) };
      }),
      recommendation: str(args.recommendation),
    }),
  },
  {
    name: "record_decision",
    description: "Kalıcı karar kaydı (neden bu yol, hangi alternatifler, sonuçları).",
    inputSchema: obj({ title: S, decision: S, alternatives: SARR, consequences: S }, [
      "title",
      "decision",
    ]),
    build: (args) => ({
      type: "record_decision",
      title: str(args.title).slice(0, 200),
      decision: str(args.decision),
      alternatives: strArr(args.alternatives),
      consequences: str(args.consequences),
    }),
  },
  {
    name: "complete_task",
    description:
      "İşi teslim et. Konteyner görevler (goal/initiative) REVIEW'a taşınmaz — kapanışları roll-up'tan gelir. Bu fiil turu bitirir.",
    inputSchema: obj(
      {
        summary: S,
        criteria: {
          type: "array",
          items: obj({ criterion: S, met: { type: "boolean" }, evidence: S }, [
            "criterion",
            "met",
            "evidence",
          ]),
        },
        artifactIds: SARR,
      },
      ["summary"],
    ),
    endsTurn: true,
    build: (args) => ({
      type: "complete_task",
      result: {
        summary: str(args.summary).slice(0, 4000),
        criteria: arr(args.criteria).map((c) => {
          const item = (c ?? {}) as Args;
          return {
            criterion: str(item.criterion),
            met: item.met === true,
            evidence: str(item.evidence),
          };
        }),
        artifactIds: strArr(args.artifactIds),
        cost: { tokensIn: 0, tokensOut: 0, cents: 0 },
      },
    }),
  },
  {
    name: "send_message",
    description: "Görev kanalına (ya da verilen kanala) mesaj gönder.",
    inputSchema: obj(
      {
        body: S,
        kind: {
          type: "string",
          enum: ["text", "help_request", "review_request", "escalation", "status"],
        },
        channelId: S,
        mentions: SARR,
      },
      ["body"],
    ),
    build: (args) => ({
      type: "send_message",
      channelId: str(args.channelId) || CONTEXT_SENTINEL_UUID,
      kind: (["text", "help_request", "review_request", "escalation", "status"].includes(
        str(args.kind),
      )
        ? str(args.kind)
        : "text") as "text" | "help_request" | "review_request" | "escalation" | "status",
      body: str(args.body).slice(0, 8000),
      mentions: strArr(args.mentions),
      refs: [],
    }),
  },
];

export const ACTION_TOOL_NAMES: readonly string[] = ACTION_TOOLS.map((t) => t.name);

export function listActionTools(): McpToolListing[] {
  return ACTION_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

function envelope(partial: Partial<McpEnvelope> & Pick<McpEnvelope, "ok" | "status">): McpEnvelope {
  return {
    decision: partial.decision ?? (partial.ok ? "allow" : "deny"),
    result: partial.result ?? null,
    reason: partial.reason ?? null,
    approvalId: partial.approvalId ?? null,
    approver: partial.approver ?? null,
    riskClass: partial.riskClass ?? "R1",
    elevatedFrom: null,
    costCents: 0,
    retryAfterSec: null,
    outputFlagged: false,
    invocationId: null,
    ...partial,
  } as McpEnvelope;
}

export interface ActionToolDeps {
  dispatcher: () => ActionDispatcher;
}

/** MCP fiil çağrısı → ORTAK dağıtıcı. Kimlik jetondan, gövde paylaşımlı. */
export async function callActionTool(
  deps: ActionToolDeps,
  identity: McpIdentity,
  toolName: string,
  args: Args,
): Promise<McpCallResult> {
  const spec = ACTION_TOOLS.find((t) => t.name === toolName);
  if (!spec) {
    const env = envelope({ ok: false, status: "denied", reason: `unknown tool: ${toolName}` });
    return { content: [{ type: "text", text: `Bilinmeyen araç: ${toolName}` }], structuredContent: env, isError: true };
  }
  if (!identity.taskId) {
    // Şirket fiilleri bir GÖREV bağlamında yapılır; görevsiz oturum yazamaz.
    const env = envelope({
      ok: false,
      status: "denied",
      reason: "NO_TASK_CONTEXT",
    });
    return {
      content: [{ type: "text", text: "Bu oturum bir göreve bağlı değil; şirket fiilleri görev bağlamı ister." }],
      structuredContent: env,
      isError: true,
    };
  }

  const parsed = AgentActionSchema.safeParse(spec.build(args, identity));
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ")
      .slice(0, 500);
    const env = envelope({ ok: false, status: "failed", reason: `validation_failed: ${detail}` });
    return {
      content: [{ type: "text", text: `${toolName} girdisi geçersiz: ${detail}` }],
      structuredContent: env,
      isError: true,
    };
  }

  const observation = (await deps.dispatcher().dispatch({
    companyId: identity.companyId,
    agentId: identity.agentId,
    taskId: identity.taskId,
    // Oturum kimliği: CLI turunun kendi agent_sessions satırı varsa o, yoksa
    // MCP oturumu. Adım kimliği her çağrıda yeni — idempotency anahtarları
    // ondan türer (08 §11), yani iki ayrı çağrı asla tek etkiye çökmez.
    sessionId: identity.agentSessionId ?? identity.mcpSessionId,
    stepId: uuidv7(),
    action: parsed.data,
  })) as Record<string, unknown>;

  const ok = observation.ok === true;
  // T57: `ok &&` şartı, onay bekleyişini YALNIZ `escalate` yolundan gelebilir
  // varsayıyordu — o dal `ok:true` döner. Gateway yolunda ise `use_tool`
  // gözlemi `ok:false` döner (`status==='awaiting_approval'`), dolayısıyla
  // kayıt AÇILSA BİLE zarf "denied" olurdu ve ajan onay beklediğini
  // öğrenemezdi. Sözleşme §5 zaten "onay bekleyişi HATA DEĞİLDİR" diyor:
  // kararı `ok`a değil, onay kaydının varlığına bağlıyoruz.
  const awaitingApproval =
    observation.approvalStatus === "pending" && typeof observation.approvalId === "string";
  const reason =
    typeof observation.error === "string"
      ? observation.error
      : typeof observation.hint === "string"
        ? observation.hint
        : null;

  const env = envelope({
    ok,
    status: awaitingApproval ? "awaiting_approval" : ok ? "succeeded" : "denied",
    decision: awaitingApproval ? "require_approval" : ok ? "allow" : "deny",
    result: observation,
    reason,
    approvalId: awaitingApproval ? (observation.approvalId as string) : null,
    approver: awaitingApproval ? "founder" : null,
  });
  // Sözleşme §5: onay bekleyişi HATA DEĞİLDİR.
  const isError = !ok && !awaitingApproval;
  const text = awaitingApproval
    ? `${toolName}: Founder onayı bekliyor (approvalId=${observation.approvalId}). Karar gelene kadar iş İLERLEMEDİ.`
    : ok
      ? `${toolName} tamam.${spec.endsTurn ? " Bu tur bitti." : ""}`
      : `${toolName} REDDEDİLDİ: ${reason ?? "koşullar uygun değil"}`;

  return {
    content: [{ type: "text", text }],
    structuredContent: { ...env, ...(spec.endsTurn && ok && { turnEnded: true }) } as McpEnvelope,
    isError,
  };
}

export function createMcpActionDispatcher(
  ...args: Parameters<typeof createActionDispatcher>
): ActionDispatcher {
  return createActionDispatcher(...args);
}
