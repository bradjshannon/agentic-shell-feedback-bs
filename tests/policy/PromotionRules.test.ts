import { shouldPromote, shouldExpire, DEFAULT_THRESHOLDS } from "../../src/policy/PromotionRules.js";
import type { FailurePattern } from "../../src/types.js";

function makePattern(overrides: Partial<FailurePattern> = {}): FailurePattern {
  const now = new Date();
  const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
  return {
    id: "p1",
    signature: "powershell:remote-ssh:multiline:heredoc:heredoc",
    environmentFingerprint: "windows:powershell:remote-ssh",
    failedApproach: "inline heredoc",
    successfulAlternative: "stdin",
    confidence: 0.75,
    status: "advisory",
    occurrences: 1,
    firstSeen: tenDaysAgo,
    lastSeen: tenDaysAgo,
    wasted_ms: 0,
    ...overrides,
  };
}

describe("shouldPromote", () => {
  const now = new Date();

  it("does not promote single occurrence under threshold", () => {
    const p = makePattern({ occurrences: 1, wasted_ms: 0 });
    expect(shouldPromote(p, now)).toBe(false);
  });

  it("promotes at occurrence threshold within window", () => {
    const p = makePattern({ occurrences: 2, wasted_ms: 0 });
    expect(shouldPromote(p, now)).toBe(true);
  });

  it("does not promote when occurrences met but outside window", () => {
    const farPast = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const p = makePattern({ occurrences: 2, firstSeen: farPast, wasted_ms: 0 });
    expect(shouldPromote(p, now)).toBe(false);
  });

  it("promotes immediately when wasted_ms exceeds threshold", () => {
    const p = makePattern({ occurrences: 1, wasted_ms: 60_001 });
    expect(shouldPromote(p, now)).toBe(true);
  });

  it("promotes exactly at wasted_ms threshold", () => {
    const p = makePattern({ occurrences: 1, wasted_ms: DEFAULT_THRESHOLDS.wastedMs });
    expect(shouldPromote(p, now)).toBe(true);
  });

  it("does not promote a blocking pattern", () => {
    const p = makePattern({ status: "blocking", occurrences: 5, wasted_ms: 100_000 });
    expect(shouldPromote(p, now)).toBe(false);
  });

  it("does not promote an expired pattern", () => {
    const p = makePattern({ status: "expired", occurrences: 5 });
    expect(shouldPromote(p, now)).toBe(false);
  });

  it("respects custom thresholds", () => {
    const p = makePattern({ occurrences: 5, wasted_ms: 0 });
    expect(shouldPromote(p, now, { ...DEFAULT_THRESHOLDS, occurrences: 10 })).toBe(false);
    expect(shouldPromote(p, now, { ...DEFAULT_THRESHOLDS, occurrences: 5 })).toBe(true);
  });
});

describe("shouldExpire", () => {
  it("does not expire recently-seen pattern", () => {
    const p = makePattern({ status: "advisory" });
    expect(shouldExpire(p, new Date())).toBe(false);
  });

  it("expires pattern not seen in expiration window", () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 100);
    const p = makePattern({
      status: "advisory",
      lastSeen: oldDate.toISOString(),
      firstSeen: oldDate.toISOString(),
    });
    expect(shouldExpire(p, new Date())).toBe(true);
  });

  it("does not expire blocking pattern even if not seen in window", () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 100);
    const p = makePattern({
      status: "blocking",
      lastSeen: oldDate.toISOString(),
    });
    expect(shouldExpire(p, new Date())).toBe(false);
  });

  it("does not re-expire an already expired pattern", () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 200);
    const p = makePattern({
      status: "expired",
      lastSeen: oldDate.toISOString(),
    });
    expect(shouldExpire(p, new Date())).toBe(false);
  });

  it("respects custom expiration threshold", () => {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const p = makePattern({ status: "advisory", lastSeen: sevenDaysAgo.toISOString() });
    expect(shouldExpire(p, new Date(), { ...DEFAULT_THRESHOLDS, expirationDays: 5 })).toBe(true);
    expect(shouldExpire(p, new Date(), { ...DEFAULT_THRESHOLDS, expirationDays: 30 })).toBe(false);
  });
});
