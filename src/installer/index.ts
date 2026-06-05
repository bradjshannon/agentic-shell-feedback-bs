import { mkdir, writeFile, readFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export type AgentTarget = "claude-code" | "cursor" | "cline" | "openhands" | "generic" | "copilot";

export interface InstallOptions {
  agent?: AgentTarget;
  global?: boolean;
  dryRun?: boolean;
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
