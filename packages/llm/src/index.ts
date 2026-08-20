export const packageName = "@acos/llm" as const;

export {
  LLM_PURPOSES,
  BINDING_PURPOSES,
  PURPOSE_TO_BINDING,
  LLM_ERROR_KINDS,
  FALLBACK_ELIGIBLE,
  LlmError,
  LlmMessageSchema,
  LlmUsageSchema,
  ProviderPricingSchema,
  computeCostCents,
  resolveProviderPricing,
  type LlmPurpose,
  type BindingPurpose,
  type LlmMessage,
  type LlmUsage,
  type CompleteRequest,
  type CompleteResult,
  type EmbedRequest,
  type EmbedResult,
  type LlmErrorKind,
  type AgentBindingInput,
  type ModelProfileInput,
  type ResolvedTarget,
  type ProviderPricing,
  type ProviderPricingTable,
  type ProviderPricingEntry,
  type LlmCallLogEntry,
  type LlmCallLogger,
} from "./types.js";
export {
  ANTHROPIC_PRICING,
  OPENAI_PRICING,
  SCRIPTED_PRICING,
  pricingDefaultsFor,
} from "./pricing-defaults.js";
export {
  AgentActionSchema,
  TaskResultSchema,
  AGENT_ACTION_TYPES,
  CONTEXT_SENTINEL_UUID,
  SELF_SENTINEL_UUID,
  type AgentAction,
  type AgentActionType,
  type TaskResult,
} from "./agent-action.js";
export {
  MemoryCandidateSchema,
  MemoryCandidateListSchema,
  MemoryEntitiesSchema,
  EvidenceRefSchema,
  parseMemoryCandidates,
  type MemoryCandidate,
  type MemoryEntities,
  type EvidenceRef,
} from "./memory-candidate.js";
export { languageName, outputLanguageDirective } from "./language.js";
export { resolveTargets } from "./resolution.js";
export { ModelRouter, type ProviderAdapter, type RouterOptions, type RoutingContext } from "./router.js";
export {
  createAnthropicAdapter,
  createOpenAiAdapter,
  createOpenAiCompatAdapter,
  createOpenRouterAdapter,
  createGeminiAdapter,
  createOllamaAdapter,
} from "./adapters/ai-sdk.js";
export { createProvidersFromConfig } from "./providers.js";
