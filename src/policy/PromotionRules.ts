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
 * Returns true if this advisory pattern should be promoted to blocking.
 */
export function shouldPromote(
  pattern: FailurePattern,
  now: Date = new Date(),
  thresholds: PromotionThresholds = DEFAULT_THRESHOLDS,
): boolean {
  if (pattern.status !== "advisory") return false;

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
  if (pattern.status === "expired") return false;

  const daysSinceLastSeen = daysBetween(new Date(pattern.lastSeen), now);
  return daysSinceLastSeen >= thresholds.expirationDays;
}

function daysBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return ms / (1000 * 60 * 60 * 24);
}
