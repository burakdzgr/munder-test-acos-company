// First-class engineering entity (_DECISIONS.md §19, 03 §3.7).
// Field details beyond this core land with T42 per 14-PROJECT-RUNTIME.md /
// doc 20 (Drizzle schemas are the authoritative column definitions).
import { DomainError } from "../errors.js";
import { uuidv7 } from "../ids.js";
import type { FactoryDeps } from "./company.js";

export const PROJECT_STATUSES = [
  // Yeni yaşam döngüsü (PROJECT-LIFECYCLE-CONTEXT-ARCHITECTURE TASK 2)
  "draft",
  "repository_setup",
  "indexing",
  "ready",
  "planning",
  "staffing_review",
  "waiting_for_founder",
  "executing",
  "failed",
  // miras durumlar (eski kayıtlar + köprüler)
  "proposed",
  "intake",
  "active",
  "paused",
  "completed",
  "archived",
  "cancelled",
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const WORKSPACE_STATUSES = [
  "provisioning",
  "ready",
  "in_use",
  "idle",
  "merged",
  "discarded",
  "failed",
  "destroyed",
] as const;
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

export const ISOLATION_LEVELS = [
  "analysis",
  "coding",
  "testing",
  "deploy",
  "browser",
  "media",
] as const;
export type IsolationLevel = (typeof ISOLATION_LEVELS)[number];

export interface Project {
  readonly id: string;
  readonly companyId: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: ProjectStatus;
  readonly createdAt: Date;
}

export interface CreateProjectInput {
  companyId: string;
  name: string;
  description?: string | null;
}

export function createProject(input: CreateProjectInput, deps: FactoryDeps = {}): Project {
  if (input.name.trim() === "") throw new DomainError("project name must not be empty");
  return {
    id: deps.id ?? uuidv7(),
    companyId: input.companyId,
    name: input.name,
    description: input.description ?? null,
    status: "proposed",
    createdAt: deps.now ?? new Date(),
  };
}

/** Task branch naming: task/<task-number>-<slug> (_DECISIONS.md §13, §21). */
export function taskBranchName(taskNumber: number, title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  if (slug === "") throw new DomainError("task title yields an empty branch slug");
  return `task/${taskNumber}-${slug}`;
}
