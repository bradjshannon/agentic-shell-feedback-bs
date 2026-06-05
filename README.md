# agentic-feedback

> Turn repeated agent failures into enforced constraints — automatically, continuously, cross-platform.

**Zero runtime dependencies.** Works out of the box. Stores patterns in `~/.agentic-feedback/`. Advanced config available via TypeScript API.

---

## The Problem

AI agents make the same transport-level mistakes repeatedly — e.g. a PowerShell agent trying to pass a heredoc payload over SSH, timing out for 30 seconds, and repeating the pattern across sessions. Prose documentation doesn't reliably fix this: agents are inconsistent at following instructions.

**The fix is architectural:** make failures executable constraints, not advice.

---

## Quick Install

```bash
npm install -g agentic-feedback

# Claude Code (default) — also covers VS Code Copilot agent mode
agentic-feedback install

# Other agents
agentic-feedback install --agent cursor
agentic-feedback install --agent cline
agentic-feedback install --agent openhands
agentic-feedback install --agent copilot   # GitHub Copilot cloud coding agent
agentic-feedback install --agent generic   # shell wrapper, works with any agent

# Install globally (affects all your projects)
agentic-feedback install --global

# Preview without writing files
agentic-feedback install --dry-run
```

The `install` command creates the hook scripts and wires them into the agent's config automatically. See [Installing for Your Agent](#installing-for-your-agent) for per-agent details.

**Installing for multiple agents is safe.** Each agent writes to its own directory (`.claude/`, `.cursor/`, `.clinerules/`, `.openhands/`, `.github/hooks/`) — they never overlap. Running `install` twice for the same agent is also safe: settings files are merged rather than overwritten, so existing config is preserved and hook entries are never duplicated. All agents share a single pattern store (`~/.agentic-feedback/` by default), so failures learned by one agent automatically protect all the others.

---

## Integrating with Agents

There are three integration patterns depending on your setup.

---

### Pattern 1 — Claude Code hooks (zero agent-code changes)

The most powerful approach: the agent never needs to call this library explicitly. Hooks intercept every shell command automatically.

#### What are Claude Code hooks?

Hooks are shell commands that Claude Code runs automatically at specific points in its lifecycle. They receive context via stdin as JSON and can block actions by exiting with code 2. They're configured in a `settings.json` file — no Claude API changes needed.

**Settings file locations** (all three can coexist; more specific wins):

| File | Scope |
|------|-------|
| `~/.claude/settings.json` | All your projects, not committed |
| `.claude/settings.json` | This repo only, can be committed |
| `.claude/settings.local.json` | This repo only, gitignored |

**Hook JSON structure:**
```json
{
  "hooks": {
    "HookEvent": [
      {
        "matcher": "ToolName",
        "hooks": [
          { "type": "command", "command": "your-script.sh" }
        ]
      }
    ]
  }
}
```

**Exit code behaviour:**

| Exit code | Effect |
|-----------|--------|
| `0` | Hook passed, continue |
| `1` | Hook failed — stderr shown to user, tool runs anyway |
| `2` | **Blocked** — stderr is fed back to Claude, tool does not run |

**What's in stdin:** The hook receives a JSON object with `tool_name`, `tool_input` (for PreToolUse), and `tool_output` (for PostToolUse), plus `session_id`, `cwd`, and others.

---

#### Step-by-step setup for agentic-feedback

**1. Install the package**
```bash
npm install -g agentic-feedback
# or locally: npm install agentic-feedback
```

**2. Create the hook scripts**

```bash
mkdir -p .claude/hooks
```

`.claude/hooks/preflight.sh`:
```bash
#!/bin/bash
# Reads the Bash tool input from stdin, runs preflight check.
# Exit 2 = blocked (Claude sees the error and must find an alternative).

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

if [ -z "$COMMAND" ]; then exit 0; fi

agentic-feedback preflight "$COMMAND"
STATUS=$?

# agentic-feedback exits 2 when blocked — pass that through
exit $STATUS
```

`.claude/hooks/record.sh`:
```bash
#!/bin/bash
# Records the outcome of every Bash command for pattern learning.

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
EXIT_CODE=$(echo "$INPUT" | jq -r '.tool_output.exit_code // 0')

if [ -z "$COMMAND" ]; then exit 0; fi

OUTCOME="success"
[ "$EXIT_CODE" != "0" ] && OUTCOME="mechanical-failure"

echo "{\"command\":$(echo "$COMMAND" | jq -Rs .),\"outcome\":\"$OUTCOME\",\"duration_ms\":0}" \
  | agentic-feedback record

exit 0  # Always exit 0 — recording should never block
```

