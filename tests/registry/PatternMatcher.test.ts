import {
  computeSignature,
  computeEnvironmentFingerprint,
  rankPatterns,
} from "../../src/registry/PatternMatcher.js";
import type { CommandContext, FailurePattern } from "../../src/types.js";

function makeContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    command: "ssh user@host 'echo hi'",
    shell: "bash",
    target: "remote-ssh",
    os: "linux",
    isMultiline: false,
    hasHeredoc: false,
    hasComplexQuoting: false,
    transportClass: "inline",
    payloadLength: 30,
    ...overrides,
  };
}

function makePattern(overrides: Partial<FailurePattern> = {}): FailurePattern {
  return {
    id: "pattern-1",
    signature: "bash:remote-ssh:single:noheredoc:inline",
    environmentFingerprint: "linux:bash:remote-ssh",
    failedApproach: "inline SSH",
    successfulAlternative: "stdin",
    confidence: 0.9,
    status: "advisory",
    occurrences: 2,
    firstSeen: "2026-01-01T00:00:00Z",
    lastSeen: "2026-05-01T00:00:00Z",
    wasted_ms: 10000,
    ...overrides,
  };
}

describe("computeSignature", () => {
  it("produces deterministic output", () => {
    const ctx = makeContext();
    expect(computeSignature(ctx)).toBe("bash:remote-ssh:single:noheredoc:inline");
  });

  it("includes multiline flag", () => {
    expect(computeSignature(makeContext({ isMultiline: true }))).toContain(":multiline:");
  });

  it("includes heredoc flag", () => {
    expect(computeSignature(makeContext({ hasHeredoc: true }))).toContain(":heredoc:");
  });

  it("includes transport class", () => {
    expect(computeSignature(makeContext({ transportClass: "stdin" }))).toMatch(/:stdin$/);
  });

  it("handles powershell + remote-ssh", () => {
    const ctx = makeContext({ shell: "powershell", target: "remote-ssh", os: "windows" });
    expect(computeSignature(ctx)).toMatch(/^powershell:remote-ssh:/);
  });
});

describe("computeEnvironmentFingerprint", () => {
  it("produces os:shell:target format", () => {
    expect(computeEnvironmentFingerprint(makeContext())).toBe("linux:bash:remote-ssh");
  });

  it("captures OS correctly", () => {
    expect(computeEnvironmentFingerprint(makeContext({ os: "windows" }))).toMatch(/^windows:/);
  });
});

describe("rankPatterns", () => {
  it("returns empty for empty patterns", () => {
    expect(rankPatterns([], makeContext())).toEqual([]);
  });

  it("scores exact match as 1.0", () => {
    const ctx = makeContext();
    const pattern = makePattern({ signature: computeSignature(ctx) });
    const results = rankPatterns([pattern], ctx);
    expect(results).toHaveLength(1);
    expect(results[0]?.score).toBe(1.0);
  });

  it("filters expired patterns", () => {
    const ctx = makeContext();
    const expired = makePattern({
      signature: computeSignature(ctx),
      status: "expired",
    });
    expect(rankPatterns([expired], ctx)).toHaveLength(0);
  });

  it("sorts descending by score", () => {
    const ctx = makeContext();
    const exact = makePattern({ signature: computeSignature(ctx), id: "exact" });
    const fuzzy = makePattern({
      signature: "powershell:remote-ssh:single:noheredoc:inline",
      id: "fuzzy",
    });
    const results = rankPatterns([fuzzy, exact], ctx);
    expect(results[0]?.pattern.id).toBe("exact");
  });

  it("filters results below minScore", () => {
    const ctx = makeContext();
    const unrelated = makePattern({ signature: "cmd:local:single:noheredoc:inline" });
    const results = rankPatterns([unrelated], ctx, 0.9);
    expect(results).toHaveLength(0);
  });

  it("returns fuzzy matches for similar shell+target", () => {
    const ctx = makeContext({ shell: "bash", target: "remote-ssh", isMultiline: true });
    // Pattern matches same shell + target but different multiline
    const similar = makePattern({
      signature: "bash:remote-ssh:single:noheredoc:inline",
      id: "similar",
    });
    const results = rankPatterns([similar], ctx, 0.4);
    expect(results).toHaveLength(1);
    expect(results[0]?.score).toBeLessThan(1.0);
  });
});
