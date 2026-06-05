import { mkdir, writeFile, readFile, chmod, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export type AgentTarget = "claude-code" | "cursor" | "cline" | "openhands" | "generic" | "copilot";

export interface InstallOptions {
  agent?: AgentTarget;
  global?: boolean;
  dryRun?: boolean;
  /** Add SessionStart + Stop hooks that persist patterns via the worktree file. */
  remote?: boolean;
  /** Also commit and push patterns at session end. Only needed for truly ephemeral
   *  containers (cloud runners that start from a fresh clone). Implies remote. */
  push?: boolean;
  cwd?: string;
}

export interface InstallResult {
  agent: AgentTarget;
  filesWritten: string[];
  filesPatched: string[];
  skipped: string[];
  dryRun: boolean;
}

// ─── Hook script templates ─────────────────────────────────────────────────

const PREFLIGHT_SH = `#!/bin/bash
# agentic-feedback preflight hook — blocks known-bad shell patterns.
# Exit 2 = blocked (Claude sees the error and must find a safe alternative).

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

if [ -z "$COMMAND" ]; then exit 0; fi

agentic-feedback preflight "$COMMAND"
STATUS=$?

exit $STATUS
`;

const RECORD_SH = `#!/bin/bash
# agentic-feedback record hook — logs every shell outcome for pattern learning.

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
EXIT_CODE=$(echo "$INPUT" | jq -r '.tool_output.exit_code // 0')

if [ -z "$COMMAND" ]; then exit 0; fi

OUTCOME="success"
[ "$EXIT_CODE" != "0" ] && OUTCOME="mechanical-failure"

echo "{\"command\":$(echo "$COMMAND" | jq -Rs .),\"outcome\":\"$OUTCOME\",\"duration_ms\":0}" \\
  | agentic-feedback record

exit 0
`;

// Remote-mode additions: SessionStart seeds the registry from the repo;
// stop-remote.sh exports learned patterns and pushes them back so they
// survive ephemeral container restarts (cloud sessions, GitHub Actions, etc.).

const SESSION_START_SH = `#!/bin/bash
# agentic-feedback session-start hook — runs at the start of each cloud session.

# Install agentic-feedback if not present in this container.
which agentic-feedback >/dev/null 2>&1 || npm install -g agentic-feedback 2>/dev/null

# Seed the pattern registry from the committed patterns file.
if [ -f ".agentic-feedback/patterns.json" ]; then
  agentic-feedback import < .agentic-feedback/patterns.json
fi

exit 0
`;

// Used when --remote is set WITHOUT --push.
// Exports patterns to the worktree file; no git commit.
// Works for Cowork (WSL2/Lima local VM) and any setup where the worktree persists.
const STOP_WORKTREE_SH = `#!/bin/bash
# agentic-feedback stop hook — exports learned patterns to the worktree.
# The file persists naturally when the worktree is local (Cowork, WSL, dev containers).

agentic-feedback learn

mkdir -p .agentic-feedback
agentic-feedback export > .agentic-feedback/patterns.json

exit 0
`;

// Used when --remote --push is set.
// Same as above but also commits and pushes so patterns survive ephemeral containers
// that start from a fresh clone each session (cloud runners, GitHub Actions, etc.).
const STOP_REMOTE_SH = `#!/bin/bash
# agentic-feedback stop hook (cloud) — exports patterns and pushes to repo.
# Use this for ephemeral containers that start from a fresh clone each session.
#
# Merge strategy for concurrent writers:
#   1. Fetch the latest remote patterns and import (merge by signature, no duplicates)
#   2. Export the merged set
#   3. Commit and push; if push is rejected (concurrent write), pull --rebase and retry once

agentic-feedback learn

mkdir -p .agentic-feedback

# Fetch remote patterns and merge them in before exporting, so concurrent
# writes from other users are preserved rather than overwritten.
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
if [ -n "$BRANCH" ]; then
  git fetch origin "$BRANCH" 2>/dev/null
  REMOTE_JSON=$(git show "origin/$BRANCH:.agentic-feedback/patterns.json" 2>/dev/null)
  if [ -n "$REMOTE_JSON" ]; then
    echo "$REMOTE_JSON" | agentic-feedback import 2>/dev/null || true
  fi
fi

agentic-feedback export > .agentic-feedback/patterns.json

git add .agentic-feedback/patterns.json 2>/dev/null
if ! git diff --staged --quiet 2>/dev/null; then
  git commit -m "chore: update agentic-feedback patterns [skip ci]" 2>/dev/null
  if ! git push 2>/dev/null; then
    # Rejected — another writer pushed first. Rebase and retry once.
    git pull --rebase 2>/dev/null && git push 2>/dev/null || true
  fi
fi

exit 0
`;

const CLAUDE_SETTINGS_HOOKS = {
  hooks: {
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [{ type: "command", command: ".claude/hooks/preflight.sh" }],
      },
    ],
    PostToolUse: [
      {
        matcher: "Bash",
        hooks: [{ type: "command", command: ".claude/hooks/record.sh" }],
      },
    ],
    Stop: [
      {
        matcher: "",
        hooks: [{ type: "command", command: "agentic-feedback learn" }],
      },
    ],
  },
};

