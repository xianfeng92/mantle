import { access, stat } from "node:fs/promises";
import path from "node:path";
import { constants as fsConstants } from "node:fs";

import type { AgentRuntime } from "./agent.js";

export type DoctorCheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  title: string;
  status: DoctorCheckStatus;
  summary: string;
  details?: string;
  fixHint?: string;
}

export interface DoctorReport {
  ok: boolean;
  service: "agent-core";
  checkedAt: string;
  summary: {
    overallStatus: DoctorCheckStatus;
    passCount: number;
    warnCount: number;
    failCount: number;
  };
  runtime: {
    model: string;
    promptProfile: string;
    contextWindowSize: number;
    workspaceDir: string;
    dataDir: string;
    memoryFilePath: string;
    workspaceMode: string;
    virtualMode: boolean;
    baseUrl?: string;
    sandboxLevel: 0 | 1 | 2;
    skillCount: number;
    subagentCount: number;
  };
  checks: DoctorCheck[];
}

function dirnameForWritableProbe(targetPath: string): string {
  return path.extname(targetPath) ? path.dirname(targetPath) : targetPath;
}

async function isWritable(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function checkWorkspaceDir(workspaceDir: string): Promise<DoctorCheck> {
  try {
    const info = await stat(workspaceDir);
    if (!info.isDirectory()) {
      return {
        id: "workspace",
        title: "Workspace directory",
        status: "fail",
        summary: `Configured workspace is not a directory: ${workspaceDir}`,
        fixHint: "Update AGENT_CORE_WORKSPACE_DIR or switch workspace mode in Mantle Settings.",
      };
    }
  } catch {
    return {
      id: "workspace",
      title: "Workspace directory",
      status: "fail",
      summary: `Workspace directory does not exist: ${workspaceDir}`,
      fixHint: "Pick an existing workspace directory before starting new runs.",
    };
  }

  const writable = await isWritable(workspaceDir);
  return {
    id: "workspace",
    title: "Workspace directory",
    status: writable ? "pass" : "warn",
    summary: writable
      ? `Workspace is reachable and writable: ${workspaceDir}`
      : `Workspace is reachable but may be read-only: ${workspaceDir}`,
    fixHint: writable
      ? "No action needed."
      : "Grant write access or switch to a writable workspace before using file tools.",
  };
}

async function checkDataDir(dataDir: string): Promise<DoctorCheck> {
  try {
    const info = await stat(dataDir);
    if (!info.isDirectory()) {
      return {
        id: "data-dir",
        title: "Data directory",
        status: "fail",
        summary: `Configured data path is not a directory: ${dataDir}`,
        fixHint: "Point AGENT_CORE_DATA_DIR to a writable directory.",
      };
    }

    return {
      id: "data-dir",
      title: "Data directory",
      status: (await isWritable(dataDir)) ? "pass" : "warn",
      summary: `Data directory is present: ${dataDir}`,
      fixHint: "Ensure Mantle can write checkpoints, traces, and memory files to this directory.",
    };
  } catch {
    const parent = dirnameForWritableProbe(dataDir);
    const writableParent = await isWritable(path.dirname(parent));
    return {
      id: "data-dir",
      title: "Data directory",
      status: writableParent ? "pass" : "fail",
      summary: writableParent
        ? `Data directory will be created on demand: ${dataDir}`
        : `Data directory is missing and parent is not writable: ${dataDir}`,
      fixHint: writableParent
        ? "No action needed unless you want a custom location."
        : "Choose a writable workspace or set AGENT_CORE_DATA_DIR to a writable path.",
    };
  }
}

async function checkMemoryStore(memoryFilePath: string): Promise<DoctorCheck> {
  try {
    const info = await stat(memoryFilePath);
    return {
      id: "memory-store",
      title: "Memory store",
      status: info.isFile() ? "pass" : "warn",
      summary: info.isFile()
        ? `Memory store is ready: ${memoryFilePath}`
        : `Memory store path exists but is not a file: ${memoryFilePath}`,
      fixHint: "Ensure the memory store path resolves to a writable JSONL file.",
    };
  } catch {
    const parent = path.dirname(memoryFilePath);
    const writableParent = await isWritable(parent);
    return {
      id: "memory-store",
      title: "Memory store",
      status: writableParent ? "pass" : "fail",
      summary: writableParent
        ? `Memory file will be created on first write: ${memoryFilePath}`
        : `Memory file parent is not writable: ${memoryFilePath}`,
      fixHint: writableParent
        ? "No action needed."
        : "Choose a writable data directory for memory persistence.",
    };
  }
}

async function probeModelProvider(
  baseUrl: string | undefined,
  apiKey: string,
): Promise<DoctorCheck> {
  if (!baseUrl) {
    return {
      id: "model-provider",
      title: "Model provider",
      status: "fail",
      summary: "No model provider base URL is configured.",
      fixHint: "Set AGENT_CORE_BASE_URL or OPENAI_BASE_URL before starting runs.",
    };
  }

  let probeUrl: URL;
  try {
    const parsed = new URL(baseUrl);
    const normalizedPath = parsed.pathname.endsWith("/")
      ? parsed.pathname
      : `${parsed.pathname}/`;
    probeUrl = new URL(`${normalizedPath}models`, parsed);
  } catch {
    return {
      id: "model-provider",
      title: "Model provider",
      status: "fail",
      summary: `Invalid model provider URL: ${baseUrl}`,
      fixHint: "Fix AGENT_CORE_BASE_URL so it points to an OpenAI-compatible endpoint.",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const headers: Record<string, string> = {};
    if (apiKey.trim()) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const response = await fetch(probeUrl, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (response.ok) {
      const payload = (await response.json().catch(() => null)) as
        | { data?: Array<{ id?: string }> }
        | null;
      const models = Array.isArray(payload?.data) ? payload?.data.length : 0;
      return {
        id: "model-provider",
        title: "Model provider",
        status: models > 0 ? "pass" : "warn",
        summary:
          models > 0
            ? `Model provider is reachable and returned ${models} model(s).`
            : "Model provider is reachable, but /models returned no entries.",
        details: `Probe URL: ${probeUrl.toString()}`,
        fixHint:
          models > 0
            ? "No action needed."
            : "Check whether LM Studio has a model loaded or whether your provider exposes /models.",
      };
    }

    return {
      id: "model-provider",
      title: "Model provider",
      status: response.status >= 500 ? "fail" : "warn",
      summary: `Model provider responded with HTTP ${response.status}.`,
      details: `Probe URL: ${probeUrl.toString()}`,
      fixHint:
        response.status === 401 || response.status === 403
          ? "Check the configured API key and provider auth settings."
          : "Confirm the provider is up and speaking an OpenAI-compatible API.",
    };
  } catch (error) {
    clearTimeout(timeout);
    const message = error instanceof Error ? error.message : String(error);
    return {
      id: "model-provider",
      title: "Model provider",
      status: "fail",
      summary: `Could not reach the configured model provider at ${baseUrl}.`,
      details: message,
      fixHint: "Start LM Studio or your OpenAI-compatible backend, then retry the connection.",
    };
  }
}

function checkSkills(skillCount: number): DoctorCheck {
  return {
    id: "skills",
    title: "Skills",
    status: skillCount > 0 ? "pass" : "warn",
    summary:
      skillCount > 0
        ? `${skillCount} skill(s) discovered from configured sources.`
        : "No skills were discovered from the configured sources.",
    fixHint:
      skillCount > 0
        ? "No action needed."
        : "Add skills under .deepagents/skills or configure AGENT_CORE_SKILL_SOURCE_PATHS.",
  };
}

function checkSubagents(subagentCount: number): DoctorCheck {
  return {
    id: "subagents",
    title: "Subagents",
    status: subagentCount > 0 ? "pass" : "warn",
    summary:
      subagentCount > 0
        ? `${subagentCount} custom subagent(s) discovered.`
        : "No custom subagents were discovered. The built-in general-purpose agent will still work.",
    fixHint:
      subagentCount > 0
        ? "No action needed."
        : "Add .deepagents/subagents or configure AGENT_CORE_SUBAGENT_SOURCE_PATHS if you want specialists.",
  };
}

function checkSandbox(level: 0 | 1 | 2): DoctorCheck {
  if (level === 0) {
    return {
      id: "sandbox",
      title: "Sandbox policy",
      status: "warn",
      summary: "Sandbox level is 0 (no execution fence).",
      fixHint: "Use AGENT_CORE_SANDBOX_LEVEL=1 for a safer default with external model providers.",
    };
  }

  return {
    id: "sandbox",
    title: "Sandbox policy",
    status: "pass",
    summary: `Sandbox level ${level} is active.`,
    fixHint: level === 1
      ? "Command and path validation are enabled."
      : "Container isolation is configured for higher-risk deployments.",
  };
}

export async function collectDoctorReport(
  runtime: AgentRuntime,
  contextWindowSize: number,
): Promise<DoctorReport> {
  const settings = runtime.settings;
  const [skills, subagents] = await Promise.all([
    runtime.listSkills(),
    runtime.listSubagents(),
  ]);

  const checks = await Promise.all([
    probeModelProvider(settings.baseUrl, settings.apiKey),
    checkWorkspaceDir(settings.workspaceDir),
    checkDataDir(settings.dataDir),
    checkMemoryStore(settings.memoryFilePath),
    Promise.resolve(checkSkills(skills.length)),
    Promise.resolve(checkSubagents(subagents.length)),
    Promise.resolve(checkSandbox(settings.sandboxLevel)),
  ]);

  const passCount = checks.filter((check) => check.status === "pass").length;
  const warnCount = checks.filter((check) => check.status === "warn").length;
  const failCount = checks.filter((check) => check.status === "fail").length;
  const overallStatus: DoctorCheckStatus =
    failCount > 0 ? "fail" : warnCount > 0 ? "warn" : "pass";

  return {
    ok: failCount === 0,
    service: "agent-core",
    checkedAt: new Date().toISOString(),
    summary: {
      overallStatus,
      passCount,
      warnCount,
      failCount,
    },
    runtime: {
      model: settings.model,
      promptProfile: settings.promptProfile,
      contextWindowSize,
      workspaceDir: settings.workspaceDir,
      dataDir: settings.dataDir,
      memoryFilePath: settings.memoryFilePath,
      workspaceMode: settings.workspaceMode,
      virtualMode: settings.virtualMode,
      baseUrl: settings.baseUrl,
      sandboxLevel: settings.sandboxLevel,
      skillCount: skills.length,
      subagentCount: subagents.length,
    },
    checks,
  };
}
