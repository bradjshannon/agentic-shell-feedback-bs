import { homedir } from "node:os";
import { join } from "node:path";
import type { LearningLoopConfig, ResolvedConfig } from "./types.js";
import { JsonStore } from "./storage/JsonStore.js";

export const DEFAULTS = {
  maxTraces: 1000,
  maxPatterns: 500,
  promotionOccurrences: 2,
  promotionWindowDays: 30,
  promotionWastedMs: 60_000,
  expirationDays: 90,
  enableBuiltInRules: true,
  customRules: [],
  blockOnConfidence: 0.7,
  replayWindowDays: 30,
} as const;

export function defaultStorageDir(): string {
  return join(homedir(), ".agentic-feedback");
}

export function resolveConfig(config: LearningLoopConfig = {}): ResolvedConfig {
  const storageDir = config.storageDir ?? defaultStorageDir();
  const storage = config.storage ?? new JsonStore(storageDir);

  return {
    storage,
    maxTraces: config.maxTraces ?? DEFAULTS.maxTraces,
    maxPatterns: config.maxPatterns ?? DEFAULTS.maxPatterns,
    promotionOccurrences: config.promotionOccurrences ?? DEFAULTS.promotionOccurrences,
    promotionWindowDays: config.promotionWindowDays ?? DEFAULTS.promotionWindowDays,
    promotionWastedMs: config.promotionWastedMs ?? DEFAULTS.promotionWastedMs,
    expirationDays: config.expirationDays ?? DEFAULTS.expirationDays,
    enableBuiltInRules: config.enableBuiltInRules ?? DEFAULTS.enableBuiltInRules,
    customRules: config.customRules ?? [],
    blockOnConfidence: config.blockOnConfidence ?? DEFAULTS.blockOnConfidence,
    replayWindowDays: config.replayWindowDays ?? DEFAULTS.replayWindowDays,
  };
}
