import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { install } from "../../src/installer/index.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agentic-install-test-"));
}

async function isExecutable(path: string): Promise<boolean> {
  const s = await stat(path);
  return (s.mode & 0o111) !== 0;
}

describe("install — claude-code (default)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates hook scripts", async () => {
    await install({ cwd: dir });
    const preflight = join(dir, ".claude", "hooks", "preflight.sh");
    const record = join(dir, ".claude", "hooks", "record.sh");
    const pf = await readFile(preflight, "utf8");
    const rec = await readFile(record, "utf8");
    expect(pf).toContain("agentic-feedback preflight");
    expect(rec).toContain("agentic-feedback record");
  });

  it("makes scripts executable", async () => {
    await install({ cwd: dir });
    const preflight = join(dir, ".claude", "hooks", "preflight.sh");
    expect(await isExecutable(preflight)).toBe(true);
  });

  it("creates settings.json with hooks wiring", async () => {
    await install({ cwd: dir });
    const settingsPath = join(dir, ".claude", "settings.json");
    const raw = await readFile(settingsPath, "utf8");
    const settings = JSON.parse(raw) as { hooks: Record<string, unknown[]> };
    expect(settings.hooks).toHaveProperty("PreToolUse");
    expect(settings.hooks).toHaveProperty("PostToolUse");
    expect(settings.hooks).toHaveProperty("Stop");
  });

  it("preserves existing settings.json keys when patching", async () => {
    const settingsDir = join(dir, ".claude");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(
      join(settingsDir, "settings.json"),
      JSON.stringify({ theme: "dark", model: "opus" }),
      "utf8",
    );

    await install({ cwd: dir });
    const raw = await readFile(join(settingsDir, "settings.json"), "utf8");
    const settings = JSON.parse(raw) as Record<string, unknown>;
    expect(settings["theme"]).toBe("dark");
    expect(settings["model"]).toBe("opus");
    expect(settings).toHaveProperty("hooks");
  });

  it("recovers from corrupt settings.json", async () => {
    const settingsDir = join(dir, ".claude");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(join(settingsDir, "settings.json"), "NOT JSON {{{", "utf8");

    await expect(install({ cwd: dir })).resolves.not.toThrow();
    const raw = await readFile(join(settingsDir, "settings.json"), "utf8");
    const settings = JSON.parse(raw) as Record<string, unknown>;
    expect(settings).toHaveProperty("hooks");
  });

  it("dry-run does not write any files", async () => {
    const result = await install({ cwd: dir, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.filesWritten.length).toBeGreaterThan(0);

    const hooksDir = join(dir, ".claude", "hooks");
    const { existsSync } = await import("node:fs");
    expect(existsSync(hooksDir)).toBe(false);
  });

  it("dry-run reports files that would be written", async () => {
    const result = await install({ cwd: dir, dryRun: true });
    const names = result.filesWritten.map((f) => f.split("/").pop());
    expect(names).toContain("preflight.sh");
    expect(names).toContain("record.sh");
  });

  it("dry-run reports settings that would be patched", async () => {
    const result = await install({ cwd: dir, dryRun: true });
    expect(result.filesPatched.some((f) => f.endsWith("settings.json"))).toBe(true);
  });

  it("uses global paths when --global is set", async () => {
    const result = await install({ cwd: dir, global: true, dryRun: true });
    const home = (await import("node:os")).homedir();
    expect(result.filesWritten.some((f) => f.startsWith(home))).toBe(true);
  });

  it("adds .agentic-feedback/ to .gitignore by default", async () => {
    await install({ cwd: dir });
    const gitignore = await readFile(join(dir, ".gitignore"), "utf8");
    expect(gitignore).toContain(".agentic-feedback/");
  });

  it("appends to existing .gitignore without duplicating", async () => {
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(dir, ".gitignore"), "node_modules/\ndist/\n", "utf8");
    await install({ cwd: dir });
    const gitignore = await readFile(join(dir, ".gitignore"), "utf8");
    expect(gitignore).toContain("node_modules/");
    expect(gitignore).toContain(".agentic-feedback/");
    expect(gitignore.split(".agentic-feedback/")).toHaveLength(2); // only one occurrence
  });

  it("skips .gitignore when .agentic-feedback/ is already present", async () => {
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(dir, ".gitignore"), ".agentic-feedback/\n", "utf8");
    const result = await install({ cwd: dir });
    expect(result.skipped.some((f) => f.endsWith(".gitignore"))).toBe(true);
  });

  it("does NOT add .agentic-feedback/ to .gitignore when --push is set", async () => {
    await install({ cwd: dir, push: true });
    const { existsSync } = await import("node:fs");
    if (existsSync(join(dir, ".gitignore"))) {
      const gitignore = await readFile(join(dir, ".gitignore"), "utf8");
      expect(gitignore).not.toContain(".agentic-feedback/");
    }
  });
});

