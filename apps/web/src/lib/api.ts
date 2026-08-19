// SDK + Query client (24 §4): server state lives in TanStack Query, keys are
// company-first so a switch can drop a whole company's cache.
import { QueryClient } from "@tanstack/react-query";
import { createAcosClient } from "@acos/contracts/client";

export const api = createAcosClient({ baseUrl: "" }); // Vite/nginx proxies /api

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 2,
    },
  },
});

/** [companyId, entity, scope?, id?] (24 §4.1). */
export const keys = {
  me: ["me"] as const,
  companies: ["companies"] as const,
  agents: (cid: string) => [cid, "agents", "list"] as const,
  agent: (cid: string, agentId: string) => [cid, "agents", "detail", agentId] as const,
  agentBindings: (cid: string, agentId: string) => [cid, "agents", "bindings", agentId] as const,
  agentSessions: (cid: string, agentId: string) => [cid, "agents", "sessions", agentId] as const,
  agentChain: (cid: string, agentId: string) => [cid, "org", "chain", agentId] as const,
  tasks: (cid: string) => [cid, "tasks", "list"] as const,
  memories: (cid: string) => [cid, "memories", "list"] as const,
  orgUnits: (cid: string) => [cid, "org", "units"] as const,
  orgPositions: (cid: string) => [cid, "org", "positions"] as const,
  orgEdges: (cid: string) => [cid, "org", "graph"] as const,
  approvals: (cid: string, scope: string) => [cid, "approvals", scope] as const,
};