const CLAUDE_SETTINGS_HOOKS_GLOBAL = {
  hooks: {
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [{ type: "command", command: "~/.claude/hooks/preflight.sh" }],
      },
    ],
    PostToolUse: [
      {
        matcher: "Bash",
        hooks: [{ type: "command", command: "~/.claude/hooks/record.sh" }],
      },
    ],
    Stop: [
      {
        matcher: "",
        hooks: [{ type: "command", command: "agentic-feedback learn" }],
      },
    ],
  },
};

function makeClaudeSettingsRemoteAdditions(base: string, usePush: boolean): unknown {
  const stopScript = usePush ? `${base}/hooks/stop-remote.sh` : `${base}/hooks/stop-worktree.sh`;
  return {
    hooks: {
      SessionStart: [
        {
          matcher: "",
          hooks: [{ type: "command", command: `${base}/hooks/session-start.sh` }],
        },
      ],
      Stop: [
        {
          matcher: "",
          hooks: [{ type: "command", command: stopScript }],
        },
      ],
    },
  };
}

// ─── Cursor hooks template ─────────────────────────────────────────────────

function makeCursorHooks(hooksDir: string): unknown {
  return {
    beforeShellExecution: {
      command: `${hooksDir}/preflight.sh`,
      description: "agentic-feedback preflight check",
    },
    afterShellExecution: {
      command: `${hooksDir}/record-cursor.sh`,
      description: "agentic-feedback outcome recording",
    },
  };
}

const CURSOR_RECORD_SH = `#!/bin/bash
# agentic-feedback record hook for Cursor.

COMMAND="$CURSOR_COMMAND"
EXIT_CODE="\${CURSOR_EXIT_CODE:-0}"

if [ -z "$COMMAND" ]; then exit 0; fi

OUTCOME="success"
[ "$EXIT_CODE" != "0" ] && OUTCOME="mechanical-failure"

echo "{\\"command\\":$(echo "$COMMAND" | jq -Rs .),\\"outcome\\":\\"$OUTCOME\\",\\"duration_ms\\":0}" \\
  | agentic-feedback record

exit 0
`;

const CURSOR_PREFLIGHT_SH = `#!/bin/bash
# agentic-feedback preflight hook for Cursor.
# Cursor passes the command via CURSOR_COMMAND env var.

COMMAND="$CURSOR_COMMAND"
if [ -z "$COMMAND" ]; then exit 0; fi

agentic-feedback preflight "$COMMAND"
exit $?
`;

// ─── Cline hooks template ──────────────────────────────────────────────────

const CLINE_PREFLIGHT_SH = `#!/bin/bash
# agentic-feedback preflight hook for Cline.
# Called before each shell command; write {"cancel": true} to block.

COMMAND="$CLINE_COMMAND"
if [ -z "$COMMAND" ]; then exit 0; fi

RESULT=$(agentic-feedback preflight "$COMMAND" 2>&1)
STATUS=$?

if [ $STATUS -eq 2 ]; then
  echo '{"cancel": true, "reason": '"$(echo "$RESULT" | jq -Rs .)"'}'
  exit 0
fi

exit 0
`;

// ─── OpenHands hooks template ──────────────────────────────────────────────

function makeOpenHandsHooks(hooksDir: string): unknown {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: `${hooksDir}/preflight.sh` }],
        },
      ],
      PostToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: `${hooksDir}/record.sh` }],
        },
      ],
    },
  };
}

