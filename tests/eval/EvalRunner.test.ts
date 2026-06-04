import { EvalRunner } from "../../src/eval/EvalRunner.js";
import { MemoryStore } from "../../src/storage/MemoryStore.js";
import type { ExecutionTrace, FailurePattern, RegistryData } from "../../src/types.js";

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
    timestamp: new Date().toISOString(),
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
    firstSeen: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    wasted_ms: 0,
    ...overrides,
  };
}

function storeWith(data: Partial<RegistryData>): MemoryStore {
  return new MemoryStore({ version: 1, patterns: [], traces: [], ...data });
}

describe("EvalRunner", () => {
  describe("baseline", () => {
    it("returns metrics for stored traces", async () => {
      const store = storeWith({
        traces: [makeTrace({ outcome: "success" }), makeTrace({ outcome: "timeout", duration_ms: 30000 })],
      });
      const runner = new EvalRunner(store);
      const m = await runner.baseline();
      expect(m.totalTraces).toBe(2);
      expect(m.firstAttemptSuccessRate).toBe(0.5);
    });

    it("excludes traces outside window", async () => {
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 60);
      const store = storeWith({
        traces: [makeTrace({ timestamp: oldDate.toISOString() })],
      });
      const runner = new EvalRunner(store);
      const m = await runner.baseline(30);
      expect(m.totalTraces).toBe(0);
    });

    it("returns sensible defaults for empty store", async () => {
      const store = storeWith({});
      const runner = new EvalRunner(store);
      const m = await runner.baseline();
      expect(m.firstAttemptSuccessRate).toBe(1);
    });
  });

  describe("compare", () => {
    it("returns recommendation=promote when candidate improves success rate", async () => {
      const store = storeWith({
        traces: Array(10).fill(null).map(() => makeTrace({ outcome: "timeout", duration_ms: 30000 })),
      });
      const runner = new EvalRunner(store);
      // Candidate has all successes
      const candidateTraces = Array(10).fill(null).map(() => makeTrace({ outcome: "success" }));
      const report = await runner.compare(candidateTraces, []);
      expect(report.recommendation).toBe("promote");
    });

    it("returns recommendation=reject when candidate regresses", async () => {
      const store = storeWith({
        traces: Array(10).fill(null).map(() => makeTrace({ outcome: "success" })),
      });
      const runner = new EvalRunner(store);
      const candidateTraces = Array(10).fill(null).map(() =>
        makeTrace({ outcome: "timeout", duration_ms: 60000 }),
      );
      const report = await runner.compare(candidateTraces, []);
      expect(report.recommendation).toBe("reject");
    });

    it("returns recommendation=neutral for small delta", async () => {
      const store = storeWith({
        traces: [makeTrace(), makeTrace()],
      });
      const runner = new EvalRunner(store);
      const report = await runner.compare([makeTrace(), makeTrace()], []);
      expect(report.recommendation).toBe("neutral");
    });

    it("includes summary string", async () => {
      const store = storeWith({ traces: [makeTrace()] });
      const runner = new EvalRunner(store);
      const report = await runner.compare([makeTrace()], []);
      expect(report.summary).toBeTruthy();
      expect(typeof report.summary).toBe("string");
    });
  });

  describe("replayStats", () => {
    it("reports zero blocked and actual failures for clean traces", async () => {
      const store = storeWith({});
      const runner = new EvalRunner(store);
      const traces = [makeTrace({ outcome: "success" })];
      const stats = await runner.replayStats(traces);
      expect(stats.wouldHaveBlocked).toBe(0);
      expect(stats.actualFailures).toBe(0);
      expect(stats.falsePositives).toBe(0);
    });

    it("counts actual failures correctly", async () => {
      const store = storeWith({});
      const runner = new EvalRunner(store);
      const traces = [
        makeTrace({ outcome: "success" }),
        makeTrace({ outcome: "timeout" }),
        makeTrace({ outcome: "mechanical-failure" }),
      ];
      const stats = await runner.replayStats(traces);
      expect(stats.actualFailures).toBe(2);
    });

    it("counts would-have-blocked against blocking patterns", async () => {
      const blockingPattern = makePattern({
        signature: "bash:remote-ssh:single:noheredoc:inline",
        status: "blocking",
      });
      const store = storeWith({ patterns: [blockingPattern] });
      const runner = new EvalRunner(store);
      const traces = [makeTrace({ outcome: "timeout" })];
      const stats = await runner.replayStats(traces);
      expect(stats.wouldHaveBlocked).toBe(1);
    });
  });
});
