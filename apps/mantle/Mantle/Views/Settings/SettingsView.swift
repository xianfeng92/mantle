import SwiftUI

// MARK: - Settings View

struct SettingsView: View {
    @Environment(AppViewModel.self) private var appVM

    @State private var backendURL: String = ""
    @State private var showingResetAlert = false
    @State private var showingLogs = false
    @State private var autoStartBackend: Bool = true
    @State private var nodePath: String = ""
    @State private var agentCorePath: String = ""
    @State private var workspaceMode: WorkspaceMode = .workspace
    @State private var customWorkspacePath: String = ""
    @State private var virtualMode: Bool = false
    @State private var storagePath: String = ""
    @State private var showingRestartAlert = false
    @State private var accessibilityGranted = AXIsProcessTrusted()

    var body: some View {
        TabView {
            generalTab
                .tabItem {
                    Label("General", systemImage: "gearshape")
                }

            connectionTab
                .tabItem {
                    Label("Connection", systemImage: "network")
                }

            contextTab
                .tabItem {
                    Label("Context", systemImage: "eye")
                }

            skillsTab
                .tabItem {
                    Label("Skills", systemImage: "puzzlepiece.extension")
                }

            rollbackTab
                .tabItem {
                    Label("Rollback", systemImage: "arrow.uturn.backward")
                }

            diagnosticsTab
                .tabItem {
                    Label("Diagnostics", systemImage: "chart.bar")
                }
        }
        .frame(width: 600, height: 500)
        .onAppear {
            backendURL = appVM.backendURL
            autoStartBackend = UserDefaults.standard.object(forKey: "mantle.autoStartBackend") as? Bool ?? true
            nodePath = UserDefaults.standard.string(forKey: "mantle.nodePath") ?? ""
            agentCorePath = BackendProcessManager.Config.default.agentCorePath
            workspaceMode = UserDefaults.standard.string(forKey: "mantle.workspaceMode")
                .flatMap(WorkspaceMode.init(rawValue:))
                ?? .workspace
            customWorkspacePath = UserDefaults.standard.string(forKey: "mantle.customWorkspacePath") ?? ""
            virtualMode = UserDefaults.standard.object(forKey: "mantle.virtualMode") as? Bool ?? false
            storagePath = UserDefaults.standard.string(forKey: "mantle.storagePath") ?? ""
        }
    }

    // MARK: - General Tab