describe("install — cursor", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates cursor hooks.json", async () => {
    await install({ agent: "cursor", cwd: dir });
    const raw = await readFile(join(dir, ".cursor", "hooks.json"), "utf8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    expect(config).toHaveProperty("beforeShellExecution");
  });

  it("creates cursor preflight script", async () => {
    await install({ agent: "cursor", cwd: dir });
    const pf = await readFile(join(dir, ".cursor", "hooks", "preflight.sh"), "utf8");
    expect(pf).toContain("CURSOR_COMMAND");
  });
});

describe("install — cline", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates cline beforeShellExecution hook", async () => {
    await install({ agent: "cline", cwd: dir });
    const hook = await readFile(
      join(dir, ".clinerules", "hooks", "beforeShellExecution"),
      "utf8",
    );
    expect(hook).toContain("cancel");
    expect(hook).toContain("agentic-feedback preflight");
  });
});

describe("install — openhands", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates openhands hooks.json", async () => {
    await install({ agent: "openhands", cwd: dir });
    const raw = await readFile(join(dir, ".openhands", "hooks.json"), "utf8");
    const config = JSON.parse(raw) as { hooks: Record<string, unknown[]> };
    expect(config.hooks).toHaveProperty("PreToolUse");
  });

  it("creates openhands preflight script", async () => {
    await install({ agent: "openhands", cwd: dir });
    const pf = await readFile(join(dir, ".openhands", "hooks", "preflight.sh"), "utf8");
    expect(pf).toContain("agentic-feedback preflight");
  });
});

describe("install — copilot (GitHub cloud agent)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates .github/hooks/preflight.json with version and preToolUse", async () => {
    await install({ agent: "copilot", cwd: dir });
    const raw = await readFile(join(dir, ".github", "hooks", "preflight.json"), "utf8");
    const config = JSON.parse(raw) as { version: number; hooks: { preToolUse: unknown[] } };
    expect(config.version).toBe(1);
    expect(config.hooks.preToolUse).toHaveLength(1);
  });

  it("creates .github/hooks/record.json with postToolUse", async () => {
    await install({ agent: "copilot", cwd: dir });
    const raw = await readFile(join(dir, ".github", "hooks", "record.json"), "utf8");
    const config = JSON.parse(raw) as { version: number; hooks: { postToolUse: unknown[] } };
    expect(config.version).toBe(1);
    expect(config.hooks.postToolUse).toHaveLength(1);
  });

  it("preflight hook bash script contains agentic-feedback preflight", async () => {
    await install({ agent: "copilot", cwd: dir });
    const raw = await readFile(join(dir, ".github", "hooks", "preflight.json"), "utf8");
    expect(raw).toContain("agentic-feedback preflight");
  });

  it("preflight hook bash script outputs permissionDecision deny on block", async () => {
    await install({ agent: "copilot", cwd: dir });
    const raw = await readFile(join(dir, ".github", "hooks", "preflight.json"), "utf8");
    expect(raw).toContain("permissionDecision");
    expect(raw).toContain("deny");
  });

  it("record hook bash script reads toolArgs.command (camelCase stdin)", async () => {
    await install({ agent: "copilot", cwd: dir });
    const raw = await readFile(join(dir, ".github", "hooks", "record.json"), "utf8");
    expect(raw).toContain("toolArgs.command");
  });

  it("creates copilot-setup-steps.yml for runner npm install", async () => {
    await install({ agent: "copilot", cwd: dir });
    const yaml = await readFile(join(dir, "copilot-setup-steps.yml"), "utf8");
    expect(yaml).toContain("agentic-feedback");
    expect(yaml).toContain("npm install");
  });

  it("dry-run reports files that would be created", async () => {
    const result = await install({ agent: "copilot", cwd: dir, dryRun: true });
    const allFiles = [...result.filesWritten, ...result.filesPatched];
    expect(allFiles.some((f) => f.endsWith("preflight.json"))).toBe(true);
    expect(allFiles.some((f) => f.endsWith("record.json"))).toBe(true);
    expect(allFiles.some((f) => f.endsWith("copilot-setup-steps.yml"))).toBe(true);
  });

  it("appends to existing copilot-setup-steps.yml rather than overwriting", async () => {
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(
      join(dir, "copilot-setup-steps.yml"),
      "steps:\n  - name: Install Node\n    run: nvm use 20\n",
      "utf8",
    );
    await install({ agent: "copilot", cwd: dir });
    const yaml = await readFile(join(dir, "copilot-setup-steps.yml"), "utf8");
    expect(yaml).toContain("Install Node");
    expect(yaml).toContain("agentic-feedback");
  });

  it("skips copilot-setup-steps.yml when agentic-feedback already present", async () => {
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(
      join(dir, "copilot-setup-steps.yml"),
      "steps:\n  - name: Install agentic-feedback\n    run: npm install -g agentic-feedback\n",
      "utf8",
    );
    const result = await install({ agent: "copilot", cwd: dir });
    expect(result.skipped.some((f) => f.endsWith("copilot-setup-steps.yml"))).toBe(true);
  });
});

