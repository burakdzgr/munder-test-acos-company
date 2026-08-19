// Resolution chain (_DECISIONS §17): purpose → agent binding override →
// company profiles (priority order) = the fallback chain. Pure function over
// data rows — the DB read happens app-side.
import {
  PURPOSE_TO_BINDING,
  type AgentBindingInput,
  type LlmPurpose,
  type ModelProfileInput,
  type ResolvedTarget,
} from "./types.js";

export function resolveTargets(
  purpose: LlmPurpose,
  bindings: readonly AgentBindingInput[],
  profiles: readonly ModelProfileInput[],
): ResolvedTarget[] {
  const bindingPreference = PURPOSE_TO_BINDING[purpose];
  const targets: ResolvedTarget[] = [];

  const prefRank = (p: string) => {
    const i = bindingPreference.indexOf(p as (typeof bindingPreference)[number]);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const fromBindings = bindings
    .filter((b) => bindingPreference.includes(b.purpose as (typeof bindingPreference)[number]))
    .sort(
      (a, b) => prefRank(a.purpose) - prefRank(b.purpose) || (a.priority ?? 0) - (b.priority ?? 0),
    )
    .map(
      (b): ResolvedTarget => ({
        providerId: b.providerId,
        model: b.model,
        params: b.params ?? {},
        maxTokensPerCall: null,
        costCapCentsPerCall: null,
        source: "binding",
      }),
    );

  const fromProfiles = profiles
    .filter((p) => p.purpose === purpose && p.enabled !== false)
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
    .map(
      (p): ResolvedTarget => ({
        providerId: p.providerId,
        model: p.model,
        params: p.params ?? {},
        maxTokensPerCall: p.maxTokensPerCall ?? null,
        costCapCentsPerCall: p.costCapCentsPerCall ?? null,
        source: "profile",
      }),
    );

  // binding override first, then company profiles as the fallback chain;
  // duplicates (same provider+model) collapse onto the first occurrence
  const seen = new Set<string>();
  for (const target of [...fromBindings, ...fromProfiles]) {
    const key = `${target.providerId}::${target.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(target);
  }
  return targets;
}
