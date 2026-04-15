import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { RunnableConfig } from "@langchain/core/runnables";
import type { StreamEvent } from "@langchain/core/types/stream";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { ChatOpenAI } from "@langchain/openai";
import { createAgent, humanInTheLoopMiddleware, todoListMiddleware } from "langchain";
import {
  DEFAULT_GENERAL_PURPOSE_DESCRIPTION,
  createDeepAgent,
  createFilesystemMiddleware,
  createPatchToolCallsMiddleware,
  createSkillsMiddleware,
  createSubAgentMiddleware,
  createSummarizationMiddleware,
  LocalShellBackend,
  type SubAgent,
} from "deepagents";

import { DefaultGuardrails, type AgentCoreGuardrails } from "./guardrails.js";
import {
  createHitlRejectionGuardMiddleware,
  createInterruptOnConfig,
} from "./hitl.js";
import type { AgentCoreSettings } from "./settings.js";
import {
  listSkillsFromSources,
  resolveSkillSources,
  type SkillMetadata,
  type SkillSource,
} from "./skills.js";
import {
  loadSubagentsFromSources,
  resolveSubagentSources,
  type LoadedSubagent,
  type SubagentMetadata,
  type SubagentSource,
} from "./subagents.js";
import {
  AGENT_CORE_COMPACT_FILESYSTEM_SYSTEM_PROMPT,
  AGENT_CORE_COMPACT_FILESYSTEM_TOOL_DESCRIPTIONS,
  AGENT_CORE_COMPACT_GENERAL_PURPOSE_DESCRIPTION,
  AGENT_CORE_COMPACT_GENERAL_PURPOSE_SYSTEM_PROMPT,
  AGENT_CORE_COMPACT_SUBAGENT_SYSTEM_PROMPT,
  AGENT_CORE_COMPACT_SYSTEM_PROMPT,
  AGENT_CORE_COMPACT_TASK_DESCRIPTION,
  AGENT_CORE_COMPACT_TODO_SYSTEM_PROMPT,
  AGENT_CORE_COMPACT_TODO_TOOL_DESCRIPTION,
  AGENT_CORE_SYSTEM_PROMPT,
} from "./system-prompt.js";
import { createAuditLogMiddleware } from "./audit-log.js";
import { cleanupOldMoves } from "./move-tracker.js";
import { createTildeExpandMiddleware } from "./tilde-expand.js";
import { createComputerUseMiddleware } from "./computer-use.js";
import { createToolStagingMiddleware } from "./tool-staging.js";
import { createLogger } from "./logger.js";
import { JsonlTraceRecorder, type TraceRecorder } from "./tracing.js";
import { MemoryStore } from "./memory.js";
import { createSandboxMiddleware, type SandboxConfig } from "./sandbox.js";
import type { InvokeResultLike } from "./types.js";

const log = createLogger("agent");

