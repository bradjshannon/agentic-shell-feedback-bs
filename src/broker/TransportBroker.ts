import type { BrokerResult, BrokerStrategy, CommandContext } from "../types.js";

const INLINE_MAX_LENGTH = 200;
const STDIN_MAX_LENGTH = 2000;

/**
 * Stateless broker: selects the safest transport strategy for a given context + payload.
 * Does NOT execute — returns a command template for the caller to use.
 */
export class TransportBroker {
  /**
   * Given the context and the actual payload to run remotely, recommend a safe transport.
   */
  selectStrategy(context: CommandContext, payload: string): BrokerResult {
    if (context.target === "local") {
      return localResult(context, payload);
    }

    if (context.target === "remote-ssh") {
      return sshResult(context, payload);
    }

    // remote-other (kubectl exec, docker exec, etc.)
    return remoteOtherResult(context, payload);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function localResult(context: CommandContext, payload: string): BrokerResult {
  // Local is safe regardless; just categorize for completeness
  if (payload.length <= INLINE_MAX_LENGTH && !context.isMultiline) {
    return {
      strategy: "inline",
      commandTemplate: payload,
      rationale: "Short, single-line local command — inline is fine.",
    };
  }

  if (context.shell === "powershell") {
    return {
      strategy: "file",
      commandTemplate: buildPsFileTemplate(payload),
      rationale: "PowerShell multiline commands are cleaner via a script file.",
    };
  }

  return {
    strategy: "stdin",
    commandTemplate: buildBashStdinTemplate(payload),
    rationale: "Multiline local command piped via stdin.",
  };
}

function sshResult(context: CommandContext, payload: string): BrokerResult {
  // PowerShell → SSH: always use file transport for multiline/heredoc
  if (context.shell === "powershell" && (context.isMultiline || context.hasHeredoc)) {
    return {
      strategy: "file",
      commandTemplate: buildPsSshFileTemplate(payload),
      rationale:
        "PowerShell + SSH + multiline/heredoc must use file transport to avoid timeout.",
    };
  }

  // Short, simple command: inline is fine
  if (
    payload.length <= INLINE_MAX_LENGTH &&
    !context.isMultiline &&
    !context.hasHeredoc &&
    !context.hasComplexQuoting
  ) {
    return {
      strategy: "inline",
      commandTemplate: buildSshInlineTemplate(payload),
      rationale: "Short, simple SSH command — inline is safe.",
    };
  }

  // Medium complexity: stdin pipe
  if (payload.length <= STDIN_MAX_LENGTH && !context.hasComplexQuoting) {
    return {
      strategy: "stdin",
      commandTemplate: buildSshStdinTemplate(payload),
      rationale:
        "Medium-complexity SSH payload — stdin piping avoids quoting issues.",
    };
  }

  // Complex or long: file transfer
  return {
    strategy: "file",
    commandTemplate: buildSshFileTemplate(payload),
    rationale:
      "Complex/long SSH payload — script file transfer is the most reliable approach.",
  };
}

function remoteOtherResult(_context: CommandContext, payload: string): BrokerResult {
  if (payload.length <= INLINE_MAX_LENGTH) {
    return {
      strategy: "inline",
      commandTemplate: payload,
      rationale: "Short payload for non-SSH remote target — inline.",
    };
  }
  return {
    strategy: "stdin",
    commandTemplate: `echo ${JSON.stringify(payload)} | <remote-executor>`,
    rationale: "Use stdin for longer payloads on non-SSH remote targets.",
  };
}

// ─── Template builders ────────────────────────────────────────────────────────

function buildSshInlineTemplate(payload: string): string {
  const escaped = payload.replace(/'/g, "'\\''");
  return `ssh <user@host> '${escaped}'`;
}

function buildSshStdinTemplate(payload: string): string {
  return `printf '%s' ${JSON.stringify(payload)} | ssh <user@host> bash`;
}

function buildSshFileTemplate(payload: string): string {
  return (
    `# 1. Write payload to temp file\n` +
    `cat > /tmp/_agent_payload.sh << 'AGENTEOF'\n${payload}\nAGENTEOF\n` +
    `# 2. Transfer\n` +
    `scp /tmp/_agent_payload.sh <user@host>:/tmp/_agent_payload.sh\n` +
    `# 3. Execute and clean up\n` +
    `ssh <user@host> 'bash /tmp/_agent_payload.sh; rm /tmp/_agent_payload.sh'`
  );
}

function buildPsSshFileTemplate(payload: string): string {
  return (
    `# PowerShell: write payload to temp file, transfer, execute\n` +
    `$payload = @'\n${payload}\n'@\n` +
    `$tmp = [System.IO.Path]::GetTempFileName() + '.sh'\n` +
    `$payload | Set-Content $tmp -Encoding UTF8\n` +
    `scp $tmp <user@host>:/tmp/_agent_payload.sh\n` +
    `ssh <user@host> 'bash /tmp/_agent_payload.sh; rm /tmp/_agent_payload.sh'\n` +
    `Remove-Item $tmp`
  );
}

function buildBashStdinTemplate(payload: string): string {
  return `printf '%s' ${JSON.stringify(payload)} | bash`;
}

function buildPsFileTemplate(payload: string): string {
  return (
    `$script = @'\n${payload}\n'@\n` +
    `$tmp = [System.IO.Path]::GetTempFileName() + '.ps1'\n` +
    `$script | Set-Content $tmp\n` +
    `& $tmp\n` +
    `Remove-Item $tmp`
  );
}
