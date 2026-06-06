/**
 * Integration test: the full preflight → record → learn → re-preflight cycle.
 * Simulates a PowerShell agent making the classic SSH+heredoc mistake, learning
 * from it, and having the next attempt blocked.
 */
import { LearningLoop } from "../../src/LearningLoop.js";
import { MemoryStore } from "../../src/storage/MemoryStore.js";

describe("Full learning loop integration", () => {
  it("blocks after learning from PowerShell + SSH + heredoc timeout", async () => {
    const store = new MemoryStore();
    const loop = new LearningLoop({
      storage: store,
      promotionOccurrences: 2,
      promotionWindowDays: 30,
    });

    const problematicCommand = "ssh user@prod << 'EOF'\necho 'deploying'\nEOF";
    const hints = { shell: "powershell" as const, target: "remote-ssh" as const, os: "windows" as const };

    // First attempt: blocked by built-in rule (no learning needed — built-ins fire immediately)
    const firstPreflight = await loop.preflight(problematicCommand, hints);
    expect(firstPreflight.allowed).toBe(false);
    expect(firstPreflight.requiredAlternative).toBeTruthy();

    // Agent ignores gate (shouldn't, but demonstrates recording still works)
    await loop.record({
      command: problematicCommand,
      context: loop.analyze(problematicCommand, hints),
      outcome: "timeout",
      duration_ms: 30_000,
    });

    // Second failure recorded
    await loop.record({
      command: problematicCommand,
      context: loop.analyze(problematicCommand, hints),
      outcome: "timeout",
      duration_ms: 31_000,
      timestamp: new Date(Date.now() + 1000).toISOString(),
    });

    // Agent discovers the working alternative — recorded so the system has a
    // concrete fix to suggest. (A pattern is only promoted to blocking when it
    // can tell the agent what to do instead.)
    await loop.record({
      command: problematicCommand,
      context: loop.analyze(problematicCommand, hints),
      outcome: "success",
      duration_ms: 1_000,
      alternativeUsed: "stdin piping: echo 'script' | ssh user@host bash",
      timestamp: new Date(Date.now() + 2000).toISOString(),
    });

    // Run policy engine
    const learned = await loop.learn();
    expect(learned.promoted).toBeGreaterThanOrEqual(1);

    // Pattern is now blocking in registry
    const data = await store.load();
    const blockingPatterns = data.patterns.filter((p) => p.status === "blocking");
    expect(blockingPatterns.length).toBeGreaterThan(0);

    // Next attempt should be blocked by registry
    const thirdPreflight = await loop.preflight(problematicCommand, hints);
    expect(thirdPreflight.allowed).toBe(false);

    await loop.close();
  });

  it("safeExec returns recommendation when blocked", async () => {
    const loop = new LearningLoop({ storage: new MemoryStore() });
    const cmd = "ssh user@host << 'EOF'\nmultiline\nEOF";
    const result = await loop.safeExec(cmd, {
      shell: "powershell",
      target: "remote-ssh",
    });

    expect(result.preflight.allowed).toBe(false);
    expect(result.recommendation).toBeDefined();
    expect(result.recommendation?.strategy).toBe("file");
    await loop.close();
  });

  it("allows clean commands and skips recommendation", async () => {
    const loop = new LearningLoop({ storage: new MemoryStore() });
    const cmd = "ssh user@host uptime";
    const result = await loop.safeExec(cmd, { shell: "bash", target: "remote-ssh" });
    expect(result.preflight.allowed).toBe(true);
    expect(result.recommendation).toBeUndefined();
    await loop.close();
  });

  it("does not promote on wasted time alone — recurrence is the only trigger", async () => {
    const store = new MemoryStore();
    const loop = new LearningLoop({
      storage: store,
      promotionOccurrences: 10, // high — won't fire by count
    });

    const cmd = "ssh host << 'HEREDOC'\nscript\nHEREDOC";
    const ctx = loop.analyze(cmd, { shell: "bash", target: "remote-ssh" });

    // Two large timeouts (lots of wasted time) plus a known alternative — but
    // still under the occurrence threshold. Wasted time must not promote it.
    await loop.record({ command: cmd, context: ctx, outcome: "timeout", duration_ms: 300_000 });
    await loop.record({ command: cmd, context: ctx, outcome: "timeout", duration_ms: 300_000, timestamp: new Date(Date.now() + 1000).toISOString() });
    await loop.record({ command: cmd, context: ctx, outcome: "success", duration_ms: 1_000, alternativeUsed: "stdin piping", timestamp: new Date(Date.now() + 2000).toISOString() });

    const result = await loop.learn();
    expect(result.promoted).toBe(0);
    await loop.close();
  });

  it("broker recommends stdin for medium complexity SSH", () => {
    const loop = new LearningLoop({ storage: new MemoryStore() });
    const cmd = "ssh user@host bash";
    // Payload > 200 chars, no complex quoting → stdin strategy
    const payload = "echo step1 && sleep 1 && echo step2 && " + "df -h && uptime && ".repeat(12);
    const rec = loop.recommend(cmd, payload, { shell: "bash", target: "remote-ssh" });
    expect(rec.strategy).toBe("stdin");
  });

  it("cross-platform: config overrides work without touching filesystem", async () => {
    const store = new MemoryStore();
    const loop = new LearningLoop({
      storage: store,
      enableBuiltInRules: false, // disable built-ins
      customRules: [
        {
          id: "BLOCK_ALL_SSH",
          description: "Block everything SSH",
          match: (ctx) => ctx.target === "remote-ssh",
          verdict: "deny",
          reason: "SSH is banned in this config",
        },
      ],
    });

    const result = await loop.preflight("ssh host uptime", { target: "remote-ssh" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("SSH is banned");
    await loop.close();
  });
});
