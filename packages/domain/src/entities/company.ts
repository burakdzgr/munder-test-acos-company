// Tenant root (_DECISIONS.md §4, 03 §3.1).
import { DomainError } from "../errors.js";
import { uuidv7 } from "../ids.js";

export interface Company {
  readonly id: string;
  readonly name: string;
  readonly slug: string; // seed idempotency key (27 §4)
  readonly currency: string; // per-company budget currency (A4)
  readonly createdAt: Date;
}

export interface CreateCompanyInput {
  name: string;
  slug: string;
  currency: string;
}

export interface FactoryDeps {
  id?: string;
  now?: Date;
}

export function createCompany(input: CreateCompanyInput, deps: FactoryDeps = {}): Company {
  if (input.name.trim() === "") throw new DomainError("company name must not be empty");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(input.slug)) {
    throw new DomainError(`company slug must be kebab-case, got "${input.slug}"`);
  }
  if (!/^[A-Z]{3}$/.test(input.currency)) {
    throw new DomainError(`company currency must be a 3-letter code, got "${input.currency}"`);
  }
  return {
    id: deps.id ?? uuidv7(),
    name: input.name,
    slug: input.slug,
    currency: input.currency,
    createdAt: deps.now ?? new Date(),
  };
}
