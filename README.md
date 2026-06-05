# agentic-feedback

> Turn repeated agent failures into enforced constraints — automatically, continuously, cross-platform.

---

## What is this?

AI coding assistants like Claude, Cursor, and Copilot make the same mistakes over and over. They'll try a command that doesn't work, get an error, and then try the exact same thing in the next session — because they have no memory of what failed before.

This tool gives them that memory. Every time an AI assistant runs a shell command, agentic-feedback watches what happens. When something fails, it gets recorded. The rules are simple:

- A failure happens **twice within 30 days** → that command is automatically blocked from then on
- A failure **wastes more than 60 seconds** → blocked immediately
- An advisory pattern causes **no problems for 90 days** → it's forgotten

When a command is blocked, the AI is told what to do instead — so it self-corrects without you having to intervene.

Everything it learns stays on your machine.

---

## Philosophy

> "From 'agents should remember docs' to 'system refuses known-bad moves and injects known-good moves.'"

1. **Executable, not narrative** — structured patterns, not prose
2. **Auto-promote on recurrence** — 2 failures in 30 days = blocking
3. **Zero supply-chain risk** — no runtime dependencies
4. **Governance problem, not prompt problem** — control the system, not the model

---

## Getting Started

```bash
git clone https://github.com/bradjshannon/agentic-shell-feedback-bs.git
cd agentic-shell-feedback-bs
./start.sh
```

This sets everything up and opens an interactive menu where you can configure which AI assistants to monitor and adjust any settings. On Windows, run the equivalent manually:

```powershell
npm install
npm run build
npm link
npm start
```

After the first run, open the menu from any project directory with:

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

## Pattern Privacy and Sharing

Learned patterns stay on the local machine — they are never uploaded or shared by default. Each person who sets up agentic-feedback starts with a fresh, empty history and builds their own over time.

To share patterns between machines manually:

```bash
# Export
agentic-feedback export > my-patterns.json

# Import on another machine (deduplicates — safe to run multiple times)
agentic-feedback import < my-patterns.json
```

Both operations are also available in the TUI under **Export Patterns** and **Import Patterns**.

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
                   advisory → expired when not seen in 90 days
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

To use a shared network store:

```typescript
const loop = new LearningLoop({ storageDir: "/shared/nfs/agentic-feedback" });
```

Or implement a custom `StorageAdapter` for Redis, S3, etc.
