#!/usr/bin/env node
import { LearningLoop } from "../LearningLoop.js";
import { computeMetrics } from "../eval/Metrics.js";
import { install } from "../installer/index.js";
import type { AnalyzerHints } from "../gates/CommandAnalyzer.js";
import type { AgentTarget } from "../installer/index.js";

const USAGE = `
Usage: agentic-feedback <command> [options]

Commands:
  preflight <cmd>   Check a command against known-bad patterns
                    Options: --shell powershell|bash|zsh|sh|cmd|fish
                             --target local|remote-ssh|remote-other
                             --os windows|linux|darwin
  record            Record an execution trace (read JSON from stdin)
  learn             Run policy engine on stored patterns
  report            Print registry summary and metrics
  export            Export registry as JSON (stdout)
  import            Import patterns from JSON file (read from stdin)
  install           Install hooks for your coding agent
                    Options: --agent claude-code|cursor|cline|openhands|generic (default: claude-code)
                             --global  Install to home directory instead of current project
                             --dry-run Show what would be created without writing files

Options:
  --dir <path>      Override storage directory (default: ~/.agentic-feedback)
  --help, -h        Show this help message

Examples:
  agentic-feedback preflight "ssh user@host 'bash -s' << 'EOF'\\necho hi\\nEOF" --shell powershell
  echo '{"command":"ssh ...","outcome":"timeout",...}' | agentic-feedback record
  agentic-feedback learn
  agentic-feedback report
  agentic-feedback install
  agentic-feedback install --agent cursor
  agentic-feedback install --global --dry-run
`.trim();

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }

  const [command, ...rest] = args;
  const flags = parseFlags(rest);
  const storageDir = flags["--dir"] as string | undefined;

  const loop = new LearningLoop({ storageDir });

  try {
    switch (command) {
      case "preflight":
        await cmdPreflight(loop, rest, flags);
        break;
      case "record":
        await cmdRecord(loop);
        break;
      case "learn":
        await cmdLearn(loop);
        break;
      case "report":
        await cmdReport(loop);
        break;
      case "export":
        await cmdExport(loop);
        break;
      case "import":
        await cmdImport(loop);
        break;
      case "install":
        await cmdInstall(rest, flags);
        break;
      default:
        console.error(`Unknown command: ${command}\n`);
        console.log(USAGE);
        process.exit(1);
    }
  } finally {
    await loop.close();
  }
}

async function cmdPreflight(
  loop: LearningLoop,
  rest: string[],
  flags: Record<string, string | boolean>,
): Promise<void> {
  const cmdArg = rest.find((a) => !a.startsWith("--"));
  if (!cmdArg) {
    console.error("preflight requires a command argument");
    process.exit(1);
  }

  const hints: AnalyzerHints = {};
  if (flags["--shell"]) hints.shell = flags["--shell"] as AnalyzerHints["shell"];
  if (flags["--target"]) hints.target = flags["--target"] as AnalyzerHints["target"];
  if (flags["--os"]) hints.os = flags["--os"] as AnalyzerHints["os"];

  const result = await loop.preflight(cmdArg, hints);

  if (result.allowed) {
    if (result.warnings.length > 0) {
      console.log("WARN: Command allowed with warnings:");
      result.warnings.forEach((w) => console.log(`  • ${w}`));
    } else {
      console.log("OK: Command passes preflight checks.");
    }
    process.exit(0);
  } else {
    console.error("BLOCKED:", result.reason);
    if (result.requiredAlternative) {
      console.error("Alternative:", result.requiredAlternative);
    }
    if (result.matchedPattern) {
      console.error("Matched pattern:", result.matchedPattern.signature);
    }
    process.exit(2);
  }
}

async function cmdRecord(loop: LearningLoop): Promise<void> {
  const raw = await readStdin();
  let trace: unknown;
  try {
    trace = JSON.parse(raw);
  } catch {
    console.error("record: stdin must be valid JSON");
    process.exit(1);
  }
  await loop.record(trace as Parameters<LearningLoop["record"]>[0]);
  console.log("Trace recorded.");
}

async function cmdLearn(loop: LearningLoop): Promise<void> {
  const result = await loop.learn();
  console.log(`Policy run complete: ${result.promoted} promoted, ${result.expired} expired.`);
}

