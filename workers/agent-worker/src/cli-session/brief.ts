// The first prompt of the CLI session = the task brief. Deterministic, small,
// and explicit about the contract: the ONLY way to act on the company is the
// ACOS MCP tools; the session ends when the task is handed off. The CLI holds
// nothing (INV-10) — everything the agent needs to remember lives in the task,
// the workspace, and what the gateway returns.

export interface BriefInput {
  readonly company: { readonly name: string };
  readonly agent: {
    readonly name: string;
    readonly persona: string;
    readonly seniority: string;
    readonly positionTitle: string | null;
  };
  readonly task: {
    readonly number: number;
    readonly title: string;
    readonly objective: string | null;
    readonly successCriteria: readonly string[];
    readonly kind: string;
    readonly priority: string;
    readonly status: string;
    readonly parentTitle: string | null;
  };
  readonly workspace: {
    readonly kind: "worktree" | "session";
    readonly cwd: string;
    readonly branch: string | null;
  };
  /** ISO language directive already rendered by @acos/llm, if any. */
  readonly languageDirective?: string | undefined;
}

const MAX_DESCRIPTION = 12_000;

export function buildCliBrief(input: BriefInput): string {
  const { company, agent, task, workspace } = input;
  const desc = (task.objective ?? "").trim();
  const objective = desc.length > MAX_DESCRIPTION ? `${desc.slice(0, MAX_DESCRIPTION)}\n…(truncated)` : desc || "(no objective)";
  const criteria = task.successCriteria.filter((c) => c.trim().length > 0);
  const description = criteria.length > 0 ? `${objective}\n\nSuccess criteria:\n${criteria.map((c) => `- ${c}`).join("\n")}` : objective;
  const role = agent.positionTitle ? `${agent.positionTitle} (${agent.seniority})` : agent.seniority;
  const lines = [
    `You are ${agent.name}, ${role} at ${company.name}, an AI Agent Company OS (ACOS) company.`,
    `Persona: ${agent.persona.trim()}`,
    "",
    `# Your task — TASK-${task.number}: ${task.title}`,
    `kind=${task.kind} priority=${task.priority} status=${task.status}${task.parentTitle ? ` parent="${task.parentTitle}"` : ""}`,
    "",
    description,
    "",
    "# How this session works",
    "- This is a live ACOS agent session. The ONLY way to act on the company (tasks, delegation, hiring, review, help) is the `acos` MCP tools; there is no other channel.",
    "- Finish by calling `complete_task` with a concise result summary. If you are blocked, call `request_help`. If your work needs review, call `request_review`.",
    "- After `complete_task` / `request_help` / `request_review` the session ends; do not keep working after that.",
    workspace.kind === "worktree"
      ? `- Your workspace is the task worktree at ${workspace.cwd}${workspace.branch ? ` on branch \`${workspace.branch}\`` : ""}. Commit your work there with git; do not push.`
      : `- This is a planning session: you have no code worktree. Work through the MCP tools (create/delegate subtasks, request reviews) and your own reasoning; ${workspace.cwd} is scratch space.`,
    "- Every file/shell action you take is audited by the company Tool Gateway; some paths are off-limits and will be denied — do not retry a denied action, adapt.",
    "- Be concrete and brief in what you write back; the Founder is watching this session live.",
  ];
  if (input.languageDirective) lines.push("", input.languageDirective);
  return lines.join("\n");
}
