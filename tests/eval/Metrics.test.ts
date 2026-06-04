import {
  computeMetrics,
  computeFirstAttemptSuccessRate,
  computeRepeatedPatternRecurrenceRate,
  computeTimeoutMinutesPer100,
  computeTransportSwitchCompliance,
} from "../../src/eval/Metrics.js";
import type { ExecutionTrace, FailurePattern } from "../../src/types.js";

function makeTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    id: `t-${Math.random().toString(36).slice(2)}`,
    command: "ssh host uptime",
    context: {
      command: "ssh host uptime",
      shell: "bash",
      target: "remote-ssh",
      os: "linux",
      isMultiline: false,
      hasHeredoc: false,
      hasComplexQuoting: false,
      transportClass: "inline",
      payloadLength: 20,
    },
    outcome: "success",
    duration_ms: 200,
    timestamp: "2026-06-01T10:00:00Z",
    ...overrides,
  };
}

function makePattern(overrides: Partial<FailurePattern> = {}): FailurePattern {
  return {
    id: `p-${Math.random().toString(36).slice(2)}`,
    signature: "bash:remote-ssh:single:noheredoc:inline",
    environmentFingerprint: "linux:bash:remote-ssh",
    failedApproach: "inline",
    successfulAlternative: "stdin",
    confidence: 0.8,
    status: "advisory",
    occurrences: 1,
    firstSeen: "2026-01-01T00:00:00Z",
    lastSeen: "2026-06-01T00:00:00Z",
    wasted_ms: 0,
    ...overrides,
  };
}

describe("computeFirstAttemptSuccessRate", () => {
  it("returns 1 for empty traces", () => {
    expect(computeFirstAttemptSuccessRate([])).toBe(1);
  });

  it("returns 1 when all succeed", () => {
    const traces = [makeTrace(), makeTrace(), makeTrace()];
    expect(computeFirstAttemptSuccessRate(traces)).toBe(1);
  });

  it("returns 0 when all fail", () => {
    const traces = [
      makeTrace({ outcome: "timeout" }),
      makeTrace({ outcome: "mechanical-failure" }),
    ];
    expect(computeFirstAttemptSuccessRate(traces)).toBe(0);
  });

  it("returns partial rate correctly", () => {
    const traces = [
      makeTrace({ outcome: "success" }),
      makeTrace({ outcome: "timeout" }),
    ];
    expect(computeFirstAttemptSuccessRate(traces)).toBe(0.5);
  });
});

describe("computeRepeatedPatternRecurrenceRate", () => {
  it("returns 0 for empty patterns", () => {
    expect(computeRepeatedPatternRecurrenceRate([])).toBe(0);
  });

  it("returns 0 when no patterns seen more than once", () => {
    const patterns = [makePattern({ occurrences: 1 }), makePattern({ occurrences: 1 })];
    expect(computeRepeatedPatternRecurrenceRate(patterns)).toBe(0);
  });

  it("returns 1 when all patterns seen multiple times", () => {
    const patterns = [makePattern({ occurrences: 3 }), makePattern({ occurrences: 2 })];
    expect(computeRepeatedPatternRecurrenceRate(patterns)).toBe(1);
  });

  it("returns partial rate", () => {
    const patterns = [makePattern({ occurrences: 1 }), makePattern({ occurrences: 2 })];
    expect(computeRepeatedPatternRecurrenceRate(patterns)).toBe(0.5);
  });
});

describe("computeTimeoutMinutesPer100", () => {
  it("returns 0 for empty traces", () => {
    expect(computeTimeoutMinutesPer100([])).toBe(0);
  });

  it("returns 0 when no timeouts", () => {
    const traces = [makeTrace(), makeTrace()];
    expect(computeTimeoutMinutesPer100(traces)).toBe(0);
  });

  it("calculates correctly for single timeout", () => {
    const traces = [makeTrace({ outcome: "timeout", duration_ms: 60_000 })];
    // 60s timeout in 1 trace = 60s per task * 100 = 6000 minutes per 100 tasks
    expect(computeTimeoutMinutesPer100(traces)).toBeCloseTo(100);
  });
});

describe("computeTransportSwitchCompliance", () => {
  it("returns 1 for empty traces (no failures = perfect compliance)", () => {
    expect(computeTransportSwitchCompliance([])).toBe(1);
  });

  it("returns 1 when no mechanical failures", () => {
    const traces = [makeTrace({ outcome: "success" }), makeTrace({ outcome: "timeout" })];
    expect(computeTransportSwitchCompliance(traces)).toBe(1);
  });

  it("returns 1 when agent switched after mechanical failure", () => {
    const traces = [
      makeTrace({ outcome: "mechanical-failure" }),
      makeTrace({ outcome: "success", alternativeUsed: "stdin" }),
    ];
    expect(computeTransportSwitchCompliance(traces)).toBe(1);
  });

  it("returns 0 when agent did not switch after mechanical failure", () => {
    const traces = [
      makeTrace({ outcome: "mechanical-failure" }),
      makeTrace({ outcome: "timeout" }), // no alternativeUsed
    ];
    expect(computeTransportSwitchCompliance(traces)).toBe(0);
  });

  it("handles last trace being mechanical failure (no next trace)", () => {
    const traces = [makeTrace({ outcome: "mechanical-failure" })];
    expect(computeTransportSwitchCompliance(traces)).toBe(0);
  });
});

describe("computeMetrics", () => {
  it("returns full metrics object", () => {
    const traces = [makeTrace(), makeTrace({ outcome: "timeout", duration_ms: 30000 })];
    const patterns = [makePattern(), makePattern({ occurrences: 2 })];
    const m = computeMetrics(traces, patterns);
    expect(m.totalTraces).toBe(2);
    expect(m.totalPatterns).toBe(2);
    expect(m.firstAttemptSuccessRate).toBe(0.5);
  });

  it("counts blocking patterns", () => {
    const patterns = [
      makePattern({ status: "blocking" }),
      makePattern({ status: "advisory" }),
    ];
    const m = computeMetrics([], patterns);
    expect(m.blockingPatterns).toBe(1);
  });

  it("returns sensible defaults for empty input", () => {
    const m = computeMetrics([], []);
    expect(m.firstAttemptSuccessRate).toBe(1);
    expect(m.timeoutMinutesPer100Tasks).toBe(0);
    expect(m.transportSwitchCompliance).toBe(1);
  });
});
