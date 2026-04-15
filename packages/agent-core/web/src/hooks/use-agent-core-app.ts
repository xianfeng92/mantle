import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AppendMessage,
  ExternalStoreAdapter,
  ThreadMessage,
} from "@assistant-ui/react";
import {
  useExternalStoreRuntime,
  SimpleImageAttachmentAdapter,
} from "@assistant-ui/react";

import type {
  AgentCoreContextCompaction,
  AgentCoreDiagnostics,
  AgentCoreHitlDecision,
  AgentCoreHitlResponse,
  AgentCoreInterruptRequest,
  AgentCoreRunResult,
  AgentCoreSkillResponse,
  AgentCoreStreamEvent,
  AgentCoreSubagentResponse,
} from "../lib/agent-core";
import {
  fetchDiagnostics,
  fetchHealth,
  fetchSkills,
  fetchSubagents,
  streamResume,
  streamRun,
} from "../lib/agent-core";
import {
  appendAssistantDelta,
  appendInterruptedDraftIfMissing,
  appendMessageToText,
  buildBackendInput,
  createAssistantMessage,
  createUserMessage,
  deriveThreadTitle,
  extractImageParts,
  serializedMessagesToThreadMessages,
  setAssistantStatus,
} from "../lib/thread-messages";
import type { ContentBlock } from "../lib/agent-core";

export interface ToolActivityEvent {
  id: string;
  kind: "tool_started" | "tool_finished" | "tool_failed";
  toolName: string;
  payload?: unknown;
  runId: string;
}

export interface ThreadRecord {
  id: string;
  title: string;
  messages: ThreadMessage[];
  isRunning: boolean;
  pendingInterrupt: AgentCoreInterruptRequest | null;
  traceId: string | null;
  contextCompaction: AgentCoreContextCompaction | null;
  toolEvents: ToolActivityEvent[];
  error: string | null;
  lastUpdatedAt: string;
}

interface BackendPanelState {
  loading: boolean;
  healthy: boolean;
  service?: string;
  model?: string;
  promptProfile?: string;
  contextWindowSize?: number;
  workspaceDir?: string;
  workspaceMode?: "repo" | "workspace" | "custom";
  virtualMode?: boolean;
  diagnostics?: AgentCoreDiagnostics;
  skills?: AgentCoreSkillResponse;
  subagents?: AgentCoreSubagentResponse;
  error?: string;
  lastCheckedAt?: string;
}

const DEFAULT_BACKEND_URL =
  import.meta.env.VITE_AGENT_CORE_BASE_URL ?? "http://127.0.0.1:8787";
const BACKEND_URL_STORAGE_KEY = "agent-core-web.backend-url";
const THREADS_STORAGE_KEY = "agent-core-web.threads";

function createEmptyThread(id: string = crypto.randomUUID()): ThreadRecord {
  return {
    id,
    title: "New thread",
    messages: [],
    isRunning: false,
    pendingInterrupt: null,
    traceId: null,
    contextCompaction: null,
    toolEvents: [],
    error: null,
    lastUpdatedAt: new Date().toISOString(),
  };
}

interface PersistedThreadState {
  threadOrder: string[];
  threadsById: Record<string, ThreadRecord>;
  currentThreadId: string;
}

function reviveThreadMessage(raw: ThreadMessage): ThreadMessage {
  return {
    ...raw,
    createdAt: raw.createdAt ? new Date(raw.createdAt as unknown as string) : new Date(),
  };
}

function reviveThreadRecord(raw: ThreadRecord): ThreadRecord {
  return {
    ...raw,
    messages: Array.isArray(raw.messages) ? raw.messages.map(reviveThreadMessage) : [],
    isRunning: false,
    pendingInterrupt: null,
    toolEvents: [],
    error: null,
  };
}

