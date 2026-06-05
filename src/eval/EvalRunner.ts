import type {
  EvalMetrics,
  EvalReport,
  ExecutionTrace,
  FailurePattern,
  StorageAdapter,
} from "../types.js";
import { computeMetrics } from "./Metrics.js";

export class EvalRunner {
  constructor(private readonly storage: StorageAdapter) {}

  /**
   * Compute metrics for all traces in the store, optionally filtered by recency.
   */
  async baseline(windowDays = 30): Promise<EvalMetrics> {
    const data = await this.storage.load();
    const cutoff = daysAgo(windowDays);
    const traces = data.traces.filter((t) => new Date(t.timestamp) >= cutoff);
    return computeMetrics(traces, data.patterns);
  }

  /**
   * Compare a candidate set of traces/patterns against the current baseline.
   * Useful for testing whether a new policy or gate reduces failures.
   */
  async compare(
    candidateTraces: ExecutionTrace[],
    candidatePatterns: FailurePattern[],
    windowDays = 30,
  ): Promise<EvalReport> {
    const baseline = await this.baseline(windowDays);
    const candidate = computeMetrics(candidateTraces, candidatePatterns);

    const improvement: Partial<EvalMetrics> = {
      firstAttemptSuccessRate:
        candidate.firstAttemptSuccessRate - baseline.firstAttemptSuccessRate,
      timeoutMinutesPer100Tasks:
        baseline.timeoutMinutesPer100Tasks - candidate.timeoutMinutesPer100Tasks,
      repeatedPatternRecurrenceRate:
        baseline.repeatedPatternRecurrenceRate - candidate.repeatedPatternRecurrenceRate,
    };

    const recommendation = recommend(improvement);
    const summary = buildSummary(baseline, candidate, improvement, recommendation);

    return { baseline, candidate, improvement, recommendation, summary };
  }

  /**
   * Replay a set of historical traces through the current gate config.
   * Returns metrics on how many would have been blocked vs. actually failed.
   */
  async replayStats(traces: ExecutionTrace[]): Promise<{
    wouldHaveBlocked: number;
    actualFailures: number;
    falsePositives: number;
  }> {
    const actualFailures = traces.filter((t) => t.outcome !== "success").length;

    // Simplified: count how many traces have a matching blocking pattern
    const data = await this.storage.load();
    const blockingPatterns = data.patterns.filter((p) => p.status === "blocking");

    let wouldHaveBlocked = 0;
    for (const trace of traces) {
      const sig = buildSig(trace);
      if (blockingPatterns.some((p) => p.signature === sig)) {
        wouldHaveBlocked++;
      }
    }

    const falsePositives = Math.max(0, wouldHaveBlocked - actualFailures);

    return { wouldHaveBlocked, actualFailures, falsePositives };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function daysAgo(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

function recommend(improvement: Partial<EvalMetrics>): EvalReport["recommendation"] {
  const successDelta = improvement.firstAttemptSuccessRate ?? 0;
  const timeoutDelta = improvement.timeoutMinutesPer100Tasks ?? 0;

  if (successDelta > 0.05 || timeoutDelta > 5) return "promote";
  if (successDelta < -0.05 || timeoutDelta < -5) return "reject";
  return "neutral";
}

function buildSummary(
  baseline: EvalMetrics,
  candidate: EvalMetrics,
  improvement: Partial<EvalMetrics>,
  recommendation: EvalReport["recommendation"],
): string {
  const successPct = ((improvement.firstAttemptSuccessRate ?? 0) * 100).toFixed(1);
  const timeoutDelta = (improvement.timeoutMinutesPer100Tasks ?? 0).toFixed(1);

  return (
    `Recommendation: ${recommendation.toUpperCase()}. ` +
    `Baseline success rate: ${(baseline.firstAttemptSuccessRate * 100).toFixed(1)}% → ` +
    `Candidate: ${(candidate.firstAttemptSuccessRate * 100).toFixed(1)}% ` +
    `(${parseFloat(successPct) >= 0 ? "+" : ""}${successPct}%). ` +
    `Timeout minutes/100 tasks: ${baseline.timeoutMinutesPer100Tasks.toFixed(1)} → ` +
    `${candidate.timeoutMinutesPer100Tasks.toFixed(1)} ` +
    `(${parseFloat(timeoutDelta) <= 0 ? "" : "+"}${timeoutDelta} min saved).`
  );
}

function buildSig(trace: ExecutionTrace): string {
  const ctx = trace.context;
  const ml = ctx.isMultiline ? "multiline" : "single";
  const hd = ctx.hasHeredoc ? "heredoc" : "noheredoc";
  return `${ctx.shell}:${ctx.target}:${ml}:${hd}:${ctx.transportClass}`;
}
