// Currency-agnostic money in minor units (_DECISIONS.md §0 A4).
import { DomainError } from "../errors.js";

export interface Money {
  readonly amountCents: number; // integer minor units
  readonly currency: string; // ISO-4217-style code, per-company setting
}

export function money(amountCents: number, currency: string): Money {
  if (!Number.isInteger(amountCents)) {
    throw new DomainError(`money amount must be integer minor units, got ${amountCents}`);
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new DomainError(`money currency must be a 3-letter uppercase code, got "${currency}"`);
  }
  return { amountCents, currency };
}

function assertSameCurrency(a: Money, b: Money, op: string): void {
  if (a.currency !== b.currency) {
    throw new DomainError(`cannot ${op} ${a.currency} and ${b.currency}`);
  }
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b, "add");
  return { amountCents: a.amountCents + b.amountCents, currency: a.currency };
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b, "subtract");
  return { amountCents: a.amountCents - b.amountCents, currency: a.currency };
}

export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b, "compare");
  if (a.amountCents < b.amountCents) return -1;
  if (a.amountCents > b.amountCents) return 1;
  return 0;
}
