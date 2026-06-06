import { PreflightGate } from "../../src/gates/PreflightGate.js";
import type { CommandContext, FailurePattern, GateRule } from "../../src/types.js";
import type { ScoredPattern } from "../../src/registry/PatternMatcher.js";

function makeContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    command: "echo hello",
    shell: "bash",
    target: "local",
    os: "linux",
    isMultiline: false,
    hasHeredoc: false,
    hasComplexQuoting: false,
    transportClass: "inline",
    payloadLength: 10,
    ...overrides,
  };
}

function makeScoredPattern(overrides: Partial<FailurePattern> = {}, score = 0.9): ScoredPattern {
  return {
    score,
    pattern: {
      id: "p1",
      signature: "bash:remote-ssh:single:noheredoc:inline",
      environmentFingerprint: "linux:bash:remote-ssh",
      failedApproach: "inline SSH",
      successfulAlternative: "stdin piping",
      confidence: 0.9,
      status: "advisory",
      occurrences: 2,
      firstSeen: "2026-01-01T00:00:00Z",
      lastSeen: "2026-05-01T00:00:00Z",
      wasted_ms: 10000,
      ...overrides,
    },
  };
}

describe("PreflightGate", () => {
  describe("clean commands", () => {
    it("allows clean local bash command", () => {
      const gate = new PreflightGate();
      const result = gate.check(makeContext());
      expect(result.allowed).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });
  });

  describe("built-in rule blocking", () => {
    it("blocks powershell + remote-ssh + heredoc", () => {
      const gate = new PreflightGate();
      const result = gate.check(
        makeContext({
          shell: "powershell",
          target: "remote-ssh",
          hasHeredoc: true,
          isMultiline: true,
        }),
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBeTruthy();
      expect(result.requiredAlternative).toBeTruthy();
    });

    it("blocks cmd + remote-ssh + multiline", () => {
      const gate = new PreflightGate();
      const result = gate.check(
        makeContext({ shell: "cmd", target: "remote-ssh", isMultiline: true }),
      );
      expect(result.allowed).toBe(false);
    });

    it("warns for long inline SSH", () => {
      const gate = new PreflightGate();
      const result = gate.check(
        makeContext({
          target: "remote-ssh",
          transportClass: "inline",
          payloadLength: 400,
        }),
      );
      expect(result.allowed).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it("warns for nested quotes on SSH", () => {
      const gate = new PreflightGate();
      const result = gate.check(
        makeContext({ target: "remote-ssh", hasComplexQuoting: true }),
      );
      expect(result.allowed).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
    });
  });

  describe("built-in rules disabled", () => {
    it("allows powershell + remote-ssh + heredoc when built-ins disabled", () => {
      const gate = new PreflightGate({ enableBuiltInRules: false });
      const result = gate.check(
        makeContext({ shell: "powershell", target: "remote-ssh", hasHeredoc: true }),
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe("custom rules", () => {
    it("applies custom deny rule", () => {
      const customRule: GateRule = {
        id: "NO_ECHO",
        description: "Echo is banned in tests",
        match: (ctx) => ctx.command.startsWith("echo"),
        verdict: "deny",
        reason: "Echo is banned",
      };
      const gate = new PreflightGate({ enableBuiltInRules: false, customRules: [customRule] });
      const result = gate.check(makeContext({ command: "echo hello" }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Echo is banned");
    });

    it("applies custom warn rule", () => {
      const warnRule: GateRule = {
        id: "WARN_LARGE",
        description: "Large command",
        match: (ctx) => ctx.payloadLength > 100,
        verdict: "warn",
        reason: "Large command",
      };
      const gate = new PreflightGate({ enableBuiltInRules: false, customRules: [warnRule] });
      const result = gate.check(makeContext({ payloadLength: 200 }));
      expect(result.allowed).toBe(true);
      expect(result.warnings).toContain("Large command");
    });
  });

  describe("registry-based blocking", () => {
    it("blocks when a blocking pattern matches exactly", () => {
      const gate = new PreflightGate({ enableBuiltInRules: false });
      const pattern = makeScoredPattern({ status: "blocking" }, 1.0);
      const result = gate.check(makeContext(), [pattern]);
      expect(result.allowed).toBe(false);
      expect(result.matchedPattern).toBeDefined();
      expect(result.requiredAlternative).toBe("stdin piping");
    });

    it("warns (not blocks) for a blocking pattern matched only fuzzily", () => {
      // A sibling command shape (score < 1.0) must never hard-block — the
      // command still runs, but we surface the related known-bad pattern.
      const gate = new PreflightGate({ enableBuiltInRules: false });
      const pattern = makeScoredPattern({ status: "blocking" }, 0.9);
      const result = gate.check(makeContext(), [pattern]);
      expect(result.allowed).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it("allows when a pattern matches below the advisory threshold", () => {
      const gate = new PreflightGate({ enableBuiltInRules: false, minMatchScore: 0.8 });
      const pattern = makeScoredPattern({ status: "blocking" }, 0.5);
      const result = gate.check(makeContext(), [pattern]);
      expect(result.allowed).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it("warns (not blocks) for advisory pattern with high score", () => {
      const gate = new PreflightGate({ enableBuiltInRules: false });
      const pattern = makeScoredPattern({ status: "advisory" }, 0.9);
      const result = gate.check(makeContext(), [pattern]);
      expect(result.allowed).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it("ignores expired patterns", () => {
      const gate = new PreflightGate({ enableBuiltInRules: false });
      const pattern = makeScoredPattern({ status: "expired" }, 1.0);
      const result = gate.check(makeContext(), [pattern]);
      // Expired patterns shouldn't reach the gate, but if one does it must not block.
      expect(result.allowed).toBe(true);
    });
  });

  describe("checkWithTopPattern", () => {
    it("returns topPattern for convenience", () => {
      const gate = new PreflightGate({ enableBuiltInRules: false });
      const pattern = makeScoredPattern();
      const result = gate.checkWithTopPattern(makeContext(), [pattern]);
      expect(result.topPattern).toBe(pattern.pattern);
    });

    it("returns undefined topPattern when no patterns", () => {
      const gate = new PreflightGate({ enableBuiltInRules: false });
      const result = gate.checkWithTopPattern(makeContext(), []);
      expect(result.topPattern).toBeUndefined();
    });
  });
});