describe("install — generic", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates wrap-exec.sh in bin/", async () => {
    await install({ agent: "generic", cwd: dir });
    const wrap = await readFile(join(dir, "bin", "wrap-exec.sh"), "utf8");
    expect(wrap).toContain("agentic-feedback preflight");
    expect(wrap).toContain("agentic-feedback record");
  });

  it("wrap-exec.sh is executable", async () => {
    await install({ agent: "generic", cwd: dir });
    expect(await isExecutable(join(dir, "bin", "wrap-exec.sh"))).toBe(true);
  });
});

describe("install — claude-code --remote (cloud/ephemeral containers)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates session-start.sh that installs and seeds patterns", async () => {
    await install({ cwd: dir, remote: true });
    const script = await readFile(join(dir, ".claude", "hooks", "session-start.sh"), "utf8");
    expect(script).toContain("npm install -g agentic-feedback");
    expect(script).toContain("agentic-feedback import");
    expect(script).toContain(".agentic-feedback/patterns.json");
  });

  it("creates stop-worktree.sh that exports patterns (no git push)", async () => {
    await install({ cwd: dir, remote: true });
    const script = await readFile(join(dir, ".claude", "hooks", "stop-worktree.sh"), "utf8");
    expect(script).toContain("agentic-feedback learn");
    expect(script).toContain("agentic-feedback export");
    expect(script).not.toContain("git push");
  });

  it("--push creates stop-remote.sh with git commit and push", async () => {
    await install({ cwd: dir, push: true });
    const script = await readFile(join(dir, ".claude", "hooks", "stop-remote.sh"), "utf8");
    expect(script).toContain("agentic-feedback learn");
    expect(script).toContain("agentic-feedback export");
    expect(script).toContain("git commit");
    expect(script).toContain("git push");
  });

  it("session-start.sh is executable", async () => {
    await install({ cwd: dir, remote: true });
    expect(await isExecutable(join(dir, ".claude", "hooks", "session-start.sh"))).toBe(true);
  });

  it("stop-worktree.sh is executable", async () => {
    await install({ cwd: dir, remote: true });
    expect(await isExecutable(join(dir, ".claude", "hooks", "stop-worktree.sh"))).toBe(true);
  });

  it("wires SessionStart hook in settings.json", async () => {
    await install({ cwd: dir, remote: true });
    const raw = await readFile(join(dir, ".claude", "settings.json"), "utf8");
    const settings = JSON.parse(raw) as { hooks: Record<string, unknown[]> };
    expect(settings.hooks).toHaveProperty("SessionStart");
  });

  it("Stop hook in settings.json points to stop-worktree.sh for --remote", async () => {
    await install({ cwd: dir, remote: true });
    const raw = await readFile(join(dir, ".claude", "settings.json"), "utf8");
    const settings = JSON.parse(raw) as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
    };
    const stopCmd = settings.hooks.Stop[0]?.hooks[0]?.command ?? "";
    expect(stopCmd).toContain("stop-worktree.sh");
  });

  it("Stop hook in settings.json points to stop-remote.sh for --push", async () => {
    await install({ cwd: dir, push: true });
    const raw = await readFile(join(dir, ".claude", "settings.json"), "utf8");
    const settings = JSON.parse(raw) as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
    };
    const stopCmd = settings.hooks.Stop[0]?.hooks[0]?.command ?? "";
    expect(stopCmd).toContain("stop-remote.sh");
  });

  it("non-remote install does not create session-start.sh", async () => {
    await install({ cwd: dir });
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(dir, ".claude", "hooks", "session-start.sh"))).toBe(false);
  });

  it("dry-run with --remote reports session-start and stop-worktree scripts", async () => {
    const result = await install({ cwd: dir, remote: true, dryRun: true });
    const names = result.filesWritten.map((f) => f.split("/").pop());
    expect(names).toContain("session-start.sh");
    expect(names).toContain("stop-worktree.sh");
  });

  it("dry-run with --push reports session-start and stop-remote scripts", async () => {
    const result = await install({ cwd: dir, push: true, dryRun: true });
    const names = result.filesWritten.map((f) => f.split("/").pop());
    expect(names).toContain("session-start.sh");
    expect(names).toContain("stop-remote.sh");
  });
});

