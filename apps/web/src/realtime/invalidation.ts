// WS event → Query invalidation map (24 §4.2). Family-based rules over the
// implemented modules; unknown families invalidate nothing (their views land
// with later tasks and bring their rules along).
import type { Event } from "@acos/contracts";
import { keys } from "../lib/api.js";

type QueryKey = readonly unknown[];

export function invalidationKeysFor(cid: string, event: Event): QueryKey[] {
  const agentId = event.subject.agentId;
  const type = event.type;

  if (type.startsWith("agent.")) {
    const invalidated: QueryKey[] = [keys.agents(cid)];
    if (agentId) invalidated.push(keys.agent(cid, agentId));
    if (type === "agent.hired" || type === "agent.offboarded") invalidated.push(keys.orgEdges(cid));
    if (type === "agent.model.binding.changed" && agentId)
      invalidated.push(keys.agentBindings(cid, agentId));
    if (type.startsWith("agent.session") && agentId)
      invalidated.push(keys.agentSessions(cid, agentId));
    // Komuta merkezi oturum hücreleri: oturum başla/bit + her kaydedilen adım
    // ana sayfadaki canlı akışı tazeler (CEO dahil her görev alan ajan).
    if (type.startsWith("agent.session") || type.startsWith("agent.step") || type === "agent.task.started")
      invalidated.push([cid, "agent-sessions"]);
    if (type.startsWith("agent.step") && agentId)
      invalidated.push([cid, "agents", agentId, "steps"]);
    if (type === "agent.task.assigned") invalidated.push([cid, "tasks"]);
    return invalidated;
  }
  if (
    type.startsWith("org.") ||
    type === "department.created" ||
    type === "team.created" ||
    type === "position.created" ||
    type === "position.updated"
  ) {
    const invalidated: QueryKey[] = [keys.orgUnits(cid), keys.orgPositions(cid), keys.orgEdges(cid)];
    // team/department channels auto-provision with their unit (11 §2)
    if (type === "team.created" || type === "department.created")
      invalidated.push([cid, "channels"]);
    return invalidated;
  }
  if (type.startsWith("company.")) {
    return [[cid, "settings"], keys.companies];
  }
  if (type.startsWith("task.")) {
    return [[cid, "tasks"]]; // prefix — list, dag and detail queries all match
  }
  if (type === "agent.message.sent" || type.startsWith("channel.")) {
    return [[cid, "channels"]];
  }
  if (type.startsWith("approval.")) {
    return [[cid, "approvals"]]; // prefix — inbox, history and detail queries
  }
  if (type.startsWith("memory.")) {
    return [[cid, "memories"]]; // panel list/graph + Observatory queries (U07)
  }
  if (type.startsWith("agent.skill.")) {
    return [[cid, "skills"]];
  }
  return [];
}
