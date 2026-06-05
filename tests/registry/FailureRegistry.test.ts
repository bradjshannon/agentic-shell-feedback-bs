import { FailureRegistry } from "../../src/registry/FailureRegistry.js";
import { MemoryStore } from "../../src/storage/MemoryStore.js";
import type { CommandContext, ExecutionTrace } from "../../src/types.js";

function makeContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    command: "ssh user@host << EOF\necho hi\nEOF",
    shell: "powershell",
    target: "remote-ssh",
    os: "windows",
    isMultiline: true,
    hasHeredoc: true,
    hasComplexQuoting: false,
    transportClass: "heredoc",
    payloadLength: 40,
    ...overrides,
  };
}

function makeTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    id: "trace-1",
    command: "ssh user@host << EOF\necho hi\nEOF",
    context: makeContext(),
    outcome: "timeout",
    duration_ms: 30000,
    timestamp: "2026-06-01T10:00:00Z",
    ...overrides,
  };
}

describe("FailureRegistry", () => {
  it("records a new failure pattern on timeout", async () => {
    const store = new MemoryStore();
    const registry = new FailureRegistry(store);
    await registry.record(makeTrace());

    const data = await store.load();
    expect(data.patterns).toHaveLength(1);
    expect(data.patterns[0]?.status).toBe("advisory");
    expect(data.patterns[0]?.occurrences).toBe(1);
    expect(data.patterns[0]?.confidence).toBeCloseTo(0.5);
  });

  it("does not create a pattern for successful traces", async () => {
    const store = new MemoryStore();
    const registry = new FailureRegistry(store);
    await registry.record(makeTrace({ outcome: "success" }));

    const data = await store.load();
    expect(data.patterns).toHaveLength(0);
  });

  it("upserts existing pattern on duplicate signature", async () => {
    const store = new MemoryStore();
    const registry = new FailureRegistry(store);
    await registry.record(makeTrace());
    await registry.record(makeTrace({ id: "trace-2", timestamp: "2026-06-02T10:00:00Z" }));

    const data = await store.load();
    expect(data.patterns).toHaveLength(1);
    expect(data.patterns[0]?.occurrences).toBe(2);
    expect(data.patterns[0]?.confidence).toBeGreaterThan(0.5);
  });

  it("accumulates wasted_ms for timeouts", async () => {
    const store = new MemoryStore();
    const registry = new FailureRegistry(store);
    await registry.record(makeTrace({ duration_ms: 30000 }));
    await registry.record(makeTrace({ id: "t2", duration_ms: 20000, timestamp: "2026-06-02T00:00:00Z" }));

    const data = await store.load();
    expect(data.patterns[0]?.wasted_ms).toBe(50000);
  });

  it("does not accumulate wasted_ms for non-timeout failures", async () => {
    const store = new MemoryStore();
    const registry = new FailureRegistry(store);
    await registry.record(makeTrace({ outcome: "mechanical-failure", duration_ms: 1000 }));

    const data = await store.load();
    expect(data.patterns[0]?.wasted_ms).toBe(0);
  });

  it("updates successfulAlternative when provided", async () => {
    const store = new MemoryStore();
    const registry = new FailureRegistry(store);
    await registry.record(makeTrace());
    await registry.record(
      makeTrace({ id: "t2", timestamp: "2026-06-02T00:00:00Z", alternativeUsed: "stdin piping" }),
    );

    const data = await store.load();
    expect(data.patterns[0]?.successfulAlternative).toBe("stdin piping");
  });

  it("records trace regardless of outcome", async () => {
    const store = new MemoryStore();
    const registry = new FailureRegistry(store);
    await registry.record(makeTrace({ outcome: "success" }));
    await registry.record(makeTrace({ id: "t2", outcome: "timeout" }));

    const data = await store.load();
    expect(data.traces).toHaveLength(2);
  });

  it("findMatching returns exact match", async () => {
    const store = new MemoryStore();
    const registry = new FailureRegistry(store);
    await registry.record(makeTrace());

    const matches = await registry.findMatching(makeContext());
    expect(matches).toHaveLength(1);
    expect(matches[0]?.score).toBe(1.0);
  });

  it("findMatching returns empty when no match", async () => {
    const store = new MemoryStore();
    const registry = new FailureRegistry(store);
    // Record a Windows/PowerShell pattern
    await registry.record(makeTrace());

    // Query with completely different context
    const matches = await registry.findMatching(
      makeContext({ shell: "bash", target: "local", isMultiline: false, hasHeredoc: false }),
      0.9,
    );
    expect(matches).toHaveLength(0);
  });

  it("promote changes status to blocking", async () => {
    const store = new MemoryStore();
    const registry = new FailureRegistry(store);
    await registry.record(makeTrace());

    const data = await store.load();
    const id = data.patterns[0]!.id;
    const success = await registry.promote(id);

    expect(success).toBe(true);
    const updated = await store.load();
    expect(updated.patterns[0]?.status).toBe("blocking");
  });

  it("promote returns false for unknown id", async () => {
    const store = new MemoryStore();
    const registry = new FailureRegistry(store);
    expect(await registry.promote("nonexistent")).toBe(false);
  });

  it("expire changes status to expired", async () => {
    const store = new MemoryStore();
    const registry = new FailureRegistry(store);
    await registry.record(makeTrace());
    const data = await store.load();
    const id = data.patterns[0]!.id;

    await registry.expire(id);
    const updated = await store.load();
    expect(updated.patterns[0]?.status).toBe("expired");
  });

  it("prune removes old expired patterns", async () => {
    const store = new MemoryStore();
    const registry = new FailureRegistry(store);
    await registry.record(makeTrace());
    const data = await store.load();
    const id = data.patterns[0]!.id;
    await registry.expire(id);

    // Force lastSeen to be very old
    const stale = await store.load();
    stale.patterns[0]!.lastSeen = "2020-01-01T00:00:00Z";
    await store.save(stale);

    const removed = await registry.prune(180);
    expect(removed).toBe(1);
    const final = await store.load();
    expect(final.patterns).toHaveLength(0);
  });

  it("prune keeps expired patterns within window", async () => {
    const store = new MemoryStore();
    const registry = new FailureRegistry(store);
    await registry.record(makeTrace());
    const data = await store.load();
    const id = data.patterns[0]!.id;
    await registry.expire(id);

    const removed = await registry.prune(180);
    expect(removed).toBe(0);
  });
});
