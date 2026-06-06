import type { FailurePattern } from "../types.js";

export interface PromotionThresholds {
  occurrences: number;
  windowDays: number;
  wastedMs: number;
  expirationDays: number;
}

export const DEFAULT_THRESHOLDS: PromotionThresholds = {
  occurrences: 2,
  windowDays: 30,
  wastedMs: 60_000,
  expirationDays: 90,
};

/**
 * A pattern has a usable alternative if it carries a concrete suggestion — not
 * the "unknown" placeholder we store when none has been observed yet.
 */
export function hasKnownAlternative(pattern: FailurePattern): boolean {
  const alt = (pattern.successfulAlternative ?? "").trim();
  return alt.length > 0 && alt.toLowerCase() !== "unknown";
}

/**
 * Returns true if this advisory pattern should be promoted to blocking.
 */
export function shouldPromote(
  pattern: FailurePattern,
  now: Date = new Date(),
  thresholds: PromotionThresholds = DEFAULT_THRESHOLDS,
): boolean {
  if (pattern.status !== "advisory") return false;

  // Light touch: only ever hard-block when we can tell the agent what to do
  // instead. Without a concrete alternative a pattern stays advisory and merely
  // warns — it never prevents a command from running. (Hook-recorded failures
  // carry no alternative, so they warn-only; the always-on built-in rules, which
  // always include an alternative, remain the source of hard blocks.)
  if (!hasKnownAlternative(pattern)) return false;

  const daysSinceFirst = daysBetween(new Date(pattern.firstSeen), now);

  const meetsOccurrenceThreshold =
    pattern.occurrences >= thresholds.occurrences && daysSinceFirst <= thresholds.windowDays;

  const meetsWastedTimeThreshold = pattern.wasted_ms >= thresholds.wastedMs;

  return meetsOccurrenceThreshold || meetsWastedTimeThreshold;
}

/**
 * Returns true if this pattern should be expired (moved out of active blocking).
 */
export function shouldExpire(
  pattern: FailurePattern,
  now: Date = new Date(),
  thresholds: PromotionThresholds = DEFAULT_THRESHOLDS,
): boolean {
  if (pattern.status !== "advisory") return false;

  const daysSinceLastSeen = daysBetween(new Date(pattern.lastSeen), now);
  return daysSinceLastSeen >= thresholds.expirationDays;
}

function daysBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return ms / (1000 * 60 * 60 * 24);
}
