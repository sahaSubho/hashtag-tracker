export interface SloRunLike {
  started_at: Date;
  status: "SUCCESS" | "TRUNCATED" | "FAILED" | "RUNNING";
  gap_status: "none" | "open" | "closed" | "unrecoverable";
}

export interface SloResult {
  ratio: number;
  totalWindows: number;
  goodWindows: number;
}

function isGoodSyncRun(run: SloRunLike): boolean {
  return run.status === "SUCCESS" || (run.status === "TRUNCATED" && run.gap_status === "closed");
}

/**
 * SLO 1, freshness (spec §14): the fraction of fixed windows (default 3h)
 * within [from, to) that contain at least one good sync run (SUCCESS, or
 * TRUNCATED with a since-closed gap). A TRUNCATED run whose gap is still
 * open does not count — the window isn't actually caught up yet.
 */
export function computeFreshnessSlo(
  runs: SloRunLike[],
  from: Date,
  to: Date,
  windowMs: number
): SloResult {
  const totalWindows = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / windowMs));
  let goodWindows = 0;

  for (let i = 0; i < totalWindows; i++) {
    const windowStart = from.getTime() + i * windowMs;
    const windowEnd = windowStart + windowMs;
    const hasGoodRun = runs.some(
      (r) => r.started_at.getTime() >= windowStart && r.started_at.getTime() < windowEnd && isGoodSyncRun(r)
    );
    if (hasGoodRun) goodWindows++;
  }

  return { ratio: goodWindows / totalWindows, totalWindows, goodWindows };
}

/**
 * SLO 2, completeness (spec §14): the fraction of sync runs that did not
 * end in an unrecoverable gap.
 */
export function computeCompletenessSlo(runs: SloRunLike[]): SloResult {
  if (runs.length === 0) return { ratio: 1, totalWindows: 0, goodWindows: 0 };
  const good = runs.filter((r) => r.gap_status !== "unrecoverable").length;
  return { ratio: good / runs.length, totalWindows: runs.length, goodWindows: good };
}

export interface BurnRateInput {
  /** Fraction of events in the observed window that were bad (0..1). */
  errorRatioInWindow: number;
  /** e.g. 0.99 for a 99% SLO. */
  sloTarget: number;
  /** How much of the full SLO period (e.g. 30 days) the observed window covers, as a fraction. */
  windowFractionOfSloPeriod: number;
}

/**
 * The standard SRE error-budget burn-rate formula (spec §14): how many
 * times faster than "on schedule" the error budget is being consumed. A
 * burn rate of 1 means the budget is being spent exactly evenly across the
 * SLO period; 14.4 means the whole 30-day budget would be exhausted in
 * about 1 hour at the observed rate — the plan's page threshold.
 */
export function computeBurnRate(input: BurnRateInput): number {
  const errorBudget = 1 - input.sloTarget;
  if (errorBudget <= 0) return input.errorRatioInWindow > 0 ? Infinity : 0;
  return input.errorRatioInWindow / (errorBudget * input.windowFractionOfSloPeriod);
}
