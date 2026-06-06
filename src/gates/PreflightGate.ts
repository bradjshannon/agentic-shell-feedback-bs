import type {
  CommandContext,
  FailurePattern,
  GateRule,
  PreflightResult,
} from "../types.js";
import { type ScoredPattern } from "../registry/PatternMatcher.js";
import { getBuiltInRules } from "./BuiltInRules.js";

/** A registry pattern only hard-blocks on an exact signature match (score 1.0). */
const EXACT_MATCH = 1;

export interface PreflightGateOptions {
  enableBuiltInRules?: boolean;
  customRules?: GateRule[];
  /** Minimum match score for a pattern to be surfaced as an advisory warning. */
  minMatchScore?: number;
}

export class PreflightGate {
  private readonly rules: GateRule[];
  private readonly minMatchScore: number;

  constructor(private readonly options: PreflightGateOptions = {}) {
    const builtIn = options.enableBuiltInRules !== false ? getBuiltInRules() : [];
    this.rules = [...builtIn, ...(options.customRules ?? [])];
    this.minMatchScore = options.minMatchScore ?? 0.7;
  }

  /**
   * Check a command context against built-in rules and known patterns.
   * Gate is synchronous — registry lookup happens before calling this.
   */
  check(context: CommandContext, knownPatterns: ScoredPattern[] = []): PreflightResult {
    const warnings: string[] = [];

    // 1. Check built-in and custom rules
    for (const rule of this.rules) {
      if (!rule.match(context)) continue;

      if (rule.verdict === "deny") {
        const res: PreflightResult = {
          allowed: false,
          warnings,
          reason: rule.reason ?? rule.description,
        };
        if (rule.alternative !== undefined) res.requiredAlternative = rule.alternative;
        return res;
      }

      if (rule.verdict === "warn") {
        warnings.push(rule.reason ?? rule.description);
      }
    }

    // 2. Check dynamic patterns from registry.
    //    Light touch: a learned pattern only *blocks* on an exact match — the
    //    same command, same shape, that we know fails and can offer a fix for.
    //    Anything fuzzier (a sibling command shape) at most raises a warning, so
    //    the command still runs.
    for (const { pattern, score } of knownPatterns) {
      if (pattern.status === "expired") continue;

      if (pattern.status === "blocking" && score >= EXACT_MATCH) {
        return {
          allowed: false,
          warnings,
          matchedPattern: pattern,
          reason: `Known-bad pattern (${pattern.signature}): ${pattern.failedApproach}`,
          requiredAlternative: pattern.successfulAlternative,
        };
      }

      if (score >= this.minMatchScore) {
        const lead =
          pattern.status === "blocking"
            ? "Advisory: a similar command is blocked"
            : `Advisory: similar pattern has failed ${pattern.occurrences} time(s)`;
        const alt = (pattern.successfulAlternative ?? "").trim();
        const suggestion = alt && alt.toLowerCase() !== "unknown" ? `. Consider: ${alt}` : "";
        warnings.push(`${lead}: ${pattern.failedApproach}${suggestion}`);
      }
    }

    return { allowed: true, warnings };
  }

  /**
   * Check using only the highest-confidence matching pattern (convenience).
   */
  checkWithTopPattern(
    context: CommandContext,
    knownPatterns: ScoredPattern[],
  ): PreflightResult & { topPattern?: FailurePattern } {
    const result = this.check(context, knownPatterns);
    const top = knownPatterns[0];
    const extended: PreflightResult & { topPattern?: FailurePattern } = { ...result };
    if (top !== undefined) extended.topPattern = top.pattern;
    return extended;
  }
}
