import type { FailurePattern, StorageAdapter } from "../types.js";
import {
  DEFAULT_THRESHOLDS,
  shouldExpire,
  shouldPromote,
  type PromotionThresholds,
} from "./PromotionRules.js";

export interface PolicyResult {
  promoted: string[];   // pattern IDs promoted advisory → blocking
  expired: string[];    // pattern IDs expired
  unchanged: number;
}

export class PolicyEngine {
  constructor(
    private readonly storage: StorageAdapter,
    private readonly thresholds: PromotionThresholds = DEFAULT_THRESHOLDS,
  ) {}

  /**
   * Evaluate all patterns and apply promotion/expiration rules.
   * Persists changes to storage.
   */
  async evaluate(now: Date = new Date()): Promise<PolicyResult> {
    const data = await this.storage.load();
    const promoted: string[] = [];
    const expired: string[] = [];

    for (const pattern of data.patterns) {
      if (shouldExpire(pattern, now, this.thresholds)) {
        pattern.status = "expired";
        expired.push(pattern.id);
        continue;
      }

      if (shouldPromote(pattern, now, this.thresholds)) {
        pattern.status = "blocking";
        promoted.push(pattern.id);
      }
    }

    if (promoted.length > 0 || expired.length > 0) {
      await this.storage.save(data);
    }

    return {
      promoted,
      expired,
      unchanged: data.patterns.length - promoted.length - expired.length,
    };
  }

  /**
   * Force-promote a specific pattern by ID.
   */
  async forcePromote(patternId: string): Promise<boolean> {
    const data = await this.storage.load();
    const pattern = data.patterns.find((p) => p.id === patternId);
    if (!pattern || pattern.status === "blocking") return false;
    pattern.status = "blocking";
    await this.storage.save(data);
    return true;
  }

  /**
   * Downgrade a blocking pattern back to advisory (manual override).
   */
  async downgrade(patternId: string): Promise<boolean> {
    const data = await this.storage.load();
    const pattern = data.patterns.find((p) => p.id === patternId);
    if (!pattern || pattern.status !== "blocking") return false;
    pattern.status = "advisory";
    await this.storage.save(data);
    return true;
  }

  /**
   * Compute a status summary without mutating anything.
   */
  async preview(now: Date = new Date()): Promise<{
    toPromote: FailurePattern[];
    toExpire: FailurePattern[];
  }> {
    const data = await this.storage.load();
    return {
      toPromote: data.patterns.filter((p) => shouldPromote(p, now, this.thresholds)),
      toExpire: data.patterns.filter((p) => shouldExpire(p, now, this.thresholds)),
    };
  }
}
