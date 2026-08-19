# ADR-015: LLM Provider Abstraction — Own ModelRouter Port, Vercel AI SDK v5 as Adapter Layer

Status: Accepted · Date: 2026-08-10 · Deciders: Architecture team

## Context

The platform must support Anthropic, OpenAI, OpenRouter, Ollama, and vLLM with task-based routing
on capability, cost, latency, privacy, and risk (_BRIEF §9), plus a fully-offline Ollama-only
profile (_DECISIONS §0 A3). Forces:

- **Identity decoupling.** Swapping the model never changes who "Alex" is (_BRIEF §2.4);
  `agent_model_bindings` map agents to purposes (`primary|fast|embedding`), and company
  `model_profiles` map purposes (`reasoning|coding|fast|embedding|vision`) to provider+model+
  params+caps (_DECISIONS §6, §17).
- **Routing & resilience.** Resolution chain: task risk/type → purpose → agent binding override →
  company profile → fallback chain on 429/5xx; per-call token caps; every call logged to
  `llm_calls` with tokens/cost/latency (_DECISIONS §17).
- **Replaceability.** The domain must never depend on a vendor SDK's types; whatever library we
  use must be swappable without touching workflows or domain code (_BRIEF §2.6 spirit).
- **Call sites.** All LLM calls happen inside Temporal activities in `workers/agent-worker`
  (ADR-004/005) — streaming structured output, tool-free JSON parsing into the `AgentAction` Zod
  union, and embedding calls.

## Options considered

### Option A: LangChain(.js)

- **Description.** Use LangChain's model wrappers, prompt templates, and output parsers as the
  provider layer.
- **Pros.** Broadest provider coverage; many utilities (parsers, retrievers) we could borrow;
  large community.
- **Cons.** Chronic **abstraction leakage**: its chain/runnable abstractions impose their own
  composition model, its types shift across releases, and provider-specific behavior seeps
  through wrappers — exactly what a stable port must hide. Much of the framework (chains, agents,
  retrievers) duplicates things we deliberately own (loop, memory, tools). Pulling it in for just
  model IO imports a heavy dependency graph for the thinnest slice of its value.
- **Rejected because** abstraction leakage and framework gravity; it solves problems we have
  already solved in the domain.

### Option B: LiteLLM proxy

- **Description.** Run LiteLLM as a gateway service exposing one OpenAI-compatible API over 100+
  providers; the app speaks OpenAI format to it.
- **Pros.** Provider translation, retries, budgets, and usage tracking handled outside the app;
  language-agnostic; popular in self-hosted stacks.
- **Cons.** An extra always-on Python service in the compose stack (against stack minimalism) —
  and a *second* budget/routing brain that would fight our domain's routing rules (agent
  bindings, purpose profiles, risk-aware selection live in Postgres and must drive decisions).
  Flattening everything to OpenAI-compat loses provider-native capabilities (Anthropic-specific
  features, structured outputs nuances).
- **Rejected as core because** extra service + duplicated routing authority; **explicitly fine as
  an optional egress gateway** a self-hoster may point a provider adapter at.

### Option C: Direct vendor SDKs only

- **Description.** Hand-written adapters per provider on top of official SDKs (Anthropic, OpenAI)
  and raw HTTP for OpenRouter/Ollama/vLLM.
- **Pros.** Zero third-party abstraction risk; full access to native features; smallest possible
  dependency surface per provider.
- **Cons.** N× integration work that is pure undifferentiated plumbing: streaming protocols,
  tool/JSON-mode differences, token accounting quirks, retry semantics — re-implemented and
  re-maintained per provider, forever. The AI SDK does exactly this translation as its whole job.
- **Rejected because** it spends ongoing effort on commodity translation the AI SDK already does
  well; kept as the escape hatch pattern (any single adapter may drop to a raw SDK).

### Option D: Own ModelRouter port + Vercel AI SDK v5 provider adapters (chosen)

- **Description.** We define the interface; AI SDK providers implement the transport inside our
  adapters. Ollama/vLLM connect via OpenAI-compatible endpoints.
- **Pros.** One well-maintained translation layer, TS-native, streaming + structured output
  support; our port stays vendor-neutral; adapters are thin and individually replaceable.
- **Cons.** AI SDK major-version churn is real (v5 breaking changes); its abstractions could
  leak if allowed outside the adapter layer — must be policed.

## Decision

`packages/llm` defines the **ModelRouter port** — our own interface and types:
`complete()`, `stream()`, `embed()`, with our request/response/usage/error shapes (Zod-schema'd),
purpose-based model resolution, fallback chains, and cost accounting. **Vercel AI SDK v5 is used
strictly inside provider adapters** implementing that port (Anthropic, OpenAI, OpenRouter;
Ollama/vLLM via OpenAI-compat).

Bounding rules:

- **No AI SDK type, function, or error crosses the adapter boundary.** Domain, workflows,
  activities, and prompts import only `packages/llm` port types; lint boundaries enforce that
  only adapter files import `ai`/`@ai-sdk/*`.
- The **router owns resolution** (_DECISIONS §17): task risk/type → purpose → agent binding →
  company profile → fallback on 429/5xx to the next provider in the chain, with per-call token
  caps and per-purpose cost caps. Adapters translate; they never choose models.
- Every call is logged to `llm_calls` (tokens, cost, latency, purpose, agent, task, cached) by
  the router — accounting cannot be skipped by any call path.
- All ModelRouter use happens inside Temporal activities (retries/timeouts per ADR-005); the
  router itself does not retry beyond its provider-fallback semantics, so retry policy stays in
  one place (Temporal) per failure class.
- Embeddings go through the same port (`embed()`), honoring per-company embedding config
  (ADR-020).
- Swapping or removing the AI SDK is, by construction, an adapter-file rewrite with zero changes
  elsewhere; an optional LiteLLM gateway can be configured as a provider endpoint without code
  changes.

## Consequences

**Positive.**
- Provider breadth without provider lock-in: new providers are one adapter file; offline mode is
  a profile whose purposes all resolve to Ollama models.
- Model routing is domain data (Postgres), aligned with identity decoupling and editable in the
  UI — not code or an external proxy's config.
- Uniform accounting: cost tracking, budget circuit breakers, and the Costs view all hang off
  `llm_calls` written in exactly one place.

**Negative / accepted tradeoffs.**
- Two-layer indirection (port + AI SDK) adds a little conceptual overhead; accepted to avoid N×
  raw integrations.
- AI SDK major upgrades will periodically demand adapter work; contained by the boundary rule.
- Provider-native exotic features are available only if we surface them through the port —
  deliberate friction that keeps call sites portable.

**Revisit triggers.**
- AI SDK churn forces adapter rewrites more than ~once/quarter, or it drops/lags a provider we
  need → replace affected adapters with direct SDKs (Option C per-provider).
- A self-hosted gateway (LiteLLM/OpenRouter-local) proves strategically valuable for key
  management at fleet scale → promote from optional to documented default egress.
- The port's shape blocks a needed capability class (e.g. server-side tool use, realtime voice) →
  extend the port via ADR update, never by leaking adapter types.

## References

- _BRIEF.md §2.4 (identity decoupling), §9 (model provider abstraction)
- _DECISIONS.md §1 (LLM row), §6 (bindings), §17 (routing), §22 row 015
- ADR-004 (agent loop call sites), ADR-005 (activities), ADR-020 (embeddings)
