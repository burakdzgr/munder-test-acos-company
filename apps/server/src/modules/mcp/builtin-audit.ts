// E4/A (T30) — CLI'ın KENDİ araçları da denetlenir (INV-3 / S3).
//
// Konteynerde koşan `claude` oturumunun kendi Bash/Read/Edit/Write araçları
// var. Onları sandbox'a bırakıp "kutu zaten sınır" demek mümkündü; Kevin daha
// iyisini yaptı ve PreToolUse kancasıyla her yerleşik çağrıyı ÖNCE buraya
// soruyor. Böylece INV-3 aynen ayakta kalıyor: her işlem için bir karar ve bir
// `tool_invocations` satırı.
//
// Buradaki tek fark ÇALIŞTIRMANIN kimde olduğudur: komutu CLI kendi kutusunda
// koşturur, gateway yalnız doğrular + yetkilendirir + yazar (auditOnly).
// İkinci kez koşturmak yan etkiyi ikiye katlardı.
//
// Kimlik yine jetondan gelir; kancanın gönderdiği hiçbir alan kimlik taşımaz.
import { companyContext } from "@acos/db";
import type { ToolGateway } from "../tools/gateway.js";
import type { McpIdentity } from "./sessions.js";

/** Claude Code yerleşik aracı → ACOS kayıt aracı (17 §2 sözlüğü). */
const BUILTIN_TO_ACOS: Record<string, string> = {
  bash: "terminal.run",
  read: "fs.read",
  edit: "fs.edit",
  multiedit: "fs.edit",
  write: "fs.write",
  notebookedit: "fs.edit",
  glob: "fs.search",
  grep: "fs.search",
  // kanca kanonik adı da yollayabilir
  "terminal.run": "terminal.run",
  "fs.read": "fs.read",
  "fs.edit": "fs.edit",
  "fs.write": "fs.write",
  "fs.search": "fs.search",
};

type Args = Record<string, unknown>;

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * CLI argümanları → ACOS araç girdisi.
 *
 * Kanca Claude Code'un alan adlarını gönderir (file_path, old_string, …);
 * kayıt kendi adlarını bekler (path, oldText, …). Çeviri burada, TEK yerde
 * yapılır — yoksa her yerleşik araç için kancanın içinde bir çeviri kopyası
 * yaşar ve ilk şema değişikliğinde ayrışır.
 */
export function toAcosInput(acosTool: string, args: Args): Args {
  const path = str(args.file_path) ?? str(args.path) ?? str(args.filePath) ?? "";
  switch (acosTool) {
    case "terminal.run":
      return {
        command: str(args.command) ?? str(args.cmd) ?? "",
        ...(str(args.cwd) && { cwd: str(args.cwd) }),
      };
    case "fs.read":
      return { path };
    case "fs.write":
      return { path, content: str(args.content) ?? "" };
    case "fs.edit":
      return {
        path,
        oldText: str(args.old_string) ?? str(args.oldText) ?? "(unknown)",
        newText: str(args.new_string) ?? str(args.newText) ?? "",
      };
    case "fs.search":
      return { pattern: str(args.pattern) ?? str(args.query) ?? "" };
    default:
      return args;
  }
}

export interface BuiltinAuditResult {
  allow: boolean;
  reason: string | null;
  toolName: string | null;
  riskClass: string | null;
  invocationId: string | null;
  /** `require_approval` çıkarsa kanca DURDURUR: onay yolu insana aittir. */
  requiresApproval: boolean;
  approver: string | null;
}

/**
 * Kancanın tek sorusu: "bu yerleşik çağrıyı yapabilir miyim?"
 *
 * FAIL-CLOSED: tanımadığımız bir yerleşik araç `allow:false` alır. Bilinmeyeni
 * geçirmek, denetlenmemiş bir yüzeyin sessizce açılması demektir — kancanın
 * bütün amacı buydu.
 */
export async function auditBuiltinTool(
  gateway: ToolGateway,
  identity: McpIdentity,
  input: { tool: string; args: Args },
): Promise<BuiltinAuditResult> {
  const acosTool = BUILTIN_TO_ACOS[input.tool.toLowerCase()];
  if (!acosTool) {
    return {
      allow: false,
      reason: `UNMAPPED_BUILTIN: ${input.tool}`,
      toolName: null,
      riskClass: null,
      invocationId: null,
      requiresApproval: false,
      approver: null,
    };
  }
  const response = await gateway.invoke(companyContext(identity.companyId), {
    agentId: identity.agentId,
    toolName: acosTool,
    input: toAcosInput(acosTool, input.args),
    auditOnly: true,
    ...(identity.taskId && { taskId: identity.taskId }),
    ...(identity.agentSessionId && { agentSessionId: identity.agentSessionId }),
  });
  return {
    allow: response.decision === "allow",
    reason: response.reason ?? null,
    toolName: acosTool,
    riskClass: response.riskClass,
    invocationId: response.invocationId,
    requiresApproval: response.decision === "require_approval",
    approver: response.approver ?? null,
  };
}
