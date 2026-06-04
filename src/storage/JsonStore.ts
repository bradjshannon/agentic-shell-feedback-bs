import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { RegistryData, StorageAdapter } from "../types.js";

const REGISTRY_FILE = "registry.json";
const EMPTY: RegistryData = { version: 1, patterns: [], traces: [] };

export class JsonStore implements StorageAdapter {
  private readonly filePath: string;

  constructor(private readonly dir: string) {
    this.filePath = join(dir, REGISTRY_FILE);
  }

  async load(): Promise<RegistryData> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      return isRegistryData(parsed) ? parsed : structuredClone(EMPTY);
    } catch (err) {
      if (isNodeError(err) && err.code === "ENOENT") {
        return structuredClone(EMPTY);
      }
      // Corrupt file — start fresh rather than crash
      return structuredClone(EMPTY);
    }
  }

  async save(data: RegistryData): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const json = JSON.stringify(data, null, 2);
    // Unique temp path per save for safe concurrent writes
    const tmpPath = join(this.dir, `registry.${randomBytes(4).toString("hex")}.tmp`);
    await writeFile(tmpPath, json, "utf8");
    await rename(tmpPath, this.filePath);
  }

  async close(): Promise<void> {
    // No persistent connection to close
  }

  get path(): string {
    return this.filePath;
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function isRegistryData(v: unknown): v is RegistryData {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj["version"] === "number" &&
    Array.isArray(obj["patterns"]) &&
    Array.isArray(obj["traces"])
  );
}
