import type {
  ActionRequest,
  ActionRiskAssessment,
  ActionRiskLevel,
  HITLRequest,
} from "./types.js";

const SENSITIVE_PATH_PATTERNS = [
  /(^|\/)\.(env|ssh|aws|gitconfig|npmrc)(\/|$)/i,
  /^\/(etc|usr|bin|sbin|System|Library)(\/|$)/,
  /(^|\/)Library(\/|$)/,
  /(^|\/)Applications(\/|$)/,
];

const HIGH_RISK_COMMAND_PATTERNS = [
  /\bsudo\b/i,
  /\brm\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\blaunchctl\b/i,
  /\bsystemctl\b/i,
  /\bgit\s+reset\b/i,
  /\bgit\s+clean\b/i,
  /\bcurl\b.*\|\s*(ba)?sh\b/i,
  /\bwget\b.*\|\s*(ba)?sh\b/i,
];

const MEDIUM_RISK_COMMAND_PATTERNS = [
  /\bnpm\s+(install|run)\b/i,
  /\bpnpm\s+(install|run)\b/i,
  /\byarn\s+(install|run)\b/i,
  /\bgit\s+(checkout|switch|pull|merge|rebase)\b/i,
  /\bpython\b/i,
  /\bnode\b/i,
];

function compactText(text: string, maxLength = 120): string {
  const cleaned = text
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  return `${cleaned.slice(0, maxLength)}…`;
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || !value.trim()) continue;
    const trimmed = value.trim();
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function shortenPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length <= 3) {
    return normalized;
  }
  return segments.slice(-3).join("/");
}

function isSensitivePath(filePath: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(filePath));
}

function resolvePrimaryPath(args: Record<string, unknown>): string | undefined {
  const candidate = [
    args.path,
    args.file_path,
    args.filePath,
    args.destPath,
    args.sourcePath,
    args.target,
    args.cwd,
  ].find((value) => typeof value === "string" && value.trim().length > 0);
  return typeof candidate === "string" ? candidate : undefined;
}

function resolveTouchedPaths(args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const key of ["path", "file_path", "filePath", "destPath", "sourcePath", "target", "cwd"]) {
    const value = args[key];
    if (typeof value === "string") {
      paths.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") {
          paths.push(item);
        }
      }
    }
  }
  return uniqueStrings(paths);
}

function classifyCommandRisk(command: string): ActionRiskLevel {
  if (HIGH_RISK_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) {
    return "high";
  }
  if (MEDIUM_RISK_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) {
    return "medium";
  }
  return "medium";
}

function analyzeExecuteAction(action: ActionRequest): ActionRiskAssessment {
  const command = typeof action.args.command === "string"
    ? action.args.command
    : typeof action.args.cmd === "string"
      ? action.args.cmd
      : "";
  const cwd = typeof action.args.cwd === "string" ? action.args.cwd : undefined;
  const level = classifyCommandRisk(command);
  const touchedPaths = uniqueStrings([cwd]);

  return {
    level,
    summary: command
      ? `Run shell command: ${compactText(command, 90)}`
      : "Run a shell command in the current workspace.",
    estimatedImpact:
      level === "high"
        ? "Executes a high-impact shell command that may modify the workspace or system state."
        : "Executes a shell command that may change files, install packages, or alter local state.",
    touchedPaths,
    command: command || undefined,
    rationale:
      level === "high"
        ? "Command matches a destructive or privileged shell pattern."
        : "Shell execution can change the workspace and should be reviewed before continuing.",
  };
}

function analyzeFileAction(action: ActionRequest): ActionRiskAssessment {
  const path = resolvePrimaryPath(action.args);
  const touchedPaths = resolveTouchedPaths(action.args);
  const sensitive = path ? isSensitivePath(path) : false;
  const content =
    typeof action.args.content === "string"
      ? action.args.content
      : typeof action.args.new_content === "string"
        ? action.args.new_content
        : undefined;
  const sizeHint = content ? `${content.length} chars` : "file contents";
  const verb = action.name === "write_file" ? "Write" : "Edit";

  return {
    level: sensitive ? "high" : "medium",
    summary: path
      ? `${verb} ${sizeHint} in ${shortenPath(path)}`
      : `${verb} ${sizeHint}`,
    estimatedImpact:
      action.name === "write_file"
        ? "Creates or overwrites file contents."
        : "Modifies an existing file in place.",
    touchedPaths,
    rationale: sensitive
      ? "Target path looks sensitive or outside a normal project workspace."
      : "File mutations are reviewable and may affect the current workspace state.",
  };
}

function analyzeComputerUseAction(action: ActionRequest): ActionRiskAssessment {
  const touchedPaths = resolveTouchedPaths(action.args);
  const appName =
    typeof action.args.app_name === "string"
      ? action.args.app_name
      : typeof action.args.bundle_id === "string"
        ? action.args.bundle_id
        : undefined;
  const element =
    typeof action.args.element_label === "string"
      ? action.args.element_label
      : typeof action.args.value === "string"
        ? compactText(action.args.value, 48)
        : undefined;
  const parts = [
    appName ? `App: ${appName}` : undefined,
    element ? `Target: ${element}` : undefined,
  ].filter(Boolean);

  return {
    level: "high",
    summary:
      parts.length > 0
        ? `Control the desktop UI. ${parts.join(" • ")}`
        : "Control the desktop UI.",
    estimatedImpact: "Sends desktop actions such as clicks, typing, app launches, or shortcuts.",
    touchedPaths,
    rationale: "Desktop control can affect data outside the current repository and should stay explicit.",
  };
}

function analyzeGenericAction(action: ActionRequest): ActionRiskAssessment {
  const touchedPaths = resolveTouchedPaths(action.args);
  return {
    level: "medium",
    summary: action.description
      ? compactText(action.description, 96)
      : `Run tool ${action.name}`,
    estimatedImpact: "Executes a sensitive tool action that needs explicit review.",
    touchedPaths,
  };
}

export function analyzeActionRisk(action: ActionRequest): ActionRiskAssessment {
  switch (action.name) {
    case "execute":
      return analyzeExecuteAction(action);
    case "write_file":
    case "edit_file":
      return analyzeFileAction(action);
    case "open_app":
    case "click_element":
    case "set_element_value":
    case "key_press":
    case "type_text":
    case "open_app_and_observe":
    case "click_element_and_wait":
    case "set_value_and_verify":
    case "press_shortcut_and_verify":
      return analyzeComputerUseAction(action);
    default:
      return analyzeGenericAction(action);
  }
}

export function enrichHitlRequest(request: HITLRequest): HITLRequest {
  return {
    ...request,
    actionRequests: request.actionRequests.map((action) => ({
      ...action,
      risk: action.risk ?? analyzeActionRisk(action),
    })),
  };
}