```bash
chmod +x .claude/hooks/preflight.sh .claude/hooks/record.sh
```

**3. Wire the hooks in `.claude/settings.json`**

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": ".claude/hooks/preflight.sh" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": ".claude/hooks/record.sh" }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "agentic-feedback learn" }
        ]
      }
    ]
  }
}
```

**4. Verify**

Run `/hooks` inside a Claude Code session to confirm hooks are loaded. Then try a blocked command:
```
> Run: ssh host << 'EOF'\necho hi\nEOF
```
Claude should see the block message and self-correct to a safe alternative.

**How it works end-to-end:**
- `PreToolUse` fires before every `Bash` call — exit 2 blocks it and feeds the reason back to Claude
- `PostToolUse` records every outcome silently — no agent cooperation needed
- `Stop` runs `learn()` when the session ends, promoting repeated failures to blocking status

---

### Pattern 2 — Agent SDK / custom agents

For agents built with the Claude API or another framework, call the library directly in your execution layer:

```typescript
import { LearningLoop } from "agentic-feedback";

const loop = new LearningLoop();

async function executeShellCommand(command: string, hints = {}) {
  // 1. Check before running
  const check = await loop.preflight(command, hints);
  if (!check.allowed) {
    // Return the block reason to the model so it can self-correct
    return {
      error: `Command blocked: ${check.reason}`,
      alternative: check.requiredAlternative,
    };
  }

  // 2. Run the command
  const start = Date.now();
  try {
    const output = await runCommand(command);
    await loop.record({
      command,
      context: loop.analyze(command, hints),
      outcome: "success",
      duration_ms: Date.now() - start,
    });
    return { output };
  } catch (err) {
    const outcome = isTimeout(err) ? "timeout" : "mechanical-failure";
    await loop.record({
      command,
      context: loop.analyze(command, hints),
      outcome,
      duration_ms: Date.now() - start,
      errorMessage: String(err),
    });
    throw err;
  }
}

// At end of session
await loop.learn();
await loop.close();
```

When a command is blocked, **return the reason and alternative to the model** — don't just throw. The model needs to see the alternative to self-correct on the next attempt.

---

### Pattern 3 — Wrap the CLI around an existing shell executor

No code changes needed to your agent. Wrap command execution at the process level:

```bash
#!/bin/bash
# wrap-exec.sh — drop-in replacement for direct shell execution
COMMAND="$*"

# Preflight check (exit code 2 = blocked)
agentic-feedback preflight "$COMMAND"
PREFLIGHT=$?

if [ $PREFLIGHT -eq 2 ]; then
  exit 1  # Agent sees the error output from preflight
fi

# Run it, record the outcome
START=$(date +%s%3N)
eval "$COMMAND"
EXIT=$?
END=$(date +%s%3N)

OUTCOME="success"
[ $EXIT -ne 0 ] && OUTCOME="mechanical-failure"

echo "{\"command\":$(echo "$COMMAND" | jq -Rs .),\"outcome\":\"$OUTCOME\",\"duration_ms\":$((END-START))}" \
  | agentic-feedback record

exit $EXIT
```

---

### Wiring up `learn()`

Patterns 2 and 3 require you to trigger `learn()` periodically. Good places:

- **End of each Claude session** — run `agentic-feedback learn` as a `Stop` hook
- **Cron job** — `0 * * * * agentic-feedback learn` (hourly)
- **After N failures** — call `loop.learn()` whenever `record()` returns a new pattern

Pattern 1 (hooks) wires this automatically via the `Stop` hook shown in the setup above.

---

### Sharing patterns across agents / team members

Export your registry and commit it, or share via a common path:

```bash
# Export learned patterns to the repo
agentic-feedback export > .claude/failure-patterns.json

