// Config → adapter map (28 §2): apps/workers build their provider set from
// @acos/config. Offline profile = only Ollama configured (A3).
import type { Config } from "@acos/config";
import type { ProviderAdapter } from "./router.js";
import {
  createAnthropicAdapter,
  createOllamaAdapter,
  createOpenAiAdapter,
  createOpenRouterAdapter,
} from "./adapters/ai-sdk.js";

export function createProvidersFromConfig(config: Config): Map<string, ProviderAdapter> {
  const providers = new Map<string, ProviderAdapter>();
  if (config.llm.anthropicApiKey) {
    providers.set("anthropic", createAnthropicAdapter({ apiKey: config.llm.anthropicApiKey }));
  }
  if (config.llm.openaiApiKey) {
    providers.set("openai", createOpenAiAdapter({ apiKey: config.llm.openaiApiKey }));
  }
  if (config.llm.openrouterApiKey) {
    providers.set("openrouter", createOpenRouterAdapter({ apiKey: config.llm.openrouterApiKey }));
  }
  if (config.llm.ollamaBaseUrl) {
    providers.set("ollama", createOllamaAdapter({ baseUrl: config.llm.ollamaBaseUrl }));
  }
  return providers;
}
