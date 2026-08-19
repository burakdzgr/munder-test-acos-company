// CompanyContext — every repository method takes one (_DECISIONS §4, S4).
import { DomainError, isUuid } from "@acos/domain";

export interface CompanyContext {
  readonly companyId: string;
}

export function companyContext(companyId: string): CompanyContext {
  if (!isUuid(companyId)) {
    throw new DomainError(`CompanyContext requires a uuid companyId, got "${companyId}"`);
  }
  return { companyId };
}
