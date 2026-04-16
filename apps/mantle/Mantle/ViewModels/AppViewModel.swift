import Foundation
import SwiftUI
import SwiftData
import UniformTypeIdentifiers
import AppKit
import os

// MARK: - App View Model
//
// Top-level state: backend connection, thread list, active thread.
// Shared between PopoverView and MainWindowView.

@Observable
@MainActor
final class AppViewModel {

    struct PreflightQuickAction {
        let title: String
        let systemImage: String
        let perform: () -> Void
    }

    // MARK: - Backend State

    enum BackendStatus: Equatable {
        case disconnected
        case connecting
        case connected(model: String?)
        case error(String)

        var isConnected: Bool {
            if case .connected = self { return true }
            return false
        }
    }

    private(set) var backendStatus: BackendStatus = .disconnected
    private(set) var backendHealth: HealthResponse?
    private(set) var backendDiagnostics: DiagnosticsResponse?
    private(set) var backendDoctor: DoctorResponse?
    private(set) var activeThreadMemoryInjection: MemoryInjectionSnapshot?
    var backendURL: String {
        didSet {
            UserDefaults.standard.set(backendURL, forKey: "mantle.backendURL")
            reconnect()
        }
    }

    // MARK: - Input Focus

    /// Set to true when the hotkey activates the window; ChatInputBar observes this.
    var shouldFocusInput = false

    // MARK: - Threads

    private(set) var threads: [ThreadState] = []
    var activeThreadId: String?

    var activeThread: ThreadState? {
        guard let id = activeThreadId else { return nil }
        return threads.first { $0.id == id }
    }

    // MARK: - Services

    private(set) var client: AgentCoreClient
    private(set) var sseClient: SSEStreamClient
    private(set) var chatVM: ChatViewModel
    private(set) var returnsService: ReturnsService

    // MARK: - Process Manager

    private(set) var processManager: BackendProcessManager
    private(set) var processState: ProcessState = .detecting

    // MARK: - Context Daemon

    let contextDaemon = ContextDaemon()
    let permissionManager = PermissionManager()

    // MARK: - Camera

    let cameraService = CameraCaptureService()
    /// Pending camera images (base64 data URIs) to attach to the next message
    var pendingCameraImages: [String] = []

    // MARK: - Speech

    let speechService = SpeechService()
    let mediaPipeline = MediaPipeline()

    // MARK: - Computer Use

    let computerUseService = ComputerUseService()
    private var computerUseServer: ComputerUseServer?

    // MARK: - Twitter Bookmarks

    let twitterBookmarkStore: TwitterBookmarkStore
    /// Stage B：后台消化 daemon。懒启动以确保 baseURL 已加载。
    private(set) var twitterBookmarkDaemon: TwitterBookmarkDaemon?
    /// Stage C：每晚 22:00 触发 daily digest。
    private(set) var dailyDigestScheduler: DailyDigestScheduler?

    /// Focus Mode / 用户活跃度判断。供 Daemon 做 quiet-time gating。
    /// "安静"定义：不在 Focus Mode 且 idleSeconds > 5min。
    var isQuietTime: Bool {
        let snap = contextDaemon.currentSnapshot
        let inFocus = snap.focusMode?.isActive ?? false
        let idleSec = snap.activity?.idleSeconds ?? 0
        return !inFocus && idleSec >= 300
    }

    // MARK: - Persistence

    private let modelContext: ModelContext

    // MARK: - Health Check

    private var healthCheckTask: Task<Void, Never>?
    private var processObserverTask: Task<Void, Never>?

    // MARK: - Streaming Persistence

    /// Interval between intermediate persistence saves during streaming (seconds)
    private let streamPersistInterval: TimeInterval = 5.0
    /// Tracks the last time we persisted during an active stream
    private var lastStreamPersistTime: Date?
    private var lastDiagnosticsRefresh: Date?
    private var lastDoctorRefresh: Date?
    private var draftTaskMode: ThreadTaskMode =
        UserDefaults.standard.string(forKey: "mantle.draftTaskMode")
            .flatMap(ThreadTaskMode.init(rawValue:))
            ?? .auto

    // MARK: - Init

    init(modelContext: ModelContext) {
        self.modelContext = modelContext
        self.twitterBookmarkStore = TwitterBookmarkStore(modelContext: modelContext)

        let savedURL = UserDefaults.standard.string(forKey: "mantle.backendURL")
            ?? "http://127.0.0.1:8787"
        self.backendURL = savedURL

        let baseURL = URL(string: savedURL) ?? URL(string: "http://127.0.0.1:8787")!
        self.client = AgentCoreClient(baseURL: baseURL)
        self.sseClient = SSEStreamClient(baseURL: baseURL)
        self.chatVM = ChatViewModel(
            sseClient: SSEStreamClient(baseURL: baseURL),
            apiClient: AgentCoreClient(baseURL: baseURL)
        )
        self.returnsService = ReturnsService(baseURL: baseURL)

        // Backend process manager
        self.processManager = BackendProcessManager()

        // Migrate from UserDefaults if needed, then load from SwiftData
        migrateFromUserDefaults()
        loadThreads()

        // Request notification permission
        NotificationManager.shared.requestPermission()

        // Start context daemon (environment snapshot collection)
        contextDaemon.start()
        Task {
            await permissionManager.refreshScreenCaptureStatus()
        }

        // Start computer-use HTTP server (agent-core calls this to execute desktop actions)
        startComputerUseServer()

        // Wire VAD result callback: when VAD+ASR produces text, send it
        speechService.onVADResult = { [weak self] text in
            self?.send(text)
        }

        // Start health monitoring + process manager
        startHealthCheck()

        // Start Returns Plane subscription (menu-bar Inbox).
        // Safe to call even if backend isn't up yet — the SSE loop will
        // back off and retry until it succeeds.
        returnsService.start()

        let autoStart = UserDefaults.standard.object(forKey: "mantle.autoStartBackend") as? Bool ?? true
        if autoStart {
            Task { await processManager.start() }
        }
        observeProcessManager()
    }

