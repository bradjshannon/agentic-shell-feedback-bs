import { homedir } from "node:os";
import { LearningLoop } from "../LearningLoop.js";
import { install } from "../installer/index.js";
import { computeMetrics } from "../eval/Metrics.js";
import type { AgentTarget } from "../installer/index.js";

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

type Screen = "menu" | "install" | "preflight" | "report" | "learn" | "export" | "import";
type Section = "left" | "right" | "cmd" | "run";

const AGENTS: AgentTarget[] = ["claude-code", "cursor", "cline", "openhands", "copilot", "generic"];
const SHELLS = ["auto-detect", "bash", "zsh", "sh", "powershell", "cmd", "fish"];
const TARGETS = ["auto-detect", "local", "remote-ssh", "remote-other"];

const AGENT_HINTS: Record<string, string> = {
  "claude-code": "Hooks via .claude/settings.json (exit-code 2 blocking)",
  cursor: "Hooks via .cursor/hooks.json (beforeShellExecution)",
  cline: "Hooks via .clinerules/hooks/ (cancel JSON, macOS/Linux only)",
  openhands: "Hooks via .openhands/hooks.json (Claude Code format)",
  copilot: "Hooks via .github/hooks/*.json (inline bash, JSON deny)",
  generic: "Drop-in shell wrapper at bin/wrap-exec.sh",
};

interface State {
  screen: Screen;
  // menu
  menuIdx: number;
  // install
  installAgentIdx: number;
  installSection: Section;
  installFlagIdx: number;
  installGlobal: boolean;
  installRemote: boolean;
  installPush: boolean;
  installDryRun: boolean;
  // preflight
  preflightCmd: string;
  preflightShellIdx: number;
  preflightTargetIdx: number;
  preflightSection: "cmd" | "shell" | "target" | "run";
  // learn
  // export/import
  ioPath: string;
  ioSection: "path" | "run";
  // shared
  output: string[];
  status: "idle" | "loading" | "done" | "error";
  reportData: string[];
}

