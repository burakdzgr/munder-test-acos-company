// agentTaskWorkflow core loop (08 §1–2, §9–10; T32/T33/T34): build Working
// Set → call LLM → strict AgentAction parse (2 bounded repairs) → execute →
// persist → GUARDS. Runaway protection is code, not prompt text: (a) budget,
// (b) deadline timer firing even mid-wait, (c) step cap 40 soft / >50 hard
// cumulative, (d) loop detector over normalized action hashes, (f) depth via
// createTaskActivity refusal; (e) ping-pong lives in the message pipeline.
// continueAsNew every 50 local steps or >5k history events with carried
// state. Pure orchestration — every side effect is an activity; stepId =
// uuidv5(String(stepNo), sessionId) is deterministic and replay-safe.
import {
  condition,
  continueAsNew,
  isCancellation,
  patched,
  proxyActivities,
  setHandler,
  sleep,
  workflowInfo,
} from "@temporalio/workflow";
import { uuidv5 } from "@acos/domain";
import { AgentActionSchema, type AgentAction } from "@acos/llm/agent-action";
import type { createAgentTaskActivities } from "../activities/agent-task.js";
import type { createCliSessionActivities } from "../cli-session/activities.js";
import type { LlmMessage } from "@acos/llm";
import {
  approvalVerdictSignal,
  cancelSignal,
  dependencyResolvedSignal,
  managerDirectiveSignal,
  messageReceivedSignal,
  reviewVerdictSignal,
  type InboxItemSignal,
} from "./signals.js";

const activities = proxyActivities<ReturnType<typeof createAgentTaskActivities>>({
  startToCloseTimeout: "120s", // fast DB ops + working-set build ceiling
  retry: { maximumAttempts: 3, initialInterval: "2s", maximumInterval: "60s" },
});

/**
 * LLM sınıfı (08 §12 satır 1) — canlı bulgu (2026-08-19, runtime):
 * claude-cli-bridge (Founder kararı) tek başına 180 sn bütçeli ve eşzamanlılık
 * 2 ile kuyruklu; yük altında tek çağrı 137 sn+ gözlendi. Eski hâlde model
 * çağrısı 120 sn'lik genel tavana çarpıyor, 3 retry tükeniyor ve TÜM
 * agentTaskWorkflow FAİL oluyordu (bir görevde art arda 5 ölü oturum). Üstelik
 * iptal edilen deneme köprüde çalışmaya devam edip ("Activity not found on
 * completion") 2 slotluk kuyruğu işgal ediyor, retry fırtınasını besliyordu.
 * Tavan köprünün en kötü zinciri (kuyruk + 180 sn exec + sağlayıcı failover)
 * kadar geniş; canlılık 08 §12'nin şart koştuğu ama hiç yazılmamış heartbeat
 * ile korunur — worker ölürse Temporal heartbeatTimeout'ta hemen yeniden
 * planlar, yavaş-ama-canlı çağrı ise kesilmez.
 */
const llmActivity = proxyActivities<ReturnType<typeof createAgentTaskActivities>>({
  startToCloseTimeout: "8 minutes",
  heartbeatTimeout: "60s", // aktivite 10 sn'de bir heartbeat basar (08 §12: 30s sınıfı)
  retry: { maximumAttempts: 3, initialInterval: "2s", maximumInterval: "60s" },
});

/**
 * B3 (2026-08-15 kod incelemesi): tool dispatch, 120 sn'lik sınıf tavanının
 * ALTINDA kalamaz — gateway'in kendi prepare bütçesi 10 dk, terminal.run
 * tavanı 30,5 dk. Eski hâlde Temporal 120 sn'de aktiviteyi iptal edip yeniden
 * deniyordu; gateway `in_flight` anahtarını devralıyor ve AYNI komut 3 kez
 * paralel koşuyordu (npm install / migration / test suite). Ayrıca yan etkili
 * araçlarda otomatik retry zaten güvenli değil → tek deneme.
 */
const toolActivity = proxyActivities<ReturnType<typeof createAgentTaskActivities>>({
  startToCloseTimeout: "45m", // prepare (10 dk) + en uzun araç (30,5 dk) + pay
  retry: { maximumAttempts: 1 },
});