    // MARK: - Starter Flows

    struct LaunchWorkflow: Identifiable, Hashable {
        let id: String
        let title: String
        let subtitle: String
        let trustCue: String
        let systemImage: String
        let taskMode: ThreadTaskMode
        let prompt: String

        init(id: String, title: String, subtitle: String, trustCue: String, systemImage: String, taskMode: ThreadTaskMode, prompt: String) {
            self.id = id
            self.title = title
            self.subtitle = subtitle
            self.trustCue = trustCue
            self.systemImage = systemImage
            self.taskMode = taskMode
            self.prompt = prompt
        }
    }

    struct StarterFlow: Identifiable, Hashable {
        let id: String
        let title: String
        let subtitle: String
        let systemImage: String
        let taskMode: ThreadTaskMode
        let prompt: String

        init(id: String, title: String, subtitle: String, systemImage: String, taskMode: ThreadTaskMode, prompt: String) {
            self.id = id
            self.title = title
            self.subtitle = subtitle
            self.systemImage = systemImage
            self.taskMode = taskMode
            self.prompt = prompt
        }
    }

    let launchWorkflows: [LaunchWorkflow] = [
        LaunchWorkflow(
            id: "rewrite-selection",
            title: "Rewrite Selection",
            subtitle: "围绕你刚选中的文字做改写、总结或回复草稿。",
            trustCue: "Uses selected text as the task anchor",
            systemImage: "text.quote",
            taskMode: .docs,
            prompt: "如果我刚刚从其他 app 带着选中文本来到这里，请基于那段文本和当前上下文，帮我完成最有用的一种处理：改写、总结或回复草稿。如果当前上下文里还没有可处理的文本，就先用一句简短中文问我想处理哪段内容。"
        ),
        LaunchWorkflow(
            id: "organize-downloads",
            title: "Organize Downloads",
            subtitle: "先检查 Downloads，给计划，确认后执行，并保留回滚。",
            trustCue: "Creates an audit trail and keeps rollback available",
            systemImage: "folder.badge.gearshape",
            taskMode: .auto,
            prompt: "帮我整理 `Downloads`。先只检查 `Downloads` 目录，给出一个具体移动计划，并说明哪些文件会保守保留在原处；等我确认后再执行。整理完成后要保留审计记录，并确保后续可以回滚。"
        ),
        LaunchWorkflow(
            id: "turn-context-into-todo",
            title: "Turn Context into Todo",
            subtitle: "把当前 app、窗口和最近文件整理成总结与下一步。",
            trustCue: "Grounded in your current app, window, and recent files",
            systemImage: "checklist",
            taskMode: .auto,
            prompt: "根据我当前的 app、窗口标题和最近文件，把我正在做的事情整理成一句简短总结，再给 3-5 条最值得先做的下一步。尽量引用当前可见的文件名、工作流或资产，不要泛泛而谈。"
        )
    ]

    let starterFlows: [StarterFlow] = [
        StarterFlow(
            id: "coding",
            title: "Coding",
            subtitle: "先只读概览仓库，再定位入口文件与关键模块。",
            systemImage: "hammer",
            taskMode: .coding,
            prompt: "先只读概览当前工作区，找出主要入口文件、核心模块和最近最值得注意的实现点，然后用简洁中文给我一个导览。除非我明确要求，不要修改文件。"
        ),
        StarterFlow(
            id: "docs",
            title: "Docs",
            subtitle: "先读 docs 和 specs，再总结项目状态与待办。",
            systemImage: "doc.text",
            taskMode: .docs,
            prompt: "先阅读当前工作区最重要的文档、specs 和最近的实现说明，整理当前项目状态、主要能力、待办和风险。优先使用只读工具。"
        ),
        StarterFlow(
            id: "diagnostics",
            title: "Diagnostics",
            subtitle: "先检查 health、diagnostics 和可用能力，再给结论。",
            systemImage: "stethoscope",
            taskMode: .auto,
            prompt: "先检查当前 backend 的 health、diagnostics、skills 和 subagents，再给我一个简洁的运行状态诊断，指出最值得优先处理的问题。"
        ),
        StarterFlow(
            id: "desktop-lite",
            title: "Desktop-lite",
            subtitle: "先观察当前前台 UI，只做观察与建议，不直接执行。",
            systemImage: "macwindow",
            taskMode: .desktopLite,
            prompt: "先观察当前前台应用和 UI 状态，只做观察和下一步建议，不要直接执行桌面动作；如果需要执行，请先说明风险和预期结果。"
        )
    ]