// ─── GitHub Copilot cloud agent templates ─────────────────────────────────
//
// GitHub Copilot coding agent uses .github/hooks/*.json with inline bash scripts.
// Blocking is done via JSON stdout ({"permissionDecision":"deny",...}), not exit code 2.
// stdin uses camelCase: toolName, toolArgs.command, toolOutput.exitCode.
// Runner must have agentic-feedback installed via copilot-setup-steps.yml.

const COPILOT_PREFLIGHT_JSON = {
  version: 1,
  hooks: {
    preToolUse: [
      {
        type: "command",
        // Reads toolArgs.command from camelCase stdin; outputs deny JSON if blocked.
        bash: [
          "INPUT=$(cat)",
          "COMMAND=$(echo \"$INPUT\" | jq -r '.toolArgs.command // empty')",
          "[ -z \"$COMMAND\" ] && exit 0",
          "REASON=$(agentic-feedback preflight \"$COMMAND\" 2>&1)",
          "STATUS=$?",
          "if [ $STATUS -eq 2 ]; then",
          "  echo \"{\\\"permissionDecision\\\":\\\"deny\\\",\\\"permissionDecisionReason\\\":$(echo \\\"$REASON\\\" | jq -Rs .)}\"",
          "fi",
          "exit 0",
        ].join("\n"),
        timeoutSec: 30,
      },
    ],
  },
};

const COPILOT_RECORD_JSON = {
  version: 1,
  hooks: {
    postToolUse: [
      {
        type: "command",
        bash: [
          "INPUT=$(cat)",
          "COMMAND=$(echo \"$INPUT\" | jq -r '.toolArgs.command // empty')",
          "EXIT_CODE=$(echo \"$INPUT\" | jq -r '.toolOutput.exitCode // 0')",
          "[ -z \"$COMMAND\" ] && exit 0",
          "OUTCOME=\"success\"",
          "[ \"$EXIT_CODE\" != \"0\" ] && OUTCOME=\"mechanical-failure\"",
          "echo \"{\\\"command\\\":$(echo \\\"$COMMAND\\\" | jq -Rs .),\\\"outcome\\\":\\\"$OUTCOME\\\",\\\"duration_ms\\\":0}\" | agentic-feedback record",
          "exit 0",
        ].join("\n"),
        timeoutSec: 10,
      },
    ],
  },
};

const COPILOT_SETUP_STEPS_YML = `# copilot-setup-steps.yml
# Installs agentic-feedback in the Copilot coding agent's sandbox runner.
# Place this file at the root of your repository.
steps:
  - name: Install agentic-feedback
    run: npm install -g agentic-feedback
`;

// ─── Generic shell wrapper template ───────────────────────────────────────

const GENERIC_WRAP_SH = `#!/bin/bash
# agentic-feedback generic shell wrapper.
# Use this as a drop-in replacement for your agent's shell executor.
#
# Usage:  wrap-exec.sh <command>
#   or:   COMMAND="..." wrap-exec.sh

COMMAND="\${1:-$COMMAND}"
if [ -z "$COMMAND" ]; then
  echo "wrap-exec.sh: no command provided" >&2
  exit 1
fi

# Preflight check — exit code 2 = blocked
agentic-feedback preflight "$COMMAND"
PREFLIGHT=$?

if [ $PREFLIGHT -eq 2 ]; then
  exit 1
fi

# Run and record
START=$(date +%s%3N)
eval "$COMMAND"
EXIT=$?
END=$(date +%s%3N)

OUTCOME="success"
[ $EXIT -ne 0 ] && OUTCOME="mechanical-failure"

echo "{\"command\":$(echo "$COMMAND" | jq -Rs .),\"outcome\":\"$OUTCOME\",\"duration_ms\":$((END-START))}" \\
  | agentic-feedback record

exit $EXIT
`;

// ─── Installer core ────────────────────────────────────────────────────────

export async function install(options: InstallOptions = {}): Promise<InstallResult> {
  const agent: AgentTarget = options.agent ?? "claude-code";
  const dryRun = options.dryRun ?? false;
  const cwd = options.cwd ?? process.cwd();
  const home = homedir();

  const result: InstallResult = {
    agent,
    filesWritten: [],
    filesPatched: [],
    skipped: [],
    dryRun,
  };

  switch (agent) {
    case "claude-code":
      await installClaudeCode(cwd, home, options, result);
      break;
    case "cursor":
      await installCursor(cwd, home, options, result);
      break;
    case "cline":
      await installCline(cwd, options, result);
      break;
    case "openhands":
      await installOpenHands(cwd, options, result);
      break;
    case "generic":
      await installGeneric(cwd, options, result);
      break;
    case "copilot":
      await installCopilot(cwd, options, result);
      break;
  }

  return result;
}

