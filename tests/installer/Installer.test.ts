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
