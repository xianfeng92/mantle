import SwiftUI

// MARK: - Chat Detail View
//
// Full chat view for the main window: message history + tool events + input.

struct ChatDetailView: View {
    @Environment(AppViewModel.self) private var appVM

    // In-chat search state
    @State private var chatSearchText = ""
    @State private var chatSearchResults: [String] = []   // matching message IDs
    @State private var currentSearchIndex = 0
    @State private var showingSearch = false

    // Toast state
    @State private var showCopyToast = false

    // Scroll state
    @State private var isNearBottom = true

    // Approve All confirmation
    @State private var showApproveAllConfirm = false

    // Thread checkpoints
    @State private var threadRunSnapshots: [RunSnapshotRecord] = []
    @State private var isLoadingRunSnapshots = false
    @State private var runSnapshotsError: String?
    @State private var selectedSnapshotTraceId: String?
    @State private var selectedRestorePreview: RunSnapshotRestoreResult?
    @State private var previewingSnapshotTraceId: String?
    @State private var restoringSnapshotTraceId: String?

    var body: some View {
        VStack(spacing: 0) {
            if let thread = appVM.activeThread {
                // Search bar (animated)
                if showingSearch {
                    chatSearchBar
                        .transition(.move(edge: .top).combined(with: .opacity))
                    Divider()
                }

                // Messages
                if thread.messages.isEmpty && !thread.isStreaming {
                    starterState(thread)
                } else {
                    messageArea(thread)
                }

                Divider()

                // Input
                ChatInputBar(
                    onSend: { text in appVM.send(text) },
                    taskMode: Binding(
                        get: { appVM.composerTaskMode },
                        set: { appVM.composerTaskMode = $0 }
                    ),
                    isConnected: appVM.backendStatus.isConnected,
                    isStreaming: thread.isStreaming,
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
                    requestFocus: Binding(
                        get: { appVM.shouldFocusInput },
                        set: { appVM.shouldFocusInput = $0 }
                    )
                )
                .padding(Design.containerPadding)
            } else {
                emptyState
            }
        }
        .copyToastOverlay(isShowing: $showCopyToast)
        .animation(.easeInOut(duration: Design.transitionDuration), value: showingSearch)
        .task(id: appVM.activeThreadId) {
            await loadActiveThreadRunSnapshots(force: true)
        }
        .onChange(of: appVM.activeThread?.lastTraceId) { _, _ in
            Task { await loadActiveThreadRunSnapshots(force: true) }
        }
        .onChange(of: appVM.activeThread?.isStreaming ?? false) { _, isStreaming in
            if !isStreaming {
                Task { await loadActiveThreadRunSnapshots(force: true) }
            }
        }
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                // Search toggle
                Button {
                    withAnimation {
                        showingSearch.toggle()
                        if !showingSearch {
                            chatSearchText = ""
                            chatSearchResults = []
                        }
                    }
                } label: {
                    Image(systemName: "magnifyingglass")
                }
                .help("Search in chat (⌘F)")
                .keyboardShortcut("f", modifiers: .command)

                Menu {
                    Button {
                        appVM.exportActiveThread()
                    } label: {
                        Label("Export as Markdown…", systemImage: "square.and.arrow.up")
                    }
                    Button {
                        appVM.copyActiveThreadAsMarkdown()
                    } label: {
                        Label("Copy as Markdown", systemImage: "doc.on.doc")
                    }
                } label: {
                    Image(systemName: "square.and.arrow.up")
                }
                .disabled(appVM.activeThread == nil || appVM.activeThread?.messages.isEmpty == true)
                .help("Export chat")
            }
        }
        .sheet(
            isPresented: Binding(
                get: { selectedSnapshotTraceId != nil },
                set: { isPresented in
                    if !isPresented {
                        selectedSnapshotTraceId = nil
                        selectedRestorePreview = nil
                    }
                }
            )
        ) {
            if let snapshot = currentSelectedSnapshot {
                RunSnapshotDetailSheet(
                    snapshot: snapshot,
                    restorePreview: selectedRestorePreview,
                    isPreviewing: previewingSnapshotTraceId == snapshot.traceId,
                    isRestoring: restoringSnapshotTraceId == snapshot.traceId,
                    onPreviewRestore: {
                        Task { await previewRestore(snapshot) }
                    },
                    onRestoreNow: {
                        Task { await restoreSnapshot(snapshot) }
                    }
                )
            } else {
                VStack(spacing: 12) {
                    ProgressView()
                    Text("Loading checkpoint details…")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                .frame(minWidth: 560, minHeight: 360)
                .padding()
            }
        }
    }

    // MARK: - Empty State

    private var emptyState: some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: "brain.head.profile")
                .font(.system(size: 48))
                .foregroundStyle(.quaternary)
            Text("Select or create a chat")
                .font(.title3)
                .foregroundStyle(.secondary)
            Text("⌘N to start a new conversation")
                .font(.caption)
                .foregroundStyle(.tertiary)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func starterState(_ thread: ThreadState) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Design.blockSpacing) {
                MantleSectionHeader(
                    eyebrow: "Thread",
                    title: thread.title == "New Chat" ? "Start from a grounded workflow" : thread.title,
                    subtitle: "Keep the current context visible, then enter through one of the three launch workflows before using broader starters."
                )

                if appVM.shouldShowPreflightCard {
                    PreflightStatusCard(
                        backendStatus: appVM.backendStatus,
                        processState: appVM.processState,
                        doctor: appVM.backendDoctor,
                        permissionStatus: appVM.permissionManager.status,
                        onQuickFix: { appVM.preflightQuickAction(for: $0) },
                        onRestartBackend: {
                            Task { await appVM.restartBackend() }
                        },
                        onCopyReport: {
                            appVM.copyDoctorSummaryToClipboard()
                        },
                        onOpenAccessibilitySettings: {
                            appVM.permissionManager.openAccessibilitySettings()
                        },
                        onOpenScreenCaptureSettings: {
                            appVM.permissionManager.openScreenCaptureSettings()
                        }
                    )
                }

                ContextInspectorCard(snapshot: appVM.contextDaemon.currentSnapshot)
                MemoryInjectionCard(snapshot: appVM.activeThreadMemoryInjection)
                if shouldShowThreadCheckpointsCard {
                    threadCheckpointsCard
                }

                if let health = appVM.backendHealth {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 10) {
                            if let model = health.model {
                                runtimeBadge("Model: \(model)")
                            }
                            if let prompt = health.promptProfile {
                                runtimeBadge("Prompt: \(prompt)")
                            }
                            if let context = health.contextWindowSize {
                                runtimeBadge("Context: \(formatContextWindow(context))")
                            }
                            if let workspaceMode = health.workspaceMode {
                                runtimeBadge("Mode: \(workspaceMode.capitalized)")
                            }
                        }
                    }
                }

                launchWorkflowSection
                starterFlowSection
            }
            .padding(Design.heroSectionPadding)
            .frame(maxWidth: 960, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .background(Design.surfaceBase)
    }

    private var launchWorkflowSection: some View {
        VStack(alignment: .leading, spacing: Design.sectionSpacing) {
            MantleSectionHeader(
                eyebrow: "Recommended",
                title: "Launch Workflows",
                subtitle: "These are the three launch promises already aligned with benchmarks and demo flows."
            )

            LazyVGrid(columns: [
                GridItem(.flexible(), spacing: Design.sectionSpacing),
                GridItem(.flexible(), spacing: Design.sectionSpacing)
            ], spacing: Design.sectionSpacing) {
                ForEach(appVM.launchWorkflows) { workflow in
                    LaunchWorkflowCard(workflow: workflow, presentation: .hero) {
                        appVM.startLaunchWorkflow(workflow)
                    }
                }
            }
        }
    }

    private var starterFlowSection: some View {
        VStack(alignment: .leading, spacing: Design.sectionSpacing) {
            MantleSectionHeader(
                title: "More Starters",
                subtitle: "Use the broader coding, docs, diagnostics, and desktop-lite flows when you need a less opinionated start."
            )

            LazyVGrid(columns: [
                GridItem(.flexible(), spacing: Design.sectionSpacing),
                GridItem(.flexible(), spacing: Design.sectionSpacing)
            ], spacing: Design.sectionSpacing) {
                ForEach(appVM.starterFlows) { starter in
                    StarterFlowCard(starter: starter, presentation: .hero) {
                        appVM.startStarterFlow(starter)
                    }
                }
            }
        }
    }

    // MARK: - Search Bar

    private var chatSearchBar: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)

            TextField("Search in chat…", text: $chatSearchText)
                .textFieldStyle(.plain)
                .onChange(of: chatSearchText) { _, newValue in
                    updateSearchResults(query: newValue)
                }

            if !chatSearchResults.isEmpty {
                Text("\(currentSearchIndex + 1)/\(chatSearchResults.count)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()

                Button {
                    navigateSearch(direction: -1)
                } label: {
                    Image(systemName: "chevron.up")
                }
                .buttonStyle(.borderless)
                .disabled(chatSearchResults.count <= 1)

                Button {
                    navigateSearch(direction: 1)
                } label: {
                    Image(systemName: "chevron.down")
                }
                .buttonStyle(.borderless)
                .disabled(chatSearchResults.count <= 1)
            } else if !chatSearchText.isEmpty {
                Text("No results")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Button {
                withAnimation {
                    showingSearch = false
                    chatSearchText = ""
                    chatSearchResults = []
                }
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.borderless)
        }
        .padding(.horizontal, Design.containerPadding)
        .padding(.vertical, 6)
        .background(.bar)
    }

    // MARK: - Message Area

    private func messageArea(_ thread: ThreadState) -> some View {
        ZStack(alignment: .bottomTrailing) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: Design.messageSpacing) {
                        threadHeader(thread)

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
                                onCopy: { showCopyToast = true },
                                highlightText: chatSearchText.isEmpty ? nil : chatSearchText
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

                        // Error + Retry
                        if let error = thread.error {
                            HStack {
                                Image(systemName: "exclamationmark.triangle.fill")
                                    .foregroundStyle(Design.stateDanger)
                                Text(error)
                                    .font(.callout)
                                Spacer()
                                Button {
                                    appVM.retryLastMessage()
                                } label: {
                                    Label("Retry", systemImage: "arrow.clockwise")
                                        .font(.callout)
                                }
                                .buttonStyle(.bordered)
                                .tint(Design.accent)
                                .controlSize(.small)
                            }
                            .padding(Design.containerPadding)
                            .background(Design.stateDanger.opacity(0.08), in: RoundedRectangle(cornerRadius: Design.cornerRadius))
                            .padding(.horizontal)
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
                            .padding(.horizontal)
                        }

                        // Bottom anchor for scroll tracking
                        Color.clear.frame(height: 1).id("bottom")
                            .onAppear { isNearBottom = true }
                            .onDisappear { isNearBottom = false }
                    }
                    .padding(16)
                    .animation(.easeInOut(duration: Design.transitionDuration), value: thread.pendingApproval != nil)
                }
                .onChange(of: thread.messages.count) {
                    withAnimation(.easeOut(duration: 0.2)) {
                        proxy.scrollTo(thread.messages.last?.id ?? "streaming", anchor: .bottom)
                    }
                }
                .onChange(of: currentSearchIndex) {
                    if !chatSearchResults.isEmpty {
                        let targetId = chatSearchResults[currentSearchIndex]
                        withAnimation(.easeOut(duration: 0.3)) {
                            proxy.scrollTo(targetId, anchor: .center)
                        }
                    }
                }
                .onChange(of: chatSearchResults) {
                    // Scroll to first result when search results change
                    if let firstId = chatSearchResults.first {
                        withAnimation(.easeOut(duration: 0.3)) {
                            proxy.scrollTo(firstId, anchor: .center)
                        }
                    }
                }
                // Store proxy for scroll-to-bottom button
                .background(ScrollProxyHolder(proxy: proxy, scrollToBottom: $scrollToBottomProxy))
            }

            // Scroll-to-bottom floating button
            if !isNearBottom {
                Button {
                    scrollToBottomProxy?("bottom")
                } label: {
                    Image(systemName: "chevron.down")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 32, height: 32)
                        .background(.ultraThinMaterial, in: Circle())
                        .shadow(color: .black.opacity(0.1), radius: 3, y: 1)
                }
                .buttonStyle(.plain)
                .padding(16)
                .transition(.scale.combined(with: .opacity))
                .animation(.spring(duration: 0.25), value: isNearBottom)
                .help("Scroll to bottom")
            }
        }
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

    private func threadHeader(_ thread: ThreadState) -> some View {
        let snapshot = appVM.contextDaemon.currentSnapshot

        return VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("THREAD")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Design.textSecondary)

                    Text(thread.title == "New Chat" ? "Context-Driven Work Surface" : thread.title)
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(Design.textPrimary)

                    Text("Keep context, runtime, approvals, and executed actions visible while you work.")
                        .font(.subheadline)
                        .foregroundStyle(Design.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: 0)

                VStack(alignment: .trailing, spacing: 8) {
                    LedgerStatusChip(
                        title: thread.taskMode.title,
                        tone: .info,
                        systemImage: "dial.medium"
                    )

                    if thread.pendingApproval != nil {
                        LedgerStatusChip(
                            title: "Review Paused",
                            tone: .warning,
                            systemImage: "pause.circle"
                        )
                    }
                }
            }

            LazyVGrid(columns: [
                GridItem(.adaptive(minimum: 180), spacing: 10)
            ], spacing: 10) {
                threadContextSignal(
                    label: "App",
                    value: snapshot.foreground?.appName ?? "No foreground app",
                    systemImage: "app.badge.checkmark"
                )

                if let title = snapshot.foreground?.windowTitle, !title.isEmpty {
                    threadContextSignal(
                        label: "Window",
                        value: title,
                        systemImage: "macwindow"
                    )
                }

                if let recentPath = snapshot.recentFiles.first?.path {
                    threadContextSignal(
                        label: "Recent",
                        value: URL(fileURLWithPath: recentPath).lastPathComponent,
                        systemImage: "doc.text"
                    )
                }

                threadContextSignal(
                    label: "Selection",
                    value: selectionSignal(snapshot.selection),
                    systemImage: "selection.pin.in.out"
                )

                if let activity = snapshot.activity {
                    threadContextSignal(
                        label: "Activity",
                        value: activitySummary(activity),
                        systemImage: "bolt.horizontal"
                    )
                }
            }

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    runtimeBadge("Task: \(thread.taskMode.title)")

                    if let health = appVM.backendHealth {
                        if let model = health.model {
                            runtimeBadge("Model: \(model)")
                        }
                        if let prompt = health.promptProfile {
                            runtimeBadge("Prompt: \(prompt)")
                        }
                        if let context = health.contextWindowSize {
                            runtimeBadge("Context: \(formatContextWindow(context))")
                        }
                        if let workspaceMode = health.workspaceMode {
                            runtimeBadge("Mode: \(workspaceMode.capitalized)")
                        }
                    }
                }
            }

            MemoryInjectionCard(snapshot: appVM.activeThreadMemoryInjection)
            if shouldShowThreadCheckpointsCard {
                threadCheckpointsCard
            }
        }
        .padding(Design.panelPadding)
        .background(Design.surfaceElevated, in: RoundedRectangle(cornerRadius: Design.panelCornerRadius))
    }

    private func threadContextSignal(label: String, value: String, systemImage: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: systemImage)
                .font(.caption.weight(.semibold))
                .foregroundStyle(Design.accent)
                .frame(width: 24, height: 24)
                .background(Design.accent.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))

            VStack(alignment: .leading, spacing: 4) {
                Text(label.uppercased())
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Design.textSecondary)

                Text(value)
                    .font(.caption)
                    .foregroundStyle(Design.textPrimary)
                    .lineLimit(2)
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Design.surfaceBase, in: RoundedRectangle(cornerRadius: Design.cardCornerRadius))
    }

    private func runtimeBadge(_ text: String) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(Design.textSecondary)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Design.surfaceMuted, in: Capsule())
    }

    private var shouldShowThreadCheckpointsCard: Bool {
        isLoadingRunSnapshots || !threadRunSnapshots.isEmpty || runSnapshotsError != nil
    }

    private var currentSelectedSnapshot: RunSnapshotRecord? {
        guard let traceId = selectedSnapshotTraceId else { return nil }
        return threadRunSnapshots.first { $0.traceId == traceId }
    }

    private var threadCheckpointsCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Thread Checkpoints")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Design.accentContext)
                    Text("Compare recent runs and preview restore without leaving the conversation.")
                        .font(.callout)
                        .foregroundStyle(Design.textSecondary)
                }

                Spacer()

                if isLoadingRunSnapshots {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Button {
                        Task { await loadActiveThreadRunSnapshots(force: true) }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .buttonStyle(.borderless)
                }
            }

            if let error = runSnapshotsError, threadRunSnapshots.isEmpty {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(Design.stateDanger)
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(Design.textSecondary)
                }
            } else if threadRunSnapshots.isEmpty {
                Text("No checkpoints for this thread yet. Once a run writes, edits, or tracks a move, it will appear here.")
                    .font(.caption)
                    .foregroundStyle(Design.textSecondary)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(threadRunSnapshots.prefix(3))) { snapshot in
                        threadCheckpointRow(snapshot)
                    }
                }

                if let error = runSnapshotsError {
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(Design.stateWarning)
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(Design.textSecondary)
                    }
                }
            }
        }
        .padding(Design.panelPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Design.surfaceElevated, in: RoundedRectangle(cornerRadius: Design.cardCornerRadius))
    }

    @ViewBuilder
    private func threadCheckpointRow(_ snapshot: RunSnapshotRecord) -> some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    threadCheckpointStatusChip(snapshot.status)
                    if snapshot.summary.changedFiles > 0 {
                        runtimeBadge("\(snapshot.summary.changedFiles) changed")
                    }
                    if snapshot.summary.restorableFiles > 0 {
                        runtimeBadge("\(snapshot.summary.restorableFiles) restorable")
                    }
                }

                Text(snapshot.inputPreview ?? "No input preview captured for this run.")
                    .font(.callout)
                    .foregroundStyle(Design.textPrimary)
                    .lineLimit(2)

                Text(threadCheckpointMetaLine(snapshot))
                    .font(.caption)
                    .foregroundStyle(Design.textSecondary)

                if let firstChanged = snapshot.files.first(where: { $0.changeType != .unchanged }) {
                    HStack(spacing: 6) {
                        Image(systemName: threadCheckpointIcon(for: firstChanged.changeType))
                            .foregroundStyle(threadCheckpointColor(for: firstChanged.changeType))
                            .font(.caption)
                        Text(shortenPath(firstChanged.path))
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(Design.textSecondary)
                            .lineLimit(1)
                    }
                }
            }

            Spacer(minLength: 0)

            Button("Compare") {
                selectedSnapshotTraceId = snapshot.traceId
                selectedRestorePreview = nil
            }
            .buttonStyle(.borderedProminent)
            .tint(Design.accent)
            .controlSize(.small)
        }
        .padding(12)
        .background(Design.surfaceMuted, in: RoundedRectangle(cornerRadius: Design.cornerRadius))
    }

    private func formatContextWindow(_ size: Int) -> String {
        if size >= 1000 {
            return String(format: "%.1fK", Double(size) / 1000)
        }
        return "\(size)"
    }

    private func activitySummary(_ activity: ActivityInfo) -> String {
        var parts = ["\(activity.state.rawValue.capitalized), idle \(activity.idleSeconds)s"]
        if let focus = activity.focusDurationMin, focus > 0 {
            parts.append("focus \(focus)m")
        }
        return parts.joined(separator: " • ")
    }

    private func selectionSignal(_ selection: SelectionInfo?) -> String {
        guard let selection else { return "No active selection" }
        let age = max(0, Int(Date.now.timeIntervalSince(selection.capturedAt)))
        let prefix = age < 15 ? "Selected text" : "Recent selection"
        if let sourceAppName = selection.sourceAppName, !sourceAppName.isEmpty {
            return "\(prefix) • \(selection.text.count) chars • \(sourceAppName)"
        }
        return "\(prefix) • \(selection.text.count) chars"
    }

    private func loadActiveThreadRunSnapshots(force: Bool = false) async {
        guard let threadId = appVM.activeThreadId else {
            threadRunSnapshots = []
            selectedSnapshotTraceId = nil
            selectedRestorePreview = nil
            runSnapshotsError = nil
            return
        }

        if isLoadingRunSnapshots && !force {
            return
        }

        isLoadingRunSnapshots = true
        defer { isLoadingRunSnapshots = false }
        if force {
            runSnapshotsError = nil
        }

        do {
            let response = try await appVM.client.runSnapshots(threadId: threadId, limit: 8)
            guard appVM.activeThreadId == threadId else { return }
            threadRunSnapshots = response.runs
            if let traceId = selectedSnapshotTraceId,
               !threadRunSnapshots.contains(where: { $0.traceId == traceId }) {
                selectedSnapshotTraceId = nil
                selectedRestorePreview = nil
            }
            runSnapshotsError = nil
        } catch {
            guard appVM.activeThreadId == threadId else { return }
            if threadRunSnapshots.isEmpty || force {
                runSnapshotsError = error.localizedDescription
            }
        }

    }

    private func previewRestore(_ snapshot: RunSnapshotRecord) async {
        previewingSnapshotTraceId = snapshot.traceId
        runSnapshotsError = nil
        do {
            selectedRestorePreview = try await appVM.client.restoreRunSnapshot(
                traceId: snapshot.traceId,
                dryRun: true
            )
        } catch {
            runSnapshotsError = error.localizedDescription
        }
        previewingSnapshotTraceId = nil
    }

    private func restoreSnapshot(_ snapshot: RunSnapshotRecord) async {
        restoringSnapshotTraceId = snapshot.traceId
        runSnapshotsError = nil
        do {
            selectedRestorePreview = try await appVM.client.restoreRunSnapshot(
                traceId: snapshot.traceId,
                dryRun: false
            )
            await loadActiveThreadRunSnapshots(force: true)
        } catch {
            runSnapshotsError = error.localizedDescription
        }
        restoringSnapshotTraceId = nil
    }

    private func threadCheckpointMetaLine(_ snapshot: RunSnapshotRecord) -> String {
        let trace = snapshot.traceId.prefix(8)
        let started = formatCheckpointDate(snapshot.startedAt)
        return "Trace \(trace) • \(snapshot.mode.rawValue.capitalized) • \(snapshot.status.rawValue.capitalized) • \(started)"
    }

    private func formatCheckpointDate(_ value: String) -> String {
        guard let date = ISO8601DateFormatter().date(from: value) else {
            return value
        }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    private func shortenPath(_ path: String) -> String {
        let home = NSHomeDirectory()
        if path.hasPrefix(home) {
            return "~" + path.dropFirst(home.count)
        }
        return path
    }

    private func threadCheckpointStatusChip(_ status: RunSnapshotStatus) -> some View {
        HStack(spacing: 6) {
            Image(systemName: threadCheckpointStatusIcon(status))
                .font(.caption2)
            Text(status.rawValue.capitalized)
                .font(.caption2.weight(.semibold))
        }
        .foregroundStyle(threadCheckpointStatusColor(status))
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(threadCheckpointStatusColor(status).opacity(0.10), in: Capsule())
    }

    private func threadCheckpointStatusIcon(_ status: RunSnapshotStatus) -> String {
        switch status {
        case .running:
            return "clock.badge.questionmark"
        case .completed:
            return "checkmark.circle"
        case .interrupted:
            return "pause.circle"
        case .failed:
            return "xmark.octagon"
        }
    }

    private func threadCheckpointStatusColor(_ status: RunSnapshotStatus) -> Color {
        switch status {
        case .running:
            return Design.stateWarning
        case .completed:
            return Design.stateSuccess
        case .interrupted:
            return Design.accent
        case .failed:
            return Design.stateDanger
        }
    }

    private func threadCheckpointIcon(for changeType: RunSnapshotChangeType) -> String {
        switch changeType {
        case .created:
            return "plus.circle"
        case .updated:
            return "pencil.circle"
        case .deleted:
            return "trash.circle"
        case .moved_in, .moved_out:
            return "arrow.left.arrow.right.circle"
        case .unchanged:
            return "minus.circle"
        }
    }

    private func threadCheckpointColor(for changeType: RunSnapshotChangeType) -> Color {
        switch changeType {
        case .created:
            return Design.stateSuccess
        case .updated:
            return Design.accent
        case .deleted:
            return Design.stateDanger
        case .moved_in, .moved_out:
            return Design.stateWarning
        case .unchanged:
            return .secondary
        }
    }

    @State private var scrollToBottomProxy: ((String) -> Void)?

    // MARK: - Search Logic

    private func updateSearchResults(query: String) {
        guard let thread = appVM.activeThread, !query.isEmpty else {
            chatSearchResults = []
            currentSearchIndex = 0
            return
        }
        let q = query.lowercased()
        chatSearchResults = thread.messages
            .filter { $0.text.lowercased().contains(q) }
            .map(\.id)
        currentSearchIndex = 0
    }

    private func navigateSearch(direction: Int) {
        guard !chatSearchResults.isEmpty else { return }
        currentSearchIndex = (currentSearchIndex + direction + chatSearchResults.count) % chatSearchResults.count
    }

    // MARK: - HITL Actions

    private func approveAll(thread: ThreadState) {
        guard let request = thread.pendingApproval else { return }
        let decisions = request.actionRequests.map { _ in HITLDecision.approve }
        appVM.resumeActiveThread(with: HITLResponse(decisions: decisions))
    }

    private func rejectAll(thread: ThreadState) {
        guard let request = thread.pendingApproval else { return }
        let decisions = request.actionRequests.map { _ in HITLDecision.reject(message: nil) }
        appVM.resumeActiveThread(with: HITLResponse(decisions: decisions))
    }
}

// MARK: - Scroll Proxy Holder

/// Helper to expose ScrollViewProxy action to the parent scope for the floating button.
private struct ScrollProxyHolder: View {
    let proxy: ScrollViewProxy
    @Binding var scrollToBottom: ((String) -> Void)?

    var body: some View {
        Color.clear
            .onAppear {
                scrollToBottom = { id in
                    withAnimation(.easeOut(duration: 0.3)) {
                        proxy.scrollTo(id, anchor: .bottom)
                    }
                }
            }
    }
}
