import type { CommandContext, FailurePattern } from "../types.js";
import { computeCommandFingerprint } from "./CommandFingerprint.js";

/**
 * Number of leading, colon-delimited "shape" components in a signature. The
 * command fingerprint is appended as the final component (and is itself stripped
 * of colons), so `split(":")` yields exactly these shape parts plus one.
 */
const SHAPE_PARTS = 5;

/**
 * Computes a deterministic signature string from a CommandContext.
 * Format: `{shell}:{target}:{multiline}:{heredoc}:{transportClass}:{commandFingerprint}`
 *
 * The fingerprint makes the signature specific to the command that ran, not just
 * its transport shape — so a learned pattern blocks the command that misbehaved
 * rather than every command of the same shape.
 */
export function computeSignature(context: CommandContext): string {
  const ml = context.isMultiline ? "multiline" : "single";
  const hd = context.hasHeredoc ? "heredoc" : "noheredoc";
  const fp = computeCommandFingerprint(context.command);
  return `${context.shell}:${context.target}:${ml}:${hd}:${context.transportClass}:${fp}`;
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
  /** 0–1: 1.0 = exact signature match, <1 = same command, fuzzier shape */
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
    .map((pattern) => ({ pattern, score: computeSimilarity(pattern, sig, env) }))
    .filter((s) => s.score >= minScore);

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

function fingerprintOf(signature: string): string {
  // Everything after the shape components is the (colon-free) fingerprint.
  return signature.split(":").slice(SHAPE_PARTS).join(":");
}

function computeSimilarity(pattern: FailurePattern, sig: string, env: string): number {
  if (pattern.signature === sig) return 1.0;

  // A different command is not "the same known-bad move." We never surface it —
  // the general transport shape is already covered by the always-on built-in
  // rules, so the learned layer stays strictly per-command.
  if (fingerprintOf(pattern.signature) !== fingerprintOf(sig)) return 0;

  // Same command, slightly different transport shape: a soft, sub-1.0 score so
  // it can raise an advisory warning but never reach the exact-match block bar.
  const patShape = pattern.signature.split(":").slice(0, SHAPE_PARTS);
  const sigShape = sig.split(":").slice(0, SHAPE_PARTS);
  const matchCount = patShape.filter((p, i) => p === sigShape[i]).length;
  const shapeScore = matchCount / SHAPE_PARTS;
  const envBoost = pattern.environmentFingerprint === env ? 0.05 : 0;

  return Math.min(0.9, 0.5 + shapeScore * 0.4 + envBoost);
}
