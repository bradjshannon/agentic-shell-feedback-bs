import type { CommandContext, FailurePattern } from "../types.js";

/**
 * Computes a deterministic signature string from a CommandContext.
 * Format: `{shell}:{target}:{multiline}:{heredoc}:{transportClass}`
 */
export function computeSignature(context: CommandContext): string {
  const ml = context.isMultiline ? "multiline" : "single";
  const hd = context.hasHeredoc ? "heredoc" : "noheredoc";
  return `${context.shell}:${context.target}:${ml}:${hd}:${context.transportClass}`;
}

/**
 * Computes an environment fingerprint (broader than signature).
 * Format: `{os}:{shell}:{target}`
 */
export function computeEnvironmentFingerprint(context: CommandContext): string {
  return `${context.os}:${context.shell}:${context.target}`;
}

export interface ScoredPattern {
  pattern: FailurePattern;
  /** 0–1: 1.0 = exact signature match, <1 = fuzzy */
  score: number;
}

/**
 * Rank patterns by relevance to the given context.
 * Returns patterns sorted descending by score, filtered above minScore.
 */
export function rankPatterns(
  patterns: FailurePattern[],
  context: CommandContext,
  minScore = 0.5,
): ScoredPattern[] {
  const sig = computeSignature(context);
  const env = computeEnvironmentFingerprint(context);

  const scored: ScoredPattern[] = patterns
    .filter((p) => p.status !== "expired")
    .map((pattern) => {
      const score = computeSimilarity(pattern, sig, env, context);
      return { pattern, score };
    })
    .filter((s) => s.score >= minScore);

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

function computeSimilarity(
  pattern: FailurePattern,
  sig: string,
  env: string,
  context: CommandContext,
): number {
  if (pattern.signature === sig) return 1.0;

  // Partial matches on signature components
  const patParts = pattern.signature.split(":");
  const sigParts = sig.split(":");
  const matchCount = patParts.filter((p, i) => p === sigParts[i]).length;
  const partialScore = matchCount / sigParts.length;

  // Boost for matching environment fingerprint
  const envBoost = pattern.environmentFingerprint === env ? 0.1 : 0;

  // Boost for same shell + target (the most important axes)
  const shellMatch = patParts[0] === sigParts[0] ? 0.15 : 0;
  const targetMatch = patParts[1] === sigParts[1] ? 0.15 : 0;

  // Payload-length proximity (within 50%)
  const lenScore = scoreLengthProximity(pattern, context);

  return Math.min(0.99, partialScore * 0.5 + envBoost + shellMatch + targetMatch + lenScore);
}

function scoreLengthProximity(pattern: FailurePattern, context: CommandContext): number {
  // Patterns don't store payload length directly; use signature cues
  const isPatternMultiline = pattern.signature.includes(":multiline:");
  const isCtxMultiline = context.isMultiline;
  return isPatternMultiline === isCtxMultiline ? 0.05 : 0;
}
