# Agentic Learning Loop — Design Plan

> Durable cross-agent learning: turning repeated failures into enforced constraints.

## Problem Statement

AI agents repeatedly make the same transport-level mistakes (e.g., PowerShell + SSH + heredoc
multiline payloads timing out) because learning lives in prose documentation that models ignore
inconsistently. The fix is architectural: make failures executable constraints, not advice.

## Design Principles

1. **Learning must be executable, not narrative** — store structured patterns, inject decisions.
2. **Zero-config out of the box** — JSON file storage, sensible defaults, no setup required.
3. **Advanced config available** — pluggable storage, custom policy rules, custom gates.
4. **Cross-platform** — Node.js 18+, no native binaries, no platform-specific paths assumed.
5. **Zero runtime dependencies** — no supply-chain risk, no install friction.
6. **TDD throughout** — tests define contract; implementation fulfills it.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    LearningLoop (orchestrator)           │
│                                                         │
│  preflight(cmd, ctx)  →  record(trace)  →  learn()     │
└───────┬──────────────────────┬──────────────────────────┘
        │                      │
   ┌────▼────────┐    ┌────────▼────────────────────────┐
   │ PreflightGate│    │       FailureRegistry            │
   │             │    │  record / findMatching / expire  │
   │ CommandAna- │    └────────┬────────────────────────┘
   │ lyzer       │             │
   │ BuiltInRules│    ┌────────▼────────────────────────┐
   └─────────────┘    │       PolicyEngine               │
                      │  evaluate / promote / expire     │
   ┌─────────────┐    └────────┬────────────────────────┘
   │ TransportBro│             │
   │ ker         │    ┌────────▼────────────────────────┐
   │ inline/stdin│    │       StorageAdapter             │
   │ /file       │    │  JsonStore (default) / Memory   │
   └─────────────┘    └─────────────────────────────────┘
