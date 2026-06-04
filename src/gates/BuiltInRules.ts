import type { CommandContext, GateRule } from "../types.js";

/**
 * Default rule set — always enforced regardless of the registry.
 * Derived from empirically observed failure patterns in agentic shell contexts.
 */
export const BUILT_IN_RULES: GateRule[] = [
  {
    id: "POWERSHELL_SSH_HEREDOC",
    description:
      "PowerShell cannot reliably pass heredoc or multiline payloads over SSH inline. " +
      "This combination reliably causes hangs or timeouts.",
    match: (ctx: CommandContext) =>
      ctx.shell === "powershell" &&
      ctx.target === "remote-ssh" &&
      (ctx.hasHeredoc || ctx.isMultiline),
    verdict: "deny",
    alternative:
      "Use stdin piping: `echo 'script content' | ssh user@host bash` " +
      "or transfer a temp script file via scp then execute it.",
    reason:
      "PowerShell + SSH + heredoc/multiline is a known-bad combination that causes timeouts.",
  },

  {
    id: "CMD_SSH_MULTILINE",
    description: "Windows CMD cannot handle multiline SSH payloads inline.",
    match: (ctx: CommandContext) =>
      ctx.shell === "cmd" && ctx.target === "remote-ssh" && ctx.isMultiline,
    verdict: "deny",
    alternative:
      "Use PowerShell with stdin piping, or transfer a batch/shell script file first.",
    reason: "CMD.EXE + SSH + multiline payload is unsupported and will fail.",
  },

  {
    id: "COMPLEX_INLINE_SSH",
    description: "Long inline SSH commands with complex payloads are fragile.",
    match: (ctx: CommandContext) =>
      ctx.target === "remote-ssh" &&
      ctx.transportClass === "inline" &&
      ctx.payloadLength > 300,
    verdict: "warn",
    alternative:
      "For commands > 300 chars, use stdin piping or a temp script file for reliability.",
    reason: "Long inline SSH commands are prone to quoting errors and shell escaping issues.",
  },

  {
    id: "NESTED_QUOTE_SSH",
    description: "Deeply nested quotes in SSH commands cause escaping failures across shells.",
    match: (ctx: CommandContext) =>
      ctx.target === "remote-ssh" && ctx.hasComplexQuoting,
    verdict: "warn",
    alternative:
      "Use base64 encoding for the payload, or a temp file transfer to avoid quote escaping.",
    reason:
      "Complex quoting in SSH commands behaves differently across shells and remote environments.",
  },

  {
    id: "HEREDOC_REMOTE_POWERSHELL",
    description: "PowerShell here-strings over remote targets are unreliable.",
    match: (ctx: CommandContext) =>
      ctx.shell === "powershell" &&
      ctx.target !== "local" &&
      ctx.hasHeredoc,
    verdict: "deny",
    alternative:
      "Convert here-string to a file: write to a temp `.ps1` file, transfer it, execute remotely.",
    reason:
      "PowerShell here-strings (@'...'@ / @\"...\"@) do not survive SSH transport reliably.",
  },
];

export function getBuiltInRules(): GateRule[] {
  return BUILT_IN_RULES;
}