async function cmdReport(loop: LearningLoop): Promise<void> {
  const data = await loop.registry.getAll();
  const metrics = computeMetrics(data.traces, data.patterns);

  console.log("=== Agentic Feedback Registry Report ===\n");
  console.log(`Patterns stored:      ${metrics.totalPatterns}`);
  console.log(`  Blocking:           ${metrics.blockingPatterns}`);
  console.log(`  Advisory:           ${data.patterns.filter((p) => p.status === "advisory").length}`);
  console.log(`  Expired:            ${data.patterns.filter((p) => p.status === "expired").length}`);
  console.log(`\nTraces recorded:      ${metrics.totalTraces}`);
  console.log(`\nMetrics (last 30 days):`);
  console.log(`  First-attempt success rate: ${(metrics.firstAttemptSuccessRate * 100).toFixed(1)}%`);
  console.log(`  Repeated pattern recurrence: ${(metrics.repeatedPatternRecurrenceRate * 100).toFixed(1)}%`);
  console.log(`  Timeout minutes per 100 tasks: ${metrics.timeoutMinutesPer100Tasks.toFixed(1)}`);
  console.log(`  Transport-switch compliance: ${(metrics.transportSwitchCompliance * 100).toFixed(1)}%`);

  if (metrics.blockingPatterns > 0) {
    console.log("\nBlocking Patterns:");
    data.patterns
      .filter((p) => p.status === "blocking")
      .forEach((p) => {
        console.log(`  [${p.id.slice(0, 8)}] ${p.signature}`);
        console.log(`    Failed: ${p.failedApproach}`);
        console.log(`    Use instead: ${p.successfulAlternative}`);
        console.log(`    Seen ${p.occurrences}x, ${(p.wasted_ms / 60000).toFixed(1)} min wasted`);
      });
  }
}

async function cmdExport(loop: LearningLoop): Promise<void> {
  const data = await loop.registry.getAll();
  console.log(JSON.stringify(data, null, 2));
}

async function cmdImport(loop: LearningLoop): Promise<void> {
  const raw = await readStdin();
  let imported: unknown;
  try {
    imported = JSON.parse(raw);
  } catch {
    console.error("import: stdin must be valid JSON");
    process.exit(1);
  }

  if (
    typeof imported !== "object" ||
    imported === null ||
    !Array.isArray((imported as { patterns?: unknown }).patterns)
  ) {
    console.error("import: expected { patterns: [...] }");
    process.exit(1);
  }

  const data = await loop.registry.getAll();
  const incoming = (imported as { patterns: unknown[] }).patterns;
  const existingSigs = new Set(data.patterns.map((p) => p.signature));
  let added = 0;

  for (const p of incoming) {
    const pattern = p as { signature?: string; status?: string };
    if (pattern.signature && !existingSigs.has(pattern.signature)) {
      data.patterns.push(p as Parameters<typeof data.patterns.push>[0]);
      added++;
    }
  }

  // Save via storage directly
  const store = (loop as unknown as { cfg: { storage: { save: (d: unknown) => Promise<void> } } }).cfg.storage;
  await store.save(data);
  console.log(`Imported ${added} new patterns.`);
}

async function cmdInstall(
  rest: string[],
  flags: Record<string, string | boolean>,
): Promise<void> {
  const validAgents: AgentTarget[] = ["claude-code", "cursor", "cline", "openhands", "generic"];
  const agentFlag = flags["--agent"] as string | undefined;
  if (agentFlag !== undefined && !validAgents.includes(agentFlag as AgentTarget)) {
    console.error(`install: unknown agent "${agentFlag}". Valid: ${validAgents.join(", ")}`);
    process.exit(1);
  }

  const result = await install({
    agent: (agentFlag as AgentTarget) ?? "claude-code",
    global: flags["--global"] === true,
    dryRun: flags["--dry-run"] === true,
    cwd: process.cwd(),
  });

  const prefix = result.dryRun ? "[dry-run] " : "";

  if (result.filesWritten.length > 0) {
    console.log(`${prefix}Scripts written:`);
    result.filesWritten.forEach((f) => console.log(`  ${f}`));
  }
  if (result.filesPatched.length > 0) {
    console.log(`${prefix}Settings patched:`);
    result.filesPatched.forEach((f) => console.log(`  ${f}`));
  }
  if (result.skipped.length > 0) {
    console.log(`${prefix}Skipped (already present):`);
    result.skipped.forEach((f) => console.log(`  ${f}`));
  }

  if (!result.dryRun) {
    console.log(`\nInstalled agentic-feedback hooks for ${result.agent}.`);
    if (result.agent === "claude-code") {
      console.log("Verify with /hooks inside a Claude Code session.");
    }
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function parseFlags(args: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg !== undefined && arg.startsWith("--")) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[arg] = next;
        i++;
      } else {
        flags[arg] = true;
      }
    }
  }
  return flags;
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
