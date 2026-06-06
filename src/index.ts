export { LearningLoop } from "./LearningLoop.js";
export { MemoryStore } from "./storage/MemoryStore.js";
export { JsonStore } from "./storage/JsonStore.js";
export { FailureRegistry } from "./registry/FailureRegistry.js";
export { computeSignature, computeEnvironmentFingerprint, rankPatterns } from "./registry/PatternMatcher.js";
export { computeCommandFingerprint } from "./registry/CommandFingerprint.js";
export { analyzeCommand } from "./gates/CommandAnalyzer.js";
export { PreflightGate } from "./gates/PreflightGate.js";
export { BUILT_IN_RULES, getBuiltInRules } from "./gates/BuiltInRules.js";
export { PolicyEngine } from "./policy/PolicyEngine.js";
export { shouldPromote, shouldExpire, hasKnownAlternative } from "./policy/PromotionRules.js";
export { TransportBroker } from "./broker/TransportBroker.js";
export { EvalRunner } from "./eval/EvalRunner.js";
export { computeMetrics } from "./eval/Metrics.js";
export { resolveConfig, DEFAULTS, defaultStorageDir } from "./config.js";
export type {
  ShellType,
  TargetType,
  TransportClass,
  OS,
  PatternStatus,
  ExecutionOutcome,
  CommandContext,
  FailurePattern,
  ExecutionTrace,
  PreflightResult,
  RegistryData,
  StorageAdapter,
  GateRule,
  RuleVerdict,
  BrokerStrategy,
  BrokerResult,
  EvalMetrics,
  EvalReport,
  LearningLoopConfig,
  ResolvedConfig,
} from "./types.js";
