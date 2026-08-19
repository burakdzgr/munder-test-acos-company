// Role definition an agent occupies (_DECISIONS.md §5, 03 §3.1).
import { DomainError } from "../errors.js";
import { uuidv7 } from "../ids.js";
import type { FactoryDeps } from "./company.js";

export interface Position {
  readonly id: string;
  readonly companyId: string;
  readonly title: string;
  readonly seniorityTrack: string; // e.g. "engineering", "management"
  readonly defaultRole: string; // default platform role for holders
  readonly createdAt: Date;
}

export interface CreatePositionInput {
  companyId: string;
  title: string;
  seniorityTrack: string;
  defaultRole: string;
}

export function createPosition(input: CreatePositionInput, deps: FactoryDeps = {}): Position {
  if (input.title.trim() === "") throw new DomainError("position title must not be empty");
  return {
    id: deps.id ?? uuidv7(),
    companyId: input.companyId,
    title: input.title,
    seniorityTrack: input.seniorityTrack,
    defaultRole: input.defaultRole,
    createdAt: deps.now ?? new Date(),
  };
}
