import type { EvalMetrics, ExecutionTrace, FailurePattern } from "../types.js";

export function computeMetrics(
  traces: ExecutionTrace[],
  patterns: FailurePattern[],
): EvalMetrics {
  if (traces.length === 0) {
    return {
      firstAttemptSuccessRate: 1,
      repeatedPatternRecurrenceRate: 0,
      timeoutMinutesPer100Tasks: 0,
      transportSwitchCompliance: 1,
      totalTraces: 0,
      totalPatterns: patterns.length,
      blockingPatterns: patterns.filter((p) => p.status === "blocking").length,
    };
  }

  return {
    firstAttemptSuccessRate: computeFirstAttemptSuccessRate(traces),
    repeatedPatternRecurrenceRate: computeRepeatedPatternRecurrenceRate(patterns),
    timeoutMinutesPer100Tasks: computeTimeoutMinutesPer100(traces),
    transportSwitchCompliance: computeTransportSwitchCompliance(traces),
    totalTraces: traces.length,
    totalPatterns: patterns.length,
    blockingPatterns: patterns.filter((p) => p.status === "blocking").length,
  };
}

/**
 * % of traces where outcome was success.
 */
export function computeFirstAttemptSuccessRate(traces: ExecutionTrace[]): number {
  if (traces.length === 0) return 1;
  const successes = traces.filter((t) => t.outcome === "success").length;
  return successes / traces.length;
}

/**
 * Fraction of patterns that have been seen more than once.
 */
export function computeRepeatedPatternRecurrenceRate(patterns: FailurePattern[]): number {
  if (patterns.length === 0) return 0;
  const repeated = patterns.filter((p) => p.occurrences > 1).length;
  return repeated / patterns.length;
}

/**
 * Total timeout duration in minutes, normalized per 100 tasks.
 */
export function computeTimeoutMinutesPer100(traces: ExecutionTrace[]): number {
  if (traces.length === 0) return 0;
  const totalTimeoutMs = traces
    .filter((t) => t.outcome === "timeout")
    .reduce((sum, t) => sum + t.duration_ms, 0);
  const perTask = totalTimeoutMs / traces.length;
  return (perTask / 60_000) * 100; // convert to minutes per 100 tasks
}

/**
 * % of mechanical failures where the agent switched transport on the next attempt.
 * Measured by: after a mechanical-failure trace, was an alternative used in the next trace?
 */
export function computeTransportSwitchCompliance(traces: ExecutionTrace[]): number {
  const mechanicalFailures = traces
    .map((t, i) => ({ trace: t, idx: i }))
    .filter(({ trace }) => trace.outcome === "mechanical-failure");

  if (mechanicalFailures.length === 0) return 1;

  let switches = 0;
  for (const { idx } of mechanicalFailures) {
    const next = traces[idx + 1];
    if (next?.alternativeUsed) switches++;
  }

  return switches / mechanicalFailures.length;
}
