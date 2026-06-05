import type { CommandContext, OS, ShellType, TargetType, TransportClass } from "../types.js";

export interface AnalyzerHints {
  /** Override shell detection (e.g., from env var SHELL or explicit config) */
  shell?: ShellType;
  /** Override target detection */
  target?: TargetType;
  /** Override OS detection */
  os?: OS;
}

/**
 * Stateless parser: extracts CommandContext from a raw command string.
 */
export function analyzeCommand(command: string, hints: AnalyzerHints = {}): CommandContext {
  const shell = hints.shell ?? detectShell();
  const target = hints.target ?? detectTarget(command);
  const os = hints.os ?? detectOS();
  const isMultiline = detectMultiline(command);
  const hasHeredoc = detectHeredoc(command);
  const hasComplexQuoting = detectComplexQuoting(command);
  const transportClass = detectTransportClass(command, isMultiline, hasHeredoc);

  return {
    command,
    shell,
    target,
    os,
    isMultiline,
    hasHeredoc,
    hasComplexQuoting,
    transportClass,
    payloadLength: command.length,
  };
}

// ─── Detection helpers ────────────────────────────────────────────────────────

function detectShell(): ShellType {
  const shellEnv = process.env["SHELL"] ?? "";
  const psEnv = process.env["PSModulePath"] ?? process.env["PSMODULEPATH"] ?? "";

  if (psEnv.length > 0 || process.env["PROCESSOR_ARCHITECTURE"] !== undefined) {
    // Likely PowerShell or Windows CMD
    if (shellEnv.toLowerCase().includes("powershell") || shellEnv.toLowerCase().includes("pwsh")) {
      return "powershell";
    }
    // Windows without explicit SHELL = likely cmd or powershell
    if (process.platform === "win32") return "powershell";
  }

  if (shellEnv.includes("bash")) return "bash";
  if (shellEnv.includes("zsh")) return "zsh";
  if (shellEnv.includes("fish")) return "fish";
  if (shellEnv.includes("powershell") || shellEnv.includes("pwsh")) return "powershell";
  if (shellEnv.includes("/sh")) return "sh";

  return "unknown";
}

function detectTarget(command: string): TargetType {
  // SSH invocation patterns
  const sshPatterns = [
    /\bssh\s+/i,
    /\bssh\s+-[a-zA-Z]/i,
    // ssh user@host
    /\bssh\s+\w+@\S+/i,
    // Common SSH wrappers
    /\brsync\s+.*ssh/i,
  ];

  if (sshPatterns.some((re) => re.test(command))) return "remote-ssh";

  // Other remote patterns
  if (/\b(kubectl\s+exec|docker\s+exec)\b/i.test(command)) return "remote-other";

  return "local";
}

function detectOS(): OS {
  switch (process.platform) {
    case "win32": return "windows";
    case "linux": return "linux";
    case "darwin": return "darwin";
    default: return "unknown";
  }
}

function detectMultiline(command: string): boolean {
  return command.includes("\n") || command.includes("\r\n") || command.includes("\\n");
}

function detectHeredoc(command: string): boolean {
  // POSIX heredoc: << or <<- followed by delimiter (with optional whitespace)
  if (/<<-?\s*['"]?[A-Z_a-z]+['"]?/m.test(command)) return true;
  // PowerShell here-string: @' ... '@ or @" ... "@
  if (/@['"][\s\S]*?['"]@/m.test(command)) return true;
  return false;
}

function detectComplexQuoting(command: string): boolean {
  // Multiple layers of quotes, escaped quotes, or mixed quote types in proximity
  const nestedSingleInDouble = /"[^"]*'[^"]*"/;
  const nestedDoubleInSingle = /'[^']*"[^']*'/;
  const escapedQuotes = /\\["']/;
  const dollarQuote = /\$'[^']*'/;

  const depth = countQuoteDepth(command);
  return (
    depth >= 3 ||
    nestedSingleInDouble.test(command) ||
    nestedDoubleInSingle.test(command) ||
    escapedQuotes.test(command) ||
    dollarQuote.test(command)
  );
}

function countQuoteDepth(command: string): number {
  let maxDepth = 0;
  let depth = 0;
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      depth += inSingle ? 1 : -1;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      depth += inDouble ? 1 : -1;
    }
    if (depth > maxDepth) maxDepth = depth;
  }
  return maxDepth;
}

function detectTransportClass(
  command: string,
  isMultiline: boolean,
  hasHeredoc: boolean,
): TransportClass {
  if (hasHeredoc) return "heredoc";

  // stdin piping patterns
  if (/\|\s*(ssh|bash|sh)\b/i.test(command)) return "stdin";

  // File transfer patterns
  if (/\b(scp|sftp|rsync)\b/i.test(command)) return "file";
  if (/\bcat\s+\S+\s+\|\s*(ssh|bash)\b/i.test(command)) return "file";

  if (isMultiline) return "stdin"; // multiline without heredoc → stdin

  return "inline";
}