    private var generalTab: some View {
        Form {
            Section("About") {
                LabeledContent("App") { Text("Mantle") }
                LabeledContent("Version") { Text("1.0.0") }
                LabeledContent("Hotkey") { Text("⌥Space (toggle)") }
            }

            Section("Startup") {
                Toggle("Launch Mantle at login", isOn: Binding(
                    get: { LaunchAtLoginManager.isEnabled },
                    set: { LaunchAtLoginManager.setEnabled($0) }
                ))
            }

            Section("Speech") {
                Toggle("Auto-speak assistant replies", isOn: Binding(
                    get: { appVM.speechService.autoSpeak },
                    set: { appVM.speechService.autoSpeak = $0 }
                ))
                .disabled(!appVM.speechService.isTTSEnabled)

                Text(
                    appVM.speechService.isTTSEnabled
                    ? "Optional. Reads completed assistant replies aloud. Leave this off if you mainly use Mantle for coding, terminal work, or desktop actions."
                    : "TTS is temporarily disabled. Assistant replies will stay text-only until this switch is restored."
                )
                    .font(.caption2)
                    .foregroundStyle(.secondary)

                Toggle("Enable experimental voice conversation", isOn: Binding(
                    get: { appVM.speechService.experimentalConversationModeEnabled },
                    set: { appVM.speechService.experimentalConversationModeEnabled = $0 }
                ))
                .disabled(!appVM.speechService.isTTSEnabled)

                Text(
                    appVM.speechService.isTTSEnabled
                    ? "Experimental hands-free loop: mic -> VAD -> ASR -> model -> TTS -> mic. It stays off by default because it adds more moving parts than the core text-first agent workflow."
                    : "Experimental voice conversation is also paused because it depends on TTS to complete the reply loop."
                )
                    .font(.caption2)
                    .foregroundStyle(.secondary)

                LabeledContent("Voice Input") {
                    Text("Manual mic input is always available")
                        .font(.callout)
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text("TTS Strategy")
                        .font(.callout)

                    Picker("TTS Strategy", selection: Binding(
                        get: { appVM.speechService.ttsStrategy },
                        set: { appVM.speechService.ttsStrategy = $0 }
                    )) {
                        ForEach(SpeechService.TTSStrategy.allCases) { strategy in
                            Text(strategy.title).tag(strategy)
                        }
                    }
                    .pickerStyle(.segmented)
                    .disabled(!appVM.speechService.isTTSEnabled)

                    Text(
                        appVM.speechService.isTTSEnabled
                        ? appVM.speechService.ttsStrategy.description
                        : appVM.speechService.ttsDisabledExplanation
                    )
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                LabeledContent("TTS Route") {
                    Text(appVM.speechService.ttsAvailabilitySummary)
                        .font(.callout)
                }

                if appVM.speechService.isSpeaking {
                    Button("Stop Current Speech") {
                        appVM.speechService.stopSpeaking()
                    }
                }
            }

            Section("Data") {
                Button("Clear All Chats", role: .destructive) {
                    showingResetAlert = true
                }
                .alert("Clear All Chats?", isPresented: $showingResetAlert) {
                    Button("Cancel", role: .cancel) {}
                    Button("Clear", role: .destructive) {
                        for thread in appVM.threads {
                            appVM.deleteThread(id: thread.id)
                        }
                    }
                } message: {
                    Text("This will delete all local chat history. Backend thread data will also be cleared.")
                }
            }

            Section("Storage") {
                LabeledContent("Location") {
                    VStack(alignment: .trailing, spacing: 4) {
                        Text(storageDisplayPath)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .help(storageDisplayPath)

                        HStack(spacing: 8) {
                            Button("Change…") {
                                browseForStorageFolder()
                            }
                            .controlSize(.small)

                            if !storagePath.isEmpty {
                                Button("Reset") {
                                    storagePath = ""
                                    UserDefaults.standard.removeObject(forKey: "mantle.storagePath")
                                    showingRestartAlert = true
                                }
                                .controlSize(.small)
                            }

                            Button {
                                revealStorageInFinder()
                            } label: {
                                Image(systemName: "folder")
                            }
                            .controlSize(.small)
                            .help("Reveal in Finder")
                        }
                    }
                }

                Text("Changing the storage location requires restarting Mantle. Existing chats will remain in the previous location.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            .alert("Restart Required", isPresented: $showingRestartAlert) {
                Button("Restart Now") {
                    restartApp()
                }
                Button("Later", role: .cancel) {}
            } message: {
                Text("The storage location change will take effect after restarting Mantle.")
            }
        }
        .formStyle(.grouped)
        .padding()
    }

    // MARK: - Connection Tab

    private var connectionTab: some View {
        Form {
            Section("Agent Core Backend") {
                TextField("Backend URL", text: $backendURL)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit {
                        appVM.backendURL = backendURL
                    }

                LabeledContent("Status") {
                    HStack(spacing: 6) {
                        Circle()
                            .fill(statusColor)
                            .frame(width: 8, height: 8)
                        Text(statusText)
                            .font(.callout)
                    }
                }
            }

            Section("Backend Process") {
                Toggle("Auto-start backend on launch", isOn: $autoStartBackend)
                    .onChange(of: autoStartBackend) { _, newValue in
                        UserDefaults.standard.set(newValue, forKey: "mantle.autoStartBackend")
                    }

                LabeledContent("Node.js") {
                    HStack {
                        TextField("Auto-detect", text: $nodePath)
                            .textFieldStyle(.roundedBorder)
                            .onSubmit { saveNodePath() }
                        Button("Browse") {
                            browseForFile { path in
                                nodePath = path
                                saveNodePath()
                            }
                        }
                    }
                }

                LabeledContent("agent-core") {
                    HStack {
                        TextField("Path", text: $agentCorePath)
                            .textFieldStyle(.roundedBorder)
                            .onSubmit { saveAgentCorePath() }
                        Button("Browse") {
                            browseForFolder { path in
                                agentCorePath = path
                                saveAgentCorePath()
                            }
                        }
                    }
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text("Workspace Mode")
                        .font(.callout)

                    Picker("Workspace Mode", selection: $workspaceMode) {
                        ForEach(WorkspaceMode.allCases) { mode in
                            Text(mode.title).tag(mode)
                        }
                    }
                    .pickerStyle(.segmented)
                    .onChange(of: workspaceMode) { _, _ in
                        saveWorkspaceSettings()
                    }

                    Text(workspaceMode.description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if workspaceMode == .custom {
                    LabeledContent("Custom Workspace") {
                        HStack {
                            TextField("Path", text: $customWorkspacePath)
                                .textFieldStyle(.roundedBorder)
                                .onSubmit { saveWorkspaceSettings() }
                            Button("Browse") {
                                browseForFolder { path in
                                    customWorkspacePath = path
                                    saveWorkspaceSettings()
                                }
                            }
                        }
                    }
                }

                Toggle("Restrict file tools to workspace", isOn: $virtualMode)
                    .onChange(of: virtualMode) { _, _ in
                        saveWorkspaceSettings()
                    }

                LabeledContent("Effective Workspace") {
                    VStack(alignment: .trailing, spacing: 4) {
                        Text(effectiveWorkspacePath)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .help(effectiveWorkspacePath)
                        Text(virtualMode ? "Scoped to selected workspace" : "Absolute-path tools remain available")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }

                if let health = appVM.backendHealth {
                    if let promptProfile = health.promptProfile {
                        LabeledContent("Prompt Profile") {
                            Text(promptProfile)
                                .font(.callout)
                        }
                    }

                    if let contextWindowSize = health.contextWindowSize {
                        LabeledContent("Context Window") {
                            Text(formatContextWindowSize(contextWindowSize))
                                .font(.callout)
                        }
                    }
                }

                LabeledContent("Process") {
                    HStack(spacing: 8) {
                        Circle()
                            .fill(processStatusColor)
                            .frame(width: 8, height: 8)
                        Text(processStatusText)
                            .font(.callout)

                        Spacer()

                        if case .crashed = appVM.processState {
                            Button("Retry") {
                                Task { await appVM.restartBackend() }
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(Design.accent)
                            .controlSize(.small)
                        } else if case .running = appVM.processState {
                            Button("Restart") {
                                Task { await appVM.restartBackend() }
                            }
                            .controlSize(.small)
                        } else if case .stopped = appVM.processState {
                            Button("Start") {
                                Task { await appVM.processManager.start() }
                            }
                            .controlSize(.small)
                        } else if case .nodeNotFound = appVM.processState {
                            Button("Retry") {
                                Task { await appVM.processManager.start() }
                            }
                            .controlSize(.small)
                        }
                    }
                }

                Text("Workspace, sandbox, and path changes take effect after restarting the backend.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)

                DisclosureGroup("Process Logs", isExpanded: $showingLogs) {
                    ProcessLogView(processManager: appVM.processManager)
                }
            }
        }
        .formStyle(.grouped)
        .padding()
    }

    // MARK: - Context Tab

    private var contextTab: some View {
        Form {
            Section("Environment Snapshot") {
                let snapshot = appVM.contextDaemon.currentSnapshot

                LabeledContent("Status") {
                    HStack(spacing: 6) {
                        Circle()
                            .fill(appVM.contextDaemon.isRunning ? .green : .gray)
                            .frame(width: 8, height: 8)
                        Text(appVM.contextDaemon.isRunning ? "Running" : "Stopped")
                            .font(.callout)
                    }
                }

                if let fg = snapshot.foreground {
                    LabeledContent("App") {
                        Text(fg.appName)
                            .font(.callout)
                    }
                    if let title = fg.windowTitle {
                        LabeledContent("Window") {
                            Text(title)
                                .font(.callout)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }
                }

                if let activity = snapshot.activity {
                    LabeledContent("Activity") {
                        Text("\(activity.state.rawValue) (idle \(activity.idleSeconds)s)")
                            .font(.callout)
                    }
                }

                if !snapshot.recentFiles.isEmpty {
                    LabeledContent("Recent Files") {
                        VStack(alignment: .trailing, spacing: 2) {
                            ForEach(snapshot.recentFiles.prefix(5), id: \.path) { file in
                                Text(URL(fileURLWithPath: file.path).lastPathComponent)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }

            Section("Prompt Preview") {
                Text(appVM.contextDaemon.currentSnapshot.toPreviewYAML())
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 6))
            }

            Section("Permissions") {
                PermissionGuideView(
                    description: PermissionManager.accessibilityDescription,
                    isGranted: accessibilityGranted,
                    onRequest: {
                        // Triggers system prompt tied to THIS binary, then opens Settings
                        appVM.permissionManager.requestAccessibility()
                        appVM.permissionManager.openAccessibilitySettings()
                    }
                )
            }
        }
        .formStyle(.grouped)
        .padding()
        .task {
            // Poll permission status every 2 seconds so UI updates after user grants in System Settings
            while !Task.isCancelled {
                accessibilityGranted = AXIsProcessTrusted()
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    // MARK: - Skills Tab

    private var skillsTab: some View {
        SkillsPanel(client: appVM.client)
            .padding()
    }

    // MARK: - Rollback Tab

    private var rollbackTab: some View {
        RollbackPanel(client: appVM.client)
    }

    // MARK: - Diagnostics Tab

    private var diagnosticsTab: some View {
        DiagnosticsPanel(client: appVM.client)
            .padding()
    }

    // MARK: - Helpers

    private func saveNodePath() {
        let value = nodePath.isEmpty ? nil : nodePath
        UserDefaults.standard.set(value, forKey: "mantle.nodePath")
        applyBackendProcessConfig()
    }

    private func saveAgentCorePath() {
        let trimmed = agentCorePath.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            UserDefaults.standard.removeObject(forKey: "mantle.agentCorePath")
            agentCorePath = BackendProcessManager.Config.default.agentCorePath
        } else {
            agentCorePath = trimmed
            UserDefaults.standard.set(trimmed, forKey: "mantle.agentCorePath")
        }
        applyBackendProcessConfig()
    }

    private func saveWorkspaceSettings() {
        UserDefaults.standard.set(workspaceMode.rawValue, forKey: "mantle.workspaceMode")
        UserDefaults.standard.set(customWorkspacePath, forKey: "mantle.customWorkspacePath")
        UserDefaults.standard.set(virtualMode, forKey: "mantle.virtualMode")
        applyBackendProcessConfig()
    }

    private func applyBackendProcessConfig() {
        Task {
            await appVM.processManager.updateConfig(
                BackendProcessManager.Config(
                    nodePath: nodePath.isEmpty ? nil : nodePath,
                    agentCorePath: agentCorePath.isEmpty
                        ? BackendProcessManager.Config.default.agentCorePath
                        : agentCorePath,
                    backendPort: 8787,
                    maxRestarts: 3,
                    workspaceMode: workspaceMode,
                    customWorkspacePath: customWorkspacePath.isEmpty ? nil : customWorkspacePath,
                    virtualMode: virtualMode
                )
            )
        }
    }

    private func browseForFile(completion: @escaping (String) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.message = "Select Node.js executable"
        if panel.runModal() == .OK, let url = panel.url {
            completion(url.path)
        }
    }

    private func browseForFolder(completion: @escaping (String) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.message = "Select agent-core directory"
        if panel.runModal() == .OK, let url = panel.url {
            completion(url.path)
        }
    }

    private var statusColor: Color {
        switch appVM.backendStatus {
        case .connected: .green
        case .connecting: .yellow
        case .disconnected, .error: .red
        }
    }

    private var statusText: String {
        switch appVM.backendStatus {
        case .connected(let model):
            "Connected" + (model.map { " — \($0)" } ?? "")
        case .connecting:
            "Connecting..."
        case .disconnected:
            "Disconnected"
        case .error(let msg):
            "Error: \(msg)"
        }
    }

    private var processStatusColor: Color {
        switch appVM.processState {
        case .running: .green
        case .detecting, .starting, .restarting: .yellow
        case .stopped: .gray
        case .nodeNotFound, .startFailed, .crashed: .red
        }
    }

    private var processStatusText: String {
        switch appVM.processState {
        case .detecting: "Detecting Node.js..."
        case .nodeNotFound: "Node.js not found"
        case .starting: "Starting backend..."
        case .running: "Running"
        case .restarting(let attempt): "Restarting (attempt \(attempt))..."
        case .startFailed(let msg): "Failed: \(msg)"
        case .crashed(let msg): "Crashed: \(msg)"
        case .stopped: "Stopped"
        }
    }

    private var effectiveWorkspacePath: String {
        let baseAgentCorePath = agentCorePath.isEmpty
            ? BackendProcessManager.Config.default.agentCorePath
            : agentCorePath
        let resolvedAgentCorePath = NSString(string: baseAgentCorePath).expandingTildeInPath
        switch workspaceMode {
        case .repo:
            return resolvedAgentCorePath
        case .workspace:
            return URL(fileURLWithPath: resolvedAgentCorePath).deletingLastPathComponent().path
        case .custom:
            if !customWorkspacePath.isEmpty {
                return NSString(string: customWorkspacePath).expandingTildeInPath
            }
            return URL(fileURLWithPath: resolvedAgentCorePath).deletingLastPathComponent().path
        }
    }

    private func formatContextWindowSize(_ size: Int) -> String {
        if size >= 1000 {
            let rounded = Double(size) / 1000
            return String(format: "%.1fK", rounded)
        }
        return "\(size)"
    }

    // MARK: - Storage Helpers

    private var storageDisplayPath: String {
        if storagePath.isEmpty {
            return MantleApp.defaultStorageDirectory.path + " (default)"
        }
        return storagePath
    }

    private func browseForStorageFolder() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.message = "Choose a folder to store Mantle chat data"
        panel.prompt = "Select"

        guard panel.runModal() == .OK, let url = panel.url else { return }

        storagePath = url.path
        UserDefaults.standard.set(storagePath, forKey: "mantle.storagePath")
        showingRestartAlert = true
    }

    private func revealStorageInFinder() {
        let path: String
        if storagePath.isEmpty {
            path = MantleApp.defaultStorageDirectory.path
        } else {
            path = storagePath
        }

        let url = URL(fileURLWithPath: path)
        if FileManager.default.fileExists(atPath: path) {
            NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: url.path)
        } else {
            // Directory doesn't exist yet — open parent
            let parent = url.deletingLastPathComponent()
            NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: parent.path)
        }
    }

    private func restartApp() {
        // Relaunch the app
        let url = Bundle.main.bundleURL
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        task.arguments = ["-n", url.path]
        try? task.run()

        // Terminate current instance after short delay
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            NSApplication.shared.terminate(nil)
        }
    }
}

// MARK: - Process Log View

struct ProcessLogView: View {
    let processManager: BackendProcessManager

    @State private var logs: [String] = []
    @State private var refreshTimer: Timer?

    var body: some View {
        ScrollView {
            Text(logs.joined())
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(height: 150)
        .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 6))
        .task {
            // Poll logs every 2 seconds
            while !Task.isCancelled {
                logs = await processManager.recentLogs
                try? await Task.sleep(for: .seconds(2))
            }
        }
        .overlay {
            if logs.isEmpty {
                Text("No logs yet")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
    }
}