```

## Module Breakdown

### `types.ts`
All shared interfaces. No runtime code — pure type definitions.

Key types:
- `FailurePattern` — stored learning unit: signature, environment, failed/successful approaches,
  confidence, status (advisory | blocking | expired), occurrence counts, wasted time.
- `CommandContext` — runtime snapshot: shell type, target type, OS, multiline flag, heredoc flag,
  transport class, raw command.
- `ExecutionTrace` — what actually happened: outcome, duration, alternatives tried.
- `PreflightResult` — gate decision: allowed, matched pattern, required alternative.
- `LearningLoopConfig` — full config with defaults.

### `storage/` — Storage Abstraction

**`StorageAdapter` interface**: `load()`, `save(data)`, `close()`.

**`MemoryStore`** (default for testing): in-process Map, no I/O.

**`JsonStore`** (default for production): atomic writes to `~/.agentic-feedback/registry.json`.
- Uses write-then-rename for atomicity on all platforms.
- Auto-creates directory on first write.
- Gracefully handles corrupt/missing files.

### `registry/` — Failure Registry

**`PatternMatcher`**: computes a deterministic `signature` string from a `CommandContext` by
normalizing: shell, target, multiline flag, heredoc flag, transport class, and a **command
fingerprint** (the command reduced to a stable skeleton — see `CommandFingerprint`). The
fingerprint is the dominant axis: a pattern for a *different* command is never surfaced, and a
match only scores 1.0 (the bar for hard-blocking) on an exact signature. Same command, slightly
different shape scores below 1.0 and can only raise an advisory warning.

**`CommandFingerprint`**: `computeCommandFingerprint(cmd)` replaces volatile parts of a command
(heredoc/here-string bodies, quoted strings, paths, `user@host` targets, URLs, numbers) with
placeholders, leaving the command/sub-command words intact. Stable across runs of the same
command, distinct across different commands.

**`FailureRegistry`**: CRUD over `FailurePattern[]` with deduplication.
- `record(trace)` — upsert: find matching pattern by signature, increment occurrence, update
  confidence and lastSeen; or create new advisory pattern.
- `findMatching(context)` — return patterns ranked by confidence; include both exact and
  fuzzy matches above threshold.
- `promote(id)` — advisory → blocking.
- `expire(id)` — blocking/advisory → expired.
- `prune()` — remove expired patterns older than 180 days.

### `gates/` — Preflight Gate

**`CommandAnalyzer`**: stateless parser that extracts a `CommandContext` from a raw command string.
Detects: shell hint (shebang, env var), SSH invocation patterns, heredoc syntax (POSIX and
PowerShell here-strings), multiline indicators, quote complexity.

**`BuiltInRules`**: default rule set, always active:
```
POWERSHELL_SSH_HEREDOC  — shell=powershell + target=remote-ssh + (multiline | heredoc) → DENY
COMPLEX_INLINE_SSH      — target=remote-ssh + length > 300 chars → WARN (blocking if matched pattern)
NESTED_QUOTE_SSH        — target=remote-ssh + deeply nested quotes → WARN
REPEATED_TIMEOUT_SHAPE  — same command shape that timed out previously → DENY
```

**`PreflightGate`**: takes registry + config. `check(context)` returns `PreflightResult`.
- First checks built-in rules (always enforced).
- Then checks dynamic rules from registry (only enforced when status=blocking).
- Merges results, returns first denial or aggregate warnings.

### `policy/` — Policy Engine

**`PromotionRules`**: pure functions over `FailurePattern`:
- `shouldPromote(pattern, now)`: advisory **and** has a known alternative, **and**
  (`occurrences >= 2 AND daysSinceFirst <= 30` OR `wasted_ms >= 60_000`) → promote to blocking.
  The known-alternative requirement is the core "light touch" guard: without a fix to suggest a
  pattern stays advisory (warn-only) and never prevents a command from running.
- `shouldExpire(pattern, now)`: `status == advisory AND daysSinceLastSeen >= 90` → expire.
  (Blocking patterns never auto-expire.)

**`PolicyEngine`**: iterates all patterns, applies rules, mutates status, persists via registry.

### `broker/` — Transport Broker

Abstracts "execute this payload on this target" into a safe, transport-aware operation.

**Strategies**:
- `InlineStrategy`: short commands (≤ 200 chars, no newlines, simple quoting).
- `StdinStrategy`: pipe payload via stdin (`echo '...' | ssh host bash`).
- `FileStrategy`: write to temp file, transfer (scp/sftp), execute, cleanup.

**`TransportBroker`**: `selectStrategy(context, payload)` → strategy name + invocation template.
Does not execute — returns the safe command string for the agent to use.

### `eval/` — Eval Runner

**`Metrics`**: pure functions computing:
- `firstAttemptSuccessRate(traces)`: % of traces where first attempt succeeded.
- `repeatedPatternRecurrence(patterns)`: patterns seen > once / total.
- `timeoutMinutesPer100(traces)`: total timeout duration / traces * 100.
- `transportSwitchCompliance(traces)`: how often agent switched after mechanical failure.

**`EvalRunner`**: runs a set of `ExecutionTrace[]` through the current gate/policy config and
reports whether candidate changes reduce failures vs. baseline.

### `LearningLoop.ts` — Orchestrator

Primary public API. Constructed with optional `LearningLoopConfig`. Wires all modules.

```typescript
const loop = new LearningLoop();                          // zero config
const loop = new LearningLoop({ storage: customStore });  // advanced

// Before executing a command:
const result = await loop.preflight(command, { shell: 'powershell', target: 'remote-ssh' });
if (!result.allowed) useAlternative(result.requiredAlternative);

// After execution:
await loop.record({ command, outcome: 'timeout', duration_ms: 30000, context });

// Periodically (or after each session):
await loop.learn();  // runs policy engine, promotes patterns
```

### `cli/index.ts` — CLI

```
Usage: agentic-feedback <command> [options]

Commands:
  preflight <cmd>     Check command against known-bad patterns
  record              Record an execution trace (JSON from stdin or flags)
  learn               Run policy engine on stored patterns
  report              Print registry summary and metrics
  export              Export registry as JSON
  import <file>       Import patterns from JSON file