async function installClaudeCode(
  cwd: string,
  home: string,
  options: InstallOptions,
  result: InstallResult,
): Promise<void> {
  const base = options.global ? join(home, ".claude") : join(cwd, ".claude");
  const hooksDir = join(base, "hooks");
  const settingsPath = join(base, "settings.json");
  const isGlobal = options.global ?? false;

  await ensureDir(hooksDir, options, result);

  await writeScript(join(hooksDir, "preflight.sh"), PREFLIGHT_SH, options, result);
  await writeScript(join(hooksDir, "record.sh"), RECORD_SH, options, result);

  const hookConfig = isGlobal ? CLAUDE_SETTINGS_HOOKS_GLOBAL : CLAUDE_SETTINGS_HOOKS;
  await patchSettings(settingsPath, hookConfig, options, result);

  // Patterns are private by default. Gitignore the worktree patterns file so it
  // can never be accidentally committed unless --push is explicitly requested.
  if (!options.push && !isGlobal) {
    await ensureGitignore(cwd, ".agentic-feedback/", options, result);
  }

  if (options.remote ?? options.push) {
    const usePush = options.push ?? false;
    const stopScript = usePush ? STOP_REMOTE_SH : STOP_WORKTREE_SH;
    const stopFilename = usePush ? "stop-remote.sh" : "stop-worktree.sh";
    await writeScript(join(hooksDir, "session-start.sh"), SESSION_START_SH, options, result);
    await writeScript(join(hooksDir, stopFilename), stopScript, options, result);
    const remoteAdditions = makeClaudeSettingsRemoteAdditions(base, usePush);
    await patchSettings(settingsPath, remoteAdditions, options, result);
  }
}

async function installCursor(
  cwd: string,
  home: string,
  options: InstallOptions,
  result: InstallResult,
): Promise<void> {
  const base = options.global ? join(home, ".cursor") : join(cwd, ".cursor");
  const hooksDir = join(base, "hooks");
  const hooksJsonPath = join(base, "hooks.json");

  await ensureDir(hooksDir, options, result);

  await writeScript(join(hooksDir, "preflight.sh"), CURSOR_PREFLIGHT_SH, options, result);
  await writeScript(join(hooksDir, "record-cursor.sh"), CURSOR_RECORD_SH, options, result);

  const hookConfig = makeCursorHooks(hooksDir);
  await patchSettings(hooksJsonPath, hookConfig, options, result);
}

async function installCline(
  cwd: string,
  options: InstallOptions,
  result: InstallResult,
): Promise<void> {
  const hooksDir = join(cwd, ".clinerules", "hooks");
  await ensureDir(hooksDir, options, result);
  await writeScript(join(hooksDir, "beforeShellExecution"), CLINE_PREFLIGHT_SH, options, result);
}

async function installOpenHands(
  cwd: string,
  options: InstallOptions,
  result: InstallResult,
): Promise<void> {
  const base = join(cwd, ".openhands");
  const hooksDir = join(base, "hooks");
  const hooksJsonPath = join(base, "hooks.json");

  await ensureDir(hooksDir, options, result);

  await writeScript(join(hooksDir, "preflight.sh"), PREFLIGHT_SH, options, result);
  await writeScript(join(hooksDir, "record.sh"), RECORD_SH, options, result);

  const hookConfig = makeOpenHandsHooks(hooksDir);
  await patchSettings(hooksJsonPath, hookConfig, options, result);
}

async function installGeneric(
  cwd: string,
  options: InstallOptions,
  result: InstallResult,
): Promise<void> {
  const binDir = resolve(cwd, "bin");
  await ensureDir(binDir, options, result);
  await writeScript(join(binDir, "wrap-exec.sh"), GENERIC_WRAP_SH, options, result);
}

