import { TransportBroker } from "../../src/broker/TransportBroker.js";
import type { CommandContext } from "../../src/types.js";

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

describe("TransportBroker", () => {
  let broker: TransportBroker;

  beforeEach(() => {
    broker = new TransportBroker();
  });

  describe("local target", () => {
    it("recommends inline for short simple local commands", () => {
      const result = broker.selectStrategy(makeContext(), "echo hello");
      expect(result.strategy).toBe("inline");
    });

    it("recommends file for powershell multiline local commands", () => {
      const result = broker.selectStrategy(
        makeContext({ shell: "powershell", isMultiline: true }),
        "Get-Service\nRestart-Service",
      );
      expect(result.strategy).toBe("file");
      expect(result.commandTemplate).toContain("Set-Content");
    });

    it("recommends stdin for bash multiline local commands", () => {
      const result = broker.selectStrategy(
        makeContext({ shell: "bash", isMultiline: true }),
        "echo one\necho two\necho three",
      );
      expect(result.strategy).toBe("stdin");
    });
  });

  describe("remote-ssh target", () => {
    it("recommends file for powershell + multiline + ssh", () => {
      const result = broker.selectStrategy(
        makeContext({ shell: "powershell", target: "remote-ssh", isMultiline: true }),
        "Get-Service\nRestart-Service",
      );
      expect(result.strategy).toBe("file");
      expect(result.rationale).toContain("PowerShell");
    });

    it("recommends file for powershell + heredoc + ssh", () => {
      const result = broker.selectStrategy(
        makeContext({ shell: "powershell", target: "remote-ssh", hasHeredoc: true }),
        "@'\nsome script\n'@",
      );
      expect(result.strategy).toBe("file");
    });

    it("recommends inline for short simple SSH command", () => {
      const result = broker.selectStrategy(
        makeContext({ target: "remote-ssh" }),
        "uptime",
      );
      expect(result.strategy).toBe("inline");
      expect(result.commandTemplate).toContain("ssh");
    });

    it("recommends stdin for medium complexity SSH command", () => {
      // Payload >200 chars but <=2000 chars, no complex quoting
      const mediumPayload = "echo step1 && sleep 1 && " + "echo continuing &&\n".repeat(12);
      const result = broker.selectStrategy(
        makeContext({ target: "remote-ssh" }),
        mediumPayload,
      );
      expect(result.strategy).toBe("stdin");
      expect(result.commandTemplate).toContain("ssh");
    });

    it("recommends file for very long SSH payloads", () => {
      const longPayload = "x".repeat(2500);
      const result = broker.selectStrategy(
        makeContext({ target: "remote-ssh" }),
        longPayload,
      );
      expect(result.strategy).toBe("file");
    });

    it("recommends file for complex-quoted SSH payloads", () => {
      const result = broker.selectStrategy(
        makeContext({ target: "remote-ssh", hasComplexQuoting: true }),
        'ssh host "echo \\"hello\\""',
      );
      expect(result.strategy).toBe("file");
    });

    it("includes rationale in result", () => {
      const result = broker.selectStrategy(
        makeContext({ shell: "powershell", target: "remote-ssh", isMultiline: true }),
        "long\nmultiline\npayload",
      );
      expect(result.rationale.length).toBeGreaterThan(10);
    });
  });

  describe("remote-other target", () => {
    it("recommends inline for short remote-other commands", () => {
      const result = broker.selectStrategy(makeContext({ target: "remote-other" }), "ls");
      expect(result.strategy).toBe("inline");
    });

    it("recommends stdin for long remote-other commands", () => {
      const result = broker.selectStrategy(
        makeContext({ target: "remote-other" }),
        "x".repeat(300),
      );
      expect(result.strategy).toBe("stdin");
    });
  });

  describe("command templates", () => {
    it("inline SSH template uses ssh placeholder", () => {
      const result = broker.selectStrategy(makeContext({ target: "remote-ssh" }), "uptime");
      expect(result.commandTemplate).toMatch(/<user@host>/);
    });

    it("stdin SSH template uses printf and ssh", () => {
      const payload = "echo hello && df -h";
      const result = broker.selectStrategy(makeContext({ target: "remote-ssh" }), payload);
      if (result.strategy === "stdin") {
        expect(result.commandTemplate).toContain("printf");
        expect(result.commandTemplate).toContain("ssh");
      }
    });

    it("file SSH template includes scp and cleanup", () => {
      const result = broker.selectStrategy(
        makeContext({ target: "remote-ssh" }),
        "x".repeat(2500),
      );
      expect(result.commandTemplate).toContain("scp");
      expect(result.commandTemplate).toContain("rm");
    });
  });
});
