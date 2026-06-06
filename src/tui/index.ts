import { homedir } from "node:os";
import { LearningLoop } from "../LearningLoop.js";
import { install, checkInstalled, uninstall } from "../installer/index.js";
import { computeMetrics } from "../eval/Metrics.js";
import type { AgentTarget } from "../installer/index.js";
import type { FailurePattern } from "../types.js";

// ─── ANSI helpers ──────────────────────────────────────────────────────────

const A = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
  bgBlue: "\x1b[44m",
  bgCyan: "\x1b[46m",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  clearScreen: "\x1b[2J\x1b[H",
  move: (r: number, c: number) => `\x1b[${r};${c}H`,
};

// ─── Box-drawing ───────────────────────────────────────────────────────────

const B = { h: "─", v: "│", tl: "┌", tr: "┐", bl: "└", br: "┘", ml: "├", mr: "┤" };

function pad(s: string, len: number): string {
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "");
  const gap = len - visible.length;
  return gap > 0 ? s + " ".repeat(gap) : s;
}

function hr(width: number): string {
  return B.h.repeat(width);
}

// ─── State ─────────────────────────────────────────────────────────────────

type Screen = "menu" | "manage-install" | "patterns" | "preflight" | "report" | "learn" | "export" | "import";

const SHELLS = ["auto-detect", "bash", "zsh", "sh", "powershell", "cmd", "fish"];
const TARGETS = ["auto-detect", "local", "remote-ssh", "remote-other"];

interface ManageEntry {
  agent: AgentTarget;
  scope: "global" | "repo";
  hint: string[];
  installed: boolean;
  selected: boolean;
}

interface State {
  screen: Screen;
  // menu
  menuIdx: number;
  // manage-install
  manageEntries: ManageEntry[];
  manageIdx: number;
  manageSection: "list" | "run";
  manageLoaded: boolean;
  // patterns
  patternsData: FailurePattern[];
  patternIdx: number;
  patternsLoaded: boolean;
  pendingAction: "delete-pattern" | "toggle-pattern" | null;
  // preflight
  preflightCmd: string;
  preflightShellIdx: number;
  preflightTargetIdx: number;
  preflightSection: "cmd" | "shell" | "target" | "run";
  // export/import
  ioPath: string;
  ioSection: "path" | "run";
  // shared
  output: string[];
  status: "idle" | "loading" | "done" | "error";
  reportData: string[];
}

// ─── Install matrix ────────────────────────────────────────────────────────

const INSTALL_MATRIX: Array<{ agent: AgentTarget; scope: "global" | "repo"; hint: string[] }> = [
  { agent: "claude-code", scope: "global", hint: ["Claude Code hooks for all projects.", "Also covers VS Code Copilot agent mode.", "", "Writes to:  ~/.claude/hooks/", "Config:     ~/.claude/settings.json"] },
  { agent: "claude-code", scope: "repo",   hint: ["Claude Code hooks for this project only.", "Also covers VS Code Copilot agent mode.", "", "Writes to:  .claude/hooks/", "Config:     .claude/settings.json"] },
  { agent: "cursor",      scope: "global", hint: ["Cursor hooks for all projects.", "Requires Cursor v1.7+.", "", "Writes to:  ~/.cursor/hooks/", "Config:     ~/.cursor/hooks.json"] },
  { agent: "cursor",      scope: "repo",   hint: ["Cursor hooks for this project only.", "Requires Cursor v1.7+.", "", "Writes to:  .cursor/hooks/", "Config:     .cursor/hooks.json"] },
  { agent: "cline",       scope: "repo",   hint: ["Cline hooks for this project.", "Requires Cline v3.36+. macOS/Linux only.", "", "Writes to:  .clinerules/hooks/"] },
  { agent: "openhands",   scope: "repo",   hint: ["OpenHands hooks for this project.", "Same format as Claude Code.", "", "Writes to:  .openhands/hooks/", "Config:     .openhands/hooks.json"] },
  { agent: "copilot",     scope: "repo",   hint: ["GitHub Copilot cloud agent hooks.", "Not for VS Code — use claude-code for that.", "", "Writes to:  .github/hooks/", "Creates:    copilot-setup-steps.yml"] },
  { agent: "generic",     scope: "repo",   hint: ["Generic shell wrapper (Aider, SWE-agent...)", "No native hook support needed.", "", "Writes to:  bin/wrap-exec.sh"] },
];

function initialState(): State {
  return {
    screen: "menu",
    menuIdx: 0,
    manageEntries: INSTALL_MATRIX.map((m) => ({ ...m, installed: false, selected: false })),
    manageIdx: 0,
    manageSection: "list",
    manageLoaded: false,
    patternsData: [],
    patternIdx: 0,
    patternsLoaded: false,
    pendingAction: null,
    preflightCmd: "",
    preflightShellIdx: 0,
    preflightTargetIdx: 0,
    preflightSection: "cmd",
    ioPath: "",
    ioSection: "path",
    output: [],
    status: "idle",
    reportData: [],
  };
}

// ─── Menu item metadata ────────────────────────────────────────────────────