    var composerTaskMode: ThreadTaskMode {
        get {
            guard let id = activeThreadId,
                  let index = threads.firstIndex(where: { $0.id == id }) else {
                return draftTaskMode
            }
            return threads[index].taskMode
        }
        set {
            if let id = activeThreadId,
               let index = threads.firstIndex(where: { $0.id == id }) {
                threads[index].taskMode = newValue
                persistThread(at: index)
            }
            draftTaskMode = newValue
            UserDefaults.standard.set(newValue.rawValue, forKey: "mantle.draftTaskMode")
        }
    }

    // MARK: - Thread Management

    func createThread(title: String = "New Chat", taskMode: ThreadTaskMode? = nil) {
        let resolvedTaskMode = taskMode ?? draftTaskMode
        draftTaskMode = resolvedTaskMode
        UserDefaults.standard.set(resolvedTaskMode.rawValue, forKey: "mantle.draftTaskMode")
        let thread = ThreadState(title: title, taskMode: resolvedTaskMode)
        threads.insert(thread, at: 0)
        activeThreadId = thread.id
        activeThreadMemoryInjection = nil
        persistThread(at: 0)
    }

    func startLaunchWorkflow(_ workflow: LaunchWorkflow) {
        if workflow.id == "rewrite-selection" {
            startRewriteSelectionWorkflow(workflow: workflow)
            return
        }
        startEntry(title: workflow.title, taskMode: workflow.taskMode, prompt: workflow.prompt)
    }

    func startRewriteSelectionWorkflow(selection: SelectionInfo? = nil) {
        guard let workflow = launchWorkflows.first(where: { $0.id == "rewrite-selection" }) else { return }
        startRewriteSelectionWorkflow(workflow: workflow, selection: selection)
    }

    func startStarterFlow(_ starter: StarterFlow) {
        startEntry(title: starter.title, taskMode: starter.taskMode, prompt: starter.prompt)
    }

    private func startRewriteSelectionWorkflow(workflow: LaunchWorkflow, selection: SelectionInfo? = nil) {
        if let selection {
            contextDaemon.seedSelection(selection)
            startEntry(
                title: workflow.title,
                taskMode: workflow.taskMode,
                prompt: rewriteSelectionPrompt(workflow: workflow, selection: selection)
            )
            return
        }

        if let capturedSelection = contextDaemon.captureSelectionForLaunch() {
            startEntry(
                title: workflow.title,
                taskMode: workflow.taskMode,
                prompt: rewriteSelectionPrompt(workflow: workflow, selection: capturedSelection)
            )
            return
        }

        startEntry(title: workflow.title, taskMode: workflow.taskMode, prompt: workflow.prompt)
    }

    private func startEntry(title: String, taskMode: ThreadTaskMode, prompt: String) {
        if activeThread?.isStreaming == true {
            stopActiveStream()
        }
        if let thread = activeThread,
           thread.messages.isEmpty,
           !thread.isStreaming,
           let index = threads.firstIndex(where: { $0.id == thread.id }) {
            threads[index].title = title
            threads[index].taskMode = taskMode
            persistThread(at: index)
            draftTaskMode = taskMode
            UserDefaults.standard.set(taskMode.rawValue, forKey: "mantle.draftTaskMode")
            send(prompt)
            return
        }
        createThread(title: title, taskMode: taskMode)
        send(prompt)
    }

    private func rewriteSelectionPrompt(workflow: LaunchWorkflow, selection: SelectionInfo) -> String {
        var metadata = ["Selected chars: \(selection.text.count)"]
        if let sourceAppName = selection.sourceAppName, !sourceAppName.isEmpty {
            metadata.append("Source app: \(sourceAppName)")
        }
        if let sourceBundleId = selection.sourceBundleId, !sourceBundleId.isEmpty {
            metadata.append("Bundle ID: \(sourceBundleId)")
        }

        return """
        \(workflow.prompt)

        [Selected Text]
        \(selection.text)

        [Selection Metadata]
        \(metadata.joined(separator: "\n"))
        """
    }

    func renameThread(id: String, title: String) {
        guard let index = threads.firstIndex(where: { $0.id == id }) else { return }
        threads[index].title = title
        persistThread(at: index)
    }

    func deleteThread(id: String) {
        threads.removeAll { $0.id == id }
        if activeThreadId == id {
            activeThreadId = threads.first?.id
        }

        // Delete from SwiftData
        ThreadState.delete(id: id, from: modelContext)

        // Best-effort delete on backend
        Task {
            try? await client.deleteThread(threadId: id)
        }
    }

    func selectThread(id: String) {
        // Cancel any active stream first
        chatVM.cancel()
        activeThreadId = id
        Task { await refreshActiveThreadMemoryInjection(force: true) }
    }

    /// Retry the last user message in the active thread
    func retryLastMessage() {
        guard let id = activeThreadId,
              let index = threads.firstIndex(where: { $0.id == id }) else { return }

        // Find last user message
        guard let lastUserMsg = threads[index].messages.last(where: { $0.role == .user }) else { return }
        let text = lastUserMsg.text

        // Clear error state
        threads[index].error = nil

        // Re-send using the existing send flow (without re-adding user message)
        let context = buildRunContext(taskMode: threads[index].taskMode)
        chatVM.send(text: text, threadId: id, context: context) { [weak self] update in
            self?.applyStreamUpdate(threadId: id, update: update)
        }
    }

