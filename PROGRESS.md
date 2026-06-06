# Implementation Progress

## Status Legend
- [ ] Not started
- [~] In progress
- [x] Complete (tests passing)

---

## Phase 1 — Foundation

- [x] `package.json` + `tsconfig.json` + `jest.config.js`
- [x] `src/types.ts` — all core interfaces
- [x] `src/config.ts` — config loading with defaults
- [x] `src/storage/MemoryStore.ts` + tests
- [x] `src/storage/JsonStore.ts` + tests
- [x] `src/registry/PatternMatcher.ts` + tests
- [x] `src/registry/FailureRegistry.ts` + tests

## Phase 2 — Intelligence

- [x] `src/gates/CommandAnalyzer.ts` + tests
- [x] `src/gates/BuiltInRules.ts` + tests
- [x] `src/gates/PreflightGate.ts` + tests
- [x] `src/policy/PromotionRules.ts` + tests
- [x] `src/policy/PolicyEngine.ts` + tests

## Phase 3 — Broker + Eval

- [x] `src/broker/TransportBroker.ts` + tests
- [x] `src/eval/Metrics.ts` + tests
- [x] `src/eval/EvalRunner.ts` + tests

## Phase 4 — Orchestration + CLI

- [x] `src/LearningLoop.ts` + integration tests
- [x] `src/cli/index.ts` + smoke tests

## Phase 5 — Polish

- [x] `README.md`
- [x] Team export/import (CLI + TUI, dedup by signature)
- [x] Interactive TUI + multi-agent installer
- [ ] Performance: pattern index (still a linear scan in `PatternMatcher`;
      fine at `maxPatterns` ≤ 500, revisit if that grows)
- [ ] JSDoc completion

---

## Test Run History

| Run | Date | Pass | Fail | Notes |
|-----|------|------|------|-------|
| 1   | 2026-06-04 | 0 | 0 | Initial scaffold |
| 2   | 2026-06-04 | 78 | 0 | Full suite green |
| 3   | 2026-06-06 | 223 | 0 | Adds gate/policy/broker/eval/installer/TUI suites |
| 4   | 2026-06-06 | 243 | 0 | Command fingerprint + light-touch blocking |
| 5   | 2026-06-06 | 241 | 0 | Drop wasted-time promotion (recurrence-only) |

---

## Key Decisions Made

1. **Zero runtime deps** — pure Node.js 18+ built-ins only. No `uuid` (use `crypto.randomUUID`),
   no `zod` (TypeScript types + runtime guards), no commander (hand-rolled arg parsing).
2. **JSON storage default** — atomic write-then-rename for cross-platform safety. SQLite is a
   future optional plugin, not a dependency.
3. **Signature format** — `{shell}:{target}:{multiline}:{heredoc}:{transportClass}:{commandFingerprint}`.
   The command fingerprint (see `CommandFingerprint.ts`) normalizes volatile parts of the command
   so a learned pattern is specific to the command that misbehaved, not every command of the same
   transport shape — which was a false-positive blocking risk. Lookup is currently a linear scan
   (fine at `maxPatterns` ≤ 500).
7. **Light-touch blocking** — the learned layer warns generously but blocks rarely:
   - Only **mechanical** failures (not-found/not-executable/timeout) are learnable; a plain
     non-zero exit (`semantic-failure`) is recorded but never seeds a pattern, so deliberately
     failing a command while developing can't get it blocked.
   - Promotion trigger is **recurrence only** (≥ 2 mechanical failures in 30 days). Wasted-time
     promotion was dropped — command duration can't be measured reliably via agent hooks.
   - A pattern is promoted to **blocking only when a known alternative exists** to suggest;
     otherwise it stays advisory (warn-only).
   - The gate **hard-blocks only on an exact signature match**; fuzzier matches warn.
   - Hooks classify exit codes (124/137/143→timeout, 126/127→mechanical, else→semantic).
   - `wasted_ms` is still tracked/displayed as a passive metric (correct when duration is known
     via the API or generic wrapper), it just no longer drives promotion.
8. **`minMatchScore`** replaces the misleadingly-named `blockOnConfidence`: it is the minimum
   similarity score for surfacing an advisory warning, not a confidence gate on blocking.
4. **Confidence model** — starts at 0.5 on first record, converges toward 1.0 as occurrences grow
   (formula: `1 - 1/(occurrences + 1)`). Caps at 0.95.
5. **Gate is synchronous** — preflight must be fast (< 1ms); storage I/O happens at `record` and
   `learn` time, not in the hot path.
6. **Broker does not execute** — returns a safe command template; the caller (agent) decides whether
   to run it. This keeps the library side-effect-free outside of storage.
