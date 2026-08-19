// Context Budget (LIVE-CONSOLE TASK 6): role/task-aware INPUT token hedefi.
// Bunlar Working Set'in HEDEF boyutlarıdır — model context window'u DEĞİL
// (o, model_profiles.max_tokens_per_call'ın işi). Sabitler env ile
// ayarlanabilir; ölçüm char/4 sezgisidir (08 §8 ile aynı).
//
// Küçültme sırası (doc §TASK 6 — en son atılacaklar en değerli):
//   1. current task + required decision      (asla kısılmaz)
//   2. current project summary               (yalnız intake raporu kısılır)
//   3. active approvals/signals              (asla kısılmaz)
//   4. relevant org/staffing state           (task tree çocuklara daralır)
//   5. relevant CodeIndex results
//   6. relevant Memory                       (agent → company → project)
//   7. bounded recent steps                  (İLK kısılan)

export interface ContextBudget {
  /** Hedef input token (rol bazlı): aşılırsa Working Set kademeli küçülür. */
  targetTokens: number;
  /** Hard warning eşiği — structured log + telemetry bayrağı. */
  hardWarnTokens: number;
  /** Investigation eşiği — bu boyut bir hatadır, incelenmelidir. */
  investigateTokens: number;
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const MANAGERIAL_ROLES = new Set(["executive", "manager", "lead"]);

/** CEO/Manager normal step: 6k–12k → hedef 12k; Developer: 8k–20k → hedef 20k. */
export function contextBudgetForRole(defaultRole: string): ContextBudget {
  const managerial = MANAGERIAL_ROLES.has(defaultRole);
  return {
    targetTokens: managerial
      ? envNumber("CTX_BUDGET_MANAGER_TOKENS", 12_000)
      : envNumber("CTX_BUDGET_DEVELOPER_TOKENS", 20_000),
    hardWarnTokens: envNumber("CTX_BUDGET_WARN_TOKENS", 24_000),
    investigateTokens: envNumber("CTX_BUDGET_INVESTIGATE_TOKENS", 32_000),
  };
}

/** char/4 sezgisi — memory-rules.ts ile aynı ölçü birimi. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** TASK 7 — Working Set bölüm telemetrisi (her model çağrısıyla kaydedilir). */
export interface WorkingSetTelemetry {
  estTotalTokens: number;
  systemTokens: number;
  taskTokens: number;
  approvalTokens: number;
  projectTokens: number;
  orgTokens: number;
  taskTreeTokens: number;
  codeIndexTokens: number;
  memoryTokens: number;
  recentStepTokens: number;
  signalTokens: number;
  budgetTargetTokens: number;
  budgetFlag: "ok" | "warn" | "investigate";
  /** Uygulanan küçültme adımları — boşsa bütçe içindeydi. */
  trims: string[];
}