    /// Send a message in the active thread, optionally with image attachments
    func send(_ text: String, images: [String] = []) {
        MantleLog.app.info("[SEND] called with text=\"\(text.prefix(50))\" images=\(images.count)")
        MantleLog.runtime("app", "[SEND] text=\"\(String(text.prefix(80)))\" images=\(images.count)")
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            MantleLog.app.warning("[SEND] text is empty, returning")
            MantleLog.runtime("app", "[SEND] ignored empty input")
            return
        }

        // Collect pending camera images + explicit images
        let allImages = pendingCameraImages + images
        pendingCameraImages = []

        // Create thread if none active
        if activeThreadId == nil {
            createThread(taskMode: draftTaskMode)
        }

        guard let threadId = activeThreadId,
              let index = threads.firstIndex(where: { $0.id == threadId }) else { return }

        // Add user message (with image attachments for display)
        let userMessage = ChatMessage(role: .user, text: text, imageAttachments: allImages)
        threads[index].messages.append(userMessage)
        threads[index].deriveTitle()

        // Persist user message immediately
        persistThread(at: index)

        // Capture current environment context for the LLM
        let context = buildRunContext(taskMode: threads[index].taskMode)

        // Media pipeline: run Vision OCR on attached images, then send enriched text.
        // OCR happens off the main thread (MediaPipeline is an actor). The original
        // image_url blocks are still sent — agent-core strips them for non-vision
        // models; vision models get both the OCR text AND the raw image.
        if allImages.isEmpty {
            chatVM.send(text: text, threadId: threadId, context: context, images: []) { [weak self] update in
                self?.applyStreamUpdate(threadId: threadId, update: update)
            }
        } else {
            Task {
                let enrichedText = await mediaPipeline.enrichText(text, withImages: allImages)
                MantleLog.runtime("app", "[SEND] OCR enriched text length=\(enrichedText.count) from \(allImages.count) image(s)")
                chatVM.send(text: enrichedText, threadId: threadId, context: context, images: allImages) { [weak self] update in
                    self?.applyStreamUpdate(threadId: threadId, update: update)
                }
            }
        }
    }

    /// Edit a user message and resend: removes all messages after the edited one, then sends
    func editAndResend(messageId: String, newText: String) {
        guard !newText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }

        guard let threadId = activeThreadId,
              let index = threads.firstIndex(where: { $0.id == threadId }),
              let msgIndex = threads[index].messages.firstIndex(where: { $0.id == messageId }) else { return }

        // Cancel any active stream
        chatVM.cancel()
        threads[index].isStreaming = false
        threads[index].error = nil

        // Update the message text and mark as edited
        threads[index].messages[msgIndex].text = newText
        threads[index].messages[msgIndex].isEdited = true

        // Remove all messages after the edited one
        let removeAfter = msgIndex + 1
        if removeAfter < threads[index].messages.count {
            threads[index].messages.removeSubrange(removeAfter...)
        }

        // Persist the trimmed state
        persistThread(at: index)

        // Re-send with current context
        let context = buildRunContext(taskMode: threads[index].taskMode)
        chatVM.send(text: newText, threadId: threadId, context: context) { [weak self] update in
            self?.applyStreamUpdate(threadId: threadId, update: update)
        }
    }

    /// Regenerate the last assistant response: removes it and resends the preceding user message
    func regenerateResponse(messageId: String) {
        guard let threadId = activeThreadId,
              let index = threads.firstIndex(where: { $0.id == threadId }),
              let msgIndex = threads[index].messages.firstIndex(where: { $0.id == messageId }),
              threads[index].messages[msgIndex].role == .assistant else { return }

        // Find the preceding user message
        let preceding = threads[index].messages[..<msgIndex].last(where: { $0.role == .user })
        guard let userText = preceding?.text, !userText.isEmpty else { return }

        // Cancel any active stream
        chatVM.cancel()
        threads[index].isStreaming = false
        threads[index].error = nil

        // Remove from assistant message onward
        threads[index].messages.removeSubrange(msgIndex...)

        // Persist and resend with current context
        persistThread(at: index)
        let context = buildRunContext(taskMode: threads[index].taskMode)
        chatVM.send(text: userText, threadId: threadId, context: context) { [weak self] update in
            self?.applyStreamUpdate(threadId: threadId, update: update)
        }
    }

    /// Delete a message and all messages after it (to maintain context coherence)
    func deleteMessage(messageId: String) {
        guard let threadId = activeThreadId,
              let index = threads.firstIndex(where: { $0.id == threadId }),
              let msgIndex = threads[index].messages.firstIndex(where: { $0.id == messageId }) else { return }

        // Don't delete while streaming
        guard !threads[index].isStreaming else { return }

        // Remove from target message onward
        threads[index].messages.removeSubrange(msgIndex...)
        persistThread(at: index)
    }

    // MARK: - Resume (HITL Approval/Rejection)

    func resumeActiveThread(with response: HITLResponse) {
        guard let threadId = activeThreadId,
              let index = threads.firstIndex(where: { $0.id == threadId }) else { return }

        // Clear the pending approval immediately
        threads[index].pendingApproval = nil
        threads[index].isStreaming = true

        chatVM.resume(threadId: threadId, response: response) { [weak self] update in
            self?.applyStreamUpdate(threadId: threadId, update: update)
        }
    }

    // MARK: - Export Chat

    /// Export a thread as Markdown text
    func exportThreadAsMarkdown(id: String) -> String? {
        guard let thread = threads.first(where: { $0.id == id }) else { return nil }

        var lines: [String] = []
        lines.append("# \(thread.title)")
        lines.append("")
        lines.append("*Exported from Mantle — \(Date.now.formatted(date: .long, time: .shortened))*")
        lines.append("")
        lines.append("---")
        lines.append("")

        for msg in thread.messages {
            let role: String
            switch msg.role {
            case .user: role = "**You**"
            case .assistant: role = "**Mantle**"
            case .system: role = "**System**"
            case .tool: role = "**Tool**"
            }

            let time = msg.timestamp.formatted(date: .omitted, time: .shortened)
            lines.append("\(role) *(\(time))*")
            lines.append("")

            if !msg.text.isEmpty {
                lines.append(msg.text)
                lines.append("")
            }

            for event in msg.toolEvents {
                lines.append("> 🔧 **\(event.toolName)** — \(event.status.rawValue)")
                if let input = event.input {
                    lines.append("> Input: `\(input.prefix(200))`")
                }
                if let output = event.output {
                    lines.append("> Output: `\(output.prefix(200))`")
                }
                if let error = event.error {
                    lines.append("> Error: `\(error.prefix(200))`")
                }
                lines.append("")
            }

            lines.append("---")
            lines.append("")
        }

        return lines.joined(separator: "\n")
    }

    /// Export and save to file via NSSavePanel
    func exportActiveThread() {
        guard let id = activeThreadId,
              let markdown = exportThreadAsMarkdown(id: id),
              let thread = activeThread else { return }

        let panel = NSSavePanel()
        panel.title = "Export Chat"
        panel.nameFieldStringValue = "\(thread.title.prefix(40)).md"
        panel.allowedContentTypes = [.plainText]
        panel.canCreateDirectories = true

        guard panel.runModal() == .OK, let url = panel.url else { return }

        do {
            try markdown.write(to: url, atomically: true, encoding: .utf8)
        } catch {
            MantleLog.app.error("Export failed: \(error)")
        }
    }

    /// Copy active thread as Markdown to clipboard
    func copyActiveThreadAsMarkdown() {
        guard let id = activeThreadId,
              let markdown = exportThreadAsMarkdown(id: id) else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(markdown, forType: .string)
    }

    // MARK: - Stop Active Stream

    func stopActiveStream() {
        chatVM.cancel()
        if let id = activeThreadId,
           let index = threads.firstIndex(where: { $0.id == id }) {
            threads[index].isStreaming = false
        }
    }

    // MARK: - Stream Update Handling

    private func applyStreamUpdate(threadId: String, update: ChatViewModel.StreamUpdate) {
        guard let index = threads.firstIndex(where: { $0.id == threadId }) else { return }

        switch update {
        case .streamingStarted(let traceId):
            threads[index].isStreaming = true
            threads[index].lastTraceId = traceId
            threads[index].error = nil
            Task { [weak self] in
                await self?.refreshActiveThreadMemoryInjection(force: true)
            }
            lastStreamPersistTime = nil  // Reset for new stream
            // Initialize streaming stats
            threads[index].streamingStats = StreamingStats(streamStartTime: .now)
            // Add an empty assistant message placeholder (only if last isn't already an empty one)
            let lastAssistant = threads[index].messages.last(where: { $0.role == .assistant })
            if lastAssistant == nil || !(lastAssistant!.text.isEmpty && lastAssistant!.toolEvents.isEmpty) {
                threads[index].messages.append(
                    ChatMessage(role: .assistant, text: "")
                )
            }

        case .textDelta(let delta):
            // Append to last assistant message
            if let lastIdx = threads[index].messages.lastIndex(where: { $0.role == .assistant }) {
                threads[index].messages[lastIdx].text += delta
            }
            // Track token stats
            if threads[index].streamingStats?.firstTokenTime == nil {
                threads[index].streamingStats?.firstTokenTime = .now
            }
            threads[index].streamingStats?.totalCharacters += delta.count
            threads[index].streamingStats?.deltaCount += 1
            // Intermediate persistence: save periodically to guard against crashes
            // Deferred to next run loop to avoid blocking the textDelta hot path
            let now = Date.now
            if let lastPersist = lastStreamPersistTime {
                if now.timeIntervalSince(lastPersist) >= streamPersistInterval {
                    lastStreamPersistTime = now
                    let threadIndex = index
                    Task { @MainActor [weak self] in
                        self?.persistThread(at: threadIndex)
                    }
                }
            } else {
                lastStreamPersistTime = now
            }

        case .toolStarted(let event):
            if let lastIdx = threads[index].messages.lastIndex(where: { $0.role == .assistant }) {
                threads[index].messages[lastIdx].toolEvents.append(event)
            }

        case .toolFinished(let toolName, let output):
            if let lastIdx = threads[index].messages.lastIndex(where: { $0.role == .assistant }) {
                if let toolIdx = threads[index].messages[lastIdx].toolEvents.lastIndex(where: { $0.toolName == toolName && $0.status == .running }) {
                    threads[index].messages[lastIdx].toolEvents[toolIdx].status = .completed
                    threads[index].messages[lastIdx].toolEvents[toolIdx].output = output
                }
            }

        case .toolFailed(let toolName, let error):
            if let lastIdx = threads[index].messages.lastIndex(where: { $0.role == .assistant }) {
                if let toolIdx = threads[index].messages[lastIdx].toolEvents.lastIndex(where: { $0.toolName == toolName && $0.status == .running }) {
                    threads[index].messages[lastIdx].toolEvents[toolIdx].status = .failed
                    threads[index].messages[lastIdx].toolEvents[toolIdx].error = error
                }
            }

        case .contextCompacted(let summary):
            // Insert a system message to indicate context was compacted
            let hint = summary ?? "Context window optimized"
            threads[index].messages.append(
                ChatMessage(role: .system, text: "🗜️ \(hint)")
            )

        case .interrupted(let request):
            threads[index].isStreaming = false
            threads[index].pendingApproval = request
            persistThread(at: index)
            Task { [weak self] in
                await self?.refreshActiveThreadMemoryInjection(force: true)
            }
            // Notify: HITL approval needed
            NotificationManager.shared.notifyApprovalNeeded(
                threadTitle: threads[index].title,
                toolCount: request.actionRequests.count
            )

        case .completed(let result):
            threads[index].isStreaming = false
            threads[index].pendingApproval = nil
            Task { [weak self] in
                await self?.refreshActiveThreadMemoryInjection(force: true)
            }
            // Finalize streaming stats
            threads[index].streamingStats?.streamEndTime = .now
            threads[index].lastCompletedStats = threads[index].streamingStats
            threads[index].streamingStats = nil
            // Sync messages from backend result if available
            if let lastMsg = result.newMessages.last, lastMsg.role == .assistant {
                if let lastIdx = threads[index].messages.lastIndex(where: { $0.role == .assistant }) {
                    threads[index].messages[lastIdx].text = lastMsg.text
                }
            }
            // Remove empty assistant messages (no text and no tool events)
            threads[index].messages.removeAll { msg in
                msg.role == .assistant && msg.text.isEmpty && msg.toolEvents.isEmpty
            }
            // Persist final state
            persistThread(at: index)
            // Auto-speak the assistant response if enabled
            if let lastAssistant = threads[index].messages.last(where: { $0.role == .assistant }) {
                speechService.speakIfAutoEnabled(lastAssistant.text)
            }
            // Notify: task completed
            NotificationManager.shared.notifyTaskCompleted(threadTitle: threads[index].title)

        case .error(let message):
            threads[index].isStreaming = false
            threads[index].error = message
            threads[index].streamingStats?.streamEndTime = .now
            threads[index].lastCompletedStats = threads[index].streamingStats
            threads[index].streamingStats = nil
            persistThread(at: index)
        }
    }

    // MARK: - Process Manager

    func shutdown() async {
        await processManager.stop()
    }

    func restartBackend() async {
        await processManager.restart()
    }

    private func observeProcessManager() {
        processObserverTask = Task { [weak self] in
            guard let self else { return }
            for await state in self.processManager.stateUpdates {
                self.processState = state
                // Map process state to backend status for UI
                switch state {
                case .detecting, .starting, .restarting:
                    self.backendStatus = .connecting
                case .running:
                    // Let health check confirm actual connectivity
                    break
                case .nodeNotFound:
                    self.backendHealth = nil
                    self.backendDiagnostics = nil
                    self.backendDoctor = nil
                    self.backendStatus = .error("Node.js not found")
                case .startFailed(let msg):
                    self.backendHealth = nil
                    self.backendDiagnostics = nil
                    self.backendDoctor = nil
                    self.backendStatus = .error(msg)
                case .crashed(let msg):
                    self.backendHealth = nil
                    self.backendDiagnostics = nil
                    self.backendDoctor = nil
                    self.backendStatus = .error(msg)
                    NotificationManager.shared.notifyBackendError(message: "Backend crashed: \(msg)")
                case .stopped:
                    self.backendHealth = nil
                    self.backendDiagnostics = nil
                    self.backendDoctor = nil
                    self.backendStatus = .disconnected
                }
            }
        }
    }

    // MARK: - Backend Connection

    func reconnect() {
        // Cancel any active stream before replacing clients
        chatVM.cancel()
        backendHealth = nil
        backendDiagnostics = nil
        backendDoctor = nil
        activeThreadMemoryInjection = nil
        lastDiagnosticsRefresh = nil
        lastDoctorRefresh = nil

        guard let baseURL = URL(string: backendURL) else {
            backendHealth = nil
            backendDiagnostics = nil
            backendDoctor = nil
            backendStatus = .error("Invalid backend URL: \(backendURL)")
            return
        }
        client = AgentCoreClient(baseURL: baseURL)
        sseClient = SSEStreamClient(baseURL: baseURL)
        chatVM = ChatViewModel(
            sseClient: SSEStreamClient(baseURL: baseURL),
            apiClient: AgentCoreClient(baseURL: baseURL)
        )
        returnsService.stop()
        returnsService = ReturnsService(baseURL: baseURL)
        returnsService.start()

        // Reset streaming state on active thread
        if let id = activeThreadId,
           let index = threads.firstIndex(where: { $0.id == id }) {
            threads[index].isStreaming = false
        }

        startHealthCheck()
    }

    // MARK: - Computer Use Server

    private func startComputerUseServer() {
        let server = ComputerUseServer(service: computerUseService)
        server.bookmarkStore = twitterBookmarkStore
        // 预先生成/读取 token，确保首次启动就落盘
        _ = ExtensionTokenManager.shared.token()
        do {
            try server.start()
            computerUseServer = server
            MantleLog.app.info("[ComputerUse] server started on port \(ComputerUseServer.defaultPort)")
        } catch {
            MantleLog.app.error("[ComputerUse] server failed to start: \(error)")
        }

        // Twitter digest daemon：周期性消化未处理的 bookmarks。
        let daemon = TwitterBookmarkDaemon(
            store: twitterBookmarkStore,
            client: client
        )
        daemon.quietTimeProvider = { [weak self] in
            self?.isQuietTime ?? true
        }
        daemon.start()
        twitterBookmarkDaemon = daemon

        // 每晚 22:00 触发 daily digest（Stage C）
        let scheduler = DailyDigestScheduler(fireHour: 22, fireMinute: 0)
        scheduler.start { [weak self] in
            guard let self else { return }
            do {
                _ = try await self.twitterBookmarkDaemon?.generateDailyDigest()
            } catch {
                MantleLog.app.error("[DigestScheduler] generateDailyDigest failed: \(error.localizedDescription, privacy: .public)")
            }
        }
        dailyDigestScheduler = scheduler
    }

    // MARK: - Twitter digest 手动触发（debug / deep link）

    /// 立即执行一次 processPending。供 `mantle://twitter/digest-now` 触发。
    func triggerTwitterDigestNow() {
        twitterBookmarkDaemon?.triggerNow()
    }

    /// 立即生成并推送 daily digest 通知。供 `mantle://twitter/digest-daily-now` 触发。
    /// 绕过 Focus gating，用于调试 / 用户主动唤起。
    func fireDailyDigestNow() {
        Task { [weak self] in
            guard let self else { return }
            // 临时绕过 Focus gating
            let original = self.twitterBookmarkDaemon?.quietTimeProvider
            self.twitterBookmarkDaemon?.quietTimeProvider = { true }
            defer { self.twitterBookmarkDaemon?.quietTimeProvider = original }
            do {
                _ = try await self.twitterBookmarkDaemon?.generateDailyDigest()
            } catch {
                MantleLog.app.error("[fireDailyDigestNow] failed: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    // MARK: - Health Check

    private func startHealthCheck() {
        healthCheckTask?.cancel()
        backendHealth = nil
        backendDiagnostics = nil
        backendDoctor = nil
        activeThreadMemoryInjection = nil
        lastDiagnosticsRefresh = nil
        lastDoctorRefresh = nil
        backendStatus = .connecting

        healthCheckTask = Task { [weak self] in
            guard let self else { return }

            // Initial check — poll every 2s until healthy
            var attempts = 0
            while !Task.isCancelled && attempts < 15 {
                if await self.checkHealth() { break }
                attempts += 1
                try? await Task.sleep(for: .seconds(2))
            }

            // Steady-state — poll every 10s
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                await self.checkHealth()
            }
        }
    }

    @discardableResult
    private func checkHealth() async -> Bool {
        do {
            let response = try await client.health()
            if response.ok {
                backendHealth = response
                backendStatus = .connected(model: response.model)
                await refreshDiagnosticsIfNeeded()
                await refreshDoctorIfNeeded()
                await refreshActiveThreadMemoryInjection()
                return true
            } else {
                backendHealth = nil
                backendDiagnostics = nil
                backendDoctor = nil
                activeThreadMemoryInjection = nil
                backendStatus = .error("Backend returned ok=false")
                return false
            }
        } catch {
            backendHealth = nil
            backendDiagnostics = nil
            backendDoctor = nil
            activeThreadMemoryInjection = nil
            backendStatus = .error(error.localizedDescription)
            return false
        }
    }

    private func buildRunContext(taskMode: ThreadTaskMode) -> String {
        let baseContext = contextDaemon.currentSnapshot.toPromptYAML()
        guard let taskModeContext = taskMode.promptContext else {
            return baseContext
        }
        return """
        \(baseContext)

        [Task Mode Preference]
        \(taskModeContext)
        """
    }

    private func refreshDiagnosticsIfNeeded(force: Bool = false) async {
        if !force, let lastDiagnosticsRefresh,
           Date.now.timeIntervalSince(lastDiagnosticsRefresh) < 8 {
            return
        }

        do {
            backendDiagnostics = try await client.diagnostics()
            lastDiagnosticsRefresh = .now
        } catch {
            if force {
                backendDiagnostics = nil
            }
        }
    }

    private func refreshDoctorIfNeeded(force: Bool = false) async {
        if !force, let lastDoctorRefresh,
           Date.now.timeIntervalSince(lastDoctorRefresh) < 20 {
            return
        }

        do {
            backendDoctor = try await client.doctor()
            lastDoctorRefresh = .now
        } catch {
            if force {
                backendDoctor = nil
            }
        }
    }

    func refreshActiveThreadMemoryInjection(force: Bool = false) async {
        guard let threadId = activeThreadId else {
            activeThreadMemoryInjection = nil
            return
        }

        if !force,
           let snapshot = activeThreadMemoryInjection,
           snapshot.threadId == threadId,
           let updatedAt = ISO8601DateFormatter().date(from: snapshot.updatedAt),
           Date.now.timeIntervalSince(updatedAt) < 8 {
            return
        }

        do {
            let envelope = try await client.memoryInjection(threadId: threadId)
            activeThreadMemoryInjection = envelope.snapshot
        } catch {
            if force {
                activeThreadMemoryInjection = nil
            }
        }
    }

    var shouldShowPreflightCard: Bool {
        if !permissionManager.status.accessibility {
            return true
        }
        if backendHealth == nil {
            return true
        }
        if let doctor = backendDoctor {
            return doctor.summary.overallStatus != .pass
        }
        return false
    }

    func copyDoctorSummaryToClipboard() {
        var lines: [String] = []
        lines.append("Mantle Preflight")
        lines.append("Backend status: \(backendStatusSummary)")
        if let doctor = backendDoctor {
            lines.append("Doctor status: \(doctor.summary.overallStatus.rawValue)")
            for check in doctor.checks {
                let marker: String
                switch check.status {
                case .pass: marker = "PASS"
                case .warn: marker = "WARN"
                case .fail: marker = "FAIL"
                }
                lines.append("[\(marker)] \(check.title): \(check.summary)")
                if let fixHint = check.fixHint, !fixHint.isEmpty {
                    lines.append("  Fix: \(fixHint)")
                }
            }
        }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(lines.joined(separator: "\n"), forType: .string)
    }

    func preflightQuickAction(for check: DoctorCheck) -> PreflightQuickAction? {
        guard let doctor = backendDoctor else { return nil }

        switch check.id {
        case "workspace":
            return PreflightQuickAction(
                title: "Reveal Workspace",
                systemImage: "folder"
            ) { [workspacePath = doctor.runtime.workspaceDir] in
                self.revealPathInFinder(workspacePath)
            }
        case "data-dir":
            return PreflightQuickAction(
                title: "Reveal Data Folder",
                systemImage: "externaldrive"
            ) { [dataDir = doctor.runtime.dataDir] in
                self.revealPathInFinder(dataDir)
            }
        case "memory-store":
            return PreflightQuickAction(
                title: "Reveal Memory File",
                systemImage: "brain"
            ) { [memoryFilePath = doctor.runtime.memoryFilePath] in
                self.revealPathInFinder(memoryFilePath)
            }
        case "model-provider":
            guard
                let baseUrl = doctor.runtime.baseUrl,
                let url = URL(string: baseUrl)
            else {
                return nil
            }
            return PreflightQuickAction(
                title: "Open Provider",
                systemImage: "safari"
            ) {
                NSWorkspace.shared.open(url)
            }
        default:
            return nil
        }
    }

    private var backendStatusSummary: String {
        switch backendStatus {
        case .disconnected:
            return "Disconnected"
        case .connecting:
            return "Connecting"
        case .connected(let model):
            return model.map { "Connected (\($0))" } ?? "Connected"
        case .error(let message):
            return "Error: \(message)"
        }
    }

    private func revealPathInFinder(_ rawPath: String) {
        let path = NSString(string: rawPath).expandingTildeInPath
        let url = URL(fileURLWithPath: path)
        var isDirectory: ObjCBool = false

        if FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) {
            NSWorkspace.shared.activateFileViewerSelecting([url])
            return
        }

        let parent = url.deletingLastPathComponent()
        NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: parent.path)
    }

    // MARK: - SwiftData Persistence

    private func persistThread(at index: Int) {
        guard threads.indices.contains(index) else { return }
        threads[index].save(to: modelContext)

        // Update Spotlight index for searchability
        let threadId = threads[index].id
        if let persisted = try? modelContext.fetch(
            FetchDescriptor<PersistedThread>(predicate: #Predicate { $0.id == threadId })
        ).first {
            SpotlightService.shared.indexThread(persisted)
        }
    }

    private func loadThreads() {
        do {
            var descriptor = FetchDescriptor<PersistedThread>(
                sortBy: [SortDescriptor(\.updatedAt, order: .reverse)]
            )
            descriptor.fetchLimit = 100

            let persisted = try modelContext.fetch(descriptor)
            threads = persisted.map { ThreadState(from: $0) }
            activeThreadId = threads.first?.id
        } catch {
            MantleLog.app.error("Failed to load threads from SwiftData: \(error)")
            threads = []
        }
    }

    private func migrateFromUserDefaults() {
        guard let saved = UserDefaults.standard.array(forKey: "mantle.threads") as? [[String: String]] else {
            return
        }

        do {
            for dict in saved {
                guard let id = dict["id"], let title = dict["title"] else { continue }

                // Check if already migrated
                var descriptor = FetchDescriptor<PersistedThread>(
                    predicate: #Predicate { $0.id == id }
                )
                descriptor.fetchLimit = 1

                if (try? modelContext.fetch(descriptor).first) != nil {
                    continue // Already exists
                }

                let persisted = PersistedThread(id: id, title: title)
                modelContext.insert(persisted)
            }
            try modelContext.save()

            // Clear old data
            UserDefaults.standard.removeObject(forKey: "mantle.threads")
            MantleLog.app.info("Migrated \(saved.count) threads from UserDefaults to SwiftData")
        } catch {
            MantleLog.app.warning("Migration from UserDefaults failed (non-fatal): \(error)")
        }
    }
}
