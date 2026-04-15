import SwiftUI

// MARK: - Main Window View
//
// Full windowed experience with sidebar (threads) + detail (chat).

struct MainWindowView: View {
    @Environment(AppViewModel.self) private var appVM

    private let starterColumns = [
        GridItem(.flexible(), spacing: Design.sectionSpacing),
        GridItem(.flexible(), spacing: Design.sectionSpacing)
    ]

    var body: some View {
        NavigationSplitView {
            ThreadSidebar()
        } detail: {
            if appVM.activeThread != nil {
                ChatDetailView()
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: Design.blockSpacing) {
                        heroSection
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

                        if appVM.backendHealth != nil {
                            runtimeSummaryStrip
                        }

                        launchWorkflowSection
                        starterFlowSection

                        HStack {
                            Spacer()
                            Button("New Chat") {
                                appVM.createThread()
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                    .padding(Design.heroSectionPadding)
                    .frame(maxWidth: 960, alignment: .leading)
                    .frame(maxWidth: .infinity, alignment: .center)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Design.surfaceBase)
            }
        }
        .navigationTitle(appVM.activeThread?.title ?? "Mantle")
        .toolbar {
            ToolbarItem(placement: .automatic) {
                HStack(spacing: 8) {
                    statusIndicator
                    backendRuntimeLabel
                }
            }
        }
    }

    private var heroSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            MantleSectionHeader(
                eyebrow: "Mantle",
                title: "Start from a grounded workflow",
                subtitle: "Use the current context on your Mac as the starting point, then move into one of the three launch workflows."
            )

            HStack(spacing: 10) {
                Label("Local-first", systemImage: "internaldrive")
                    .font(.caption)
                    .foregroundStyle(Design.textSecondary)
                Label("Context-aware", systemImage: "scope")
                    .font(.caption)
                    .foregroundStyle(Design.textSecondary)
                Label("Reviewable actions", systemImage: "checkmark.shield")
                    .font(.caption)
                    .foregroundStyle(Design.textSecondary)
            }
        }
        .padding(Design.panelPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Design.surfaceElevated, in: RoundedRectangle(cornerRadius: Design.panelCornerRadius))
    }

    private var launchWorkflowSection: some View {
        VStack(alignment: .leading, spacing: Design.sectionSpacing) {
            MantleSectionHeader(
                eyebrow: "Recommended",
                title: "Launch Workflows",
                subtitle: "The three product workflows we show in demos, benchmarks, and launch materials."
            )

            LazyVGrid(columns: starterColumns, spacing: Design.sectionSpacing) {
                ForEach(appVM.launchWorkflows) { workflow in
                    LaunchWorkflowCard(workflow: workflow, presentation: .hero) {
                        appVM.startLaunchWorkflow(workflow)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var starterFlowSection: some View {
        VStack(alignment: .leading, spacing: Design.sectionSpacing) {
            MantleSectionHeader(
                title: "More Starters",
                subtitle: "General coding, docs, diagnostics, and desktop-lite entry points stay available, but remain secondary to the launch workflows."
            )

            LazyVGrid(columns: starterColumns, spacing: Design.sectionSpacing) {
                ForEach(appVM.starterFlows) { starter in
                    StarterFlowCard(starter: starter, presentation: .hero) {
                        appVM.startStarterFlow(starter)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var runtimeSummaryStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                if case .connected(let model) = appVM.backendStatus,
                   let label = model.map(formatModelLabel) {
                    runtimeBadge("Model: \(label)")
                }
                if let prompt = appVM.backendHealth?.promptProfile {
                    runtimeBadge("Prompt: \(prompt)")
                }
                if let context = appVM.backendHealth?.contextWindowSize {
                    runtimeBadge("Context: \(formatContextWindow(context))")
                }
                if let workspaceMode = appVM.backendHealth?.workspaceMode {
                    runtimeBadge("Mode: \(workspaceMode.capitalized)")
                }
            }
        }
    }

    private var statusIndicator: some View {
        Circle()
            .fill(statusColor)
            .frame(width: 8, height: 8)
            .help(statusText)
    }

    private var backendRuntimeLabel: some View {
        Group {
            if case .connected(let model) = appVM.backendStatus {
                let prompt = appVM.backendHealth?.promptProfile
                let context = appVM.backendHealth?.contextWindowSize.map(formatContextWindow)

                let summary = ([model.map(formatModelLabel), prompt, context]
                    .compactMap { $0 }
                    .joined(separator: " · "))

                HStack(spacing: 8) {
                    Text(summary.isEmpty ? "agent-core" : summary)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)

                    if let workspaceMode = appVM.backendHealth?.workspaceMode {
                        workspaceModeBadge(workspaceMode)
                    }
                }
                .help(runtimeHelpText)
            }
        }
    }

    private func runtimeBadge(_ text: String) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(Design.textSecondary)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Design.surfaceMuted, in: Capsule())
    }

    private var runtimeHelpText: String {
        guard let health = appVM.backendHealth else { return "Connected to agent-core" }
        let model = health.model ?? "—"
        let prompt = health.promptProfile ?? "—"
        let context = health.contextWindowSize.map(formatContextWindow) ?? "—"
        let workspaceMode = health.workspaceMode.map(formatWorkspaceModeHelp) ?? "—"
        let workspace = health.workspaceDir ?? "—"
        let virtualMode = health.virtualMode == true ? "on" : "off"
        return """
        Model: \(model)
        Prompt profile: \(prompt)
        Context: \(context)
        Workspace mode: \(workspaceMode)
        Workspace: \(workspace)
        Virtual mode: \(virtualMode)
        """
    }

    private func formatContextWindow(_ size: Int) -> String {
        if size >= 1000 {
            let thousands = Double(size) / 1000
            if thousands.rounded() == thousands {
                return "\(Int(thousands))K"
            }
            return String(format: "%.1fK", thousands)
        }
        return "\(size)"
    }

    private func formatModelLabel(_ model: String) -> String {
        let raw = model.split(separator: "/").last.map(String.init) ?? model
        switch raw {
        case "gemma-4-26b-a4b":
            return "Gemma 4 26B"
        default:
            return raw
                .split(separator: "-")
                .map { token in
                    if token.allSatisfy(\.isNumber) {
                        return String(token)
                    }
                    if token.contains(where: \.isNumber) {
                        return token.uppercased()
                    }
                    return token.prefix(1).uppercased() + token.dropFirst()
                }
                .joined(separator: " ")
        }
    }

    private func workspaceModeBadge(_ mode: String) -> some View {
        let config = workspaceModeBadgeConfig(mode)

        return Label(config.title, systemImage: config.symbol)
            .font(.caption2)
            .foregroundStyle(config.color)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(config.color.opacity(0.10), in: Capsule())
            .fixedSize(horizontal: true, vertical: false)
    }

    private func workspaceModeBadgeConfig(_ mode: String) -> (title: String, symbol: String, color: Color) {
        switch mode {
        case "workspace":
            return ("Workspace", "square.grid.2x2", Design.accent)
        case "custom":
            return ("Custom", "folder.badge.gearshape", .secondary)
        case "repo":
            return ("Repo", "folder", .secondary)
        default:
            return (mode.capitalized, "folder", .secondary)
        }
    }

    private func formatWorkspaceModeHelp(_ mode: String) -> String {
        switch mode {
        case "workspace":
            return "workspace"
        case "custom":
            return "custom"
        case "repo":
            return "repo"
        default:
            return mode
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
            "Connected to agent-core" + (model.map { " (\($0))" } ?? "")
        case .connecting:
            "Connecting to agent-core..."
        case .disconnected:
            "Disconnected from agent-core"
        case .error(let msg):
            "Error: \(msg)"
        }
    }
}
