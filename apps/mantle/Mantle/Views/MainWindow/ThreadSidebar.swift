import SwiftUI
import UniformTypeIdentifiers

// MARK: - Thread Sidebar

struct ThreadSidebar: View {
    @Environment(AppViewModel.self) private var appVM

    @State private var editingThreadId: String?
    @State private var editingTitle: String = ""
    @State private var searchText: String = ""
    @State private var threadToDelete: String?
    @FocusState private var isRenameFieldFocused: Bool

    /// Threads filtered by search query (matches title or message content)
    private var filteredThreads: [ThreadState] {
        guard !searchText.isEmpty else { return appVM.threads }
        let query = searchText.lowercased()
        return appVM.threads.filter { thread in
            if thread.title.lowercased().contains(query) { return true }
            return thread.messages.contains { $0.text.lowercased().contains(query) }
        }
    }

    var body: some View {
        List(selection: Binding(
            get: { appVM.activeThreadId },
            set: { id in
                if let id { appVM.selectThread(id: id) }
            }
        )) {
            ForEach(filteredThreads) { thread in
                threadRow(thread)
                    .tag(thread.id)
                    .contextMenu {
                        Button("Rename") {
                            editingThreadId = thread.id
                            editingTitle = thread.title
                            // Focus triggers on next run loop after state update
                            Task { @MainActor in isRenameFieldFocused = true }
                        }
                        Button {
                            exportThread(id: thread.id, title: thread.title)
                        } label: {
                            Label("Export as Markdown…", systemImage: "square.and.arrow.up")
                        }
                        Button {
                            copyThreadAsMarkdown(id: thread.id)
                        } label: {
                            Label("Copy as Markdown", systemImage: "doc.on.doc")
                        }
                        Divider()
                        Button("Delete", role: .destructive) {
                            threadToDelete = thread.id
                        }
                    }
            }
        }
        .listStyle(.sidebar)
        .searchable(text: $searchText, prompt: "Search chats")
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 10) {
                quickStartPanel
                newChatButton
            }
        }
        .navigationTitle("Chats")
        .alert("Delete Thread", isPresented: Binding(
            get: { threadToDelete != nil },
            set: { if !$0 { threadToDelete = nil } }
        )) {
            Button("Cancel", role: .cancel) { threadToDelete = nil }
            Button("Delete", role: .destructive) {
                if let id = threadToDelete {
                    appVM.deleteThread(id: id)
                    threadToDelete = nil
                }
            }
        } message: {
            Text("This will permanently delete this thread and all its messages. This cannot be undone.")
        }
    }

    private func threadRow(_ thread: ThreadState) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                if editingThreadId == thread.id {
                    TextField("Title", text: $editingTitle)
                        .textFieldStyle(.plain)
                        .font(.body)
                        .focused($isRenameFieldFocused)
                        .onSubmit {
                            commitRename(threadId: thread.id)
                        }
                        .onExitCommand {
                            editingThreadId = nil
                        }
                } else {
                    Text(thread.title)
                        .font(.body)
                        .lineLimit(1)
                }

                Spacer()

                if thread.isStreaming {
                    ProgressView()
                        .controlSize(.small)
                }
            }

            if let lastMessage = thread.messages.last {
                Text(lastMessage.text.prefix(60))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, Design.sidebarRowPadding)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(thread.title)\(thread.isStreaming ? ", generating" : "")")
        .accessibilityHint("Double tap to open this chat")
    }

    private func commitRename(threadId: String) {
        let trimmed = editingTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            appVM.renameThread(id: threadId, title: trimmed)
        }
        editingThreadId = nil
    }

    private func exportThread(id: String, title: String) {
        guard let markdown = appVM.exportThreadAsMarkdown(id: id) else { return }
        let panel = NSSavePanel()
        panel.title = "Export Chat"
        panel.nameFieldStringValue = "\(title.prefix(40)).md"
        panel.allowedContentTypes = [.plainText]
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let url = panel.url else { return }
        try? markdown.write(to: url, atomically: true, encoding: .utf8)
    }

    private func copyThreadAsMarkdown(id: String) {
        guard let markdown = appVM.exportThreadAsMarkdown(id: id) else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(markdown, forType: .string)
    }

    private var newChatButton: some View {
        Button {
            appVM.createThread()
        } label: {
            Label("New Chat", systemImage: "plus")
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .padding(Design.containerPadding)
    }

    private var quickStartPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            MantleSectionHeader(
                eyebrow: "Start Here",
                title: "Launch Workflows",
                subtitle: "Use a grounded workflow first, then drop into broader starters only when you need them."
            )

            ContextInspectorCard(snapshot: appVM.contextDaemon.currentSnapshot, compact: true)

            ForEach(appVM.launchWorkflows) { workflow in
                LaunchWorkflowRow(workflow: workflow) {
                    appVM.startLaunchWorkflow(workflow)
                }
            }

            Divider()
                .padding(.vertical, 2)

            Text("More Starters")
                .font(.caption)
                .foregroundStyle(.secondary)

            ForEach(appVM.starterFlows) { starter in
                StarterFlowRow(starter: starter) {
                    appVM.startStarterFlow(starter)
                }
            }
        }
        .padding(Design.panelPadding)
        .background(Design.surfaceElevated, in: RoundedRectangle(cornerRadius: Design.panelCornerRadius))
        .padding(.horizontal, Design.containerPadding)
        .padding(.top, 8)
    }
}