# On a new machine / fresh container, seed the registry
agentic-feedback import < .claude/failure-patterns.json
```

Or point all agents at a shared storage directory:

```typescript
const loop = new LearningLoop({ storageDir: "/shared/nfs/agentic-feedback" });
```

---

## Installing for Your Agent

You can install for multiple agents in the same project — each uses a separate config directory and they never conflict. All agents share a single pattern store, so learned failures protect every agent automatically.

| Agent | Config location | Conflicts with others? |
|-------|----------------|------------------------|
| `claude-code` | `.claude/` | No |
| `cursor` | `.cursor/` | No |
| `cline` | `.clinerules/` | No |
| `openhands` | `.openhands/` | No |
| `copilot` | `.github/hooks/` | No |
| `generic` | `bin/` | No |

Repeated installs for the same agent are also safe — settings files are merged and scripts are overwritten in place, so nothing accumulates.

---

### Claude Code

```bash
agentic-feedback install
# or globally (all projects):
agentic-feedback install --global
```

Creates:
- `.claude/hooks/preflight.sh` — blocks known-bad commands (exit 2)
- `.claude/hooks/record.sh` — logs every outcome
- `.claude/settings.json` — wires hooks to `PreToolUse`, `PostToolUse`, and `Stop`

Verify with `/hooks` inside a Claude Code session. Try a blocked command:
```
> Run: ssh host << 'EOF'\necho hi\nEOF
```
Claude should see the block and self-correct to a safe alternative.

---

### Cursor

Cursor (v1.7+) supports `beforeShellExecution` and `afterShellExecution` hooks via `.cursor/hooks.json`.

```bash
agentic-feedback install --agent cursor
```

Creates:
- `.cursor/hooks/preflight.sh` — reads `$CURSOR_COMMAND`, exits non-zero to block
- `.cursor/hooks/record-cursor.sh` — records outcome via `$CURSOR_COMMAND` / `$CURSOR_EXIT_CODE`
- `.cursor/hooks.json` — wires both hooks

**Note:** Cursor hooks require Cursor v1.7 or later. Use `--global` to install to `~/.cursor/` and affect all projects.

---

### Cline

Cline (v3.36+, macOS/Linux only) runs scripts from `.clinerules/hooks/` named after the event.

```bash
agentic-feedback install --agent cline
```

Creates:
- `.clinerules/hooks/beforeShellExecution` — reads `$CLINE_COMMAND`, writes `{"cancel": true}` to block

**Note:** Cline hooks are only available on macOS and Linux. The hook must output JSON to stdout; any non-zero exit or `{"cancel": true}` blocks the command.

---

### OpenHands

OpenHands uses the same hook format as Claude Code (`.openhands/hooks.json`).

```bash
agentic-feedback install --agent openhands
```

Creates:
- `.openhands/hooks/preflight.sh`
- `.openhands/hooks/record.sh`
- `.openhands/hooks.json` — wires `PreToolUse` / `PostToolUse` for the `Bash` tool

---

### GitHub Copilot

There are two distinct Copilot environments with different hook mechanisms.

#### VS Code Copilot agent mode

VS Code Copilot agent mode (v1.96+, requires enabling agent mode in settings) uses the **identical hook format** as Claude Code — `.claude/settings.json`, exit code 2 for blocking, same stdin schema:

```bash
agentic-feedback install   # claude-code installer covers this too
```

Both agents read from `.claude/settings.json`, so a single install works for both.

#### GitHub Copilot cloud coding agent

The GitHub Copilot cloud agent runs autonomously in an ephemeral GitHub Actions sandbox. It uses a different hook format: `.github/hooks/*.json` with inline bash scripts, and blocks via JSON stdout rather than exit codes.

```bash
agentic-feedback install --agent copilot
```

Creates:
- `.github/hooks/preflight.json` — `preToolUse` hook; reads `toolArgs.command` from camelCase stdin, outputs `{"permissionDecision":"deny",...}` to block
- `.github/hooks/record.json` — `postToolUse` hook; records outcome via `toolOutput.exitCode`
- `copilot-setup-steps.yml` — installs `agentic-feedback` in the sandbox runner

**Required step:** Commit `copilot-setup-steps.yml` to your repo root so the sandbox runner has `agentic-feedback` available:

```yaml
# copilot-setup-steps.yml (auto-generated)
steps:
  - name: Install agentic-feedback
    run: npm install -g agentic-feedback
```

**Key differences from Claude Code hooks:**

| | VS Code Copilot / Claude Code | Copilot cloud agent |
|--|-------------------------------|---------------------|
| Config file | `.claude/settings.json` | `.github/hooks/*.json` |
| Script location | File path | Inline bash string |
| Blocking | Exit code 2 | `{"permissionDecision":"deny"}` in stdout |
| stdin keys | `tool_input.command` | `toolArgs.command` |
| Timeout unit | Milliseconds | Seconds |

---

### Aider / SWE-agent / any agent without native hooks

Use the generic shell wrapper — a drop-in replacement for your agent's shell executor:

```bash
agentic-feedback install --agent generic
```

Creates `bin/wrap-exec.sh`. Configure your agent to use it instead of running commands directly:

```bash
# Aider
aider --shell bin/wrap-exec.sh

# SWE-agent: set your tool bundle's shell_cmd to wrap-exec.sh

# Any subprocess-based agent
SHELL=bin/wrap-exec.sh my-agent run
```

The wrapper runs preflight before execution and records the outcome afterwards. Run `agentic-feedback learn` at the end of each session (or add a cron job).

---

### Continue.dev CLI

Continue.dev CLI (March 2026+) supports `.continue/hooks.json`. Documentation is still incomplete; the format mirrors Claude Code hooks.

```bash
mkdir -p .continue
agentic-feedback export > /dev/null  # ensure registry exists
# Then manually copy .claude/settings.json → .continue/hooks.json
# and update script paths to use full paths
```

---

### MCP-compatible agents

For agents that expose an MCP `bash`/`shell` tool, wrap the tool at the server level using the TypeScript API:

```typescript
import { LearningLoop } from "agentic-feedback";

const loop = new LearningLoop();

// In your MCP tool handler for "bash":
server.tool("bash", async ({ command }) => {
  const check = await loop.preflight(command);
  if (!check.allowed) {
    return { error: `Blocked: ${check.reason}. Try: ${check.requiredAlternative}` };
  }
  const start = Date.now();
  try {
    const output = await runShell(command);
    await loop.record({ command, context: loop.analyze(command), outcome: "success", duration_ms: Date.now() - start });
    return { output };
  } catch (err) {
    await loop.record({ command, context: loop.analyze(command), outcome: "mechanical-failure", duration_ms: Date.now() - start });
    throw err;
  }
});
```

---

### Sharing patterns across agents and machines

```bash
# Export learned patterns and commit them
agentic-feedback export > .agentic-feedback/patterns.json

# On a new machine or CI container, seed from the export
agentic-feedback import < .agentic-feedback/patterns.json
```

All agents reading from the same `storageDir` (or seeded from the same export) share pattern history automatically.

---

## Quick Start

```typescript
import { LearningLoop } from "agentic-feedback";

const loop = new LearningLoop(); // zero config — stores at ~/.agentic-feedback/

// Before executing a command:
const result = await loop.preflight(
  "ssh user@host << 'EOF'\necho hi\nEOF",
  { shell: "powershell", target: "remote-ssh" }
);

if (!result.allowed) {
  console.log("BLOCKED:", result.reason);
  console.log("Use instead:", result.requiredAlternative);
  // result.requiredAlternative: "Use stdin piping: ..."
}

// After execution (record the outcome):
await loop.record({
  command,
  context: loop.analyze(command, hints),
  outcome: "timeout",          // or "success" | "mechanical-failure" | "semantic-failure"
  duration_ms: 30_000,
  alternativeUsed: "stdin piping",  // optional: what worked instead
});

// Periodically — or after each session:
const learned = await loop.learn();
// { promoted: 1, expired: 0 }
// Pattern is now "blocking" — will be enforced on next preflight
```

---

## How It Works

```
preflight(cmd, hints)
  │
  ├─ CommandAnalyzer     → detect shell, target, heredoc, multiline, transport class
  │
  ├─ PreflightGate
  │    ├─ Built-in rules (always enforced):
  │    │    POWERSHELL_SSH_HEREDOC  → deny
  │    │    CMD_SSH_MULTILINE       → deny
  │    │    COMPLEX_INLINE_SSH      → warn (> 300 chars)
  │    │    NESTED_QUOTE_SSH        → warn
  │    └─ Registry patterns (blocking status, confidence ≥ threshold) → deny
  │
  └─ PreflightResult { allowed, warnings, reason, requiredAlternative }

record(trace)
  └─ FailureRegistry: upsert pattern, accumulate wasted_ms, update confidence

learn()
  └─ PolicyEngine: advisory → blocking when seen ≥ 2× in 30 days OR ≥ 60s wasted
                   blocking/advisory → expired when not seen in 90 days
```

---

## Preflight Gate — Built-in Rules

| Rule ID | Condition | Verdict |
|---------|-----------|---------|
| `POWERSHELL_SSH_HEREDOC` | PowerShell + SSH + heredoc or multiline | **deny** |
| `CMD_SSH_MULTILINE` | Windows CMD + SSH + multiline | **deny** |
| `HEREDOC_REMOTE_POWERSHELL` | PowerShell + any remote + heredoc | **deny** |
| `COMPLEX_INLINE_SSH` | SSH + inline + > 300 chars | warn |
| `NESTED_QUOTE_SSH` | SSH + complex quoting | warn |

---

## Transport Broker

When a command is blocked, get a safe alternative automatically:

```typescript
const { preflight, recommendation } = await loop.safeExec(command, hints);

if (!preflight.allowed) {
  console.log(recommendation.strategy);       // "file" | "stdin" | "inline"
  console.log(recommendation.commandTemplate); // ready-to-use safe command
  console.log(recommendation.rationale);       // why this strategy
}
```

**Strategy selection:**

| Condition | Strategy |
|-----------|----------|
| PowerShell + SSH + multiline/heredoc | `file` (scp + execute) |
| Payload ≤ 200 chars, no heredoc, no complex quotes | `inline` |
| Payload ≤ 2000 chars, no complex quotes | `stdin` (printf pipe) |
| Payload > 2000 chars or complex quotes | `file` |

---

## Advanced Configuration

```typescript
const loop = new LearningLoop({
  // Storage
  storageDir: "/path/to/custom/dir",    // default: ~/.agentic-feedback
  storage: customStorageAdapter,         // implement StorageAdapter interface

  // Policy thresholds
  promotionOccurrences: 2,              // default: 2 failures → blocking
  promotionWindowDays: 30,              // default: within 30 days
  promotionWastedMs: 60_000,            // default: 60s wasted → immediate block
  expirationDays: 90,                   // default: 90 days inactive → expired

  // Gate behavior
  enableBuiltInRules: false,            // disable built-ins (use custom only)
  customRules: [
    {
      id: "MY_RULE",
      description: "Block risky operation",
      match: (ctx) => ctx.target === "remote-ssh" && ctx.payloadLength > 500,
      verdict: "deny",
      reason: "Payload too large for SSH",
      alternative: "Transfer a script file instead",
    },
  ],
  blockOnConfidence: 0.7,               // default: 0.7 confidence to block
});
```

---

## CLI

```bash
# Install hooks for your agent (default: claude-code)
agentic-feedback install
agentic-feedback install --agent cursor
agentic-feedback install --agent cline
agentic-feedback install --agent openhands
agentic-feedback install --agent copilot
agentic-feedback install --agent generic
agentic-feedback install --global            # install to home dir
agentic-feedback install --dry-run           # preview without writing

# Check a command
agentic-feedback preflight "ssh user@host 'echo hi'" --shell powershell --target remote-ssh

# Record an outcome
echo '{"command":"ssh ...","context":{...},"outcome":"timeout","duration_ms":30000}' \
  | agentic-feedback record

# Run policy engine
agentic-feedback learn

# View report
agentic-feedback report

# Export/import patterns (share across teams)
agentic-feedback export > patterns.json
agentic-feedback import < team-patterns.json
```

---

## Eval & Metrics

```typescript
// Baseline: what's your current failure rate?
const metrics = await loop.eval.baseline(30); // last 30 days
// {
//   firstAttemptSuccessRate: 0.73,
//   timeoutMinutesPer100Tasks: 12.4,
//   repeatedPatternRecurrenceRate: 0.4,
//   transportSwitchCompliance: 0.6,
// }

// Compare candidate changes vs. baseline
const report = await loop.eval.compare(candidateTraces, candidatePatterns);
// { recommendation: "promote" | "reject" | "neutral", summary: "..." }
```

**Key metrics:**

| Metric | Description |
|--------|-------------|
| `firstAttemptSuccessRate` | % of commands that succeeded first try |
| `timeoutMinutesPer100Tasks` | Minutes wasted on timeouts per 100 commands |
| `repeatedPatternRecurrenceRate` | % of known-bad patterns that recurred |
| `transportSwitchCompliance` | % of mechanical failures where agent switched transport |

---

## Custom Storage Adapter

```typescript
import type { StorageAdapter, RegistryData } from "agentic-feedback";

class RedisStore implements StorageAdapter {
  async load(): Promise<RegistryData> { /* ... */ }
  async save(data: RegistryData): Promise<void> { /* ... */ }
  async close(): Promise<void> { /* ... */ }
}

const loop = new LearningLoop({ storage: new RedisStore() });
```

---

## Philosophy

> "From 'agents should remember docs' to 'system refuses known-bad moves and injects known-good moves.'"

1. **Executable, not narrative** — structured patterns, not prose
2. **One-strike mechanical failure switching** — ban the same transport class for the session
3. **Auto-promote on recurrence** — 2 failures in 30 days = blocking
4. **Zero supply-chain risk** — no runtime dependencies
5. **Governance problem, not prompt problem** — control the system, not the model

---

## Requirements

- Node.js ≥ 18
- Zero runtime dependencies
