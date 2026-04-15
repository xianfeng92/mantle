/**
 * Sandbox — command and path validation layer for tool execution.
 *
 * Inspired by NanoClaw/ZeroClaw's isolation patterns, this module
 * provides configurable security levels for agent tool execution.
 *
 * Level 0: No restrictions (current default, local development)
 * Level 1: Command blocklist + path fence (lightweight, recommended)
 * Level 2: Docker container isolation (future, not yet implemented)
 */

import path from "node:path";
import { createMiddleware } from "langchain";

// ── Types ──────────────────────────────────────────────────────────

export interface SandboxConfig {
  level: 0 | 1 | 2;
  /** Commands explicitly allowed (Level 1 allowlist mode). If empty, blocklist mode is used. */
  allowedCommands?: string[];
  /** Commands/patterns always blocked (Level 1 blocklist mode). */
  blockedPatterns?: string[];
  /** Writable path prefixes. Defaults to [workspaceDir]. */
  allowedWritePaths?: string[];
  /** Read-only path prefixes (can read but not write). */
  readOnlyPaths?: string[];
  /** Whether network access is allowed. Default: true. */
  networkAccess?: boolean;
}

export interface SandboxValidationResult {
  allowed: boolean;
  reason?: string;
}

// ── Default blocked patterns ───────────────────────────────────────

const DEFAULT_BLOCKED_PATTERNS = [
  // Destructive filesystem operations
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/(?!\w)/,  // rm -rf / (root deletion)
  /\bmkfs\b/,
  /\bdd\s+.*\bof=\//,
  // Privilege escalation
  /\bsudo\b/,
  /\bsu\s+-?\s*$/,
  /\bchmod\s+[0-7]*777\b/,
  /\bchown\s+root\b/,
  // Dangerous download + execute patterns
  /\bcurl\b.*\|\s*(ba)?sh\b/,
  /\bwget\b.*\|\s*(ba)?sh\b/,
  // System modification
  /\bsystemctl\s+(start|stop|restart|enable|disable)\b/,
  /\blaunchctl\s+(load|unload|bootstrap)\b/,
  // Crypto mining / reverse shells
  /\bnc\s+-[a-z]*l/,        // netcat listener
  /\/dev\/(tcp|udp)\//,      // bash reverse shell
  /\bxmrig\b|\bcpuminer\b/,  // known miners
];

// ── Validator ──────────────────────────────────────────────────────

export class SandboxValidator {
  private readonly config: SandboxConfig;
  private readonly workspaceDir: string;
  private readonly blockedRegexps: RegExp[];

  constructor(workspaceDir: string, config: SandboxConfig) {
    this.workspaceDir = path.resolve(workspaceDir);
    this.config = config;

    if (config.blockedPatterns) {
      this.blockedRegexps = config.blockedPatterns.map((p) =>
        typeof p === "string" ? new RegExp(p, "i") : p,
      );
    } else {
      this.blockedRegexps = DEFAULT_BLOCKED_PATTERNS;
    }
  }