function loadPersistedThreads(): PersistedThreadState | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(THREADS_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as PersistedThreadState;
    if (
      !Array.isArray(parsed.threadOrder) ||
      typeof parsed.threadsById !== "object" ||
      parsed.threadsById === null ||
      typeof parsed.currentThreadId !== "string"
    ) {
      return null;
    }

    const validOrder = parsed.threadOrder.filter(
      (id) => typeof id === "string" && parsed.threadsById[id],
    );
    if (validOrder.length === 0) {
      return null;
    }

    const revivedById: Record<string, ThreadRecord> = {};
    for (const id of validOrder) {
      const thread = parsed.threadsById[id];
      if (thread && typeof thread.id === "string") {
        revivedById[id] = reviveThreadRecord(thread);
      }
    }

    const finalOrder = validOrder.filter((id) => revivedById[id]);
    if (finalOrder.length === 0) {
      return null;
    }

    return {
      threadOrder: finalOrder,
      threadsById: revivedById,
      currentThreadId: revivedById[parsed.currentThreadId]
        ? parsed.currentThreadId
        : finalOrder[0]!,
    };
  } catch {
    return null;
  }
}

function saveThreadsToStorage(state: PersistedThreadState): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(THREADS_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Silently ignore storage errors (quota exceeded, etc.)
  }
}

function createInitialThreadState() {
  const persisted = loadPersistedThreads();
  if (persisted) {
    const firstThread = persisted.threadsById[persisted.threadOrder[0]!]!;
    return {
      initialThread: firstThread,
      threadOrder: persisted.threadOrder,
      threadsById: persisted.threadsById,
      currentThreadId: persisted.currentThreadId,
    };
  }

  const initialThread = createEmptyThread();
  return {
    initialThread,
    threadOrder: [initialThread.id],
    threadsById: {
      [initialThread.id]: initialThread,
    } satisfies Record<string, ThreadRecord>,
    currentThreadId: initialThread.id,
  };
}

function getInitialBackendUrl(): string {
  if (typeof window === "undefined") {
    return DEFAULT_BACKEND_URL;
  }

  return window.localStorage.getItem(BACKEND_URL_STORAGE_KEY) ?? DEFAULT_BACKEND_URL;
}

export interface AgentCoreAppState {
  runtime: ReturnType<typeof useExternalStoreRuntime>;
  backendUrl: string;
  setBackendUrl: (value: string) => void;
  backend: BackendPanelState;
  refreshBackend: () => Promise<void>;
  threads: ThreadRecord[];
  currentThread: ThreadRecord;
  switchThread: (threadId: string) => void;
  createThread: () => void;
  clearAllThreads: () => void;
  approveInterrupt: () => void;
  rejectInterrupt: () => void;
  applyEdits: (editedArgs: string[]) => void;
  /** Push a camera snapshot data URI to be sent with the next message. */
  addPendingImage: (dataUri: string) => void;
  /** Current pending images (camera snapshots waiting to be sent). */
  pendingImages: string[];
  /** Clear pending images (called after send or on discard). */
  clearPendingImages: () => void;
}