function initialState(): State {
  return {
    screen: "menu",
    menuIdx: 0,
    installAgentIdx: 0,
    installSection: "left",
    installFlagIdx: 0,
    installGlobal: false,
    installRemote: false,
    installPush: false,
    installDryRun: false,
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
    label: "Install Hooks",
    key: "install" as Screen,
    desc: [
      "Create hook scripts and wire them into",
      "your coding agent's config file.",
      "",
      "Hooks intercept every shell command:",
      "  PreToolUse  — block known-bad patterns",
      "  PostToolUse — record outcomes",
      "  Stop        — run learn() at session end",
      "",
      "Supported agents:",
      "  claude-code  cursor  cline",
      "  openhands  copilot  generic",
      "",
      "Flags: --global  --remote  --push",
      "       --dry-run (preview only)",
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
      "  ≥ 2 failures in 30 days",
      "  OR ≥ 60 seconds wasted",
      "",
      "Expiration (→ expired):",
      "  No occurrence in 90 days",
      "",
      "The Stop hook runs this automatically",
      "at the end of each session.",
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

// ─── Screen: Install ───────────────────────────────────────────────────────

function renderInstall(state: State): void {
  const { innerW, innerH } = renderFrame("Install Hooks");
  const leftW = Math.floor(innerW / 2) - 2;
  const rightW = innerW - leftW - 3;
  const bodyRows = innerH - 2;

  const FLAGS = [
    { key: "installGlobal" as const, label: "--global", hint: "Install to home dir (all projects)" },
    { key: "installRemote" as const, label: "--remote", hint: "SessionStart + worktree Stop hook" },
    { key: "installPush" as const, label: "--push", hint: "Also git commit+push patterns (implies --remote)" },
    { key: "installDryRun" as const, label: "--dry-run", hint: "Preview without writing files" },
  ];

  const agentHint = AGENT_HINTS[AGENTS[state.installAgentIdx] ?? "claude-code"] ?? "";

  for (let r = 0; r < bodyRows; r++) {
    if (r === bodyRows - 2) {
      // Output header
      const line = `  ${A.dim}Output${A.reset}`;
      renderLine(0, line, innerW);
      continue;
    }
    if (r === bodyRows - 1) {
      const line = state.status === "loading"
        ? `  ${A.yellow}Running...${A.reset}`
        : state.output.length > 0
          ? `  ${state.status === "error" ? A.red : A.green}${state.output[state.output.length - 1] ?? ""}${A.reset}`
          : `  ${A.dim}(results will appear here)${A.reset}`;
      renderLine(0, line, innerW);
      continue;
    }

    let left = "";
    let right = "";

    if (r === 0) {
      left = A.dim + "  Agent" + A.reset;
      right = A.dim + "  Flags" + A.reset;
    } else if (r === 1) {
      left = A.dim + "  " + hr(leftW - 2) + A.reset;
      right = A.dim + "  " + hr(rightW - 2) + A.reset;
    } else if (r >= 2 && r - 2 < AGENTS.length) {
      const i = r - 2;
      const agent = AGENTS[i]!;
      const active = i === state.installAgentIdx;
      const focused = state.installSection === "left";
      const bullet = active ? (focused ? A.bold + A.cyan + "  ◉ " : A.bold + "  ◉ ") : "  ○ ";
      left = bullet + (active ? A.bold : "") + agent + A.reset;
      if (active) left += A.dim + "\n" + A.reset; // shown below, not here
    } else if (r === AGENTS.length + 2) {
      left = A.dim + "  " + agentHint.slice(0, leftW - 2) + A.reset;
    }

    if (r >= 2 && r - 2 < FLAGS.length) {
      const fi = r - 2;
      const f = FLAGS[fi]!;
      const checked = state[f.key];
      const focused = state.installSection === "right" && state.installFlagIdx === fi;
      const box = checked ? A.green + " ✓ " : "   ";
      const label = focused ? A.bold + A.cyan + f.label + A.reset : f.label;
      right = "  " + box + A.reset + label + A.reset;
      if (focused) right += `  ${A.dim}${f.hint}${A.reset}`;
    }

    if (r === bodyRows - 4) {
      // Run button row
      const focused = state.installSection === "run";
      const btn = focused
        ? `${A.bgCyan}${A.bold}  Install  ${A.reset}`
        : `  [ Install ]  `;
      const btnPlain = btn.replace(/\x1b\[[0-9;]*m/g, "");
      const pad2 = Math.floor((innerW - btnPlain.length) / 2);
      renderLine(0, " ".repeat(pad2) + btn, innerW);
      continue;
    }

    const leftPadded = pad(left, leftW);
    const sep = A.cyan + " " + B.v + A.reset + " ";
    const rightPadded = pad(right, rightW);
    write(A.cyan + B.v + A.reset + leftPadded + sep + rightPadded + A.cyan + B.v + A.reset + "\n");
  }

  write(A.cyan + B.bl + hr(innerW) + B.br + A.reset + "\n");
  renderFooter(["↑↓ Navigate", "Tab Switch section", "Space Toggle flag", "Enter Run", "Esc Back"]);
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
        const focused = shellFocused && active;
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
    `  Evaluates all recorded traces and promotes patterns that`,
    `  have crossed the blocking threshold:`,
    "",
    `    ${A.cyan}≥ 2 failures in 30 days${A.reset}   OR   ${A.cyan}≥ 60 seconds wasted${A.reset}`,
    "",
    `  Patterns not seen in 90 days are expired.`,
    "",
    `  ${A.dim}This runs automatically via the Stop hook at session end.${A.reset}`,
    "",
    "",
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
    case "menu":     renderMenu(state); break;
    case "install":  renderInstall(state); break;
    case "preflight": renderPreflight(state); break;
    case "report":   renderReport(state); break;
    case "learn":    renderLearn(state); break;
    case "export":   renderIO(state, true); break;
    case "import":   renderIO(state, false); break;
  }
}

// ─── Actions ───────────────────────────────────────────────────────────────

async function runInstall(state: State): Promise<State> {
  const agent = AGENTS[state.installAgentIdx] ?? "claude-code";
  const opts = {
    agent,
    global: state.installGlobal,
    remote: state.installRemote,
    push: state.installPush,
    dryRun: state.installDryRun,
    cwd: process.cwd(),
  };
  try {
    const result = await install(opts);
    const lines: string[] = [];
    if (result.dryRun) lines.push("Dry run — no files written.");
    lines.push(...result.filesWritten.map((f) => "✓ " + f));
    lines.push(...result.filesPatched.map((f) => "~ " + f));
    lines.push(...result.skipped.map((f) => "· " + f + " (skipped)"));
    if (lines.length === 0) lines.push("Nothing to do.");
    return { ...state, status: "done", output: lines };
  } catch (err) {
    return { ...state, status: "error", output: [String(err)] };
  }
}

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
        return next;
      }
      return state;
    }

    case "install": {
      if (key === KEY.esc || key === KEY.b) return { ...state, screen: "menu", output: [], status: "idle" };
      if (key === KEY.tab) {
        const sections: Array<State["installSection"]> = ["left", "right", "run"];
        const idx = sections.indexOf(state.installSection);
        return { ...state, installSection: sections[(idx + 1) % sections.length]! };
      }
      if (state.installSection === "left") {
        if (key === KEY.up) return { ...state, installAgentIdx: clamp(state.installAgentIdx - 1, 0, AGENTS.length - 1) };
        if (key === KEY.down) return { ...state, installAgentIdx: clamp(state.installAgentIdx + 1, 0, AGENTS.length - 1) };
      } else if (state.installSection === "right") {
        const FLAGS_KEYS = ["installGlobal", "installRemote", "installPush", "installDryRun"] as const;
        if (key === KEY.up) return { ...state, installFlagIdx: clamp(state.installFlagIdx - 1, 0, FLAGS_KEYS.length - 1) };
        if (key === KEY.down) return { ...state, installFlagIdx: clamp(state.installFlagIdx + 1, 0, FLAGS_KEYS.length - 1) };
        if (key === KEY.space || key === KEY.enter || key === KEY.enter2) {
          const k = FLAGS_KEYS[state.installFlagIdx];
          if (k) return { ...state, [k]: !state[k] };
        }
      } else if (state.installSection === "run") {
        if (key === KEY.enter || key === KEY.enter2) return "async";
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
    case "install": return runInstall(loading);
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

    render(state);
  });
}