const MENU_ITEMS = [
  {
    label: "Configure Agents",
    key: "manage-install" as Screen,
    desc: [
      "Install or remove hooks for each agent",
      "and scope via a live checkbox matrix.",
      "",
      "Checks disk for existing installations.",
      "Toggle checkboxes, then Apply.",
      "",
      "↑ = will install   ↓ = will uninstall",
      "",
      "Supported agents:",
      "  claude-code  cursor  cline",
      "  openhands  copilot  generic",
      "",
      "Scopes: global (home dir) or repo (cwd)",
    ],
  },
  {
    label: "Manage Patterns",
    key: "patterns" as Screen,
    desc: [
      "Review all learned failure patterns.",
      "",
      "Status badges:",
      "  [B] blocking  — blocks the command",
      "  [A] advisory  — warns only",
      "  [E] expired   — inactive",
      "",
      "Actions:",
      "  b  toggle advisory ↔ blocking",
      "  d  delete the pattern",
      "",
      "Detail panel shows signature,",
      "approach, alternative, and stats.",
    ],
  },
  {
    label: "Check Command",
    key: "preflight" as Screen,
    desc: [
      "Run a preflight check on a shell command.",
      "",
      "Results:",
      "  OK       safe to run",
      "  WARN     allowed with warnings",
      "  BLOCKED  known-bad pattern; an",
      "           alternative is suggested",
      "",
      "Optionally set shell and target for",
      "more accurate pattern matching.",
      "",
      "Exit code 2 = blocked (same as hooks).",
    ],
  },
  {
    label: "View Report",
    key: "report" as Screen,
    desc: [
      "Show a summary of the pattern registry",
      "and learning metrics.",
      "",
      "Metrics (last 30 days):",
      "  • First-attempt success rate",
      "  • Timeout minutes per 100 tasks",
      "  • Repeated pattern recurrence",
      "  • Transport-switch compliance",
      "",
      "Blocking patterns are listed with their",
      "failed approach and recommended",
      "alternative.",
    ],
  },
  {
    label: "Run Learn",
    key: "learn" as Screen,
    desc: [
      "Run the policy engine over recorded",
      "traces to promote/expire patterns.",
      "",
      "Promotion (advisory → blocking):",
      "  (≥ 2 mechanical failures in 30 days",
      "   OR ≥ 60s wasted) AND a known fix",
      "",
      "Without a known alternative a pattern",
      "stays advisory and only warns.",
      "",
      "Expiration: no occurrence in 90 days.",
    ],
  },
  {
    label: "Export Patterns",
    key: "export" as Screen,
    desc: [
      "Export the pattern registry as JSON.",
      "",
      "Use this to:",
      "  • Back up your learned patterns",
      "  • Share patterns with teammates",
      "  • Seed a new machine's registry",
      "",
      "Patterns are private by default.",
      "Use --remote --push to have the Stop",
      "hook commit them to the repo.",
    ],
  },
  {
    label: "Import Patterns",
    key: "import" as Screen,
    desc: [
      "Import patterns from a JSON file.",
      "",
      "Merges with existing patterns without",
      "creating duplicates (deduplicates by",
      "signature).",
      "",
      "Safe to run multiple times or against",
      "patterns from multiple sources.",
      "",
      "Reads from stdin if no path given.",
    ],
  },
];

// ─── Renderer ──────────────────────────────────────────────────────────────

function cols(): number {
  return Math.max(process.stdout.columns ?? 80, 78);
}
function rows(): number {
  return Math.max(process.stdout.rows ?? 24, 20);
}

function write(s: string): void {
  process.stdout.write(s);
}

