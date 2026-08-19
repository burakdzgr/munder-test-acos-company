// Canonical state machines are data + guard functions (_DECISIONS.md §19,
// 03 §1.5) — implemented once here, reused by server, workers, and UI.
import { DomainError } from "../errors.js";

export interface StateMachine<S extends string> {
  readonly name: string;
  readonly states: readonly S[];
  readonly terminalStates: readonly S[];
  canTransition(from: S, to: S): boolean;
  transitionsFrom(from: S): readonly S[];
  isTerminal(state: S): boolean;
  /** Throws DomainError on an illegal transition. */
  assertTransition(from: S, to: S): void;
}

export function defineStateMachine<S extends string>(
  name: string,
  table: Readonly<Record<S, readonly S[]>>,
): StateMachine<S> {
  const states = Object.keys(table) as S[];
  for (const [from, targets] of Object.entries(table) as [S, readonly S[]][]) {
    for (const to of targets) {
      if (!(to in table)) {
        throw new DomainError(`${name}: transition ${from} → ${to} targets unknown state`);
      }
    }
  }
  const canTransition = (from: S, to: S): boolean => table[from]?.includes(to) ?? false;
  return {
    name,
    states,
    terminalStates: states.filter((s) => table[s].length === 0),
    canTransition,
    transitionsFrom: (from) => table[from] ?? [],
    isTerminal: (state) => (table[state]?.length ?? 0) === 0,
    assertTransition: (from, to) => {
      if (!canTransition(from, to)) {
        throw new DomainError(`${name}: illegal transition ${from} → ${to}`);
      }
    },
  };
}
