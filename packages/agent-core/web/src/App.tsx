import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  ThreadPrimitive,
  type MessageState,
} from "@assistant-ui/react";
import { useState } from "react";

import type { AgentCoreInterruptRequest } from "./lib/agent-core";
import { useAgentCoreApp } from "./hooks/use-agent-core-app";
import { useCamera } from "./hooks/use-camera";

function MessageBubble({ message }: { message: MessageState }) {
  const isAssistant = message.role === "assistant";
  const isSystem = message.role === "system";
  const text = message.content
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }
      if (part.type === "reasoning") {
        return part.text;
      }
      if (part.type === "source") {
        return `${part.title ?? part.url} (${part.url})`;
      }
      if (part.type === "data") {
        return JSON.stringify(part.data, null, 2);
      }
      if (part.type === "tool-call") {
        return `[tool:${part.toolName}] ${part.argsText}`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n");

  return (
    <article
      className={[
        "message-bubble",
        isAssistant ? "assistant" : message.role,
        isSystem ? "system" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <header className="message-meta">
        <span className="message-role">
          {message.role === "user"
            ? "You"
            : message.role === "assistant"
              ? "Agent Core"
              : "Runtime"}
        </span>
        <span className="message-status">{message.status?.type ?? "complete"}</span>
      </header>
      <div className="message-body">
        {text ? <p>{text}</p> : <p className="message-placeholder">Waiting for output…</p>}
      </div>
    </article>
  );
}

function InterruptPanel({
  interruptRequest,
  isBusy,
  onApprove,
  onReject,
  onApplyEdits,
}: {
  interruptRequest: AgentCoreInterruptRequest | null;
  isBusy: boolean;
  onApprove: () => void;
  onReject: () => void;
  onApplyEdits: (editedArgs: string[]) => void;
}) {
  const [drafts, setDrafts] = useState<string[]>(
    () =>
      interruptRequest?.actionRequests.map((action) =>
        JSON.stringify(action.args, null, 2),
      ) ?? [],
  );

  if (!interruptRequest) {
    return null;
  }

  return (
    <section className="interrupt-panel">
      <div className="interrupt-header">
        <div>
          <h3>Approval Required</h3>
          <p>
            The backend paused for a human decision. You can approve, reject, or
            edit arguments before resuming.
          </p>
        </div>
        <span className="interrupt-count">
          {interruptRequest.actionRequests.length} action
          {interruptRequest.actionRequests.length > 1 ? "s" : ""}
        </span>
      </div>

      <div className="interrupt-actions-list">
        {interruptRequest.actionRequests.map((action, index) => (
          <article key={`${action.name}-${index}`} className="interrupt-action-card">
            <div className="interrupt-action-title">
              <strong>{action.name}</strong>
            </div>
            <textarea
              value={drafts[index] ?? JSON.stringify(action.args, null, 2)}
              onChange={(event) => {
                setDrafts((current) =>
                  current.map((value, currentIndex) =>
                    currentIndex === index ? event.target.value : value,
                  ),
                );
              }}
              spellCheck={false}
            />
          </article>
        ))}
      </div>

      <div className="interrupt-toolbar">
        <button
          className="secondary-button"
          onClick={onReject}
          disabled={isBusy}
        >
          Reject
        </button>
        <button
          className="secondary-button"
          onClick={onApprove}
          disabled={isBusy}
        >
          Approve
        </button>
        <button
          className="primary-button"
          onClick={() => onApplyEdits(drafts)}
          disabled={isBusy}
        >
          Resume With Edits
        </button>
      </div>
    </section>
  );
}

function CameraPanel({
  cameraState,
  cameraActions,
  onAccept,
}: {
  cameraState: import("./hooks/use-camera").CameraState;
  cameraActions: import("./hooks/use-camera").CameraActions;
  onAccept: (dataUri: string) => void;
}) {
  if (!cameraState.isOpen) return null;

  return (
    <section className="camera-panel">
      <div className="camera-header">
        <h3>Camera</h3>
        <button className="link-button" onClick={cameraActions.close}>
          Close
        </button>
      </div>

      {cameraState.error ? (
        <p className="camera-error">{cameraState.error}</p>
      ) : cameraState.snapshot ? (
        <div className="camera-preview-wrap">
          <img src={cameraState.snapshot} alt="Snapshot" className="camera-preview-img" />
          <div className="camera-toolbar">
            <button className="secondary-button" onClick={cameraActions.retake}>
              Retake
            </button>
            <button
              className="primary-button"
              onClick={() => {
                const uri = cameraActions.accept();
                if (uri) onAccept(uri);
              }}
            >
              Use Photo
            </button>
          </div>
        </div>
      ) : (
        <div className="camera-preview-wrap">
          <video
            ref={cameraActions.videoRef}
            autoPlay
            playsInline
            muted
            className="camera-video"
          />
          {cameraState.isReady ? (
            <div className="camera-toolbar">
              <button className="primary-button" onClick={cameraActions.capture}>
                Capture
              </button>
            </div>
          ) : (
            <p className="muted-copy">Starting camera…</p>
          )}
        </div>
      )}
    </section>
  );
}

function App() {
  const {
    runtime,
    backendUrl,
    setBackendUrl,
    backend,
    refreshBackend,
    threads,
    currentThread,
    switchThread,
    createThread,
    approveInterrupt,
    rejectInterrupt,
    applyEdits,
    addPendingImage,
    pendingImages,
    clearPendingImages,
  } = useAgentCoreApp();

  const [cameraState, cameraActions] = useCamera();
  const quickStarts = {
    coding: [
      "先用只读工具概览当前工作区，再告诉我最值得看的 3 个入口文件。",
      "检查当前工作区里最可能需要修的 TypeScript / 构建问题，先不要改代码。",
    ],
    docs: [
      "读一下当前工作区的 docs/specs，并总结最重要的待实现项。",
      "帮我总结当前工作区的文档结构，并指出哪些说明已经过期。",
    ],
    diagnostics: [
      "检查一下本地 agent-core 后端、skills、subagents 和 diagnostics，告诉我当前状态。",
      "解释一下最近一次 trace / diagnostics 里发生了什么，重点看 verify、compaction 和 fallback。",
    ],
    desktop: [
      "这是一个桌面轻代理任务：先观察前台 UI，再告诉我下一步应该点什么，不要直接执行。",
      "先观察当前前台应用的 UI，给我一个最稳妥的单步操作建议。",
    ],
  } as const;
  const runStarterPrompt = (prompt: string) => {
    runtime.thread.append({
      role: "user",
      content: [{ type: "text", text: prompt }],
      startRun: true,
    });
  };

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="app-shell">
        <aside className="sidebar">
          <div className="sidebar-top">
            <p className="eyebrow">Agent Core Web</p>
            <h1>Local Agent Cockpit</h1>
            <p className="sidebar-copy">
              A browser front-end for your local `agent-core` runtime, powered by
              assistant-ui and your existing HTTP/SSE endpoints.
            </p>
            <button
              className="primary-button"
              onClick={createThread}
              disabled={currentThread.isRunning}
            >
              New Thread
            </button>
          </div>

          <div className="sidebar-section">
            <div className="section-heading">
              <span>Backend</span>
              <button className="link-button" onClick={() => void refreshBackend()}>
                Refresh
              </button>
            </div>
            <label className="backend-label">
              <span>Base URL</span>
              <input
                value={backendUrl}
                onChange={(event) => setBackendUrl(event.target.value)}
                placeholder="http://127.0.0.1:8787"
              />
            </label>

            <div className="status-grid">
              <div className={`status-card ${backend.healthy ? "healthy" : "offline"}`}>
                <span>Status</span>
                <strong>{backend.loading ? "Checking…" : backend.healthy ? "Connected" : "Offline"}</strong>
              </div>
              <div className="status-card">
                <span>Skills</span>
                <strong>{backend.skills?.skills.length ?? 0}</strong>
              </div>
              <div className="status-card">
                <span>Subagents</span>
                <strong>
                  {(backend.subagents?.subagents.length ?? 0) +
                    (backend.subagents?.generalPurposeAgent.enabled ? 1 : 0)}
                </strong>
              </div>
              <div className="status-card">
                <span>Workspace</span>
                <strong>{backend.workspaceMode ?? "unknown"}</strong>
              </div>
            </div>

            {backend.workspaceDir ? (
              <p className="muted-copy">
                {backend.model ?? "unknown model"} · {backend.promptProfile ?? "?"} ·{" "}
                ctx {backend.contextWindowSize ?? "?"}
                <br />
                {backend.workspaceDir}
                {backend.virtualMode ? " · virtual" : ""}
              </p>
            ) : null}

            {backend.error ? <p className="backend-error">{backend.error}</p> : null}
          </div>

          <div className="sidebar-section">
            <div className="section-heading">
              <span>Threads</span>
              <span>{threads.length}</span>
            </div>
            <div className="thread-list">
              {threads.map((thread) => (
                <button
                  key={thread.id}
                  className={`thread-pill ${thread.id === currentThread.id ? "active" : ""}`}
                  onClick={() => switchThread(thread.id)}
                >
                  <span className="thread-title">{thread.title}</span>
                  <span className="thread-meta">
                    {thread.pendingInterrupt ? "Approval" : thread.isRunning ? "Running" : "Idle"}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </aside>

        <main className="workspace">
          <header className="workspace-header">
            <div>
              <p className="eyebrow">Current thread</p>
              <h2>{currentThread.title}</h2>
            </div>
            <div className="header-badges">
              <span className="header-badge">Trace: {currentThread.traceId ?? "pending"}</span>
              <span className="header-badge">
                {currentThread.contextCompaction ? "Compacted" : "Full context"}
              </span>
            </div>
          </header>

          <section className="workspace-grid">
            <div className="chat-panel">
              <ThreadPrimitive.Root className="thread-root">
                <ThreadPrimitive.Viewport className="thread-viewport" autoScroll>
                  {currentThread.messages.length === 0 ? (
                    <div className="empty-state">
                      <p className="eyebrow">Ready</p>
                      <h3>Use Gemma where it is already strong</h3>
                      <p>
                        Pick a focused entry point instead of starting with an open-ended
                        request. Gemma is currently strongest at coding, docs, diagnostics,
                        and desktop-lite short loops.
                      </p>
                      <div className="event-list">
                        <div className="event-item tool_finished">
                          <div>
                            <strong>Coding</strong>
                            <p>Inspect-first code reading, bug triage, controlled edits</p>
                          </div>
                          <div className="suggestion-row">
                            {quickStarts.coding.map((prompt) => (
                              <button
                                key={prompt}
                                className="suggestion-chip"
                                onClick={() => runStarterPrompt(prompt)}
                              >
                                {prompt}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className="event-item tool_finished">
                          <div>
                            <strong>Docs</strong>
                            <p>Spec summarization, workspace notes, project orientation</p>
                          </div>
                          <div className="suggestion-row">
                            {quickStarts.docs.map((prompt) => (
                              <button
                                key={prompt}
                                className="suggestion-chip"
                                onClick={() => runStarterPrompt(prompt)}
                              >
                                {prompt}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className="event-item tool_finished">
                          <div>
                            <strong>Diagnostics</strong>
                            <p>Backend health, traces, compaction, verify/fallback signals</p>
                          </div>
                          <div className="suggestion-row">
                            {quickStarts.diagnostics.map((prompt) => (
                              <button
                                key={prompt}
                                className="suggestion-chip"
                                onClick={() => runStarterPrompt(prompt)}
                              >
                                {prompt}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className="event-item tool_finished">
                          <div>
                            <strong>Desktop-lite</strong>
                            <p>Observe first, then do one GUI step, then verify</p>
                          </div>
                          <div className="suggestion-row">
                            {quickStarts.desktop.map((prompt) => (
                              <button
                                key={prompt}
                                className="suggestion-chip"
                                onClick={() => runStarterPrompt(prompt)}
                              >
                                {prompt}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <ThreadPrimitive.Messages>
                      {({ message }) => <MessageBubble message={message} />}
                    </ThreadPrimitive.Messages>
                  )}
                </ThreadPrimitive.Viewport>
              </ThreadPrimitive.Root>

              {currentThread.pendingInterrupt ? (
                <InterruptPanel
                  key={currentThread.pendingInterrupt.actionRequests
                    .map((action) => `${action.name}:${JSON.stringify(action.args)}`)
                    .join("|")}
                  interruptRequest={currentThread.pendingInterrupt}
                  isBusy={currentThread.isRunning}
                  onApprove={approveInterrupt}
                  onReject={rejectInterrupt}
                  onApplyEdits={applyEdits}
                />
              ) : null}

              <CameraPanel
                cameraState={cameraState}
                cameraActions={cameraActions}
                onAccept={(dataUri) => {
                  addPendingImage(dataUri);
                }}
              />

              <ComposerPrimitive.Root className="composer-shell">
                <ComposerPrimitive.Attachments
                  components={{
                    Attachment: ({ attachment }: any) => (
                      <div className="composer-attachment">
                        {attachment.type === "image" && attachment.file ? (
                          <img
                            src={URL.createObjectURL(attachment.file)}
                            alt={attachment.name}
                            className="composer-attachment-img"
                          />
                        ) : (
                          <span className="composer-attachment-name">{attachment.name}</span>
                        )}
                      </div>
                    ),
                  }}
                />

                {pendingImages.length > 0 && (
                  <div className="pending-images-row">
                    {pendingImages.map((uri, i) => (
                      <div key={`cam-${i}`} className="composer-attachment">
                        <img src={uri} alt={`Camera ${i + 1}`} className="composer-attachment-img" />
                      </div>
                    ))}
                    <button
                      className="link-button"
                      onClick={clearPendingImages}
                    >
                      Clear
                    </button>
                  </div>
                )}

                <div className="composer-row">
                  <ComposerPrimitive.AddAttachment className="composer-attach-btn" />
                  <button
                    type="button"
                    className="composer-attach-btn"
                    title="Open camera"
                    onClick={cameraActions.open}
                  >
                    📷
                  </button>
                  <ComposerPrimitive.Input
                    className="composer-input"
                    placeholder="Ask Agent Core to inspect code, run tools, or explain its work…"
                    submitMode="enter"
                    rows={1}
                  />
                  <ComposerPrimitive.Send className="primary-button composer-send">
                    Send
                  </ComposerPrimitive.Send>
                </div>
              </ComposerPrimitive.Root>
            </div>

            <aside className="inspector-panel">
              <section className="inspector-card">
                <div className="section-heading">
                  <span>Diagnostics</span>
                  <span>{backend.diagnostics?.eventsAnalyzed ?? 0}</span>
                </div>
                {backend.diagnostics ? (
                  <div className="tag-cloud">
                    <span className="tag-pill">
                      Context {backend.diagnostics.contextUsage.lastUsagePercent ?? "?"}%
                    </span>
                    <span className="tag-pill">
                      Compaction {backend.diagnostics.compaction.count}
                    </span>
                    <span className="tag-pill">
                      Verify {backend.diagnostics.verification.passed}/
                      {backend.diagnostics.verification.failed}
                    </span>
                    <span className="tag-pill">
                      GUI Avg {backend.diagnostics.runs.avgGuiActionStepsPerCompletedRun ?? "?"}
                    </span>
                  </div>
                ) : (
                  <p className="muted-copy">
                    Backend diagnostics will appear here after the first refresh.
                  </p>
                )}

                {backend.diagnostics ? (
                  <div className="event-list">
                    <div className="event-item tool_finished">
                      <div>
                        <strong>Context</strong>
                        <p>
                          Avg prompt {backend.diagnostics.contextUsage.avgPromptTokens ?? "?"} /
                          peak {backend.diagnostics.contextUsage.peakUsagePercent ?? "?"}%
                        </p>
                      </div>
                    </div>
                    <div className="event-item tool_finished">
                      <div>
                        <strong>Stages</strong>
                        <p>
                          observe {backend.diagnostics.staging.byStage.observe ?? 0} · act_fs{" "}
                          {backend.diagnostics.staging.byStage.act_fs ?? 0} · act_gui{" "}
                          {backend.diagnostics.staging.byStage.act_gui ?? 0} · verify{" "}
                          {backend.diagnostics.staging.byStage.verify ?? 0}
                        </p>
                      </div>
                    </div>
                    <div className="event-item tool_finished">
                      <div>
                        <strong>Runs</strong>
                        <p>
                          avg tools {backend.diagnostics.runs.avgToolCallsPerCompletedRun ?? "?"} ·
                          avg GUI {backend.diagnostics.runs.avgGuiActionStepsPerCompletedRun ?? "?"}{" "}
                          / budget {backend.diagnostics.staging.guiStepBudget}
                        </p>
                      </div>
                    </div>
                  </div>
                ) : null}
              </section>

              <section className="inspector-card">
                <div className="section-heading">
                  <span>Runtime Notes</span>
                  <span>{currentThread.toolEvents.length}</span>
                </div>
                {currentThread.toolEvents.length === 0 ? (
                  <p className="muted-copy">
                    Tool start/finish events will appear here during streaming runs.
                  </p>
                ) : (
                  <ul className="event-list">
                    {currentThread.toolEvents.map((event) => (
                      <li key={event.id} className={`event-item ${event.kind}`}>
                        <div>
                          <strong>{event.toolName}</strong>
                          <p>{event.kind.replaceAll("_", " ")}</p>
                        </div>
                        <pre>{JSON.stringify(event.payload, null, 2)}</pre>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="inspector-card">
                <div className="section-heading">
                  <span>Loaded Skills</span>
                  <span>{backend.skills?.skills.length ?? 0}</span>
                </div>
                <div className="tag-cloud">
                  {backend.skills?.skills.length ? (
                    backend.skills.skills.map((skill) => (
                      <span key={skill.name} className="tag-pill">
                        {skill.name}
                      </span>
                    ))
                  ) : (
                    <p className="muted-copy">No skills detected for this workspace.</p>
                  )}
                </div>
              </section>

              <section className="inspector-card">
                <div className="section-heading">
                  <span>Subagents</span>
                  <span>
                    {(backend.subagents?.subagents.length ?? 0) +
                      (backend.subagents?.generalPurposeAgent.enabled ? 1 : 0)}
                  </span>
                </div>
                <div className="tag-cloud">
                  {backend.subagents?.generalPurposeAgent.enabled ? (
                    <span className="tag-pill">general-purpose</span>
                  ) : null}
                  {backend.subagents?.subagents.length ? (
                    backend.subagents.subagents.map((subagent) => (
                      <span key={subagent.name} className="tag-pill">
                        {subagent.name}
                      </span>
                    ))
                  ) : (
                    <p className="muted-copy">
                      No custom subagents found in `.deepagents/subagents`.
                    </p>
                  )}
                </div>
              </section>

              {currentThread.error ? (
                <section className="inspector-card error-card">
                  <div className="section-heading">
                    <span>Last Error</span>
                  </div>
                  <p>{currentThread.error}</p>
                </section>
              ) : null}
            </aside>
          </section>
        </main>
      </div>
    </AssistantRuntimeProvider>
  );
}

export default App;
