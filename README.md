# agentic-feedback

> Turn repeated agent failures into enforced constraints — automatically, continuously, cross-platform.

**Zero runtime dependencies.** Works out of the box. Stores patterns in `~/.agentic-feedback/`. Advanced config available via TypeScript API.

---

## The Problem

AI agents make the same transport-level mistakes repeatedly — e.g. a PowerShell agent trying to pass a heredoc payload over SSH, timing out for 30 seconds, and repeating the pattern across sessions. Prose documentation doesn't reliably fix this: agents are inconsistent at following instructions.

**The fix is architectural:** make failures executable constraints, not advice.

---

## Integrating with Agents

There are three integration patterns depending on your setup.

---

### Pattern 1 — Claude Code hooks (zero agent-code changes)

The most powerful approach: the agent never needs to call this library explicitly. Hooks intercept every shell command automatically.

Add to `.claude/settings.json` in your repo (or `~/.claude/settings.json` globally):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "command": "node -e \"\nconst input = require('fs').readFileSync('/dev/stdin','utf8');\nconst cmd = JSON.parse(input).command;\nconst {execSync} = require('child_process');\ntry {\n  execSync('agentic-feedback preflight ' + JSON.stringify(cmd), {stdio:'inherit'});\n} catch(e) { process.exit(1); }\n\""
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash",
        "command": "node -e \"\nconst input = require('fs').readFileSync('/dev/stdin','utf8');\nconst {tool_input, tool_response} = JSON.parse(input);\nconst outcome = tool_response.exit_code === 0 ? 'success' : 'mechanical-failure';\nconst trace = JSON.stringify({command: tool_input.command, outcome, duration_ms: 0});\nrequire('child_process').execSync('echo ' + JSON.stringify(trace) + ' | agentic-feedback record');\n\""
      }
    ]
  }
}
```

**How it works:**
- `PreToolUse` fires before every `Bash` tool call — if `agentic-feedback preflight` exits non-zero (blocked), Claude sees the error message and must find an alternative
- `PostToolUse` records every outcome automatically — no agent cooperation needed
- Run `agentic-feedback learn` at the end of a session to promote patterns

For a cleaner setup, extract the hook logic into a script:

```bash
# .claude/hooks/preflight.js
#!/usr/bin/env node
import { createReadStream } from "node:fs";

let raw = "";
process.stdin.on("data", d => raw += d);
process.stdin.on("end", () => {
  const { command } = JSON.parse(raw);
  // Inline the LearningLoop here for speed, or shell out to the CLI
  import("agentic-feedback").then(({ LearningLoop }) => {
    const loop = new LearningLoop();
    loop.preflight(command).then(result => {
      if (!result.allowed) {
        console.error(`BLOCKED: ${result.reason}`);
        console.error(`Use instead: ${result.requiredAlternative}`);
        process.exit(1);
      }
    });
  });
});
```

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "Bash", "command": "node .claude/hooks/preflight.js" }]
  }
}
```

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

Pattern 1 (hooks) can wire this as a `Stop` hook:

```json
{
  "hooks": {
    "Stop": [{ "command": "agentic-feedback learn" }]
  }
}
```

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
