import SwiftUI

// MARK: - Popover View
//
// Compact chat interface shown in the menu bar popover.
// Contains: status indicator, message list, input bar, expand button.

struct PopoverView: View {
    @Environment(AppViewModel.self) private var appVM
    var onExpandToWindow: () -> Void

    @State private var showCopyToast = false
    @State private var showApproveAllConfirm = false

    private let starterColumns = [
        GridItem(.flexible(), spacing: 10),
        GridItem(.flexible(), spacing: 10)
    ]

    var body: some View {
        VStack(spacing: 0) {
            // Header
            header

            Divider()

            // Messages
            if let thread = appVM.activeThread {
                if thread.messages.isEmpty && !thread.isStreaming {
                    starterState(inExistingThread: true)
                } else {
                    messageList(thread)
                }
            } else {
                emptyState
            }

            Divider()

            // Input
            chatInput
        }
        .background(.ultraThinMaterial)
        .copyToastOverlay(isShowing: $showCopyToast)
        .confirmationDialog("Approve All Actions", isPresented: $showApproveAllConfirm) {
            Button("Approve \(appVM.activeThread?.pendingApproval?.actionRequests.count ?? 0) Actions") {
                if let thread = appVM.activeThread {
                    approveAll(thread: thread)
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This will approve all pending tool actions. Are you sure?")
        }
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                // Status dot with pulse when connecting
                Circle()
                    .fill(statusColor)
                    .frame(width: 8, height: 8)
                    .opacity(isConnecting ? 0.5 : 1.0)
                    .animation(
                        isConnecting
                            ? .easeInOut(duration: Design.pulseDuration).repeatForever(autoreverses: true)
                            : .default,
                        value: isConnecting
                    )
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 2) {
                    Text("Mantle")
                        .font(.headline)
                        .accessibilityLabel("Mantle, \(statusAccessibilityLabel)")
                }

                Spacer()

                // New thread
                Button {
                    appVM.createThread()
                } label: {
                    Image(systemName: "plus.message")
                }
                .buttonStyle(.borderless)
                .help("New Chat (⌘N)")

                // Settings
                SettingsLink {
                    Image(systemName: "gearshape")
                }
                .buttonStyle(.borderless)
                .help("Settings (⌘,)")

                // Expand to window
                Button {
                    onExpandToWindow()
                } label: {
                    Image(systemName: "arrow.up.left.and.arrow.down.right")
                }
                .buttonStyle(.borderless)
                .help("Open Full Window")
            }

            ContextInspectorCard(snapshot: appVM.contextDaemon.currentSnapshot, compact: true)

            if let health = appVM.backendHealth {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        if let model = health.model {
                            runtimeBadge(model)
                        }
                        if let prompt = health.promptProfile {
                            runtimeBadge(prompt)
                        }
                        if let context = health.contextWindowSize {
                            runtimeBadge(formatContextWindow(context))
                        }
                        if let workspaceMode = health.workspaceMode {
                            runtimeBadge(workspaceMode)
                        }
                    }
                }
                .help(runtimeHelpText)
            }
        }
        .padding(.horizontal, Design.containerPadding)
        .padding(.vertical, 8)
    }

    // MARK: - Message List

    private func messageList(_ thread: ThreadState) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Design.messageSpacing) {
                    ForEach(thread.messages) { message in
                        let isLastAssistant = message.role == .assistant
                            && message.id == thread.messages.last(where: { $0.role == .assistant })?.id

                        MessageBubble(
                            message: message,
                            isStreaming: thread.isStreaming && message.id == thread.messages.last?.id,
                            onEdit: message.role == .user ? { msgId, newText in
                                appVM.editAndResend(messageId: msgId, newText: newText)
                            } : nil,
                            onRegenerate: isLastAssistant && !thread.isStreaming ? { msgId in
                                appVM.regenerateResponse(messageId: msgId)
                            } : nil,
                            onDelete: !thread.isStreaming ? { msgId in
                                appVM.deleteMessage(messageId: msgId)
                            } : nil,
                            onCopy: { showCopyToast = true }
                        )
                        .id(message.id)
                    }

                    if thread.isStreaming {
                        StreamingIndicator(stats: thread.streamingStats)
                            .id("streaming")
                    }

                    // Generation stats (shown after completion)
                    if !thread.isStreaming, let stats = thread.lastCompletedStats,
                       stats.totalCharacters > 0 {
                        GenerationStatsBar(stats: stats)
                            .transition(.opacity)
                    }

                    // Error display
                    if let error = thread.error {
                        errorBanner(error)
                    }

                    // HITL Approval
                    if let approval = thread.pendingApproval {
                        ApprovalBanner(
                            request: approval,
                            onApproveAll: { showApproveAllConfirm = true },
                            onRejectAll: { rejectAll(thread: thread) },
                            onSubmitDecisions: { response in
                                appVM.resumeActiveThread(with: response)
                            }
                        )
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                    }
                }
                .padding(Design.containerPadding)
            }
            .onChange(of: thread.messages.count) {
                withAnimation {
                    proxy.scrollTo(thread.messages.last?.id ?? "streaming", anchor: .bottom)
                }
            }
        }
        .frame(maxHeight: .infinity)
    }

    // MARK: - Empty State

    private var emptyState: some View {
        starterState(inExistingThread: false)
    }

    // MARK: - Chat Input

    private var chatInput: some View {
        ChatInputBar(
            onSend: { text in appVM.send(text) },
            taskMode: Binding(
                get: { appVM.composerTaskMode },
                set: { appVM.composerTaskMode = $0 }
            ),
            isConnected: appVM.backendStatus.isConnected,
            isStreaming: appVM.activeThread?.isStreaming ?? false,
            onStop: { appVM.stopActiveStream() },
            cameraService: appVM.cameraService,
            onCameraImage: { dataUri in
                appVM.pendingCameraImages.append(dataUri)
            },
            pendingImages: appVM.pendingCameraImages,
            onClearPendingImages: {
                appVM.pendingCameraImages.removeAll()
            },
            speechService: appVM.speechService,
            requestFocus: .constant(false)
        )
        .padding(Design.messageSpacing)
    }

    // MARK: - Helpers

    private func starterState(inExistingThread: Bool) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Design.sectionSpacing) {
                MantleSectionHeader(
                    eyebrow: inExistingThread ? "Launch" : "Popover",
                    title: inExistingThread ? "Start from a grounded workflow" : "Start directly from current context",
                    subtitle: "The popover is optimized for the three launch workflows first, with broader starters kept underneath."
                )

                VStack(alignment: .leading, spacing: 10) {
                    Text("Launch Workflows")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    LazyVGrid(columns: starterColumns, spacing: 10) {
                        ForEach(appVM.launchWorkflows) { workflow in
                            LaunchWorkflowCard(workflow: workflow, presentation: .compact) {
                                appVM.startLaunchWorkflow(workflow)
                            }
                        }
                    }
                }

                VStack(alignment: .leading, spacing: 10) {
                    Text("More Starters")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    LazyVGrid(columns: starterColumns, spacing: 10) {
                        ForEach(appVM.starterFlows) { starter in
                            StarterFlowCard(starter: starter, presentation: .compact) {
                                launchStarter(starter, inExistingThread: inExistingThread)
                            }
                        }
                    }
                }

                if !inExistingThread {
                    Button {
                        appVM.createThread()
                    } label: {
                        Label("Blank Chat", systemImage: "square.and.pencil")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                }
            }
            .padding(Design.containerPadding)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: .infinity)
    }

    private var isConnecting: Bool {
        if case .connecting = appVM.backendStatus { return true }
        return false
    }

    private var statusColor: Color {
        switch appVM.backendStatus {
        case .connected: .green
        case .connecting: .yellow
        case .disconnected, .error: .red
        }
    }

    private var statusAccessibilityLabel: String {
        switch appVM.backendStatus {
        case .connected: "connected"
        case .connecting: "connecting"
        case .disconnected: "disconnected"
        case .error(let msg): "error: \(msg)"
        }
    }

    private var runtimeHelpText: String {
        guard let health = appVM.backendHealth else { return "Connected to agent-core" }
        let workspace = health.workspaceDir ?? "—"
        let virtualMode = health.virtualMode == true ? "on" : "off"
        return "Workspace: \(workspace)\nVirtual mode: \(virtualMode)"
    }

    private func runtimeBadge(_ text: String) -> some View {
        Text(text)
            .font(.caption2)
            .foregroundStyle(Design.textSecondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Design.surfaceMuted, in: Capsule())
    }

    private func formatContextWindow(_ size: Int) -> String {
        if size >= 1000 {
            return String(format: "%.1fK", Double(size) / 1000)
        }
        return "\(size)"
    }

    private func launchStarter(_ starter: AppViewModel.StarterFlow, inExistingThread _: Bool) {
        appVM.startStarterFlow(starter)
    }

    private func errorBanner(_ message: String) -> some View {
        HStack {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(Design.stateDanger)
            Text(message)
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
            Button {
                appVM.retryLastMessage()
            } label: {
                Label("Retry", systemImage: "arrow.clockwise")
                    .font(.caption)
            }
            .buttonStyle(.bordered)
            .tint(Design.accent)
            .controlSize(.mini)
        }
        .padding(8)
        .background(Design.stateDanger.opacity(0.08), in: RoundedRectangle(cornerRadius: Design.cornerRadius))
    }

    private func approveAll(thread: ThreadState) {
        guard let request = thread.pendingApproval else { return }
        let decisions = request.actionRequests.map { _ in HITLDecision.approve }
        appVM.resumeActiveThread(with: HITLResponse(decisions: decisions))
    }

    private func rejectAll(thread: ThreadState) {
        guard let request = thread.pendingApproval else { return }
        let decisions = request.actionRequests.map { _ in HITLDecision.reject(message: "Rejected by user") }
        appVM.resumeActiveThread(with: HITLResponse(decisions: decisions))
    }
}
