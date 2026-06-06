import { PolicyEngine } from "../../src/policy/PolicyEngine.js";
import { MemoryStore } from "../../src/storage/MemoryStore.js";
import type { FailurePattern, RegistryData } from "../../src/types.js";
import { DEFAULT_THRESHOLDS } from "../../src/policy/PromotionRules.js";

function nowMinus(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function makePattern(overrides: Partial<FailurePattern> = {}): FailurePattern {
  return {
    id: `p-${Math.random().toString(36).slice(2)}`,
    signature: "bash:remote-ssh:single:noheredoc:inline",
    environmentFingerprint: "linux:bash:remote-ssh",
    failedApproach: "inline",
    successfulAlternative: "stdin",
    confidence: 0.75,
    status: "advisory",
    occurrences: 1,
    firstSeen: nowMinus(5),
    lastSeen: nowMinus(1),
    wasted_ms: 0,
    ...overrides,
  };
}

function storeWithPatterns(patterns: FailurePattern[]): MemoryStore {
  const data: RegistryData = { version: 1, patterns, traces: [] };
  return new MemoryStore(data);
}

describe("PolicyEngine", () => {
  describe("promote", () => {
    it("promotes advisory patterns meeting occurrence threshold", async () => {
      const store = storeWithPatterns([makePattern({ occurrences: 2 })]);
      const engine = new PolicyEngine(store);
      const result = await engine.evaluate();
      expect(result.promoted).toHaveLength(1);
      const data = await store.load();
      expect(data.patterns[0]?.status).toBe("blocking");
    });

    it("does not promote patterns below threshold", async () => {
      const store = storeWithPatterns([makePattern({ occurrences: 1, wasted_ms: 0 })]);
      const engine = new PolicyEngine(store);
      const result = await engine.evaluate();
      expect(result.promoted).toHaveLength(0);
    });

    it("does not promote already-blocking patterns", async () => {
      const store = storeWithPatterns([makePattern({ status: "blocking", occurrences: 5 })]);
      const engine = new PolicyEngine(store);
      const result = await engine.evaluate();
      expect(result.promoted).toHaveLength(0);
    });
  });

  describe("expire", () => {
    it("expires patterns not seen within expiration window", async () => {
      const store = storeWithPatterns([
        makePattern({ lastSeen: nowMinus(100), firstSeen: nowMinus(100) }),
      ]);
      const engine = new PolicyEngine(store);
      const result = await engine.evaluate();
      expect(result.expired).toHaveLength(1);
      const data = await store.load();
      expect(data.patterns[0]?.status).toBe("expired");
    });

    it("does not expire recently-seen patterns", async () => {
      const store = storeWithPatterns([makePattern({ lastSeen: nowMinus(1) })]);
      const engine = new PolicyEngine(store);
      const result = await engine.evaluate();
      expect(result.expired).toHaveLength(0);
    });

    it("expiration takes priority over promotion", async () => {
      // Pattern is both promotable (occurrences) AND should expire (stale)
      const store = storeWithPatterns([
        makePattern({ occurrences: 2, lastSeen: nowMinus(100), firstSeen: nowMinus(100) }),
      ]);
      const engine = new PolicyEngine(store);
      const result = await engine.evaluate();
      expect(result.expired).toHaveLength(1);
      expect(result.promoted).toHaveLength(0);
    });
  });

  describe("forcePromote", () => {
    it("promotes advisory pattern by ID", async () => {
      const p = makePattern({ id: "fixed-id" });
      const store = storeWithPatterns([p]);
      const engine = new PolicyEngine(store);
      const ok = await engine.forcePromote("fixed-id");
      expect(ok).toBe(true);
      const data = await store.load();
      expect(data.patterns[0]?.status).toBe("blocking");
    });

    it("returns false for nonexistent ID", async () => {
      const store = storeWithPatterns([]);
      const engine = new PolicyEngine(store);
      expect(await engine.forcePromote("nope")).toBe(false);
    });

    it("returns false if already blocking", async () => {
      const p = makePattern({ id: "b", status: "blocking" });
      const store = storeWithPatterns([p]);
      const engine = new PolicyEngine(store);
      expect(await engine.forcePromote("b")).toBe(false);
    });
  });

  describe("downgrade", () => {
    it("downgrades blocking pattern to advisory", async () => {
      const p = makePattern({ id: "b", status: "blocking" });
      const store = storeWithPatterns([p]);
      const engine = new PolicyEngine(store);
      const ok = await engine.downgrade("b");
      expect(ok).toBe(true);
      const data = await store.load();
      expect(data.patterns[0]?.status).toBe("advisory");
    });

    it("returns false for non-blocking patterns", async () => {
      const p = makePattern({ id: "a", status: "advisory" });
      const store = storeWithPatterns([p]);
      const engine = new PolicyEngine(store);
      expect(await engine.downgrade("a")).toBe(false);
    });
  });

  describe("preview", () => {
    it("previews without mutating", async () => {
      const p = makePattern({ occurrences: 3 });
      const store = storeWithPatterns([p]);
      const engine = new PolicyEngine(store);

      const preview = await engine.preview();
      expect(preview.toPromote).toHaveLength(1);

      const data = await store.load();
      expect(data.patterns[0]?.status).toBe("advisory"); // no mutation
    });
  });

  describe("unchanged count", () => {
    it("counts unchanged patterns", async () => {
      const store = storeWithPatterns([
        makePattern({ occurrences: 1, wasted_ms: 0 }), // no-op
        makePattern({ occurrences: 1, wasted_ms: 0 }), // no-op
      ]);
      const engine = new PolicyEngine(store);
      const result = await engine.evaluate();
      expect(result.unchanged).toBe(2);
    });
  });

  describe("custom thresholds", () => {
    it("respects custom occurrence threshold", async () => {
      const store = storeWithPatterns([makePattern({ occurrences: 5 })]);
      const engine = new PolicyEngine(store, { ...DEFAULT_THRESHOLDS, occurrences: 10 });
      const result = await engine.evaluate();
      expect(result.promoted).toHaveLength(0);
    });
  });
});