describe("multi-agent co-installation", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("claude-code and cursor installs do not conflict", async () => {
    await install({ agent: "claude-code", cwd: dir });
    await install({ agent: "cursor", cwd: dir });

    const claudeSettings = JSON.parse(
      await readFile(join(dir, ".claude", "settings.json"), "utf8"),
    ) as { hooks: unknown };
    const cursorHooks = JSON.parse(
      await readFile(join(dir, ".cursor", "hooks.json"), "utf8"),
    ) as { beforeShellExecution: unknown };

    expect(claudeSettings.hooks).toBeDefined();
    expect(cursorHooks.beforeShellExecution).toBeDefined();
  });

  it("claude-code and cline installs do not conflict", async () => {
    await install({ agent: "claude-code", cwd: dir });
    await install({ agent: "cline", cwd: dir });

    const { existsSync } = await import("node:fs");
    expect(existsSync(join(dir, ".claude", "hooks", "preflight.sh"))).toBe(true);
    expect(existsSync(join(dir, ".clinerules", "hooks", "beforeShellExecution"))).toBe(true);
  });

  it("claude-code and copilot installs do not conflict", async () => {
    await install({ agent: "claude-code", cwd: dir });
    await install({ agent: "copilot", cwd: dir });

    const claudeSettings = JSON.parse(
      await readFile(join(dir, ".claude", "settings.json"), "utf8"),
    ) as { hooks: unknown };
    const preflight = JSON.parse(
      await readFile(join(dir, ".github", "hooks", "preflight.json"), "utf8"),
    ) as { version: number };

    expect(claudeSettings.hooks).toBeDefined();
    expect(preflight.version).toBe(1);
  });

  it("installing the same agent twice is idempotent", async () => {
    await install({ agent: "claude-code", cwd: dir });
    await install({ agent: "claude-code", cwd: dir });

    const raw = await readFile(join(dir, ".claude", "settings.json"), "utf8");
    const settings = JSON.parse(raw) as { hooks: { PreToolUse: unknown[] } };
    // Should not accumulate duplicate hook entries
    expect(settings.hooks.PreToolUse).toHaveLength(1);
  });

  it("installing claude-code preserves settings added by cursor install", async () => {
    // cursor install writes .cursor/hooks.json; claude-code install only touches .claude/
    await install({ agent: "cursor", cwd: dir });
    await install({ agent: "claude-code", cwd: dir });

    const { existsSync } = await import("node:fs");
    expect(existsSync(join(dir, ".cursor", "hooks.json"))).toBe(true);
    expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(true);
  });
});