function renderFrame(title: string): { innerW: number; innerH: number } {
  const W = cols();
  const H = rows();
  const innerW = W - 2;
  const innerH = H - 4; // top border + header row + bottom border + footer

  let out = A.clearScreen;

  // Top border + title
  const titleStr = ` agentic-feedback ${A.dim}·${A.reset} ${A.bold}${title}${A.reset} `;
  const titleLen = titleStr.replace(/\x1b\[[0-9;]*m/g, "").length;
  const rightFill = hr(innerW - titleLen);
  out += A.cyan + B.tl + titleStr + rightFill + B.tr + A.reset + "\n";

  // Storage dir line
  const storageDir = `${A.dim}  ${homedir()}/.agentic-feedback/${A.reset}`;
  out += A.cyan + B.v + A.reset + pad(storageDir, innerW) + A.cyan + B.v + A.reset + "\n";

  // Separator
  out += A.cyan + B.ml + hr(innerW) + B.mr + A.reset + "\n";

  write(out);
  return { innerW, innerH };
}

function renderFooter(hints: string[]): void {
  const W = cols();
  const H = rows();
  const innerW = W - 2;

  write(A.move(H - 1, 1));
  write(A.cyan + B.ml + hr(innerW) + B.mr + A.reset + "\n");

  const footer = hints.map((h) => A.dim + h + A.reset).join(`  ${A.gray}·${A.reset}  `);
  const footerPlain = footer.replace(/\x1b\[[0-9;]*m/g, "");
  const padding = Math.max(0, Math.floor((W - footerPlain.length) / 2));
  write(A.cyan + B.bl + A.reset + " ".repeat(padding) + footer + "\n");
}

function renderLine(col: number, content: string, width: number): void {
  write(A.cyan + B.v + A.reset + pad(content, width) + A.cyan + B.v + A.reset + "\n");
}

// ─── Screen: Main Menu ─────────────────────────────────────────────────────

function renderMenu(state: State): void {
  const { innerW, innerH } = renderFrame("Main Menu");
  const leftW = 26;
  const rightW = innerW - leftW - 3; // 3 = '│ ' padding
  const bodyRows = innerH - 2;

  const item = MENU_ITEMS[state.menuIdx];

  for (let r = 0; r < bodyRows; r++) {
    let left = "";
    if (r === 0) {
      left = ""; // blank
    } else if (r - 1 < MENU_ITEMS.length) {
      const i = r - 1;
      const m = MENU_ITEMS[i]!;
      const active = i === state.menuIdx;
      const prefix = active ? A.bold + A.cyan + " ▶ " + A.reset : "   ";
      const label = active ? A.bold + m.label + A.reset : m.label;
      left = prefix + label;
    }

    let right = "";
    if (item) {
      if (r === 0) right = A.bold + A.cyan + item.label + A.reset;
      else if (r === 1) right = A.dim + hr(Math.min(rightW, item.label.length + 4)) + A.reset;
      else {
        const descLine = item.desc[r - 2];
        right = descLine !== undefined ? descLine : "";
      }
    }

    const leftPadded = pad(left, leftW);
    const sep = A.cyan + " " + B.v + A.reset + " ";
    const rightPadded = pad(right, rightW);
    write(A.cyan + B.v + A.reset + leftPadded + sep + rightPadded + A.cyan + B.v + A.reset + "\n");
  }

  // Bottom border
  write(A.cyan + B.bl + hr(leftW + 1) + "┴" + hr(rightW + 2) + B.br + A.reset + "\n");

  renderFooter(["↑↓ Navigate", "Enter Select", "q Quit"]);
}

// ─── Screen: Manage Install ────────────────────────────────────────────────

function renderManageInstall(state: State): void {
  const { innerW, innerH } = renderFrame("Configure Agents");
  const leftW = 38;
  const rightW = innerW - leftW - 3;
  const bodyRows = innerH - 2;

  if (!state.manageLoaded) {
    // Show loading state centered
    for (let r = 0; r < bodyRows; r++) {
      if (r === Math.floor(bodyRows / 2)) {
        const msg = A.yellow + "  Loading..." + A.reset;
        const msgLen = "  Loading...".length;
        const p = Math.floor((innerW - msgLen) / 2);
        renderLine(0, " ".repeat(p) + A.yellow + "Loading..." + A.reset, innerW);
      } else {
        renderLine(0, "", innerW);
      }
    }
    write(A.cyan + B.bl + hr(innerW) + B.br + A.reset + "\n");
    renderFooter(["Loading..."]);
    return;
  }

  const focusedEntry = state.manageEntries[state.manageIdx];
  const pendingCount = state.manageEntries.filter((e) => e.selected !== e.installed).length;

  for (let r = 0; r < bodyRows; r++) {
    if (r === bodyRows - 4) {
      // Apply button
      const focused = state.manageSection === "run";
      let btn: string;
      if (pendingCount > 0) {
        btn = focused
          ? `${A.bgCyan}${A.bold}  Apply (${pendingCount} change${pendingCount !== 1 ? "s" : ""})  ${A.reset}`
          : `  [ Apply (${pendingCount} change${pendingCount !== 1 ? "s" : ""}) ]  `;
      } else {
        btn = A.dim + "  Nothing to apply  " + A.reset;
      }
      const btnPlain = btn.replace(/\x1b\[[0-9;]*m/g, "");
      const p = Math.floor((innerW - btnPlain.length) / 2);
      renderLine(0, " ".repeat(p) + btn, innerW);
      continue;
    }

    if (r === bodyRows - 2) {
      renderLine(0, A.dim + "  Output" + A.reset, innerW);
      continue;
    }

    if (r === bodyRows - 1) {
      const line = state.status === "loading"
        ? `  ${A.yellow}Applying...${A.reset}`
        : state.output.length > 0
          ? `  ${state.status === "error" ? A.red : A.green}${state.output[state.output.length - 1] ?? ""}${A.reset}`
          : `  ${A.dim}(results will appear here)${A.reset}`;
      renderLine(0, line, innerW);
      continue;
    }

    let left = "";
    let right = "";

    if (r === 0) {
      left = A.dim + "  Agent / Scope" + A.reset;
      right = A.dim + "  About" + A.reset;
    } else if (r === 1) {
      left = A.dim + "  " + hr(leftW - 2) + A.reset;
      right = A.dim + "  " + hr(rightW - 2) + A.reset;
    } else {
      const entryIdx = r - 2;
      if (entryIdx < state.manageEntries.length) {
        const entry = state.manageEntries[entryIdx]!;
        const focused = state.manageSection === "list" && entryIdx === state.manageIdx;
        const prefix = focused ? A.bold + A.cyan + "▶ " + A.reset : "  ";
        const checkbox = entry.selected ? A.green + "[✓]" + A.reset : "[ ]";
        const label = `${entry.agent} / ${entry.scope}`;

        // Status indicator: ● installed, ○ not installed
        const dot = entry.installed ? A.green + "●" + A.reset : A.dim + "○" + A.reset;

        // Change indicator
        let changeIndicator = "";
        if (entry.selected && !entry.installed) {
          changeIndicator = " " + A.cyan + "↑" + A.reset;
        } else if (!entry.selected && entry.installed) {
          changeIndicator = " " + A.yellow + "↓" + A.reset;
        }

        left = prefix + checkbox + " " + label + "   " + dot + changeIndicator;

        // Right panel: hint lines or pending changes summary
        if (state.manageSection === "run") {
          // Show pending changes summary
          const changes = state.manageEntries.filter((e) => e.selected !== e.installed);
          if (r - 2 === 0) {
            right = A.dim + "  Pending changes:" + A.reset;
          } else if (r - 2 === 1) {
            right = A.dim + "  " + hr(rightW - 4) + A.reset;
          } else {
            const ci = r - 4;
            if (ci >= 0 && ci < changes.length) {
              const c = changes[ci]!;
              if (c.selected && !c.installed) {
                right = "  " + A.cyan + `+ ${c.agent} / ${c.scope}` + A.reset;
              } else {
                right = "  " + A.yellow + `- ${c.agent} / ${c.scope}` + A.reset;
              }
            }
          }
        } else {
          // Show focused entry's hint
          if (focusedEntry) {
            const hi = r - 2;
            right = hi < focusedEntry.hint.length ? "  " + focusedEntry.hint[hi]! : "";
          }
        }
      } else if (focusedEntry && state.manageSection === "list") {
        // Extra hint lines below the list
        const hi = r - 2;
        right = hi < focusedEntry.hint.length ? "  " + focusedEntry.hint[hi]! : "";
      }
    }

    const leftPadded = pad(left, leftW);
    const sep = A.cyan + " " + B.v + A.reset + " ";
    const rightPadded = pad(right, rightW);
    write(A.cyan + B.v + A.reset + leftPadded + sep + rightPadded + A.cyan + B.v + A.reset + "\n");
  }

  write(A.cyan + B.bl + hr(innerW) + B.br + A.reset + "\n");
  renderFooter(["↑↓ Navigate", "Space Toggle", "Tab Switch section", "Enter Apply", "Esc Back"]);
}

// ─── Screen: Patterns ─────────────────────────────────────────────────────

function renderPatterns(state: State): void {
  const { innerW, innerH } = renderFrame("Manage Patterns");
  const leftW = 40;
  const rightW = innerW - leftW - 3;
  const bodyRows = innerH - 2;

  if (!state.patternsLoaded) {
    for (let r = 0; r < bodyRows; r++) {
      if (r === Math.floor(bodyRows / 2)) {
        const msgLen = "Loading...".length;
        const p = Math.floor((innerW - msgLen) / 2);
        renderLine(0, " ".repeat(p) + A.yellow + "Loading..." + A.reset, innerW);
      } else {
        renderLine(0, "", innerW);
      }
    }
    write(A.cyan + B.bl + hr(innerW) + B.br + A.reset + "\n");
    renderFooter(["Loading..."]);
    return;
  }

  const patterns = state.patternsData;
  const focused = patterns[state.patternIdx];

  for (let r = 0; r < bodyRows; r++) {
    if (r === bodyRows - 2) {
      renderLine(0, A.dim + "  Output" + A.reset, innerW);
      continue;
    }

    if (r === bodyRows - 1) {
      const line = state.output.length > 0
        ? `  ${state.status === "error" ? A.red : A.green}${state.output[state.output.length - 1] ?? ""}${A.reset}`
        : `  ${A.dim}d=delete  b=toggle advisory/blocking${A.reset}`;
      renderLine(0, line, innerW);
      continue;
    }

    let left = "";
    let right = "";

    if (r === 0) {
      left = A.dim + `  Patterns (${patterns.length})` + A.reset;
      right = focused ? A.dim + "  Detail" + A.reset : "";
    } else if (r === 1) {
      left = A.dim + "  " + hr(leftW - 2) + A.reset;
      right = focused ? A.dim + "  " + hr(rightW - 4) + A.reset : "";
    } else {
      const pi = r - 2;
      if (pi < patterns.length) {
        const p = patterns[pi]!;
        const isFocused = pi === state.patternIdx;
        const prefix = isFocused ? A.bold + A.cyan + "▶ " + A.reset : "  ";

        // Status badge
        let badge: string;
        if (p.status === "blocking") badge = A.red + "[B]" + A.reset;
        else if (p.status === "advisory") badge = A.yellow + "[A]" + A.reset;
        else badge = A.dim + "[E]" + A.reset;

        // Truncate signature to fit
        const maxSigLen = leftW - 14; // prefix(2) + badge(3) + space(1) + count(4) + padding
        const sig = p.signature.length > maxSigLen
          ? p.signature.slice(0, maxSigLen - 1) + "…"
          : p.signature;

        // Occurrence count right-aligned
        const countStr = `${p.occurrences}×`;
        const sigPad = leftW - 2 - 3 - 1 - countStr.length - 2; // subtract prefix, badge, spaces
        const sigFitted = sig.length > sigPad ? sig.slice(0, sigPad - 1) + "…" : sig.padEnd(sigPad);

        left = prefix + badge + " " + sigFitted + " " + A.dim + countStr + A.reset;
      } else if (patterns.length === 0 && r === 2) {
        left = A.dim + "  No patterns learned yet." + A.reset;
      }

      // Right panel: detail for focused pattern
      if (focused) {
        const detailLines: string[] = [
          // r=2: status line
          focused.status === "blocking"
            ? A.red + "  Status: BLOCKING" + A.reset
            : focused.status === "advisory"
              ? A.yellow + "  Status: ADVISORY" + A.reset
              : A.dim + "  Status: EXPIRED" + A.reset,
          // r=3: separator
          A.dim + "  " + hr(rightW - 4) + A.reset,
          // r=4+: details
          "  " + A.dim + "Sig: " + A.reset + focused.signature.slice(0, rightW - 8),
          focused.signature.length > rightW - 8
            ? "       " + focused.signature.slice(rightW - 8, rightW - 8 + rightW - 9)
            : "",
          "  " + A.dim + "Approach: " + A.reset + focused.failedApproach.slice(0, rightW - 12),
          "  " + A.dim + "Use: " + A.reset + focused.successfulAlternative.slice(0, rightW - 8),
          "",
          `  ${A.dim}${focused.occurrences}× seen,${A.reset} ${(focused.wasted_ms / 60000).toFixed(1)} min wasted`,
          `  ${A.dim}First: ${focused.firstSeen.slice(0, 10)}  Last: ${focused.lastSeen.slice(0, 10)}${A.reset}`,
        ];
        const di = r - 2;
        if (di >= 0 && di < detailLines.length) {
          right = detailLines[di] ?? "";
        }
      }
    }

    const leftPadded = pad(left, leftW);
    const sep = A.cyan + " " + B.v + A.reset + " ";
    const rightPadded = pad(right, rightW);
    write(A.cyan + B.v + A.reset + leftPadded + sep + rightPadded + A.cyan + B.v + A.reset + "\n");
  }

  write(A.cyan + B.bl + hr(innerW) + B.br + A.reset + "\n");
  renderFooter(["↑↓ Navigate", "d Delete", "b Toggle status", "Esc Back"]);
}

// ─── Screen: Preflight ─────────────────────────────────────────────────────

function renderPreflight(state: State): void {
  const { innerW, innerH } = renderFrame("Check Command");
  const bodyRows = innerH - 2;

  const cmdFocused = state.preflightSection === "cmd";
  const shellFocused = state.preflightSection === "shell";
  const targetFocused = state.preflightSection === "target";
  const runFocused = state.preflightSection === "run";

  const halfW = Math.floor((innerW - 3) / 2);
  const shellW = halfW;
  const targetW = innerW - halfW - 3;

  for (let r = 0; r < bodyRows; r++) {
    if (r === 0) {
      renderLine(0, A.dim + "  Command" + A.reset, innerW);
    } else if (r === 1) {
      renderLine(0, A.dim + "  " + hr(innerW - 4) + A.reset, innerW);
    } else if (r === 2) {
      const cursor = cmdFocused ? A.bold + A.cyan + "▶ " : A.dim + "  ";
      const cmdDisplay = state.preflightCmd || (cmdFocused ? "" : A.dim + "(enter a command)" + A.reset);
      const caretChar = cmdFocused ? A.reset + A.bold + "█" + A.reset : "";
      renderLine(0, `  ${cursor}${cmdDisplay}${caretChar}${A.reset}`, innerW);
    } else if (r === 4) {
      // shell / target header
      const shellHdr = A.dim + "  Shell" + A.reset;
      const targetHdr = A.dim + "  Target" + A.reset;
      write(A.cyan + B.v + A.reset + pad(shellHdr, shellW) + A.cyan + " " + B.v + A.reset + " " + pad(targetHdr, targetW) + A.cyan + B.v + A.reset + "\n");
    } else if (r === 5) {
      const sl = A.dim + "  " + hr(shellW - 4) + A.reset;
      const tl = A.dim + "  " + hr(targetW - 4) + A.reset;
      write(A.cyan + B.v + A.reset + pad(sl, shellW) + A.cyan + " " + B.v + A.reset + " " + pad(tl, targetW) + A.cyan + B.v + A.reset + "\n");
    } else if (r >= 6 && r - 6 < Math.max(SHELLS.length, TARGETS.length)) {
      const si = r - 6;
      let sl = "";
      let tl = "";
      if (si < SHELLS.length) {
        const active = si === state.preflightShellIdx;
        sl = "  " + (active ? (shellFocused ? A.cyan + A.bold + "◉ " : A.bold + "◉ ") : "○ ") + (active ? A.bold : "") + SHELLS[si]! + A.reset;
      }
      if (si < TARGETS.length) {
        const active = si === state.preflightTargetIdx;
        tl = "  " + (active ? (targetFocused ? A.cyan + A.bold + "◉ " : A.bold + "◉ ") : "○ ") + (active ? A.bold : "") + TARGETS[si]! + A.reset;
      }
      write(A.cyan + B.v + A.reset + pad(sl, shellW) + A.cyan + " " + B.v + A.reset + " " + pad(tl, targetW) + A.cyan + B.v + A.reset + "\n");
    } else if (r === bodyRows - 4) {
      const btn = runFocused ? `${A.bgCyan}${A.bold}  Check  ${A.reset}` : "  [ Check ]  ";
      const btnPlain = btn.replace(/\x1b\[[0-9;]*m/g, "");
      const p = Math.floor((innerW - btnPlain.length) / 2);
      renderLine(0, " ".repeat(p) + btn, innerW);
    } else if (r === bodyRows - 2) {
      renderLine(0, A.dim + "  Output" + A.reset, innerW);
    } else if (r === bodyRows - 1) {
      if (state.status === "loading") {
        renderLine(0, `  ${A.yellow}Checking...${A.reset}`, innerW);
      } else if (state.output.length > 0) {
        const color = state.status === "error" ? A.red : state.output[0]?.startsWith("BLOCKED") ? A.red : A.green;
        renderLine(0, `  ${color}${state.output[0] ?? ""}${A.reset}`, innerW);
      } else {
        renderLine(0, `  ${A.dim}(result will appear here)${A.reset}`, innerW);
      }
    } else {
      renderLine(0, "", innerW);
    }
  }

  write(A.cyan + B.bl + hr(innerW) + B.br + A.reset + "\n");
  const footHints = ["Tab Switch", "↑↓ Select", "Enter " + (cmdFocused ? "Confirm cmd" : "Run"), "Esc Back"];
  renderFooter(footHints);
}

// ─── Screen: Report ────────────────────────────────────────────────────────

function renderReport(state: State): void {
  const { innerW, innerH } = renderFrame("Registry Report");
  const bodyRows = innerH - 2;

  for (let r = 0; r < bodyRows; r++) {
    const line = state.reportData[r] ?? "";
    renderLine(0, line, innerW);
  }

  write(A.cyan + B.bl + hr(innerW) + B.br + A.reset + "\n");
  renderFooter(["r Refresh", "Esc Back"]);
}

// ─── Screen: Learn ─────────────────────────────────────────────────────────

function renderLearn(state: State): void {
  const { innerW, innerH } = renderFrame("Run Learn");
  const bodyRows = innerH - 2;

  const lines = [
    "",
    `  Evaluates recorded traces and promotes a pattern to`,
    `  blocking only when both conditions hold:`,
    "",
    `    ${A.cyan}≥ 2 mechanical failures in 30 days  OR  ≥ 60s wasted${A.reset}`,
    `    ${A.cyan}AND a known alternative to suggest${A.reset}`,
    "",
    `  Without a known fix, a pattern stays advisory (warns only).`,
    `  Patterns not seen in 90 days are expired.`,
    "",
    `  ${A.dim}This runs automatically via the Stop hook at session end.${A.reset}`,
  ];

  for (let r = 0; r < bodyRows; r++) {
    if (r === bodyRows - 4) {
      const runFocused = true;
      const btn = state.status === "idle" || state.status === "done" || state.status === "error"
        ? (runFocused ? `${A.bgCyan}${A.bold}  Run Learn  ${A.reset}` : "  [ Run Learn ]  ")
        : `  ${A.yellow}Running...${A.reset}`;
      const btnPlain = btn.replace(/\x1b\[[0-9;]*m/g, "");
      const p = Math.floor((innerW - btnPlain.length) / 2);
      renderLine(0, " ".repeat(p) + btn, innerW);
    } else if (r === bodyRows - 2) {
      renderLine(0, A.dim + "  Output" + A.reset, innerW);
    } else if (r === bodyRows - 1) {
      if (state.output.length > 0) {
        const color = state.status === "error" ? A.red : A.green;
        renderLine(0, `  ${color}${state.output[0] ?? ""}${A.reset}`, innerW);
      } else {
        renderLine(0, `  ${A.dim}(results will appear here)${A.reset}`, innerW);
      }
    } else {
      renderLine(0, lines[r] ?? "", innerW);
    }
  }

  write(A.cyan + B.bl + hr(innerW) + B.br + A.reset + "\n");
  renderFooter(["Enter Run", "Esc Back"]);
}

// ─── Screen: Export / Import ───────────────────────────────────────────────

function renderIO(state: State, isExport: boolean): void {
  const { innerW, innerH } = renderFrame(isExport ? "Export Patterns" : "Import Patterns");
  const bodyRows = innerH - 2;

  const pathFocused = state.ioSection === "path";
  const runFocused = state.ioSection === "run";

  const descLines = isExport
    ? [
        "",
        "  Exports the full pattern registry as JSON.",
        "  Leave path empty to write to stdout.",
        "",
        `  Default: ${A.dim}~/.agentic-feedback/registry.json${A.reset}`,
        "",
        "  Use the exported file to seed another",
        "  machine or share with teammates.",
        "",
      ]
    : [
        "",
        "  Imports patterns from a JSON export file.",
        "  Leave path empty to read from stdin.",
        "",
        "  Merges with existing patterns.",
        "  Deduplicates by signature — safe to run",
        "  multiple times or from multiple sources.",
        "",
      ];

  for (let r = 0; r < bodyRows; r++) {
    if (r < descLines.length) {
      renderLine(0, descLines[r] ?? "", innerW);
    } else if (r === descLines.length) {
      renderLine(0, A.dim + "  File path (optional)" + A.reset, innerW);
    } else if (r === descLines.length + 1) {
      renderLine(0, A.dim + "  " + hr(innerW - 4) + A.reset, innerW);
    } else if (r === descLines.length + 2) {
      const cursor = pathFocused ? A.bold + A.cyan + "▶ " : A.dim + "  ";
      const pathDisplay = state.ioPath || (pathFocused ? "" : A.dim + "(leave empty for stdout/stdin)" + A.reset);
      const caret = pathFocused ? A.reset + A.bold + "█" + A.reset : "";
      renderLine(0, `  ${cursor}${pathDisplay}${caret}${A.reset}`, innerW);
    } else if (r === bodyRows - 4) {
      const label = isExport ? "Export" : "Import";
      const btn = runFocused
        ? `${A.bgCyan}${A.bold}  ${label}  ${A.reset}`
        : `  [ ${label} ]  `;
      const btnPlain = btn.replace(/\x1b\[[0-9;]*m/g, "");
      const p = Math.floor((innerW - btnPlain.length) / 2);
      renderLine(0, " ".repeat(p) + btn, innerW);
    } else if (r === bodyRows - 2) {
      renderLine(0, A.dim + "  Output" + A.reset, innerW);
    } else if (r === bodyRows - 1) {
      if (state.status === "loading") {
        renderLine(0, `  ${A.yellow}Running...${A.reset}`, innerW);
      } else if (state.output.length > 0) {
        const color = state.status === "error" ? A.red : A.green;
        renderLine(0, `  ${color}${state.output[0] ?? ""}${A.reset}`, innerW);
      } else {
        renderLine(0, `  ${A.dim}(result will appear here)${A.reset}`, innerW);
      }
    } else {
      renderLine(0, "", innerW);
    }
  }

  write(A.cyan + B.bl + hr(innerW) + B.br + A.reset + "\n");
  const hints = pathFocused
    ? ["Type path", "Enter Confirm", "Tab Move to button", "Esc Back"]
    : ["Tab Back to path", "Enter Run", "Esc Back"];
  renderFooter(hints);
}

// ─── Master render ─────────────────────────────────────────────────────────

function render(state: State): void {
  switch (state.screen) {
    case "menu":           renderMenu(state); break;
    case "manage-install": renderManageInstall(state); break;
    case "patterns":       renderPatterns(state); break;
    case "preflight":      renderPreflight(state); break;
    case "report":         renderReport(state); break;
    case "learn":          renderLearn(state); break;
    case "export":         renderIO(state, true); break;
    case "import":         renderIO(state, false); break;
  }
}

// ─── Actions ───────────────────────────────────────────────────────────────

async function runPreflight(state: State): Promise<State> {
  if (!state.preflightCmd.trim()) {
    return { ...state, status: "error", output: ["No command entered."] };
  }
  const loop = new LearningLoop();
  try {
    const shellVal = state.preflightShellIdx > 0 ? SHELLS[state.preflightShellIdx] : undefined;
    const targetVal = state.preflightTargetIdx > 0 ? TARGETS[state.preflightTargetIdx] : undefined;
    const hints: Record<string, unknown> = {};
    if (shellVal) hints["shell"] = shellVal;
    if (targetVal) hints["target"] = targetVal;
    const result = await loop.preflight(state.preflightCmd, hints as Parameters<typeof loop.preflight>[1]);
    const lines: string[] = [];
    if (result.allowed) {
      if (result.warnings.length > 0) {
        lines.push("WARN: Allowed with warnings:");
        result.warnings.forEach((w) => lines.push("  · " + w));
      } else {
        lines.push("OK: Command passes all preflight checks.");
      }
    } else {
      lines.push("BLOCKED: " + (result.reason ?? "Known-bad pattern."));
      if (result.requiredAlternative) lines.push("Use instead: " + result.requiredAlternative);
    }
    return { ...state, status: result.allowed ? "done" : "error", output: lines };
  } catch (err) {
    return { ...state, status: "error", output: [String(err)] };
  } finally {
    await loop.close();
  }
}

async function runLearn(): Promise<State["output"]> {
  const loop = new LearningLoop();
  try {
    const result = await loop.learn();
    return [`Done. Promoted: ${result.promoted}, expired: ${result.expired}.`];
  } catch (err) {
    return [String(err)];
  } finally {
    await loop.close();
  }
}

async function buildReportData(): Promise<string[]> {
  const loop = new LearningLoop();
  try {
    const data = await loop.registry.getAll();
    const metrics = computeMetrics(data.traces, data.patterns);
    const advisory = data.patterns.filter((p) => p.status === "advisory").length;
    const expired = data.patterns.filter((p) => p.status === "expired").length;

    const lines: string[] = [
      "",
      `  Patterns: ${metrics.totalPatterns} total  (${metrics.blockingPatterns} blocking, ${advisory} advisory, ${expired} expired)`,
      `  Traces:   ${metrics.totalTraces} recorded`,
      "",
      "  Metrics (last 30 days)",
      `  ${B.h.repeat(40)}`,
      `  First-attempt success rate:     ${(metrics.firstAttemptSuccessRate * 100).toFixed(1)}%`,
      `  Repeated pattern recurrence:    ${(metrics.repeatedPatternRecurrenceRate * 100).toFixed(1)}%`,
      `  Timeout minutes per 100 tasks:  ${metrics.timeoutMinutesPer100Tasks.toFixed(1)}`,
      `  Transport-switch compliance:    ${(metrics.transportSwitchCompliance * 100).toFixed(1)}%`,
      "",
    ];

    const blocking = data.patterns.filter((p) => p.status === "blocking");
    if (blocking.length > 0) {
      lines.push("  Blocking Patterns");
      lines.push(`  ${B.h.repeat(40)}`);
      for (const p of blocking) {
        lines.push(`  ${A.cyan}[${p.id.slice(0, 8)}]${A.reset} ${p.signature}`);
        lines.push(`    Failed:   ${p.failedApproach}`);
        lines.push(`    Use:      ${p.successfulAlternative}`);
        lines.push(`    Seen ${p.occurrences}×, ${(p.wasted_ms / 60000).toFixed(1)} min wasted`);
        lines.push("");
      }
    } else {
      lines.push("  No blocking patterns yet.");
    }

    return lines;
  } finally {
    await loop.close();
  }
}

async function runExport(path: string): Promise<State["output"]> {
  const { writeFile } = await import("node:fs/promises");
  const loop = new LearningLoop();
  try {
    const data = await loop.registry.getAll();
    const json = JSON.stringify(data, null, 2);
    if (path.trim()) {
      await writeFile(path.trim(), json, "utf8");
      return [`Exported to ${path.trim()}`];
    } else {
      // Temporarily exit raw mode, print, re-enter
      return [`${metrics_summary(data.patterns.length)} patterns exported (stdout below)`, json];
    }
  } catch (err) {
    return [String(err)];
  } finally {
    await loop.close();
  }
}

function metrics_summary(n: number): string {
  return String(n);
}

async function runImport(path: string): Promise<State["output"]> {
  const { readFile } = await import("node:fs/promises");
  const loop = new LearningLoop();
  try {
    let raw: string;
    if (path.trim()) {
      raw = await readFile(path.trim(), "utf8");
    } else {
      return ["No path provided. Use the CLI: agentic-feedback import < file.json"];
    }
    const parsed = JSON.parse(raw) as { patterns?: unknown[] };
    if (!Array.isArray(parsed.patterns)) throw new Error("Invalid format: expected { patterns: [...] }");

    const data = await loop.registry.getAll();
    const existingSigs = new Set(data.patterns.map((p) => p.signature));
    let added = 0;
    for (const p of parsed.patterns) {
      const pat = p as { signature?: string };
      if (pat.signature && !existingSigs.has(pat.signature)) {
        data.patterns.push(p as (typeof data.patterns)[0]);
        added++;
      }
    }
    // Save via internal storage
    const store = (loop as unknown as { cfg: { storage: { save: (d: unknown) => Promise<void> } } }).cfg.storage;
    await store.save(data);
    return [`Imported ${added} new pattern${added !== 1 ? "s" : ""}.`];
  } catch (err) {
    return [String(err)];
  } finally {
    await loop.close();
  }
}

// ─── Key handler ───────────────────────────────────────────────────────────

const KEY = {
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  enter: "\r",
  enter2: "\n",
  space: " ",
  tab: "\t",
  esc: "\x1b",
  backspace: "\x7f",
  backspace2: "\x08",
  ctrlC: "\x03",
  q: "q",
  b: "b",
  r: "r",
  d: "d",
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function handleKey(key: string, state: State): State | "quit" | "async" {
  // Global
  if (key === KEY.ctrlC) return "quit";

  switch (state.screen) {
    case "menu": {
      if (key === KEY.q) return "quit";
      if (key === KEY.up) return { ...state, menuIdx: clamp(state.menuIdx - 1, 0, MENU_ITEMS.length - 1) };
      if (key === KEY.down) return { ...state, menuIdx: clamp(state.menuIdx + 1, 0, MENU_ITEMS.length - 1) };
      if (key === KEY.enter || key === KEY.enter2) {
        const item = MENU_ITEMS[state.menuIdx];
        if (!item) return state;
        const next: State = { ...state, screen: item.key, output: [], status: "idle" };
        if (item.key === "report") return { ...next, reportData: ["  Loading..."] };
        if (item.key === "manage-install") return { ...next, manageLoaded: false };
        if (item.key === "patterns") return { ...next, patternsLoaded: false };
        return next;
      }
      return state;
    }

    case "manage-install": {
      if (key === KEY.esc || key === KEY.b) return { ...state, screen: "menu", output: [], status: "idle" };
      if (key === KEY.tab) {
        return { ...state, manageSection: state.manageSection === "list" ? "run" : "list" };
      }
      if (state.manageSection === "list") {
        if (key === KEY.up) return { ...state, manageIdx: clamp(state.manageIdx - 1, 0, state.manageEntries.length - 1) };
        if (key === KEY.down) return { ...state, manageIdx: clamp(state.manageIdx + 1, 0, state.manageEntries.length - 1) };
        if (key === KEY.space || key === KEY.enter || key === KEY.enter2) {
          const entries = state.manageEntries.map((e, i) =>
            i === state.manageIdx ? { ...e, selected: !e.selected } : e
          );
          return { ...state, manageEntries: entries };
        }
      } else if (state.manageSection === "run") {
        if (key === KEY.enter || key === KEY.enter2) return "async";
      }
      return state;
    }

    case "patterns": {
      // Only Esc goes back here — `b` is reserved for toggling pattern status below.
      if (key === KEY.esc) return { ...state, screen: "menu", output: [], status: "idle" };
      if (key === KEY.up) return { ...state, patternIdx: clamp(state.patternIdx - 1, 0, Math.max(0, state.patternsData.length - 1)) };
      if (key === KEY.down) return { ...state, patternIdx: clamp(state.patternIdx + 1, 0, Math.max(0, state.patternsData.length - 1)) };
      if (key === KEY.d) {
        if (state.patternsData.length > 0) return { ...state, pendingAction: "delete-pattern" };
        return state;
      }
      if (key === KEY.b) {
        // b on patterns screen: toggle advisory/blocking (not back)
        if (state.patternsData.length > 0) return { ...state, pendingAction: "toggle-pattern" };
        return state;
      }
      return state;
    }

    case "preflight": {
      if (key === KEY.esc || key === KEY.b) return { ...state, screen: "menu", output: [], status: "idle" };
      if (key === KEY.tab) {
        const sections: Array<State["preflightSection"]> = ["cmd", "shell", "target", "run"];
        const idx = sections.indexOf(state.preflightSection);
        return { ...state, preflightSection: sections[(idx + 1) % sections.length]! };
      }
      if (state.preflightSection === "cmd") {
        if (key === KEY.enter || key === KEY.enter2) return { ...state, preflightSection: "shell" };
        if (key === KEY.backspace || key === KEY.backspace2) return { ...state, preflightCmd: state.preflightCmd.slice(0, -1) };
        if (key.length === 1 && key.charCodeAt(0) >= 32) return { ...state, preflightCmd: state.preflightCmd + key };
      } else if (state.preflightSection === "shell") {
        if (key === KEY.up) return { ...state, preflightShellIdx: clamp(state.preflightShellIdx - 1, 0, SHELLS.length - 1) };
        if (key === KEY.down) return { ...state, preflightShellIdx: clamp(state.preflightShellIdx + 1, 0, SHELLS.length - 1) };
      } else if (state.preflightSection === "target") {
        if (key === KEY.up) return { ...state, preflightTargetIdx: clamp(state.preflightTargetIdx - 1, 0, TARGETS.length - 1) };
        if (key === KEY.down) return { ...state, preflightTargetIdx: clamp(state.preflightTargetIdx + 1, 0, TARGETS.length - 1) };
      } else if (state.preflightSection === "run") {
        if (key === KEY.enter || key === KEY.enter2) return "async";
      }
      return state;
    }

    case "report": {
      if (key === KEY.esc || key === KEY.b) return { ...state, screen: "menu" };
      if (key === KEY.r) return { ...state, reportData: ["  Loading..."] };
      return state;
    }

    case "learn": {
      if (key === KEY.esc || key === KEY.b) return { ...state, screen: "menu", output: [], status: "idle" };
      if (key === KEY.enter || key === KEY.enter2) return "async";
      return state;
    }

    case "export":
    case "import": {
      if (key === KEY.esc || key === KEY.b) return { ...state, screen: "menu", output: [], status: "idle" };
      if (key === KEY.tab) {
        return { ...state, ioSection: state.ioSection === "path" ? "run" : "path" };
      }
      if (state.ioSection === "path") {
        if (key === KEY.backspace || key === KEY.backspace2) return { ...state, ioPath: state.ioPath.slice(0, -1) };
        if (key === KEY.enter || key === KEY.enter2) return { ...state, ioSection: "run" };
        if (key.length === 1 && key.charCodeAt(0) >= 32) return { ...state, ioPath: state.ioPath + key };
      } else {
        if (key === KEY.enter || key === KEY.enter2) return "async";
      }
      return state;
    }
  }
}

// ─── Async action dispatcher ───────────────────────────────────────────────

async function runAsync(state: State): Promise<State> {
  const loading: State = { ...state, status: "loading", output: [] };
  render(loading);

  switch (state.screen) {
    case "manage-install": {
      if (!state.manageLoaded) {
        // Load: check all entries via checkInstalled
        const cwd = process.cwd();
        const entries = await Promise.all(
          state.manageEntries.map(async (e) => {
            const installed = await checkInstalled(e.agent, e.scope, cwd);
            return { ...e, installed, selected: installed };
          })
        );
        return { ...loading, status: "done", manageEntries: entries, manageLoaded: true };
      } else {
        // Apply: install/uninstall to match selection
        const cwd = process.cwd();
        const results: string[] = [];
        const updatedEntries = [...state.manageEntries];
        for (let i = 0; i < updatedEntries.length; i++) {
          const entry = updatedEntries[i]!;
          if (entry.selected === entry.installed) continue;
          if (entry.selected && !entry.installed) {
            try {
              await install({ agent: entry.agent, global: entry.scope === "global", cwd });
              results.push(`✓ Installed ${entry.agent} / ${entry.scope}`);
              updatedEntries[i] = { ...entry, installed: true };
            } catch (err) {
              results.push(`✗ ${entry.agent} / ${entry.scope}: ${String(err)}`);
            }
          } else if (!entry.selected && entry.installed) {
            try {
              await uninstall(entry.agent, entry.scope, cwd);
              results.push(`✓ Removed ${entry.agent} / ${entry.scope}`);
              updatedEntries[i] = { ...entry, installed: false };
            } catch (err) {
              results.push(`✗ ${entry.agent} / ${entry.scope}: ${String(err)}`);
            }
          }
        }
        if (results.length === 0) results.push("Nothing to do.");
        return { ...loading, status: "done", output: results, manageEntries: updatedEntries };
      }
    }

    case "patterns": {
      const loop = new LearningLoop();
      try {
        if (!state.patternsLoaded) {
          const data = await loop.registry.getAll();
          return { ...loading, status: "done", patternsData: data.patterns, patternsLoaded: true, pendingAction: null };
        }

        if (state.pendingAction === "delete-pattern") {
          const pattern = state.patternsData[state.patternIdx];
          if (pattern) {
            const data = await loop.registry.getAll();
            data.patterns = data.patterns.filter((p) => p.id !== pattern.id);
            const store = (loop as unknown as { cfg: { storage: { save: (d: unknown) => Promise<void> } } }).cfg.storage;
            await store.save(data);
            const reloaded = await loop.registry.getAll();
            const newIdx = clamp(state.patternIdx, 0, Math.max(0, reloaded.patterns.length - 1));
            return {
              ...loading,
              status: "done",
              patternsData: reloaded.patterns,
              patternIdx: newIdx,
              pendingAction: null,
              output: [`Deleted pattern: ${pattern.signature.slice(0, 40)}`],
            };
          }
          return { ...loading, pendingAction: null };
        }

        if (state.pendingAction === "toggle-pattern") {
          const pattern = state.patternsData[state.patternIdx];
          if (pattern) {
            const data = await loop.registry.getAll();
            const idx = data.patterns.findIndex((p) => p.id === pattern.id);
            if (idx >= 0) {
              const p = data.patterns[idx]!;
              const newStatus = p.status === "blocking" ? "advisory" : "blocking";
              data.patterns[idx] = { ...p, status: newStatus };
              const store = (loop as unknown as { cfg: { storage: { save: (d: unknown) => Promise<void> } } }).cfg.storage;
              await store.save(data);
              const reloaded = await loop.registry.getAll();
              return {
                ...loading,
                status: "done",
                patternsData: reloaded.patterns,
                pendingAction: null,
                output: [`Toggled ${pattern.signature.slice(0, 30)} → ${newStatus}`],
              };
            }
          }
          return { ...loading, pendingAction: null };
        }

        return { ...loading, pendingAction: null };
      } finally {
        await loop.close();
      }
    }

    case "preflight": return runPreflight(loading);
    case "learn": {
      const out = await runLearn();
      const status = out[0]?.startsWith("Done") ? "done" : "error";
      return { ...loading, status, output: out };
    }
    case "export": {
      const out = await runExport(state.ioPath);
      return { ...loading, status: "done", output: out };
    }
    case "import": {
      const out = await runImport(state.ioPath);
      const status = out[0]?.includes("Error") || out[0]?.includes("No path") ? "error" : "done";
      return { ...loading, status, output: out };
    }
    case "report": {
      const data = await buildReportData();
      return { ...loading, status: "done", reportData: data };
    }
    default: return state;
  }
}

// ─── Main entry point ──────────────────────────────────────────────────────

export async function runTui(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("TUI requires an interactive terminal (TTY).");
    process.exit(1);
  }

  // Enable ANSI on Windows (Node 18+ sets this automatically but be explicit)
  if (process.platform === "win32") {
    try {
      (process.stdout as unknown as { _handle?: { setBlocking?: (v: boolean) => void } })._handle?.setBlocking?.(true);
    } catch { /* ignore */ }
  }

  let state = initialState();

  // Hide cursor, enter raw mode
  write(A.hideCursor);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  function cleanup(): void {
    write(A.showCursor + A.reset);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    write(A.clearScreen);
  }

  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("exit", cleanup);

  // Resize handler
  process.stdout.on("resize", () => render(state));

  // Load report data eagerly if first screen
  render(state);

  // If navigating to report, load data
  const origState = state;
  if (origState.screen === "report") {
    state = { ...state, reportData: ["  Loading..."] };
    render(state);
    state = await runAsync(state);
    render(state);
  }

  process.stdin.on("data", async (chunk: string) => {
    const key = chunk;
    const result = handleKey(key, state);

    if (result === "quit") {
      cleanup();
      process.exit(0);
    }

    if (result === "async") {
      state = await runAsync(state);
      render(state);
      return;
    }

    state = result;

    // Auto-load report when entering that screen
    if (state.screen === "report" && state.reportData[0] === "  Loading...") {
      render(state);
      state = await runAsync(state);
    }

    // Auto-load manage-install on screen enter
    if (state.screen === "manage-install" && !state.manageLoaded) {
      render(state);
      state = await runAsync(state);
    }

    // Auto-load patterns on screen enter
    if (state.screen === "patterns" && !state.patternsLoaded) {
      render(state);
      state = await runAsync(state);
    }

    // Auto-run pending action for patterns
    if (state.screen === "patterns" && state.pendingAction !== null) {
      render(state);
      state = await runAsync(state);
    }

    render(state);
  });
}