/**
 * E4/T31 (ADR-022): the agent turn as ONE live Claude Code CLI session. The
 * whole turn is a single long activity (the session's own wall-clock ceiling
 * is enforced inside it and by the broker); heartbeats every 10s so a dead
 * worker is rescheduled fast. ONE retry: a re-run re-mints idempotently and
 * re-attaches to a still-running session (open is idempotent while live).
 */
const cliSessionActivity = proxyActivities<ReturnType<typeof createCliSessionActivities>>({
  startToCloseTimeout: "3 hours",
  heartbeatTimeout: "2 minutes",
  retry: { maximumAttempts: 2, initialInterval: "10s" },
});
const cliRuntimeResolve = proxyActivities<ReturnType<typeof createCliSessionActivities>>({
  startToCloseTimeout: "30s",
  retry: { maximumAttempts: 3, initialInterval: "2s" },
});

/** Carried across continueAsNew (08 §10) — small, schema-versioned. */
export interface CarriedState {
  stepNo: number;
  loopHashes: string[]; // guard (d) ring, last 6
  pendingMessages: InboxItemSignal[]; // capped 50
  seenSignalIds: string[]; // capped ring 200
  version: 1;
}

export interface AgentTaskInput {
  companyId: string;
  agentId: string;
  taskId: string;
  sessionId: string;
  attempt: number;
  carriedState?: CarriedState | undefined;
  /** Rework re-entry (T43, 15 §5): a changes_requested verdict restarts the
   *  owner's loop with the verdict pre-seeded so the first Working Set
   *  carries the [signal:reviewVerdict=…] marker the script branches on. */
  initialReviewVerdict?: { verdict: string; notes?: string | undefined } | undefined;
}

export interface AgentTaskOutcome {
  outcome: "review_requested" | "completed" | "abandoned" | "guard_stopped" | "help_requested";
  steps: number;
}

const MAX_REPAIRS = 2;
const STEP_SOFT_WARN = 60; // guard (c) soft — injected into section 10
const STEP_HARD_CAP = 120; // guard (c) hard — cumulative across continues (raised for live LLM)
const CONTINUE_EVERY_STEPS = 50; // 08 §10 (local steps per run)
const HISTORY_EVENT_LIMIT = 5_000;
const LOOP_WINDOW = 10; // guard (d) — longer pattern detection
const LOOP_TRIP = 4; // more tolerant (was 3)

/**
 * Canlı model toleransı (2026-08-14): markdown çiti / önsöz-sonsöz metni
 * içinden ilk dengeli JSON nesnesini çıkarır. Şema doğrulaması KATI kalır
 * (08 §4) — yalnız çıkarım toleranslıdır. Deterministik saf string işlemi
 * (workflow-güvenli).
 */
function extractJsonCandidate(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const source = (fenced?.[1] ?? text).trim();
  if (source.startsWith("{") && source.endsWith("}")) return source;
  const start = source.indexOf("{");
  if (start === -1) return source;
  let depth = 0;
  let inString = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start);
}

/** Cause-chain flattener: ActivityFailure's message is generic ("Activity
 *  task failed"); the real error (LlmError, TaskEngineError…) lives down the
 *  `cause` chain. Pure + deterministic (workflow-safe). */
function describeError(err: unknown, depth = 0): string {
  if (depth > 4) return "…";
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    const head = err.message || err.name;
    return cause ? `${head} <- ${describeError(cause, depth + 1)}` : head;
  }
  return String(err);
}

/** guard (d) normalization: lowercase, strip volatile fields (08 §9). */
function normalizedActionHash(action: AgentAction): string {
  const raw = JSON.stringify(action)
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/\d{4}-\d{2}-\d{2}t[\d:.]+z?/g, "<ts>")
    // Normalize file paths: strip leading ./ and /work/ prefix
    .replace(/\.\/|\/work\//g, "")
    // Normalize numbers (line numbers, byte counts, etc.)
    .replace(/\b\d+\b/g, "<n>")
    // Normalize message/note content length (first 100 chars only)
    .replace(/"(body|note|summary|content|message)":\s*"([^"]{100})[^"]*"/g, '"$1":"$2<...>"');
  let hash = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

