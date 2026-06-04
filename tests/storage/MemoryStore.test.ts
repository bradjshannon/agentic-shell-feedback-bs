import { MemoryStore } from "../../src/storage/MemoryStore.js";
import type { RegistryData } from "../../src/types.js";

describe("MemoryStore", () => {
  it("loads empty data when initialized with no args", async () => {
    const store = new MemoryStore();
    const data = await store.load();
    expect(data.version).toBe(1);
    expect(data.patterns).toEqual([]);
    expect(data.traces).toEqual([]);
  });

  it("loads pre-seeded data", async () => {
    const seed: RegistryData = {
      version: 1,
      patterns: [
        {
          id: "abc",
          signature: "bash:local:single:noheredoc:inline",
          environmentFingerprint: "linux:bash:local",
          failedApproach: "test",
          successfulAlternative: "test2",
          confidence: 0.8,
          status: "advisory",
          occurrences: 2,
          firstSeen: "2026-01-01T00:00:00Z",
          lastSeen: "2026-01-02T00:00:00Z",
          wasted_ms: 5000,
        },
      ],
      traces: [],
    };
    const store = new MemoryStore(seed);
    const data = await store.load();
    expect(data.patterns).toHaveLength(1);
    expect(data.patterns[0]?.id).toBe("abc");
  });

  it("saves and loads roundtrip", async () => {
    const store = new MemoryStore();
    const original = await store.load();
    original.patterns.push({
      id: "x",
      signature: "powershell:remote-ssh:multiline:heredoc:heredoc",
      environmentFingerprint: "windows:powershell:remote-ssh",
      failedApproach: "heredoc via SSH",
      successfulAlternative: "stdin piping",
      confidence: 0.9,
      status: "blocking",
      occurrences: 3,
      firstSeen: "2026-01-01T00:00:00Z",
      lastSeen: "2026-01-03T00:00:00Z",
      wasted_ms: 90000,
    });
    await store.save(original);
    const loaded = await store.load();
    expect(loaded.patterns).toHaveLength(1);
    expect(loaded.patterns[0]?.id).toBe("x");
  });

  it("isolates saved data from external mutations", async () => {
    const store = new MemoryStore();
    const data = await store.load();
    data.patterns.push({} as never);
    const reloaded = await store.load();
    expect(reloaded.patterns).toHaveLength(0);
  });

  it("snapshot returns independent copy", async () => {
    const store = new MemoryStore();
    const snap = store.snapshot();
    snap.patterns.push({} as never);
    expect(store.snapshot().patterns).toHaveLength(0);
  });

  it("close resolves without error", async () => {
    const store = new MemoryStore();
    await expect(store.close()).resolves.toBeUndefined();
  });
});
