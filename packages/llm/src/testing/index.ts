// @acos/llm/testing — the deterministic fake ModelRouter tier (32 §6).
// Never imported by production paths; workers select it via LLM_MODE=scripted.
export {
  ScriptSchema,
  ScriptLoadError,
  ScriptedSession,
  loadScript,
  normalizeStep,
  createScriptedAdapter,
  type Script,
  type ScriptStep,
  type StepObservation,
} from "./scripted.js";
export {
  pseudoEmbedding,
  cannedConsolidation,
  type CannedConsolidation,
} from "./embeddings.js";
