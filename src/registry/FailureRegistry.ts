import { randomUUID } from "node:crypto";
import type {
  CommandContext,
  ExecutionTrace,
  FailurePattern,
  PatternStatus,
  RegistryData,
  StorageAdapter,
} from "../types.js";
import {
  computeEnvironmentFingerprint,
  computeSignature,
  rankPatterns,
  type ScoredPattern,
} from "./PatternMatcher.js";

export class FailureRegistry {
  constructor(
    private readonly storage: StorageAdapter,
    private readonly maxTraces = 1000,
    private readonly maxPatterns = 500,
  ) {}

  async record(trace: ExecutionTrace): Promise<void> {
    const data = await this.storage.load();
    const sig = computeSignature(trace.context);
    const env = computeEnvironmentFingerprint(trace.context);

    const existing = data.patterns.find((p) => p.signature === sig && p.status !== "expired");

    if (existing) {
      // A successful run must never strengthen a failure pattern: doing so would
      // inflate occurrences/confidence (and refresh lastSeen, preventing expiry)
      // off the back of commands that actually worked, risking false promotion to
      // blocking. We still capture a working alternative when one is reported.
      if (trace.outcome !== "success") {
        existing.occurrences += 1;
        existing.lastSeen = trace.timestamp;
        existing.wasted_ms += trace.outcome === "timeout" ? trace.duration_ms : 0;
        existing.confidence = computeConfidence(existing.occurrences);
      }
      if (trace.alternativeUsed) {
        existing.successfulAlternative = trace.alternativeUsed;
      }
    } else if (trace.outcome !== "success") {
      const newPattern: FailurePattern = {
        id: randomUUID(),
        signature: sig,
        environmentFingerprint: env,
        failedApproach: describeApproach(trace.context),
        successfulAlternative: trace.alternativeUsed ?? "unknown",
        confidence: 0.5,
        status: "advisory",
        occurrences: 1,
        firstSeen: trace.timestamp,
        lastSeen: trace.timestamp,
        wasted_ms: trace.outcome === "timeout" ? trace.duration_ms : 0,
      };

      data.patterns.push(newPattern);
      if (data.patterns.length > this.maxPatterns) {
        // Evict lowest-confidence expired patterns first, then lowest-confidence advisory
        data.patterns = evictExcess(data.patterns, this.maxPatterns);
      }
    }

    // Always record the trace
    data.traces.push(trace);
    if (data.traces.length > this.maxTraces) {
      data.traces = data.traces.slice(data.traces.length - this.maxTraces);
    }

    await this.storage.save(data);
  }

  async findMatching(
    context: CommandContext,
    minScore = 0.5,
  ): Promise<ScoredPattern[]> {
    const data = await this.storage.load();
    return rankPatterns(data.patterns, context, minScore);
  }

  async promote(patternId: string): Promise<boolean> {
    return this.setStatus(patternId, "blocking");
  }

  async expire(patternId: string): Promise<boolean> {
    return this.setStatus(patternId, "expired");
  }

  async prune(olderThanDays = 180): Promise<number> {
    const data = await this.storage.load();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);

    const before = data.patterns.length;
    data.patterns = data.patterns.filter((p) => {
      if (p.status !== "expired") return true;
      return new Date(p.lastSeen) >= cutoff;
    });
    const removed = before - data.patterns.length;
    if (removed > 0) await this.storage.save(data);
    return removed;
  }

  async getAll(): Promise<RegistryData> {
    return this.storage.load();
  }

  private async setStatus(patternId: string, status: PatternStatus): Promise<boolean> {
    const data = await this.storage.load();
    const pattern = data.patterns.find((p) => p.id === patternId);
    if (!pattern) return false;
    pattern.status = status;
    await this.storage.save(data);
    return true;
  }
}

function computeConfidence(occurrences: number): number {
  // Converges toward 0.95 as occurrences grow: 1 - 1/(n+1), capped at 0.95
  return Math.min(0.95, 1 - 1 / (occurrences + 1));
}

function describeApproach(ctx: CommandContext): string {
  const parts: string[] = [];
  if (ctx.hasHeredoc) parts.push("heredoc");
  if (ctx.isMultiline) parts.push("multiline");
  parts.push(`${ctx.transportClass} transport`);
  parts.push(`via ${ctx.target}`);
  return parts.join(" ");
}

function evictExcess(patterns: FailurePattern[], max: number): FailurePattern[] {
  const sorted = [...patterns].sort((a, b) => {
    // Expired first, then lowest confidence
    if (a.status === "expired" && b.status !== "expired") return -1;
    if (b.status === "expired" && a.status !== "expired") return 1;
    return a.confidence - b.confidence;
  });
  return sorted.slice(sorted.length - max);
}