export async function agentTaskWorkflow(input: AgentTaskInput): Promise<AgentTaskOutcome> {
  const info = workflowInfo();
  const ref = {
    companyId: input.companyId,
    agentId: input.agentId,
    taskId: input.taskId,
    sessionId: input.sessionId,
  };

  // ---- signal + guard state, re-hydrated across continueAsNew (08 §10) ----
  const carried = input.carriedState;
  const seenSignalIds = new Set<string>(carried?.seenSignalIds ?? []);
  const pendingMessages: InboxItemSignal[] = [...(carried?.pendingMessages ?? [])];
  const loopHashes: string[] = [...(carried?.loopHashes ?? [])];
  // property access (not closed-over lets) — keeps TS control-flow honest
  // about mutations arriving from signal handlers
  const signals: {
    resolvedDependencies: string[];
    reviewVerdict: { verdict: string; notes?: string | undefined } | null;
    approvalVerdict: { verdict: string; note?: string | undefined } | null;
    paused: boolean;
    cancelled: { by: string; reason: string } | null;
  } = {
    resolvedDependencies: [],
    // rework re-entry pre-seeds the verdict (T43) — undefined on old histories
    reviewVerdict: input.initialReviewVerdict ?? null,
    approvalVerdict: null,
    paused: false,
    cancelled: null,
  };

  setHandler(messageReceivedSignal, (item) => {
    if (seenSignalIds.has(item.signalId)) return; // at-least-once dedupe
    seenSignalIds.add(item.signalId);
    if (pendingMessages.length < 50) pendingMessages.push(item);
  });
  setHandler(dependencyResolvedSignal, (payload) => {
    // A4: signal delivery is at-least-once (09 §9 fire-and-forget + the
    // consumer's redelivery), and "which dependencies are resolved" is a SET,
    // not a stream — so a redelivery must not grow the list. Same dedupe
    // discipline as messageReceived above.
    if (signals.resolvedDependencies.includes(payload.dependsOnTaskId)) return;
    signals.resolvedDependencies.push(payload.dependsOnTaskId);
  });
  setHandler(reviewVerdictSignal, (payload) => {
    signals.reviewVerdict = { verdict: payload.verdict, notes: payload.notes };
  });
  setHandler(approvalVerdictSignal, (payload) => {
    signals.approvalVerdict = { verdict: payload.verdict, note: payload.note };
  });
  setHandler(managerDirectiveSignal, (payload) => {
    if (payload.directive === "pause") signals.paused = true;
    if (payload.directive === "resume") signals.paused = false;
  });
  setHandler(cancelSignal, (payload) => {
    signals.cancelled = payload;
  });

  const wakeConditionMet = (what: string): boolean => {
    if (signals.cancelled) return true;
    switch (what) {
      case "reply":
        return pendingMessages.length > 0;
      case "dependency":
        return signals.resolvedDependencies.length > 0;
      case "review":
        return signals.reviewVerdict !== null;
      case "approval":
        return signals.approvalVerdict !== null;
      default:
        return false; // timer waits only time out
    }
  };
  await activities.startAgentSessionActivity({
    ...ref,
    workflowId: info.workflowId,
    runId: info.runId,
    attempt: input.attempt,
  });

  // guard (b): a timer set at workflow start fires at the deadline even
  // mid-wait (08 §9b); the snapshot supplies the wall-clock deadline
  const guardFlags = { deadlineReached: false, deadlineEscalated: false };
  const initialSnapshot = await activities.getGuardSnapshotActivity(ref);
  if (initialSnapshot.deadline) {
    const untilDeadline = new Date(initialSnapshot.deadline).getTime() - Date.now();
    if (untilDeadline <= 0) guardFlags.deadlineReached = true;
    else {
      void sleep(untilDeadline).then(() => {
        guardFlags.deadlineReached = true;
      });
    }
  }

  let stepNo = carried?.stepNo ?? 0; // cumulative across continues (guard c)
  // 2026-08-14: canlı modeller plan-döngüsüne saplanabiliyor (record_decision
  // ×N, 50-adım bütçesi erir) — normalize-hash guard'ı farklı planları
  // yakalayamaz. Ardışık düşünme adımları sayılır; 3+ olunca working set'e
  // sert bir yönlendirme marker'ı girer.
  let contemplationStreak = 0;
  // 2026-08-15: okuma-döngüsü kırıcı — canlı model 50 adımı fs.read/fs.search
  // ile eritebiliyor (TASK-21 vakası: 50/50 salt-okuma, sıfır yazma).
  // Ardışık salt-okuma araç çağrıları sayılır; 8+ olunca sert marker girer.
  const READ_ONLY_TOOLS = new Set(["fs.read", "fs.search", "task.query", "memory.search", "git.diff", "web.fetch", "web.search", "db.inspect"]);
  let readStreak = 0;
  // wait_for uyanış notları — bir sonraki adımın working set'ine marker olur
  const wakeNotes: string[] = [];
  let localSteps = 0;
  let continuing = false;
  let outcome: AgentTaskOutcome["outcome"] = "guard_stopped";

  const carryState = (): CarriedState => ({
    stepNo,
    loopHashes: loopHashes.slice(-LOOP_WINDOW),
    pendingMessages: pendingMessages.slice(0, 50),
    seenSignalIds: [...seenSignalIds].slice(-200),
    version: 1,
  });

  try {
    // E4/T31 (ADR-022): patched() keeps recorded histories replaying the
    // steps loop unchanged; new runs ask the runtime which path this turn takes.
    if (patched("t31-cli-runtime")) {
      const runtime = await cliRuntimeResolve.resolveAgentRuntimeActivity(ref);
      if (runtime.kind === "cli") {
        const session = await cliSessionActivity.runCliSessionActivity(ref);
        outcome = session.outcome;
        stepNo += session.requests;
        return { outcome, steps: stepNo };
      }
    }
    for (;;) {
      // guard (c) hard: cumulative cap — starting a step beyond 50 is refused
      if (stepNo >= STEP_HARD_CAP) {
        await activities.guardEscalateActivity({
          ...ref,
          stepId: uuidv5(`guard:step_cap:${stepNo}`, input.sessionId),
          guard: "step_cap",
          detail: `cumulative step ${stepNo} reached the hard cap ${STEP_HARD_CAP}`,
        });
        outcome = "guard_stopped";
        break;
      }
      stepNo += 1;
      localSteps += 1;
      const stepId = uuidv5(String(stepNo), input.sessionId);
      const stepStart = Date.now(); // Temporal-deterministic Date in workflows

      if (signals.cancelled !== null) {
        outcome = "abandoned";
        break;
      }
      if (signals.paused) {
        await condition(() => !signals.paused || signals.cancelled !== null);
        continue;
      }

      // drain the signal buffer into this step's working set (08 §5)
      const drained = pendingMessages.splice(0, pendingMessages.length);
      const signalMarkers: string[] = drained.map(
        (m) => `[signal:message=${m.kind}] from ${m.senderAgentId ?? "founder"}: ${m.preview}`,
      );
      signalMarkers.push(...wakeNotes.splice(0, wakeNotes.length));
      // 2026-08-14: karar notları marker'a eklenir — Founder'ın onay notu
      // yalnız "approved" kelimesine indirgeniyordu, ajan talimatı göremiyordu
      if (signals.reviewVerdict !== null) {
        const notes = signals.reviewVerdict.notes ? ` notes: ${signals.reviewVerdict.notes}` : "";
        signalMarkers.push(`[signal:reviewVerdict=${signals.reviewVerdict.verdict}]${notes}`);
        signals.reviewVerdict = null;
      }
      if (signals.approvalVerdict !== null) {
        const note = signals.approvalVerdict.note ? ` note: ${signals.approvalVerdict.note}` : "";
        signalMarkers.push(`[signal:approvalVerdict=${signals.approvalVerdict.verdict}]${note}`);
        signals.approvalVerdict = null;
      }

      // guard (b): deadline breach forces one escalation, then work continues
      // under the manager's direction (extend / rescope / reassign)
      if (guardFlags.deadlineReached && !guardFlags.deadlineEscalated) {
        guardFlags.deadlineEscalated = true;
        await activities.guardEscalateActivity({
          ...ref,
          stepId: uuidv5("guard:deadline", input.sessionId),
          guard: "deadline",
          detail: "wall-clock deadline passed",
        });
      }
      // guard (a): budget — never start a step you cannot pay for (08 §9a)
      const snapshot = await activities.getGuardSnapshotActivity(ref);
      if (
        snapshot.remainingCents !== null &&
        (snapshot.remainingCents <= 0 || snapshot.remainingCents <= snapshot.estimatedNextStepCents)
      ) {
        await activities.guardEscalateActivity({
          ...ref,
          stepId: uuidv5(`guard:budget:${stepNo}`, input.sessionId),
          guard: "budget",
          detail: `remaining ${snapshot.remainingCents}¢ ≤ estimated next step ${snapshot.estimatedNextStepCents}¢`,
        });
        outcome = "guard_stopped";
        break;
      }
      // guard (c) soft: constraint injected into section 10 (08 §9c)
      if (stepNo >= STEP_SOFT_WARN) {
        signalMarkers.push(`[guard:step_cap_warning] step ${stepNo} of ${STEP_HARD_CAP}`);
      }
      if (contemplationStreak >= 3) {
        signalMarkers.push(
          `[guard:plan_loop] ${contemplationStreak} consecutive planning steps with NO effect. You MUST now emit a MUTATING action (create_task / delegate_task / use_tool / update_task_status / complete_task). Do NOT reply with think or record_decision.`,
        );
      }
      if (readStreak >= 8) {
        signalMarkers.push(
          `[guard:read_loop] ${readStreak} consecutive READ-ONLY tool calls (step budget: ${stepNo}/${STEP_HARD_CAP}). STOP exploring. You already know enough — this step MUST be fs.write (produce the deliverable), git.commit, or complete_task.`,
        );
      }

      const workingSet = await activities.buildWorkingSetActivity({
        ...ref,
        stepNo,
        signalMarkers,
      });

      // strict parse with bounded auto-repair (08 §4)
      let action: AgentAction | null = null;
      let usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
      let costCents = 0;
      const messages: LlmMessage[] = [...workingSet.messages];
      let lastModelText = "";
      for (let repair = 0; repair <= MAX_REPAIRS; repair++) {
        const result = await llmActivity.callModelActivity({
          ...ref,
          stepId,
          repairAttempt: repair,
          messages,
          // TASK 7: bölüm telemetrisi model çağrısıyla birlikte kaydedilir
          contextTelemetry: workingSet.telemetry,
        });
        usage = {
          inputTokens: usage.inputTokens + result.usage.inputTokens,
          outputTokens: usage.outputTokens + result.usage.outputTokens,
          cachedInputTokens: usage.cachedInputTokens + result.usage.cachedInputTokens,
        };
        costCents += result.costCents;
        lastModelText = result.text;
        let parsed: unknown;
        try {
          parsed = JSON.parse(extractJsonCandidate(result.text));
        } catch (err) {
          messages.push(
            { role: "assistant", content: result.text },
            { role: "user", content: `Your reply was not valid JSON (${String(err)}). Respond with exactly one AgentAction JSON object.` },
          );
          continue;
        }
        const verdict = AgentActionSchema.safeParse(parsed);
        if (verdict.success) {
          action = verdict.data;
          break;
        }
        messages.push(
          { role: "assistant", content: result.text },
          {
            role: "user",
            content: `Your action failed schema validation: ${verdict.error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; ")}. Respond with exactly one corrected AgentAction JSON object.`,
          },
        );
      }

      if (!action) {
        // 3rd failure = failed step (08 §4); persist it and stop — the full
        // request_help forcing arrives with T33 messaging
        await activities.persistStepActivity({
          ...ref,
          stepId,
          stepNo,
          action: { type: "abandon", reason: "model output failed AgentAction parse after 2 repairs" },
          // teşhis: son ham model çıktısının ilk 400 karakteri kayda geçer
          observation: { ok: false, parseFailed: true, sample: lastModelText.slice(0, 400) },
          usage,
          costCents,
          durationMs: Date.now() - stepStart,
        });
        outcome = "abandoned";
        break;
      }

      // guard (d): loop detector — ≥3 identical normalized hashes within the
      // last 6 steps forces request_help (08 §9d)
      const actionHash = normalizedActionHash(action);
      loopHashes.push(actionHash);
      if (loopHashes.length > LOOP_WINDOW) loopHashes.shift();
      if (loopHashes.filter((h) => h === actionHash).length >= LOOP_TRIP) {
        await activities.persistStepActivity({
          ...ref,
          stepId,
          stepNo,
          action,
          observation: { ok: false, guard: "loop", hash: actionHash },
          usage,
          costCents,
          durationMs: Date.now() - stepStart,
        });
        await activities.guardEscalateActivity({
          ...ref,
          stepId,
          guard: "loop",
          detail: `action hash ${actionHash} repeated ${LOOP_TRIP}x within ${LOOP_WINDOW} steps`,
        });
        outcome = "guard_stopped";
        break;
      }

      // wait_for maps to Temporal condition + timer — never polling (08 §6)
      if (action.type === "wait_for") {
        // 2026-08-18 (Founder: "40 dk'dır iş yapılmıyor"): üç düzeltme.
        // 1) Park süresi 15 dk ile SINIRLI — model 120 dk (şema varsayılanı)
        //    isteyebiliyor ve ofis saatlerce sessiz kalıyordu; zaman aşımında
        //    döngü devam eder, model taze bağlamla yeniden karar verir.
        // 2) Adım UYUMADAN ÖNCE persist edilir — Founder terminal hücresinde
        //    "⏸ bekliyor" anında görünür (eskiden uyanana dek hiçbir iz yoktu).
        // 3) HERHANGİ bir gelen mesaj (Founder direktifi dahil) her bekleyişi
        //    uyandırır — direktif atınca ajan anında işe döner.
        const effectiveWaitMs = Math.min(action.timeoutMinutes, 15) * 60_000;
        const waitObservation = (await activities.executeActionActivity({
          ...ref,
          stepId,
          action,
        })) as { alreadyResolved?: boolean; verdict?: string } | undefined; // → WAITING
        if (waitObservation?.alreadyResolved) {
          // onay çoktan kararlaşmış — uyku yok, model taze bağlamla devam eder
          await activities.persistStepActivity({
            ...ref,
            stepId,
            stepNo,
            action,
            observation: { ok: true, waiting: action.what, ...waitObservation },
            usage,
            costCents,
            durationMs: Date.now() - stepStart,
          });
          wakeNotes.push(
            `[signal:approval_resolved] Beklediğin onay ZATEN kararlaşmış: ${waitObservation.verdict}. Bekleme atlandı — hemen harekete geç.`,
          );
          await activities.resumeFromWaitActivity({ ...ref });
          continue;
        }
        await activities.persistStepActivity({
          ...ref,
          stepId,
          stepNo,
          action,
          observation: {
            ok: true,
            waiting: action.what,
            effectiveTimeoutMinutes: Math.min(action.timeoutMinutes, 15),
          },
          usage,
          costCents,
          durationMs: Date.now() - stepStart,
        });
        const woken = await condition(
          () => wakeConditionMet(action.what) || pendingMessages.length > 0,
          effectiveWaitMs,
        );
        if (signals.cancelled !== null) {
          outcome = "abandoned";
          break;
        }
        wakeNotes.push(
          woken
            ? `[signal:wait_over] '${action.what}' bekleyişi bir sinyalle uyandı — şimdi harekete geç.`
            : `[signal:wait_timeout] '${action.what}' bekleyişi ${Math.min(action.timeoutMinutes, 15)} dk zaman aşımıyla bitti; beklenen şey GELMEDİ. Durumu yeniden değerlendir ve MUTASYON üreten bir aksiyon seç (gerekirse escalate).`,
        );
        await activities.resumeFromWaitActivity({ ...ref });
        continue;
      }

      contemplationStreak =
        action.type === "think" || action.type === "record_decision"
          ? contemplationStreak + 1
          : 0;
      readStreak =
        action.type === "use_tool" && READ_ONLY_TOOLS.has(action.tool)
          ? readStreak + 1
          : action.type === "think" || action.type === "record_decision"
            ? readStreak // düşünme adımı okuma serisini bozmaz da beslemez de
            : 0;
      // B3: yan etkili aksiyonlar (araç çağrıları dahil) uzun-pencere + retry'sız
      const observation = await toolActivity.executeActionActivity({ ...ref, stepId, action });
      await activities.persistStepActivity({
        ...ref,
        stepId,
        stepNo,
        action,
        observation,
        usage,
        costCents,
        durationMs: Date.now() - stepStart,
      });

      // escalate = Approval Engine wait (19 §7, T35): the workflow blocks
      // durably on the Founder verdict until the derived expiry; on silence
      // it closes the approval itself (expired ≡ rejected — nothing
      // irreversible proceeds). The verdict reaches the next working set as
      // a [signal:approvalVerdict=…] marker.
      if (
        action.type === "escalate" &&
        typeof observation.approvalId === "string" &&
        observation.approvalStatus === "pending"
      ) {
        const untilExpiry = new Date(String(observation.expiresAt)).getTime() - Date.now();
        // 2026-08-19 (Founder: "boş boş beklemek sıkıntı"): onay bekleyişi
        // 24 saate kadar KESİNTİSİZ park edebiliyordu. Artık 15 dk'lık
        // dilimlerle bekler; her dilim sonunda karar hâlâ yoksa model
        // marker'la uyandırılır — onay gerektirmeyen kısmı ilerletir, sonra
        // isterse yeniden bekler. Süre dolumu (expiry) semantiği aynı:
        // yalnız gerçek son tarihte approval kapatılır (expired ≡ rejected).
        const woken = await condition(
          () => signals.approvalVerdict !== null || signals.cancelled !== null || pendingMessages.length > 0,
          Math.max(Math.min(untilExpiry, 15 * 60_000), 1),
        );
        if (signals.cancelled !== null) {
          outcome = "abandoned";
          break;
        }
        if (signals.approvalVerdict === null && untilExpiry <= 15 * 60_000 && !woken) {
          const { status } = await activities.expireApprovalActivity({
            ...ref,
            approvalId: observation.approvalId,
          });
          signals.approvalVerdict = { verdict: status, note: undefined };
        }
        if (signals.approvalVerdict === null) {
          wakeNotes.push(
            `[signal:approval_pending] Onay (${observation.approvalId}) HENÜZ kararlaşmadı; süre dolmadı. Bloklanmadan yapabileceğin işe geç (başka alt görev, hazırlık, dokümantasyon); yapacak bir şey kalmadıysa wait_for {"what":"approval","refId":"${observation.approvalId}"} ile yeniden bekleyebilirsin.`,
          );
        }
        await activities.resumeFromWaitActivity({ ...ref });
        continue;
      }

      if (action.type === "request_review") {
        outcome = "review_requested";
        break;
      }
      if (action.type === "complete_task") {
        outcome = "completed";
        break;
      }
      if (action.type === "abandon") {
        outcome = "abandoned";
        break;
      }

      // continueAsNew boundary (08 §10) — independent of the step cap; the
      // session stays open across continues (truth lives in Postgres)
      if (
        localSteps >= CONTINUE_EVERY_STEPS ||
        workflowInfo().historyLength > HISTORY_EVENT_LIMIT
      ) {
        continuing = true;
        await continueAsNew<typeof agentTaskWorkflow>({
          ...input,
          carriedState: carryState(),
        });
      }
    }
  } catch (err) {
    // 33 §2.2 failure handler — çökme sessiz ölüm değildir: görev BLOCKED'a
    // alınır, yönetici help-request ile haberdar edilir, hata sonra Temporal'a
    // aynen düşer. continueAsNew (`continuing`) ve dış iptal çökme sayılmaz.
    if (!continuing && !isCancellation(err)) {
      try {
        await activities.reportWorkflowCrashActivity({
          ...ref,
          reason: describeError(err).slice(0, 500),
        });
      } catch {
        // raporlama best-effort: oturum kapanışı finally'de, workflow failure
        // Temporal'da zaten görünür kalır
      }
    }
    throw err;
  } finally {
    if (!continuing) {
      await activities.closeAgentSessionActivity({
        ...ref,
        // Faz E: `guard_stopped` de "completed" sayılıyordu — bir güvenlik
        // guard'ı (bütçe, döngü, adım tavanı) tarafından hiçbir şey teslim
        // etmeden kesilen koşu, Founder'ın oturum listesinde başarılı bir
        // koşudan ayırt edilemiyordu. Teslimat yoksa oturum başarılı değildir.
        // help_requested (CLI runtime): the turn ended by asking for help — not a delivery, not a failure
        status: outcome === "abandoned" || outcome === "guard_stopped" ? "failed" : "completed",
      });
    }
  }
  return { outcome, steps: stepNo };
}
