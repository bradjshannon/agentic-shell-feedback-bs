// ─── Core domain types ────────────────────────────────────────────────────────

export type ShellType = "bash" | "zsh" | "sh" | "powershell" | "cmd" | "fish" | "unknown";
export type TargetType = "local" | "remote-ssh" | "remote-other";
export type TransportClass = "inline" | "stdin" | "file" | "heredoc" | "unknown";
export type OS = "windows" | "linux" | "darwin" | "unknown";
export type PatternStatus = "advisory" | "blocking" | "expired";
export type ExecutionOutcome =
  | "success"
  | "mechanical-failure"
  | "semantic-failure"
  | "timeout"
  | "unknown";

export interface CommandContext {
  command: string;
  shell: ShellType;
  target: TargetType;
  os: OS;
  isMultiline: boolean;
  hasHeredoc: boolean;
  hasComplexQuoting: boolean;
  transportClass: TransportClass;
  /** Approximate character length of the command payload */
  payloadLength: number;
}

export interface FailurePattern {
  id: string;
  /** Deterministic fingerprint of the command shape: shell:target:multiline:heredoc:transport */
  signature: string;
  /** Broader context: os:shell:target */
  environmentFingerprint: string;
  failedApproach: string;
  successfulAlternative: string;
  /** 0–0.95: converges toward 1 as occurrences accumulate */
  confidence: number;
  status: PatternStatus;
  occurrences: number;
  firstSeen: string; // ISO 8601
  lastSeen: string;  // ISO 8601
  /** Cumulative milliseconds wasted on this failure shape */
  wasted_ms: number;
}

export interface ExecutionTrace {
  id: string;
  command: string;
  context: CommandContext;
  outcome: ExecutionOutcome;
  duration_ms: number;
  timestamp: string; // ISO 8601
  alternativeUsed?: string;
  errorMessage?: string;
}

export interface PreflightResult {
  allowed: boolean;
  /** Warning-level messages (allowed but cautioned) */
  warnings: string[];
  /** The matched pattern that caused a block, if any */
  matchedPattern?: FailurePattern;
  /** Alternative approach to use if blocked */
  requiredAlternative?: string;
  /** Human-readable explanation */
  reason?: string;
}

// ─── Storage interface ────────────────────────────────────────────────────────

export interface RegistryData {
  version: number;
  patterns: FailurePattern[];
  traces: ExecutionTrace[];
}

export interface StorageAdapter {
  load(): Promise<RegistryData>;
  save(data: RegistryData): Promise<void>;
  close(): Promise<void>;
}

// ─── Gate rules ───────────────────────────────────────────────────────────────

export type RuleVerdict = "allow" | "warn" | "deny";

export interface GateRule {
  id: string;
  description: string;
  match(context: CommandContext): boolean;
  verdict: RuleVerdict;
  alternative?: string;
  reason?: string;
}

// ─── Broker ───────────────────────────────────────────────────────────────────

export type BrokerStrategy = "inline" | "stdin" | "file";

export interface BrokerResult {
  strategy: BrokerStrategy;
  /** Safe command template to use instead of inline construction */
  commandTemplate: string;
  /** Explanation of why this strategy was chosen */
  rationale: string;
}

// ─── Eval ─────────────────────────────────────────────────────────────────────

export interface EvalMetrics {
  firstAttemptSuccessRate: number;
  repeatedPatternRecurrenceRate: number;
  timeoutMinutesPer100Tasks: number;
  transportSwitchCompliance: number;
  totalTraces: number;
  totalPatterns: number;
  blockingPatterns: number;
}

export interface EvalReport {
  baseline: EvalMetrics;
  candidate?: EvalMetrics;
  improvement?: Partial<EvalMetrics>;
  recommendation: "promote" | "reject" | "neutral";
  summary: string;
}

// ─── Configuration ────────────────────────────────────────────────────────────

export interface LearningLoopConfig {
  // Storage
  storage?: StorageAdapter;
  storageDir?: string;
  maxTraces?: number;
  maxPatterns?: number;

  // Policy thresholds
  promotionOccurrences?: number;
  promotionWindowDays?: number;
  promotionWastedMs?: number;
  expirationDays?: number;

  // Gate behavior
  enableBuiltInRules?: boolean;
  customRules?: GateRule[];
  blockOnConfidence?: number;

  // Eval
  replayWindowDays?: number;
}

export interface ResolvedConfig {
  storage: StorageAdapter;
  maxTraces: number;
  maxPatterns: number;
  promotionOccurrences: number;
  promotionWindowDays: number;
  promotionWastedMs: number;
  expirationDays: number;
  enableBuiltInRules: boolean;
  customRules: GateRule[];
  blockOnConfidence: number;
  replayWindowDays: number;
}
