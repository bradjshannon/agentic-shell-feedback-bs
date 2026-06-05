import { BUILT_IN_RULES, getBuiltInRules } from "../../src/gates/BuiltInRules.js";
import type { CommandContext } from "../../src/types.js";

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

describe("BUILT_IN_RULES", () => {
  it("exports a non-empty array", () => {
    expect(BUILT_IN_RULES.length).toBeGreaterThan(0);
  });

  it("getBuiltInRules returns same set", () => {
    expect(getBuiltInRules()).toEqual(BUILT_IN_RULES);
  });

  describe("POWERSHELL_SSH_HEREDOC", () => {
    const rule = BUILT_IN_RULES.find((r) => r.id === "POWERSHELL_SSH_HEREDOC")!;

    it("exists", () => expect(rule).toBeDefined());

    it("fires for powershell + remote-ssh + heredoc", () => {
      expect(
        rule.match(makeContext({ shell: "powershell", target: "remote-ssh", hasHeredoc: true })),
      ).toBe(true);
    });

    it("fires for powershell + remote-ssh + multiline", () => {
      expect(
        rule.match(makeContext({ shell: "powershell", target: "remote-ssh", isMultiline: true })),
      ).toBe(true);
    });

    it("does not fire for bash + remote-ssh + heredoc", () => {
      expect(
        rule.match(makeContext({ shell: "bash", target: "remote-ssh", hasHeredoc: true })),
      ).toBe(false);
    });

    it("does not fire for powershell + local + multiline", () => {
      expect(
        rule.match(makeContext({ shell: "powershell", target: "local", isMultiline: true })),
      ).toBe(false);
    });

    it("has verdict deny", () => {
      expect(rule.verdict).toBe("deny");
    });

    it("provides an alternative", () => {
      expect(rule.alternative).toBeTruthy();
    });
  });

  describe("CMD_SSH_MULTILINE", () => {
    const rule = BUILT_IN_RULES.find((r) => r.id === "CMD_SSH_MULTILINE")!;

    it("fires for cmd + remote-ssh + multiline", () => {
      expect(
        rule.match(makeContext({ shell: "cmd", target: "remote-ssh", isMultiline: true })),
      ).toBe(true);
    });

    it("does not fire for cmd + local + multiline", () => {
      expect(
        rule.match(makeContext({ shell: "cmd", target: "local", isMultiline: true })),
      ).toBe(false);
    });

    it("has verdict deny", () => {
      expect(rule.verdict).toBe("deny");
    });
  });

  describe("COMPLEX_INLINE_SSH", () => {
    const rule = BUILT_IN_RULES.find((r) => r.id === "COMPLEX_INLINE_SSH")!;

    it("fires for remote-ssh + inline + long command", () => {
      expect(
        rule.match(
          makeContext({
            target: "remote-ssh",
            transportClass: "inline",
            payloadLength: 400,
          }),
        ),
      ).toBe(true);
    });

    it("does not fire for short inline commands", () => {
      expect(
        rule.match(
          makeContext({ target: "remote-ssh", transportClass: "inline", payloadLength: 50 }),
        ),
      ).toBe(false);
    });

    it("has verdict warn", () => {
      expect(rule.verdict).toBe("warn");
    });
  });

  describe("NESTED_QUOTE_SSH", () => {
    const rule = BUILT_IN_RULES.find((r) => r.id === "NESTED_QUOTE_SSH")!;

    it("fires for remote-ssh + complex quoting", () => {
      expect(
        rule.match(makeContext({ target: "remote-ssh", hasComplexQuoting: true })),
      ).toBe(true);
    });

    it("does not fire for local + complex quoting", () => {
      expect(
        rule.match(makeContext({ target: "local", hasComplexQuoting: true })),
      ).toBe(false);
    });

    it("has verdict warn", () => {
      expect(rule.verdict).toBe("warn");
    });
  });

  describe("HEREDOC_REMOTE_POWERSHELL", () => {
    const rule = BUILT_IN_RULES.find((r) => r.id === "HEREDOC_REMOTE_POWERSHELL")!;

    it("fires for powershell + remote-ssh + heredoc", () => {
      expect(
        rule.match(makeContext({ shell: "powershell", target: "remote-ssh", hasHeredoc: true })),
      ).toBe(true);
    });

    it("does not fire for powershell + local + heredoc", () => {
      expect(
        rule.match(makeContext({ shell: "powershell", target: "local", hasHeredoc: true })),
      ).toBe(false);
    });

    it("has verdict deny", () => {
      expect(rule.verdict).toBe("deny");
    });
  });
});
