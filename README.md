# agentic-feedback

> Turn repeated agent failures into enforced constraints — automatically, continuously, cross-platform.

**Zero runtime dependencies.** Patterns stored in `~/.agentic-feedback/` — private by default, never committed.

---

## The Problem

AI agents make the same transport-level mistakes repeatedly — e.g. a PowerShell agent trying to pass a heredoc payload over SSH, timing out for 30 seconds, and repeating the pattern across sessions. Prose instructions don't reliably fix this: agents are inconsistent at following instructions.

**The fix is architectural:** make failures executable constraints, not advice.

---

## Getting Started

```bash
git clone https://github.com/bradjshannon/agentic-shell-feedback-bs.git
cd agentic-shell-feedback-bs
./start.sh
```

`start.sh` installs dependencies, builds, links `agentic-feedback` globally on your PATH, and launches the TUI. On Windows, run the equivalent manually:

```powershell
npm install
npm run build
npm link
npm start
```

After the first run, launch the TUI from any project directory with:

```bash
agentic-feedback
```

---

## The TUI

Everything is configured at runtime in the interactive terminal UI. Use arrow keys to navigate, Tab to switch panels, Space to toggle flags, Enter to run.

| Screen | What it does |
|--------|-------------|
| **Install Hooks** | Wire preflight + recording hooks into your agent's config. Choose agent, flags, and run. |
| **Check Command** | Test a shell command against the preflight gate. See if it would be blocked and why. |
| **View Report** | Summary of learned patterns and metrics for the last 30 days. |
| **Run Learn** | Promote advisory patterns to blocking based on failure history. |
| **Export Patterns** | Save the registry to a JSON file (or stdout). |
| **Import Patterns** | Merge patterns from a JSON file into the registry. |

---

> **Note — ephemeral containers:** if you select `--remote --push` in the TUI (for cloud runners or GitHub Actions where the repo is cloned fresh each session), commit a seed file once so the first import has something to read:
>
> ```bash
> mkdir -p .agentic-feedback
> echo '{"version":1,"patterns":[],"traces":[]}' > .agentic-feedback/patterns.json
> git add .agentic-feedback/patterns.json
> git commit -m "chore: seed agentic-feedback pattern registry"
> ```

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

## TypeScript API

For agents built with the Claude API or another framework, call the library directly:

```typescript
import { LearningLoop } from "agentic-feedback";

const loop = new LearningLoop(); // zero config — stores at ~/.agentic-feedback/

// Before executing a command:
const result = await loop.preflight(
  "ssh user@host << 'EOF'\necho hi\nEOF",
  { shell: "powershell", target: "remote-ssh" }
);

if (!result.allowed) {
  // Return the reason to the model so it can self-correct
  return { error: `Blocked: ${result.reason}`, alternative: result.requiredAlternative };
}

// After execution:
await loop.record({
  command,
  context: loop.analyze(command, hints),
  outcome: "timeout",          // "success" | "timeout" | "mechanical-failure" | "semantic-failure"
  duration_ms: 30_000,
});

// At end of session:
await loop.learn();
await loop.close();
```

**Advanced configuration:**

```typescript
const loop = new LearningLoop({
  storageDir: "/path/to/custom/dir",
  promotionOccurrences: 2,       // failures before blocking (default: 2)
  promotionWindowDays: 30,        // window for counting failures (default: 30)
  promotionWastedMs: 60_000,      // wasted time threshold (default: 60s)
  expirationDays: 90,             // days inactive before expiry (default: 90)
  enableBuiltInRules: false,      // disable built-in rules
  customRules: [ /* ... */ ],
});
```

---

## Pattern Privacy and Sharing

Patterns live in `~/.agentic-feedback/` — they never enter the repo by default. Each user who clones your repo starts with a fresh, empty registry and builds their own patterns independently.

To share patterns across machines manually:

```bash
# Export
agentic-feedback export > my-patterns.json

# Import on another machine (deduplicates — safe to run multiple times)
agentic-feedback import < my-patterns.json
```

Both operations are also available in the TUI under **Export Patterns** and **Import Patterns**.

To use a shared network store:

```typescript
const loop = new LearningLoop({ storageDir: "/shared/nfs/agentic-feedback" });
```

Or implement a custom `StorageAdapter` for Redis, S3, etc.

---

## Philosophy

> "From 'agents should remember docs' to 'system refuses known-bad moves and injects known-good moves.'"

1. **Executable, not narrative** — structured patterns, not prose
2. **Auto-promote on recurrence** — 2 failures in 30 days = blocking
3. **Zero supply-chain risk** — no runtime dependencies
4. **Governance problem, not prompt problem** — control the system, not the model
