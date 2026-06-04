import type {
  CommandContext,
  FailurePattern,
  GateRule,
  PreflightResult,
} from "../types.js";
import { type ScoredPattern } from "../registry/PatternMatcher.js";
import { getBuiltInRules } from "./BuiltInRules.js";

export interface PreflightGateOptions {
  enableBuiltInRules?: boolean;
  customRules?: GateRule[];
  blockOnConfidence?: number;
}

export class PreflightGate {
  private readonly rules: GateRule[];
  private readonly blockOnConfidence: number;

  constructor(private readonly options: PreflightGateOptions = {}) {
    const builtIn = options.enableBuiltInRules !== false ? getBuiltInRules() : [];
    this.rules = [...builtIn, ...(options.customRules ?? [])];
    this.blockOnConfidence = options.blockOnConfidence ?? 0.7;
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

    // 2. Check dynamic patterns from registry
    for (const { pattern, score } of knownPatterns) {
      if (pattern.status === "blocking" && score >= this.blockOnConfidence) {
        return {
          allowed: false,
          warnings,
          matchedPattern: pattern,
          reason: `Known-bad pattern (${pattern.signature}): ${pattern.failedApproach}`,
          requiredAlternative: pattern.successfulAlternative,
        };
      }

      if (pattern.status === "advisory" && score >= this.blockOnConfidence) {
        warnings.push(
          `Advisory: similar pattern has failed ${pattern.occurrences} time(s): ` +
            `${pattern.failedApproach}. Consider: ${pattern.successfulAlternative}`,
        );
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
