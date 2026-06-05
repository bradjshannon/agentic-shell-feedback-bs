import type { RegistryData, StorageAdapter } from "../types.js";

const EMPTY: RegistryData = { version: 1, patterns: [], traces: [] };

export class MemoryStore implements StorageAdapter {
  private data: RegistryData;

  constructor(initial?: RegistryData) {
    this.data = initial ? structuredClone(initial) : structuredClone(EMPTY);
  }

  async load(): Promise<RegistryData> {
    return structuredClone(this.data);
  }

  async save(data: RegistryData): Promise<void> {
    this.data = structuredClone(data);
  }

  async close(): Promise<void> {
    // No-op for in-memory store
  }

  /** Test helper: peek at raw internal state */
  snapshot(): RegistryData {
    return structuredClone(this.data);
  }
}
