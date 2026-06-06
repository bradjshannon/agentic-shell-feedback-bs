import { computeCommandFingerprint } from "../../src/registry/CommandFingerprint.js";

describe("computeCommandFingerprint", () => {
  it("collapses POSIX heredoc bodies to a marker", () => {
    const a = computeCommandFingerprint("ssh host << 'EOF'\necho one\nEOF");
    const b = computeCommandFingerprint("ssh host << 'EOF'\necho two\necho three\nEOF");
    expect(a).toBe(b);
    expect(a).toContain("<<HEREDOC");
  });

  it("collapses PowerShell here-strings", () => {
    const fp = computeCommandFingerprint("$s = @'\nbig\nmultiline\nbody\n'@");
    expect(fp).toContain("HEREDOC");
    expect(fp).not.toContain("multiline");
  });

  it("normalizes quoted strings", () => {
    expect(computeCommandFingerprint("echo 'hello world'")).toBe("echo STR");
    expect(computeCommandFingerprint('echo "hello world"')).toBe("echo STR");
  });

  it("normalizes user@host targets", () => {
    expect(computeCommandFingerprint("ssh alice@server-1 uptime")).toBe("ssh HOST uptime");
  });

  it("normalizes filesystem paths", () => {
    expect(computeCommandFingerprint("cat /var/log/syslog")).toBe("cat PATH");
    expect(computeCommandFingerprint("cat ./relative/file")).toBe("cat PATH");
    expect(computeCommandFingerprint("type C:\\\\Users\\\\me\\\\f.txt")).toContain("PATH");
  });

  it("normalizes URLs and numbers", () => {
    expect(computeCommandFingerprint("curl https://example.com/x?y=1")).toBe("curl URL");
    expect(computeCommandFingerprint("kill 12345")).toBe("kill N");
  });

  it("is stable across volatile argument variation", () => {
    const a = computeCommandFingerprint("scp build.tar user@host-a:/tmp/2024/");
    const b = computeCommandFingerprint("scp build.tar user@host-b:/tmp/2025/");
    expect(a).toBe(b);
  });

  it("keeps genuinely different commands distinct", () => {
    expect(computeCommandFingerprint("npm test")).not.toBe(
      computeCommandFingerprint("npm run build"),
    );
    expect(computeCommandFingerprint("git commit")).not.toBe(
      computeCommandFingerprint("git push"),
    );
  });

  it("never contains the signature delimiter", () => {
    const fp = computeCommandFingerprint("ssh user@host:22 'cmd'");
    expect(fp).not.toContain(":");
  });

  it("bounds the length", () => {
    const fp = computeCommandFingerprint("echo " + "word ".repeat(200));
    expect(fp.length).toBeLessThanOrEqual(80);
  });

  it("handles empty input", () => {
    expect(computeCommandFingerprint("")).toBe("");
  });
});
