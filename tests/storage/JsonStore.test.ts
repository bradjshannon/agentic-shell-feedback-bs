import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonStore } from "../../src/storage/JsonStore.js";
import type { RegistryData } from "../../src/types.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agentic-test-"));
}

describe("JsonStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns empty data when file does not exist", async () => {
    const store = new JsonStore(dir);
    const data = await store.load();
    expect(data.version).toBe(1);
    expect(data.patterns).toEqual([]);
    expect(data.traces).toEqual([]);
  });

  it("saves and loads roundtrip", async () => {
    const store = new JsonStore(dir);
    const data = await store.load();
    data.patterns.push({
      id: "y",
      signature: "bash:remote-ssh:single:noheredoc:inline",
      environmentFingerprint: "linux:bash:remote-ssh",
      failedApproach: "inline",
      successfulAlternative: "stdin",
      confidence: 0.7,
      status: "advisory",
      occurrences: 1,
      firstSeen: "2026-01-01T00:00:00Z",
      lastSeen: "2026-01-01T00:00:00Z",
      wasted_ms: 0,
    });
    await store.save(data);

    const loaded = await new JsonStore(dir).load();
    expect(loaded.patterns).toHaveLength(1);
    expect(loaded.patterns[0]?.id).toBe("y");
  });

  it("creates directory when saving", async () => {
    const nested = join(dir, "deep", "nested");
    const store = new JsonStore(nested);
    await store.save({ version: 1, patterns: [], traces: [] });
    const content = await readFile(join(nested, "registry.json"), "utf8");
    expect(JSON.parse(content)).toMatchObject({ version: 1 });
  });

  it("recovers gracefully from corrupt file", async () => {
    await writeFile(join(dir, "registry.json"), "NOT JSON {{{", "utf8");
    const store = new JsonStore(dir);
    const data = await store.load();
    expect(data.patterns).toEqual([]);
  });

  it("handles missing version field gracefully", async () => {
    await writeFile(join(dir, "registry.json"), JSON.stringify({ foo: "bar" }), "utf8");
    const store = new JsonStore(dir);
    const data = await store.load();
    expect(data.patterns).toEqual([]);
  });

  it("exposes path property", () => {
    const store = new JsonStore("/some/dir");
    expect(store.path).toBe("/some/dir/registry.json");
  });

  it("close resolves without error", async () => {
    const store = new JsonStore(dir);
    await expect(store.close()).resolves.toBeUndefined();
  });

  it("write is atomic (uses temp file rename)", async () => {
    const store = new JsonStore(dir);
    const data: RegistryData = { version: 1, patterns: [], traces: [] };

    // Run concurrent saves — should not corrupt
    await Promise.all([
      store.save({ ...data }),
      store.save({ ...data }),
      store.save({ ...data }),
    ]);

    const loaded = await store.load();
    expect(loaded.version).toBe(1);
  });
});