async function installCopilot(
  cwd: string,
  options: InstallOptions,
  result: InstallResult,
): Promise<void> {
  const hooksDir = join(cwd, ".github", "hooks");
  await ensureDir(hooksDir, options, result);
  await patchSettings(join(hooksDir, "preflight.json"), COPILOT_PREFLIGHT_JSON, options, result);
  await patchSettings(join(hooksDir, "record.json"), COPILOT_RECORD_JSON, options, result);
  await patchSetupSteps(join(cwd, "copilot-setup-steps.yml"), options, result);
}

async function patchSetupSteps(
  path: string,
  options: InstallOptions,
  result: InstallResult,
): Promise<void> {
  if (options.dryRun) {
    result.filesPatched.push(path);
    return;
  }
  // If the file already mentions agentic-feedback, don't touch it.
  if (existsSync(path)) {
    const existing = await readFile(path, "utf8");
    if (existing.includes("agentic-feedback")) {
      result.skipped.push(path);
      return;
    }
    // Append install step to existing file rather than overwriting.
    const append = `\n  - name: Install agentic-feedback\n    run: npm install -g agentic-feedback\n`;
    await writeFile(path, existing.trimEnd() + append, "utf8");
    result.filesPatched.push(path);
    return;
  }
  await writeFile(path, COPILOT_SETUP_STEPS_YML, "utf8");
  await chmod(path, 0o644);
  result.filesWritten.push(path);
}

// ─── File helpers ──────────────────────────────────────────────────────────

async function ensureGitignore(
  cwd: string,
  entry: string,
  options: InstallOptions,
  result: InstallResult,
): Promise<void> {
  const gitignorePath = join(cwd, ".gitignore");
  if (options.dryRun) {
    result.filesPatched.push(gitignorePath);
    return;
  }
  let content = "";
  if (existsSync(gitignorePath)) {
    content = await readFile(gitignorePath, "utf8");
    const lines = content.split("\n").map((l) => l.trim());
    if (lines.some((l) => l === entry || l === `/${entry}`)) {
      result.skipped.push(gitignorePath);
      return;
    }
  }
  const suffix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  await writeFile(gitignorePath, `${content}${suffix}${entry}\n`, "utf8");
  result.filesPatched.push(gitignorePath);
}

async function ensureDir(
  dir: string,
  options: InstallOptions,
  result: InstallResult,
): Promise<void> {
  if (!options.dryRun) {
    await mkdir(dir, { recursive: true });
  }
}

async function writeScript(
  path: string,
  content: string,
  options: InstallOptions,
  result: InstallResult,
): Promise<void> {
  if (options.dryRun) {
    result.filesWritten.push(path);
    return;
  }
  await writeFile(path, content, "utf8");
  await chmod(path, 0o755);
  result.filesWritten.push(path);
}

async function patchSettings(
  path: string,
  incoming: unknown,
  options: InstallOptions,
  result: InstallResult,
): Promise<void> {
  if (options.dryRun) {
    result.filesPatched.push(path);
    return;
  }

  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      // Corrupt file — overwrite
    }
  }

  const merged = deepMerge(existing, incoming as Record<string, unknown>);
  if (!options.dryRun) {
    await writeFile(path, JSON.stringify(merged, null, 2) + "\n", "utf8");
  }
  result.filesPatched.push(path);
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [key, val] of Object.entries(source)) {
    const existing = out[key];
    if (
      typeof val === "object" &&
      val !== null &&
      !Array.isArray(val) &&
      typeof existing === "object" &&
      existing !== null &&
      !Array.isArray(existing)
    ) {
      out[key] = deepMerge(
        existing as Record<string, unknown>,
        val as Record<string, unknown>,
      );
    } else {
      out[key] = val;
    }
  }
  return out;
}

// ─── Live install detection ────────────────────────────────────────────────

export async function checkInstalled(
  agent: AgentTarget,
  scope: "global" | "repo",
  cwd: string,
): Promise<boolean> {
  const home = homedir();
  const base = scope === "global" ? home : cwd;
  const p = primaryHookPath(agent, scope, base, cwd);
  if (!p) return false;
  try { await readFile(p); return true; } catch { return false; }
}