```

## Data Model (JSON Storage Schema)

```json
{
  "version": 1,
  "patterns": [
    {
      "id": "uuid",
      "signature": "powershell:remote-ssh:multiline:heredoc:heredoc:ssh HOST <<HEREDOC",
      "environmentFingerprint": "windows:powershell:ssh",
      "failedApproach": "inline heredoc via SSH",
      "successfulAlternative": "stdin piping",
      "confidence": 0.9,
      "status": "blocking",
      "occurrences": 3,
      "firstSeen": "2026-01-01T00:00:00Z",
      "lastSeen": "2026-05-01T00:00:00Z",
      "wasted_ms": 90000
    }
  ],
  "traces": [
    {
      "id": "uuid",
      "command": "...",
      "context": { "shell": "powershell", "target": "remote-ssh", ... },
      "outcome": "timeout",
      "duration_ms": 30000,
      "timestamp": "2026-05-01T00:00:00Z"
    }
  ]
}
```

## Configuration Reference

```typescript
interface LearningLoopConfig {
  // Storage
  storage?: StorageAdapter;           // default: JsonStore at ~/.agentic-feedback/
  storageDir?: string;                // override default storage directory
  maxTraces?: number;                 // max traces to keep (default: 1000)
  maxPatterns?: number;               // max patterns to keep (default: 500)

  // Policy thresholds
  promotionOccurrences?: number;      // default: 2
  promotionWindowDays?: number;       // default: 30
  promotionWastedMs?: number;         // default: 60_000
  expirationDays?: number;            // default: 90

  // Gate behavior
  enableBuiltInRules?: boolean;       // default: true
  customRules?: GateRule[];           // additional rules
  minMatchScore?: number;             // min similarity to raise an advisory warning
                                      // (default: 0.7). Hard blocking always
                                      // requires an exact signature match.

  // Eval
  replayWindowDays?: number;          // traces to include in eval (default: 30)
}
```

## TDD Test Plan

### Unit Tests

| Module | Tests |
|--------|-------|
| `MemoryStore` | load empty, save/load roundtrip, concurrent saves |
| `JsonStore` | creates dir, atomic write, corrupt file recovery |
| `PatternMatcher` | signature for each shell/target combo, fuzzy score |
| `FailureRegistry` | record new, record duplicate (upsert), findMatching exact, findMatching fuzzy, promote, expire, prune |
| `CommandAnalyzer` | detect powershell, detect SSH, detect heredoc, detect multiline, detect complex quotes |
| `BuiltInRules` | POWERSHELL_SSH_HEREDOC fires, COMPLEX_INLINE_SSH fires at threshold, clean command passes |
| `PreflightGate` | allows clean, blocks built-in match, blocks registry match (blocking), warns advisory |
| `PromotionRules` | promotes at threshold occurrences, promotes on wasted time, no promote under threshold, expires after window |
| `PolicyEngine` | promotes matching, expires stale, skips already-blocking, persists changes |
| `TransportBroker` | selects inline for simple, stdin for medium, file for complex/multiline |
| `EvalRunner` | computes metrics correctly, detects regression |
| `LearningLoop` | full preflight→record→learn cycle (integration-level unit test) |

### Integration Tests

- Full session: powershell + SSH + heredoc → timeout → record → learn → preflight blocks next attempt
- Cross-platform path handling (mock OS detection)
- Config override: custom storage, custom thresholds
- CLI smoke tests

## Implementation Phases

### Phase 1 — Foundation (types, storage, registry)
Tests: MemoryStore, JsonStore, PatternMatcher, FailureRegistry

### Phase 2 — Intelligence (gates, policy)
Tests: CommandAnalyzer, BuiltInRules, PreflightGate, PromotionRules, PolicyEngine

### Phase 3 — Broker + Eval
Tests: TransportBroker, Metrics, EvalRunner

### Phase 4 — Orchestration + CLI
Tests: LearningLoop (integration), CLI smoke tests

### Phase 5 — Polish
- README, JSDoc, examples
- Performance: index patterns by signature for O(1) lookup
- Export/import for sharing patterns across teams