export interface AgentInvokeConfig {
  version?: "v1" | "v2";
  configurable?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface AgentStreamEventsConfig extends AgentInvokeConfig {
  version: "v1" | "v2";
}

export interface AgentStateSnapshotLike {
  values: unknown;
  tasks?: Array<{
    interrupts?: Array<{ value?: unknown }>;
    [key: string]: unknown;
  }>;
}

export interface AgentInvoker {
  invoke(input: unknown, config?: AgentInvokeConfig): Promise<InvokeResultLike>;
  streamEvents?(
    input: unknown,
    config: AgentStreamEventsConfig,
    streamOptions?: unknown,
  ): AsyncIterable<StreamEvent> | Promise<AsyncIterable<StreamEvent>>;
  getState?(
    config: RunnableConfig,
    options?: {
      subgraphs?: boolean;
    },
  ): Promise<AgentStateSnapshotLike>;
  /**
   * Update the graph state directly.  Used by the fallback tool-call
   * recovery path to inject a patched AIMessage (with proper `tool_calls`)
   * so the tools node executes on the next loop iteration.
   *
   * `asNode` tells LangGraph which node "produced" this state update,
   * which determines the next routing step (e.g. "agent" → tools node).
   */
  updateState?(
    config: RunnableConfig,
    values: Record<string, unknown>,
    asNode?: string,
  ): Promise<unknown>;
}

export interface AgentRuntime {
  agent: AgentInvoker;
  backend: LocalShellBackend;
  checkpointer: SqliteSaver;
  settings: AgentCoreSettings;
  skillSources: SkillSource[];
  subagentSources: SubagentSource[];
  guardrails: AgentCoreGuardrails;
  traceRecorder: TraceRecorder;
  memoryStore: MemoryStore;
  generalPurposeSubagent: {
    enabled: true;
    name: string;
    description: string;
    inheritedSkillSources: string[];
  };
  listSkills(): Promise<SkillMetadata[]>;
  listSubagents(): Promise<SubagentMetadata[]>;
  close(): Promise<void>;
}

function attachSkillMiddleware(
  backend: LocalShellBackend,
  subagents: readonly SubAgent[],
): SubAgent[] {
  return subagents.map((subagent) => {
    if (!Array.isArray(subagent.skills) || subagent.skills.length === 0) {
      return subagent;
    }

    return {
      ...subagent,
      middleware: [
        createSkillsMiddleware({
          backend,
          sources: subagent.skills,
        }),
        ...(subagent.middleware ?? []),
      ],
    };
  });
}

function createCompactAgentInvoker(options: {
  model: ChatOpenAI;
  backend: LocalShellBackend;
  checkpointer: SqliteSaver;
  loadedSubagents: LoadedSubagent[];
  mainSkillSources: string[];
  auditLogPath: string;
  movesLogPath: string;
  workspaceDir: string;
  traceRecorder: TraceRecorder;
  sandboxLevel: 0 | 1 | 2;
  sandboxAllowedCommands: string[];
  sandboxBlockedPatterns: string[];
}): AgentInvoker {
  const {
    model,
    backend,
    checkpointer,
    loadedSubagents,
    mainSkillSources,
    auditLogPath,
    movesLogPath,
    workspaceDir,
    traceRecorder,
    sandboxLevel,
    sandboxAllowedCommands,
    sandboxBlockedPatterns,
  } = options;
  const interruptOn = createInterruptOnConfig();
  const subagentMiddleware = [
    todoListMiddleware({
      systemPrompt: AGENT_CORE_COMPACT_TODO_SYSTEM_PROMPT,
      toolDescription: AGENT_CORE_COMPACT_TODO_TOOL_DESCRIPTION,
    }),
    createFilesystemMiddleware({
      backend,
      systemPrompt: AGENT_CORE_COMPACT_FILESYSTEM_SYSTEM_PROMPT,
      customToolDescriptions: AGENT_CORE_COMPACT_FILESYSTEM_TOOL_DESCRIPTIONS,
    }),
    createSummarizationMiddleware({
      model,
      backend,
    }),
    createPatchToolCallsMiddleware(),
    createTildeExpandMiddleware(),
    createAuditLogMiddleware({ auditLogPath, movesLogPath, workspaceDir }),
  ];
  const compactGeneralPurposeSubagent: SubAgent = {
    name: "general-purpose",
    description: AGENT_CORE_COMPACT_GENERAL_PURPOSE_DESCRIPTION,
    systemPrompt: AGENT_CORE_COMPACT_GENERAL_PURPOSE_SYSTEM_PROMPT,
    ...(mainSkillSources.length > 0 ? { skills: mainSkillSources } : {}),
  };
  const processedSubagents = attachSkillMiddleware(backend, [
    compactGeneralPurposeSubagent,
    ...loadedSubagents.map((subagent) => subagent.definition),
  ]);
  const mainSkillsMiddleware =
    mainSkillSources.length > 0
      ? [
          createSkillsMiddleware({
            backend,
            sources: mainSkillSources,
          }),
        ]
      : [];

  return createAgent({
    model,
    systemPrompt: AGENT_CORE_COMPACT_SYSTEM_PROMPT,
    middleware: [
      todoListMiddleware({
        systemPrompt: AGENT_CORE_COMPACT_TODO_SYSTEM_PROMPT,
        toolDescription: AGENT_CORE_COMPACT_TODO_TOOL_DESCRIPTION,
      }),
      createFilesystemMiddleware({
        backend,
        systemPrompt: AGENT_CORE_COMPACT_FILESYSTEM_SYSTEM_PROMPT,
        customToolDescriptions: AGENT_CORE_COMPACT_FILESYSTEM_TOOL_DESCRIPTIONS,
      }),
      createSubAgentMiddleware({
        defaultModel: model,
        defaultMiddleware: subagentMiddleware,
        defaultInterruptOn: interruptOn,
        subagents: processedSubagents,
        generalPurposeAgent: false,
        systemPrompt: AGENT_CORE_COMPACT_SUBAGENT_SYSTEM_PROMPT,
        taskDescription: AGENT_CORE_COMPACT_TASK_DESCRIPTION,
      }),
      createComputerUseMiddleware(),
      // Sandbox: validate commands and paths before execution (Level 1+)
      ...(sandboxLevel > 0
        ? [createSandboxMiddleware({
            workspaceDir,
            config: {
              level: sandboxLevel,
              allowedCommands: sandboxAllowedCommands.length > 0 ? sandboxAllowedCommands : undefined,
              blockedPatterns: sandboxBlockedPatterns.length > 0 ? sandboxBlockedPatterns : undefined,
            },
          })]
        : []),
      createToolStagingMiddleware({
        backend,
        traceRecorder,
      }),
      createSummarizationMiddleware({
        model,
        backend,
      }),
      createPatchToolCallsMiddleware(),
      createHitlRejectionGuardMiddleware(),
      createTildeExpandMiddleware(),
      createAuditLogMiddleware({ auditLogPath, movesLogPath, workspaceDir }),
      ...mainSkillsMiddleware,
      humanInTheLoopMiddleware({ interruptOn }),
    ],
    checkpointer,
    name: "agent-core",
  }).withConfig({
    recursionLimit: 50,
    metadata: {
      ls_integration: "deepagents",
      prompt_profile: "compact",
    },
  }) as unknown as AgentInvoker;
}

export async function createAgentRuntime(
  settings: AgentCoreSettings,
): Promise<AgentRuntime> {
  log.info("runtime.init", { model: settings.model, profile: settings.promptProfile, workspace: settings.workspaceDir, virtualMode: settings.virtualMode });
  await mkdir(settings.dataDir, { recursive: true });
  await mkdir(path.dirname(settings.checkpointDbPath), { recursive: true });

  // Cleanup move records older than 7 days
  const removed = await cleanupOldMoves(settings.movesLogPath, 7);
  if (removed > 0) {
    console.log(`[agent-core] Cleaned up ${removed} expired move record(s)`);
  }

  const backend = await LocalShellBackend.create({
    rootDir: settings.workspaceDir,
    inheritEnv: true,
    timeout: settings.commandTimeoutSec,
    maxOutputBytes: settings.maxOutputBytes,
    virtualMode: settings.virtualMode,
  });

  const model = new ChatOpenAI({
    model: settings.model,
    temperature: settings.temperature,
    apiKey: settings.apiKey,
    configuration: settings.baseUrl ? { baseURL: settings.baseUrl } : undefined,
  });
  if (settings.contextWindowTokensHint > 0) {
    // ChatOpenAI.profile may be a getter-only property in some versions,
    // so use Object.defineProperty to ensure we can set it.
    const modelAny = model as unknown as Record<string, unknown>;
    const currentProfile =
      typeof modelAny.profile === "object" && modelAny.profile !== null
        ? (modelAny.profile as Record<string, unknown>)
        : {};
    Object.defineProperty(model, "profile", {
      value: {
        ...currentProfile,
        maxInputTokens: settings.contextWindowTokensHint,
      },
      writable: true,
      configurable: true,
    });
  }

  const checkpointer = SqliteSaver.fromConnString(settings.checkpointDbPath);
  const skillSources = await resolveSkillSources(
    settings.workspaceDir,
    settings.skillSourcePaths,
  );
  const subagentSources = await resolveSubagentSources(
    settings.workspaceDir,
    settings.subagentSourcePaths,
  );
  const loadedSubagents = await loadSubagentsFromSources(
    settings.workspaceDir,
    subagentSources,
  );
  const guardrails = new DefaultGuardrails({
    maxInputChars: settings.maxInputChars,
    maxOutputChars: settings.maxOutputChars,
    blockedInputTerms: settings.blockedInputTerms,
    blockedOutputTerms: settings.blockedOutputTerms,
  });
  const traceRecorder = new JsonlTraceRecorder(settings.traceLogPath);
  const memoryStore = new MemoryStore(settings.memoryFilePath);
  const mainSkillSources = skillSources.map((source) => source.backendPath);
  log.info("runtime.loaded", { skills: skillSources.length, subagents: loadedSubagents.length, graph: settings.agentGraphVersion });
  const agent =
    settings.promptProfile === "compact"
      ? createCompactAgentInvoker({
          model,
          backend,
          checkpointer,
          loadedSubagents,
          mainSkillSources,
          auditLogPath: settings.auditLogPath,
          movesLogPath: settings.movesLogPath,
          workspaceDir: settings.workspaceDir,
          traceRecorder,
          sandboxLevel: settings.sandboxLevel,
          sandboxAllowedCommands: settings.sandboxAllowedCommands,
          sandboxBlockedPatterns: settings.sandboxBlockedPatterns,
        })
      : (createDeepAgent({
          name: "agent-core",
          model,
          backend,
          checkpointer,
          systemPrompt: AGENT_CORE_SYSTEM_PROMPT,
          interruptOn: createInterruptOnConfig(),
          ...(mainSkillSources.length > 0
            ? {
                skills: mainSkillSources,
              }
            : {}),
          ...(loadedSubagents.length > 0
            ? {
                subagents: loadedSubagents.map((subagent) => subagent.definition),
              }
            : {}),
        }) as unknown as AgentInvoker);
  let closed = false;

  return {
    agent,
    backend,
    checkpointer,
    settings,
    skillSources,
    subagentSources,
    guardrails,
    traceRecorder,
    memoryStore,
    generalPurposeSubagent: {
      enabled: true,
      name: "general-purpose",
      description:
        settings.promptProfile === "compact"
          ? AGENT_CORE_COMPACT_GENERAL_PURPOSE_DESCRIPTION
          : DEFAULT_GENERAL_PURPOSE_DESCRIPTION,
      inheritedSkillSources: skillSources.map((source) => source.backendPath),
    },
    async listSkills(): Promise<SkillMetadata[]> {
      return listSkillsFromSources(skillSources);
    },
    async listSubagents(): Promise<SubagentMetadata[]> {
      return loadedSubagents.map((subagent) => subagent.metadata);
    },
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await backend.close();
      checkpointer.db.close();
    },
  };
}