function primaryHookPath(
  agent: AgentTarget,
  scope: "global" | "repo",
  base: string,
  cwd: string,
): string | null {
  switch (agent) {
    case "claude-code": return join(base, ".claude", "hooks", "preflight.sh");
    case "cursor":      return join(base, ".cursor", "hooks", "preflight.sh");
    case "cline":       return scope === "global" ? null : join(cwd, ".clinerules", "hooks", "beforeShellExecution");
    case "openhands":   return scope === "global" ? null : join(cwd, ".openhands", "hooks", "preflight.sh");
    case "copilot":     return scope === "global" ? null : join(cwd, ".github", "hooks", "preflight.json");
    case "generic":     return scope === "global" ? null : join(cwd, "bin", "wrap-exec.sh");
  }
}

// ─── Uninstall ─────────────────────────────────────────────────────────────

export async function uninstall(
  agent: AgentTarget,
  scope: "global" | "repo",
  cwd: string,
): Promise<void> {
  const home = homedir();
  const base = scope === "global" ? home : cwd;

  async function tryDel(dir: string, files: string[]): Promise<void> {
    await Promise.all(files.map((f) => unlink(join(dir, f)).catch(() => undefined)));
  }

  switch (agent) {
    case "claude-code": {
      const hooksDir = join(base, ".claude", "hooks");
      await tryDel(hooksDir, ["preflight.sh", "record.sh", "session-start.sh", "stop-worktree.sh", "stop-remote.sh"]);
      await cleanJsonHooks(join(base, ".claude", "settings.json"));
      break;
    }
    case "cursor": {
      const hooksDir = join(base, ".cursor", "hooks");
      await tryDel(hooksDir, ["preflight.sh", "record-cursor.sh"]);
      await cleanCursorHooks(join(base, ".cursor", "hooks.json"));
      break;
    }
    case "cline":
      if (scope === "repo") await tryDel(join(cwd, ".clinerules", "hooks"), ["beforeShellExecution"]);
      break;
    case "openhands":
      if (scope === "repo") {
        await tryDel(join(cwd, ".openhands", "hooks"), ["preflight.sh", "record.sh"]);
        await cleanJsonHooks(join(cwd, ".openhands", "hooks.json"));
      }
      break;
    case "copilot":
      if (scope === "repo") await tryDel(join(cwd, ".github", "hooks"), ["preflight.json", "record.json"]);
      break;
    case "generic":
      if (scope === "repo") await tryDel(join(cwd, "bin"), ["wrap-exec.sh"]);
      break;
  }
}

async function cleanJsonHooks(settingsPath: string): Promise<void> {
  let raw: string;
  try { raw = await readFile(settingsPath, "utf8"); } catch { return; }
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(raw) as Record<string, unknown>; } catch { return; }

  const hooks = obj["hooks"] as Record<string, unknown[]> | undefined;
  if (!hooks) return;

  for (const event of Object.keys(hooks)) {
    const arr = hooks[event];
    if (!Array.isArray(arr)) continue;
    hooks[event] = arr
      .map((e: unknown) => {
        const entry = e as { hooks?: Array<{ command?: string }> };
        if (!Array.isArray(entry.hooks)) return e;
        return { ...entry, hooks: entry.hooks.filter((h) => !isOurCommand(h.command ?? "")) };
      })
      .filter((e: unknown) => {
        const entry = e as { hooks?: unknown[] };
        return !Array.isArray(entry.hooks) || entry.hooks.length > 0;
      });
    if ((hooks[event] as unknown[]).length === 0) delete hooks[event];
  }

  if (Object.keys(hooks).length === 0) delete obj["hooks"];
  await writeFile(settingsPath, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

async function cleanCursorHooks(hooksJsonPath: string): Promise<void> {
  let raw: string;
  try { raw = await readFile(hooksJsonPath, "utf8"); } catch { return; }
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
  for (const key of ["beforeShellExecution", "afterShellExecution"]) {
    const entry = obj[key] as { command?: string } | undefined;
    if (entry?.command && isOurCommand(entry.command)) delete obj[key];
  }
  await writeFile(hooksJsonPath, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function isOurCommand(command: string): boolean {
  return (
    command.includes("agentic-feedback") ||
    /\/hooks\/preflight\.sh/.test(command) ||
    /\/hooks\/record\.sh/.test(command) ||
    /\/hooks\/record-cursor\.sh/.test(command) ||
    /\/hooks\/session-start\.sh/.test(command) ||
    /\/hooks\/stop-worktree\.sh/.test(command) ||
    /\/hooks\/stop-remote\.sh/.test(command)
  );
}
