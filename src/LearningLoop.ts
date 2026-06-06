import type {
  CommandContext,
  ExecutionTrace,
  LearningLoopConfig,
  PreflightResult,
} from "./types.js";
import { resolveConfig } from "./config.js";
import type { ResolvedConfig } from "./types.js";
import { FailureRegistry } from "./registry/FailureRegistry.js";
import { analyzeCommand, type AnalyzerHints } from "./gates/CommandAnalyzer.js";
import { PreflightGate } from "./gates/PreflightGate.js";
import { PolicyEngine } from "./policy/PolicyEngine.js";
import { TransportBroker } from "./broker/TransportBroker.js";
import { EvalRunner } from "./eval/EvalRunner.js";
import type { BrokerResult } from "./types.js";

export class LearningLoop {
  private readonly cfg: ResolvedConfig;
  readonly registry: FailureRegistry;
  private readonly gate: PreflightGate;
  private readonly policy: PolicyEngine;
  readonly broker: TransportBroker;
  readonly eval: EvalRunner;

  constructor(config: LearningLoopConfig = {}) {
    this.cfg = resolveConfig(config);

    this.registry = new FailureRegistry(
      this.cfg.storage,
      this.cfg.maxTraces,
      this.cfg.maxPatterns,
    );

    this.gate = new PreflightGate({
      enableBuiltInRules: this.cfg.enableBuiltInRules,
      customRules: this.cfg.customRules,
      minMatchScore: this.cfg.minMatchScore,
    });

    this.policy = new PolicyEngine(this.cfg.storage, {
      occurrences: this.cfg.promotionOccurrences,
      windowDays: this.cfg.promotionWindowDays,
      wastedMs: this.cfg.promotionWastedMs,
      expirationDays: this.cfg.expirationDays,
    });

    this.broker = new TransportBroker();
    this.eval = new EvalRunner(this.cfg.storage);
  }

  /**
   * Check a raw command string before execution.
   * Pass hints to override auto-detected shell/target/OS.
   */
  async preflight(command: string, hints: AnalyzerHints = {}): Promise<PreflightResult> {
    const context = analyzeCommand(command, hints);
    return this.preflightContext(context);
  }

  /**
   * Check a pre-built CommandContext (e.g., when you've already analyzed the command).
   */
  async preflightContext(context: CommandContext): Promise<PreflightResult> {
    // Surface fuzzy (advisory) matches down to minMatchScore, but always include
    // exact matches (score 1.0) so the gate can hard-block them.
    const matches = await this.registry.findMatching(context, this.cfg.minMatchScore);
    return this.gate.check(context, matches);
  }

  /**
   * Record the outcome of a command execution.
   */
  async record(trace: Omit<ExecutionTrace, "id" | "timestamp"> & { id?: string; timestamp?: string }): Promise<void> {
    const { randomUUID } = await import("node:crypto");
    const full: ExecutionTrace = {
      id: trace.id ?? randomUUID(),
      timestamp: trace.timestamp ?? new Date().toISOString(),
      command: trace.command,
      context: trace.context,
      outcome: trace.outcome,
      duration_ms: trace.duration_ms,
      ...(trace.alternativeUsed !== undefined && { alternativeUsed: trace.alternativeUsed }),
      ...(trace.errorMessage !== undefined && { errorMessage: trace.errorMessage }),
    };
    await this.registry.record(full);
  }

  /**
   * Run policy engine: promote advisory patterns and expire stale ones.
   * Call after each session or periodically.
   */
  async learn(now?: Date): Promise<{ promoted: number; expired: number }> {
    const result = await this.policy.evaluate(now);
    return { promoted: result.promoted.length, expired: result.expired.length };
  }

  /**
   * Get a safe transport recommendation for a command payload.
   */
  recommend(command: string, payload: string, hints: AnalyzerHints = {}): BrokerResult {
    const context = analyzeCommand(command, hints);
    return this.broker.selectStrategy(context, payload);
  }

  /**
   * Convenience: preflight → if blocked, get broker recommendation.
   */
  async safeExec(
    command: string,
    hints: AnalyzerHints = {},
  ): Promise<{ preflight: PreflightResult; recommendation?: BrokerResult }> {
    const preflight = await this.preflight(command, hints);

    if (!preflight.allowed) {
      const context = analyzeCommand(command, hints);
      const recommendation = this.broker.selectStrategy(context, command);
      return { preflight, recommendation };
    }

    return { preflight };
  }

  /**
   * Analyze a command string into a CommandContext without gating.
   */
  analyze(command: string, hints: AnalyzerHints = {}): CommandContext {
    return analyzeCommand(command, hints);
  }

  /**
   * Close storage connections. Call when shutting down.
   */
  async close(): Promise<void> {
    await this.cfg.storage.close();
  }
}
