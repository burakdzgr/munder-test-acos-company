// Self-referencing org hierarchy node (_DECISIONS.md §5, 03 §3.1).
import { DomainError } from "../errors.js";
import { uuidv7 } from "../ids.js";
import type { FactoryDeps } from "./company.js";

export const UNIT_KINDS = ["department", "team", "office", "division"] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

export interface OrgUnit {
  readonly id: string;
  readonly companyId: string;
  readonly name: string;
  readonly kind: UnitKind;
  readonly parentUnitId: string | null;
  readonly createdAt: Date;
}

export interface CreateOrgUnitInput {
  companyId: string;
  name: string;
  kind: UnitKind;
  parentUnitId?: string | null;
}

export function createOrgUnit(input: CreateOrgUnitInput, deps: FactoryDeps = {}): OrgUnit {
  if (input.name.trim() === "") throw new DomainError("org unit name must not be empty");
  if (!(UNIT_KINDS as readonly string[]).includes(input.kind)) {
    throw new DomainError(`unknown org unit kind "${input.kind}"`);
  }
  return {
    id: deps.id ?? uuidv7(),
    companyId: input.companyId,
    name: input.name,
    kind: input.kind,
    parentUnitId: input.parentUnitId ?? null,
    createdAt: deps.now ?? new Date(),
  };
}