  /**
   * Validate whether a shell command should be allowed to execute.
   */
  validateCommand(command: string): SandboxValidationResult {
    if (this.config.level === 0) {
      return { allowed: true };
    }

    const trimmed = command.trim();

    // Level 1: blocklist check
    for (const pattern of this.blockedRegexps) {
      if (pattern.test(trimmed)) {
        return {
          allowed: false,
          reason: `Command blocked by sandbox (matched pattern: ${pattern.source})`,
        };
      }
    }

    // Level 1: allowlist check (if configured)
    if (this.config.allowedCommands && this.config.allowedCommands.length > 0) {
      const executable = extractExecutable(trimmed);
      if (executable && !this.config.allowedCommands.includes(executable)) {
        return {
          allowed: false,
          reason: `Command "${executable}" is not in the sandbox allowlist`,
        };
      }
    }

    // Network access check
    if (this.config.networkAccess === false) {
      const networkCommands = ["curl", "wget", "fetch", "http", "ssh", "scp", "rsync"];
      const executable = extractExecutable(trimmed);
      if (executable && networkCommands.includes(executable)) {
        return {
          allowed: false,
          reason: `Network access is disabled in sandbox (command: ${executable})`,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Validate whether a file path is allowed for write operations.
   */
  validateWritePath(filePath: string): SandboxValidationResult {
    if (this.config.level === 0) {
      return { allowed: true };
    }

    const resolved = path.resolve(filePath);
    const allowedPaths = this.config.allowedWritePaths ?? [this.workspaceDir];

    for (const allowed of allowedPaths) {
      const resolvedAllowed = path.resolve(allowed);
      if (resolved.startsWith(resolvedAllowed + path.sep) || resolved === resolvedAllowed) {
        return { allowed: true };
      }
    }

    return {
      allowed: false,
      reason: `Write to "${resolved}" blocked: outside allowed paths [${allowedPaths.join(", ")}]`,
    };
  }

  /**
   * Validate whether a file path is allowed for read operations.
   */
  validateReadPath(filePath: string): SandboxValidationResult {
    if (this.config.level === 0) {
      return { allowed: true };
    }

    const resolved = path.resolve(filePath);
    const readablePaths = [
      ...(this.config.allowedWritePaths ?? [this.workspaceDir]),
      ...(this.config.readOnlyPaths ?? []),
    ];

    for (const allowed of readablePaths) {
      const resolvedAllowed = path.resolve(allowed);
      if (resolved.startsWith(resolvedAllowed + path.sep) || resolved === resolvedAllowed) {
        return { allowed: true };
      }
    }

    return {
      allowed: false,
      reason: `Read from "${resolved}" blocked: outside allowed paths`,
    };
  }
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Extract the first executable name from a shell command string.
 * Handles common patterns: `cmd args`, `env VAR=val cmd`, pipes.
 */
function extractExecutable(command: string): string | undefined {
  // Strip leading env assignments (VAR=val)
  const stripped = command.replace(/^(\s*\w+=\S+\s+)+/, "").trim();
  // Take the first word (before space, pipe, semicolon, &&)
  const match = stripped.match(/^([^\s|;&]+)/);
  if (!match) return undefined;
  // Get basename (handle paths like /usr/bin/node)
  return path.basename(match[1]);
}

// ── Factory ────────────────────────────────────────────────────────

/**
 * Create a SandboxValidator from settings. Returns null if level is 0.
 */
export function createSandbox(
  workspaceDir: string,
  config?: Partial<SandboxConfig>,
): SandboxValidator | null {
  const level = config?.level ?? 0;
  if (level === 0) return null;

  return new SandboxValidator(workspaceDir, {
    level: level as 0 | 1 | 2,
    ...config,
  });
}

// ── Middleware ──────────────────────────────────────────────────────

/**
 * Creates a middleware that validates tool calls against the sandbox policy.
 * Blocked calls are replaced with an error ToolMessage so the agent sees
 * the rejection and can adjust.
 */
export function createSandboxMiddleware(options: {
  workspaceDir: string;
  config: SandboxConfig;
}) {
  const validator = new SandboxValidator(options.workspaceDir, options.config);

  // Tools that execute shell commands
  const executionTools = new Set(["execute", "bash", "shell"]);
  // Tools that write files
  const writeTools = new Set(["write_file", "edit_file"]);
  // Tools that read files
  const readTools = new Set(["read_file", "glob", "grep", "ls"]);

  return createMiddleware({
    name: "sandbox",
    wrapToolCall: async (request: any, handler: any) => {
      const toolCall = request.toolCall;
      if (!toolCall) return handler(request);

      const name = toolCall.name;
      const args = (toolCall.args ?? {}) as Record<string, unknown>;

      // Validate execute commands
      if (executionTools.has(name)) {
        const command = (args.command ?? args.cmd ?? "") as string;
        const result = validator.validateCommand(command);
        if (!result.allowed) {
          return { content: `[sandbox] ${result.reason}` };
        }
      }

      // Validate write paths
      if (writeTools.has(name)) {
        const filePath = (args.path ?? args.file_path ?? "") as string;
        if (filePath) {
          const result = validator.validateWritePath(filePath);
          if (!result.allowed) {
            return { content: `[sandbox] ${result.reason}` };
          }
        }
      }

      // Validate read paths (if read restrictions are configured)
      if (readTools.has(name) && options.config.readOnlyPaths) {
        const filePath = (args.path ?? args.file_path ?? args.directory ?? "") as string;
        if (filePath) {
          const result = validator.validateReadPath(filePath);
          if (!result.allowed) {
            return { content: `[sandbox] ${result.reason}` };
          }
        }
      }

      return handler(request);
    },
  });
}