export function useAgentCoreApp(): AgentCoreAppState {
  const initialThreadStateRef = useRef<ReturnType<typeof createInitialThreadState> | null>(
    null,
  );
  if (!initialThreadStateRef.current) {
    initialThreadStateRef.current = createInitialThreadState();
  }
  const initialThreadState = initialThreadStateRef.current;
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const pendingImagesRef = useRef<string[]>([]);
  // Keep ref in sync for use inside onNew callback
  pendingImagesRef.current = pendingImages;

  const addPendingImage = useCallback((dataUri: string) => {
    setPendingImages((prev) => [...prev, dataUri]);
  }, []);
  const clearPendingImages = useCallback(() => {
    setPendingImages([]);
  }, []);

  const [backendUrl, setBackendUrlState] = useState(getInitialBackendUrl);
  const [backend, setBackend] = useState<BackendPanelState>({
    loading: true,
    healthy: false,
  });
  const [threadOrder, setThreadOrder] = useState<string[]>(() => initialThreadState.threadOrder);
  const [threadsById, setThreadsById] = useState<Record<string, ThreadRecord>>(
    () => initialThreadState.threadsById,
  );
  const [currentThreadId, setCurrentThreadId] = useState(
    () => initialThreadState.currentThreadId,
  );
  const threadsRef = useRef(threadsById);
  const abortControllersRef = useRef(new Map<string, AbortController>());
  const effectiveBackendUrl = backendUrl.trim() || DEFAULT_BACKEND_URL;

  useEffect(() => {
    threadsRef.current = threadsById;
  }, [threadsById]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(BACKEND_URL_STORAGE_KEY, backendUrl);
  }, [backendUrl]);

  // Persist threads to localStorage on every change
  useEffect(() => {
    saveThreadsToStorage({
      threadOrder,
      threadsById,
      currentThreadId,
    });
  }, [threadOrder, threadsById, currentThreadId]);

  useEffect(
    () => () => {
      for (const controller of abortControllersRef.current.values()) {
        controller.abort();
      }
    },
    [],
  );

  const updateThread = useCallback(
    (threadId: string, updater: (thread: ThreadRecord) => ThreadRecord) => {
      setThreadsById((current) => {
        const thread = current[threadId];
        if (!thread) {
          return current;
        }

        return {
          ...current,
          [threadId]: updater(thread),
        };
      });
    },
    [],
  );

  const ensureThread = useCallback((threadId: string) => {
    setThreadsById((current) => {
      if (current[threadId]) {
        return current;
      }
      return {
        ...current,
        [threadId]: createEmptyThread(threadId),
      };
    });
    setThreadOrder((current) => (current.includes(threadId) ? current : [threadId, ...current]));
  }, []);

  const currentThread =
    threadsById[currentThreadId] ??
    threadsById[threadOrder[0] ?? ""] ??
    initialThreadState.initialThread;

  const applyFinalResult = useCallback(
    (threadId: string, baseMessages: readonly ThreadMessage[], result: AgentCoreRunResult) => {
      updateThread(threadId, (thread) => ({
        ...thread,
        messages: [...baseMessages, ...serializedMessagesToThreadMessages(result)],
        isRunning: false,
        pendingInterrupt: result.interruptRequest ?? null,
        traceId: result.traceId,
        contextCompaction: result.contextCompaction ?? null,
        error: null,
        lastUpdatedAt: new Date().toISOString(),
      }));
    },
    [updateThread],
  );

  const refreshBackend = useCallback(async () => {
    setBackend((current) => ({
      ...current,
      loading: true,
      error: undefined,
    }));

    try {
      const [health, diagnostics, skills, subagents] = await Promise.all([
        fetchHealth(effectiveBackendUrl),
        fetchDiagnostics(effectiveBackendUrl),
        fetchSkills(effectiveBackendUrl),
        fetchSubagents(effectiveBackendUrl),
      ]);

      startTransition(() => {
        setBackend({
          loading: false,
          healthy: health.ok,
          service: health.service,
          model: health.model,
          promptProfile: health.promptProfile,
          contextWindowSize: health.contextWindowSize,
          workspaceDir: health.workspaceDir,
          workspaceMode: health.workspaceMode,
          virtualMode: health.virtualMode,
          diagnostics,
          skills,
          subagents,
          lastCheckedAt: new Date().toISOString(),
        });
      });
    } catch (error) {
      setBackend({
        loading: false,
        healthy: false,
        error: error instanceof Error ? error.message : String(error),
        lastCheckedAt: new Date().toISOString(),
      });
    }
  }, [effectiveBackendUrl]);

  useEffect(() => {
    void refreshBackend();
  }, [refreshBackend]);

  const handleStreamEvent = useCallback(
    (options: {
      threadId: string;
      baseMessages: readonly ThreadMessage[];
      draftId: string;
      event: AgentCoreStreamEvent;
    }) => {
      const { threadId, baseMessages, draftId, event } = options;
      switch (event.type) {
        case "run_started":
          updateThread(threadId, (thread) => ({
            ...thread,
            traceId: event.data.traceId,
            error: null,
            isRunning: true,
            lastUpdatedAt: new Date().toISOString(),
          }));
          return;
        case "text_delta":
          updateThread(threadId, (thread) => ({
            ...thread,
            messages: appendAssistantDelta(thread.messages, draftId, event.data.delta),
            traceId: event.data.traceId,
            lastUpdatedAt: new Date().toISOString(),
          }));
          return;
        case "tool_started":
        case "tool_finished":
        case "tool_failed":
          updateThread(threadId, (thread) => ({
            ...thread,
            toolEvents: [
              {
                id: crypto.randomUUID(),
                kind: event.type,
                toolName: event.data.toolName,
                payload:
                  event.type === "tool_started"
                    ? event.data.input
                    : event.type === "tool_finished"
                      ? event.data.output
                      : event.data.error,
                runId: event.data.runId,
              },
              ...thread.toolEvents,
            ].slice(0, 24),
            lastUpdatedAt: new Date().toISOString(),
          }));
          return;
        case "context_compacted":
          updateThread(threadId, (thread) => ({
            ...thread,
            contextCompaction: event.data.contextCompaction,
            lastUpdatedAt: new Date().toISOString(),
          }));
          return;
        case "run_completed":
          applyFinalResult(threadId, baseMessages, event.data);
          return;
        case "run_interrupted":
          applyFinalResult(threadId, baseMessages, event.data);
          updateThread(threadId, (thread) => ({
            ...thread,
            messages: setAssistantStatus(
              appendInterruptedDraftIfMissing(thread.messages, draftId),
              draftId,
              { type: "requires-action", reason: "interrupt" },
            ),
            pendingInterrupt: event.data.interruptRequest ?? null,
          }));
          return;
        case "error":
          updateThread(threadId, (thread) => ({
            ...thread,
            isRunning: false,
            error: event.data.error,
            messages: setAssistantStatus(thread.messages, draftId, {
              type: "incomplete",
              reason: "error",
              error: event.data.error,
            }),
            lastUpdatedAt: new Date().toISOString(),
          }));
      }
    },
    [applyFinalResult, updateThread],
  );

  const runStream = useCallback(
    async (options: {
      threadId: string;
      input: string | ContentBlock[];
      baseMessages: readonly ThreadMessage[];
      draftId: string;
    }) => {
      const controller = new AbortController();
      abortControllersRef.current.set(options.threadId, controller);

      try {
        await streamRun(
          effectiveBackendUrl,
          {
            threadId: options.threadId,
            input: options.input,
          },
          {
            signal: controller.signal,
            onEvent: async (event) => {
              handleStreamEvent({
                threadId: options.threadId,
                baseMessages: options.baseMessages,
                draftId: options.draftId,
                event,
              });
            },
          },
        );
      } finally {
        abortControllersRef.current.delete(options.threadId);
      }
    },
    [effectiveBackendUrl, handleStreamEvent],
  );

  const resumeStream = useCallback(
    async (options: {
      threadId: string;
      baseMessages: readonly ThreadMessage[];
      draftId: string;
      resume: AgentCoreHitlResponse;
    }) => {
      const controller = new AbortController();
      abortControllersRef.current.set(options.threadId, controller);

      try {
        await streamResume(
          effectiveBackendUrl,
          {
            threadId: options.threadId,
            resume: options.resume,
          },
          {
            signal: controller.signal,
            onEvent: async (event) => {
              handleStreamEvent({
                threadId: options.threadId,
                baseMessages: options.baseMessages,
                draftId: options.draftId,
                event,
              });
            },
          },
        );
      } finally {
        abortControllersRef.current.delete(options.threadId);
      }
    },
    [effectiveBackendUrl, handleStreamEvent],
  );

  const createThread = useCallback(() => {
    const thread = createEmptyThread();
    setThreadsById((current) => ({
      ...current,
      [thread.id]: thread,
    }));
    setThreadOrder((current) => [thread.id, ...current]);
    startTransition(() => {
      setCurrentThreadId(thread.id);
    });
  }, []);

  const switchThread = useCallback((threadId: string) => {
    startTransition(() => {
      setCurrentThreadId(threadId);
    });
  }, []);

  const clearAllThreads = useCallback(() => {
    const fresh = createEmptyThread();
    setThreadsById({ [fresh.id]: fresh });
    setThreadOrder([fresh.id]);
    startTransition(() => {
      setCurrentThreadId(fresh.id);
    });
    try {
      window.localStorage.removeItem(THREADS_STORAGE_KEY);
    } catch {
      // ignore
    }
  }, []);

  const adapter = useMemo<ExternalStoreAdapter<ThreadMessage>>(
    () => ({
      messages: currentThread.messages,
      isRunning: currentThread.isRunning,
      extras: {
        pendingInterrupt: currentThread.pendingInterrupt,
        traceId: currentThread.traceId,
        contextCompaction: currentThread.contextCompaction,
        toolEvents: currentThread.toolEvents,
        error: currentThread.error,
      },
      suggestions: [
        { prompt: "先用只读工具概览当前工作区，再告诉我最值得看的 3 个入口文件。" },
        { prompt: "检查一下本地 agent-core 后端、skills、subagents 和 diagnostics，告诉我当前状态。" },
        { prompt: "这是一个桌面轻代理任务：先观察前台 UI，再告诉我下一步应该点什么，不要直接执行。" },
      ],
      setMessages: (messages) => {
        updateThread(currentThread.id, (thread) => ({
          ...thread,
          messages: [...messages],
          lastUpdatedAt: new Date().toISOString(),
        }));
      },
      onNew: async (message: AppendMessage) => {
        const text = appendMessageToText(message);
        const attachmentImages = extractImageParts(message);
        // Merge assistant-ui attachments with camera snapshots
        const cameraImages = pendingImagesRef.current;
        const images = [...attachmentImages, ...cameraImages];
        if (cameraImages.length > 0) {
          setPendingImages([]);
        }
        if (!text && images.length === 0) {
          return;
        }

        const threadId = currentThread.id;
        const userMessage = createUserMessage(text || "(image)");
        const draftId = crypto.randomUUID();
        const draftMessage = createAssistantMessage("", { type: "running" }, { id: draftId });
        const baseMessages = threadsRef.current[threadId]?.messages ?? [];

        const backendInput = buildBackendInput(text, images);

        ensureThread(threadId);
        updateThread(threadId, (thread) => ({
          ...thread,
          title:
            thread.messages.length === 0 || thread.title === "New thread"
              ? deriveThreadTitle(text || "Image conversation")
              : thread.title,
          messages: [...baseMessages, userMessage, draftMessage],
          isRunning: true,
          pendingInterrupt: null,
          error: null,
          toolEvents: [],
          contextCompaction: null,
          lastUpdatedAt: new Date().toISOString(),
        }));

        try {
          await runStream({
            threadId,
            input: backendInput,
            baseMessages,
            draftId,
          });
        } catch (error) {
          updateThread(threadId, (thread) => ({
            ...thread,
            isRunning: false,
            error: error instanceof Error ? error.message : String(error),
            messages: setAssistantStatus(thread.messages, draftId, {
              type: "incomplete",
              reason: "error",
              error: error instanceof Error ? error.message : String(error),
            }),
            lastUpdatedAt: new Date().toISOString(),
          }));
        }
      },
      onResume: async (config) => {
        const hitlResponse = config.runConfig.custom?.hitlResponse as
          | AgentCoreHitlResponse
          | undefined;
        if (!hitlResponse) {
          throw new Error("Missing hitlResponse payload for resume.");
        }

        const threadId = currentThread.id;
        const baseMessages = threadsRef.current[threadId]?.messages ?? [];
        const draftId = crypto.randomUUID();

        updateThread(threadId, (thread) => ({
          ...thread,
          messages: [
            ...baseMessages,
            createAssistantMessage("", { type: "running" }, { id: draftId }),
          ],
          isRunning: true,
          pendingInterrupt: null,
          error: null,
          lastUpdatedAt: new Date().toISOString(),
        }));

        try {
          await resumeStream({
            threadId,
            baseMessages,
            draftId,
            resume: hitlResponse,
          });
        } catch (error) {
          updateThread(threadId, (thread) => ({
            ...thread,
            isRunning: false,
            error: error instanceof Error ? error.message : String(error),
            messages: setAssistantStatus(thread.messages, draftId, {
              type: "incomplete",
              reason: "error",
              error: error instanceof Error ? error.message : String(error),
            }),
            lastUpdatedAt: new Date().toISOString(),
          }));
        }
      },
      onCancel: async () => {
        abortControllersRef.current.get(currentThread.id)?.abort();
        updateThread(currentThread.id, (thread) => ({
          ...thread,
          isRunning: false,
          error: "Streaming request cancelled in the browser.",
          lastUpdatedAt: new Date().toISOString(),
        }));
      },
      adapters: {
        attachments: new SimpleImageAttachmentAdapter(),
      },
      unstable_capabilities: {
        copy: true,
      },
    }),
    [
      currentThread,
      ensureThread,
      resumeStream,
      runStream,
      updateThread,
    ],
  );

  const runtime = useExternalStoreRuntime(adapter);

  const setBackendUrl = useCallback((value: string) => {
    setBackendUrlState(value);
  }, []);

  const makeUniformDecisions = useCallback(
    (decision: AgentCoreHitlDecision) => {
      const interrupt = currentThread.pendingInterrupt;
      if (!interrupt || interrupt.actionRequests.length <= 1) {
        return {
          decisions: [decision],
        } satisfies AgentCoreHitlResponse;
      }

      if (decision.type !== "approve" && decision.type !== "reject") {
        return {
          decisions: [decision],
        } satisfies AgentCoreHitlResponse;
      }

      return {
        decisions: interrupt.actionRequests.map(() => decision),
      } satisfies AgentCoreHitlResponse;
    },
    [currentThread.pendingInterrupt],
  );

  const submitResume = useCallback(
    (response: AgentCoreHitlResponse) => {
      runtime.thread.resumeRun({
        parentId: currentThread.messages.at(-1)?.id ?? null,
        runConfig: {
          custom: {
            hitlResponse: response,
          },
        },
      });
    },
    [currentThread.messages, runtime.thread],
  );

  const approveInterrupt = useCallback(() => {
    submitResume(makeUniformDecisions({ type: "approve" }));
  }, [makeUniformDecisions, submitResume]);

  const rejectInterrupt = useCallback(() => {
    submitResume(
      makeUniformDecisions({
        type: "reject",
        message: "Rejected from Agent Core Web UI.",
      }),
    );
  }, [makeUniformDecisions, submitResume]);

  const applyEdits = useCallback(
    (editedArgs: string[]) => {
      const interrupt = currentThread.pendingInterrupt;
      if (!interrupt) {
        return;
      }

      try {
        const decisions: AgentCoreHitlDecision[] = interrupt.actionRequests.map(
          (action, index) => {
            const reviewConfig = interrupt.reviewConfigs.find(
              (config) => config.actionName === action.name,
            );
            const canEdit = reviewConfig?.allowedDecisions.includes("edit") ?? false;
            if (!canEdit) {
              return { type: "approve" };
            }

            const raw = editedArgs[index] ?? JSON.stringify(action.args, null, 2);
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            return {
              type: "edit",
              editedAction: {
                name: action.name,
                args: parsed,
              },
            };
          },
        );

        submitResume({ decisions });
      } catch (error) {
        updateThread(currentThread.id, (thread) => ({
          ...thread,
          error:
            error instanceof Error
              ? `Edited action arguments are invalid JSON: ${error.message}`
              : "Edited action arguments are invalid JSON.",
          lastUpdatedAt: new Date().toISOString(),
        }));
      }
    },
    [currentThread.id, currentThread.pendingInterrupt, submitResume, updateThread],
  );

  return {
    runtime,
    backendUrl,
    setBackendUrl,
    backend,
    refreshBackend,
    threads: threadOrder
      .map((threadId) => threadsById[threadId])
      .filter((thread): thread is ThreadRecord => Boolean(thread)),
    currentThread,
    switchThread,
    createThread,
    clearAllThreads,
    approveInterrupt,
    rejectInterrupt,
    applyEdits,
    addPendingImage,
    pendingImages,
    clearPendingImages,
  };
}
