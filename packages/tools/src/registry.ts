// Tool registry (17 §2): the gateway refuses any invocation whose name is
// not registered here — fail-closed. The Working-Set builder renders only
// the subset the agent has any grant for.
import type { ToolDefinition } from "./contract.js";
import { MVP_TOOLS } from "./definitions.js";

const NAME_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*){1,3}$/;

export function buildRegistry(defs: readonly ToolDefinition[]): Map<string, ToolDefinition> {
  const registry = new Map<string, ToolDefinition>();
  for (const def of defs) {
    if (!NAME_PATTERN.test(def.name)) {
      throw new Error(`tool name "${def.name}" violates dot-namespaced naming`);
    }
    if (registry.has(def.name)) {
      throw new Error(`duplicate tool definition "${def.name}"`);
    }
    registry.set(def.name, def);
  }
  return registry;
}

/** The MVP registry — source of truth for every invokable tool (S3). */
export const toolRegistry: ReadonlyMap<string, ToolDefinition> = buildRegistry(MVP_TOOLS);

export function getTool(name: string): ToolDefinition | undefined {
  return toolRegistry.get(name);
}

export function listTools(): ToolDefinition[] {
  return [...toolRegistry.values()];
}
