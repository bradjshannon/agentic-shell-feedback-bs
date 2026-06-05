import { analyzeCommand } from "../../src/gates/CommandAnalyzer.js";

describe("CommandAnalyzer", () => {
  describe("target detection", () => {
    it("detects local target for plain commands", () => {
      expect(analyzeCommand("echo hello").target).toBe("local");
    });

    it("detects remote-ssh for ssh invocation", () => {
      expect(analyzeCommand("ssh user@host 'echo hi'").target).toBe("remote-ssh");
    });

    it("detects remote-ssh for ssh with flags", () => {
      expect(analyzeCommand("ssh -i key.pem user@host uptime").target).toBe("remote-ssh");
    });

    it("detects remote-other for kubectl exec", () => {
      expect(analyzeCommand("kubectl exec pod -- bash").target).toBe("remote-other");
    });

    it("detects remote-other for docker exec", () => {
      expect(analyzeCommand("docker exec container bash").target).toBe("remote-other");
    });
  });

  describe("multiline detection", () => {
    it("detects multiline from newline character", () => {
      expect(analyzeCommand("echo one\necho two").isMultiline).toBe(true);
    });

    it("detects single-line for plain commands", () => {
      expect(analyzeCommand("echo hello").isMultiline).toBe(false);
    });

    it("detects multiline from escaped newline", () => {
      expect(analyzeCommand("echo line1\\necho line2").isMultiline).toBe(true);
    });
  });

  describe("heredoc detection", () => {
    it("detects POSIX heredoc", () => {
      expect(analyzeCommand("ssh host << 'EOF'\necho hi\nEOF").hasHeredoc).toBe(true);
    });

    it("detects heredoc with <<-", () => {
      expect(analyzeCommand("bash <<- EOF\n  echo hi\n  EOF").hasHeredoc).toBe(true);
    });

    it("detects PowerShell here-string @'...'@", () => {
      expect(analyzeCommand("$s = @'\nhello\n'@").hasHeredoc).toBe(true);
    });

    it("does not flag plain commands as heredoc", () => {
      expect(analyzeCommand("echo 'hello world'").hasHeredoc).toBe(false);
    });
  });

  describe("complex quoting detection", () => {
    it("detects escaped quotes", () => {
      expect(analyzeCommand('ssh host "echo \\"hi\\""').hasComplexQuoting).toBe(true);
    });

    it("flags clean simple commands as not complex", () => {
      expect(analyzeCommand("echo hello").hasComplexQuoting).toBe(false);
    });
  });

  describe("transport class detection", () => {
    it("classifies heredoc commands as heredoc", () => {
      expect(analyzeCommand("ssh host << EOF\necho hi\nEOF").transportClass).toBe("heredoc");
    });

    it("classifies piped stdin as stdin", () => {
      expect(analyzeCommand("echo 'script' | ssh host bash").transportClass).toBe("stdin");
    });

    it("classifies scp as file", () => {
      expect(analyzeCommand("scp script.sh user@host:/tmp/").transportClass).toBe("file");
    });

    it("classifies short commands as inline", () => {
      expect(analyzeCommand("ssh host uptime").transportClass).toBe("inline");
    });
  });

  describe("hints override", () => {
    it("shell hint overrides auto-detection", () => {
      const ctx = analyzeCommand("echo hi", { shell: "powershell" });
      expect(ctx.shell).toBe("powershell");
    });

    it("target hint overrides auto-detection", () => {
      const ctx = analyzeCommand("echo hi", { target: "remote-ssh" });
      expect(ctx.target).toBe("remote-ssh");
    });

    it("os hint overrides auto-detection", () => {
      const ctx = analyzeCommand("echo hi", { os: "windows" });
      expect(ctx.os).toBe("windows");
    });
  });

  describe("payload length", () => {
    it("sets payload length to command string length", () => {
      const cmd = "ssh host uptime";
      expect(analyzeCommand(cmd).payloadLength).toBe(cmd.length);
    });
  });
});
