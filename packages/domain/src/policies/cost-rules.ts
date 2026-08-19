// Burn-rate forecasting (26 §8, T49): simple, deterministic, no ML.
// projected = spent_so_far + burn_rate_per_hour × hours_remaining, where the
// burn rate is trailing-24h spend ÷ 24 (fallback: period-to-date average when
// under 24h of data). Always recomputable — never persisted.

export interface BurnForecastInput {
  readonly spentSoFarCents: number;
  readonly trailing24hCents: number;
  readonly hoursElapsedInPeriod: number;
  readonly hoursRemainingInPeriod: number;
}

export function projectedSpendCents(input: BurnForecastInput): number {
  const elapsed = Math.max(0, input.hoursElapsedInPeriod);
  const remaining = Math.max(0, input.hoursRemainingInPeriod);
  const ratePerHour =
    elapsed >= 24
      ? input.trailing24hCents / 24
      : elapsed > 0
        ? input.spentSoFarCents / elapsed
        : 0;
  return Math.round(input.spentSoFarCents + ratePerHour * remaining);
}

/** Soft breach signal: projection exceeds a hard limit with >12h to act (26 §8). */
export function forecastBreach(input: {
  projectedCents: number;
  limitCents: number;
  hoursRemainingInPeriod: number;
}): boolean {
  return input.projectedCents > input.limitCents && input.hoursRemainingInPeriod > 12;
}
