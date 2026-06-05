# agentic-feedback

> Turn repeated agent failures into enforced constraints — automatically, continuously, cross-platform.

**Zero runtime dependencies.** Works out of the box. Stores patterns in `~/.agentic-feedback/`. Advanced config available via TypeScript API.

---

## The Problem

AI agents make the same transport-level mistakes repeatedly — e.g. a PowerShell agent trying to pass a heredoc payload over SSH, timing out for 30 seconds, and repeating the pattern across sessions. Prose documentation doesn't reliably fix this: agents are inconsistent at following instructions.

**The fix is architectural:** make failures executable constraints, not advice.

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
