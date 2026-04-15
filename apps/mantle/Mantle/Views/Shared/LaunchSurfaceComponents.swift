import SwiftUI

// MARK: - Shared Launch Surface Components

struct MantleSectionHeader: View {
    let eyebrow: String?
    let title: String
    let subtitle: String?

    init(eyebrow: String? = nil, title: String, subtitle: String? = nil) {
        self.eyebrow = eyebrow
        self.title = title
        self.subtitle = subtitle
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let eyebrow, !eyebrow.isEmpty {
                Text(eyebrow.uppercased())
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Design.accentLaunch)
                    .tracking(0.6)
            }

            Text(title)
                .font(.headline)
                .foregroundStyle(Design.textPrimary)

            if let subtitle, !subtitle.isEmpty {
                Text(subtitle)
                    .font(.callout)
                    .foregroundStyle(Design.textSecondary)
            }
        }
    }
}

struct ContextInspectorCard: View {
    let snapshot: ContextSnapshot
    var compact: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 10 : 12) {
            HStack(spacing: 8) {
                Text("Current Context")
                    .font(compact ? .caption.weight(.semibold) : .caption.weight(.semibold))
                    .foregroundStyle(Design.accentContext)
                Spacer()
                Text(contextFreshness)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            if compact {
                compactContent
            } else {
                expandedContent
            }
        }
        .padding(compact ? 12 : Design.panelPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Design.surfaceElevated, in: RoundedRectangle(cornerRadius: Design.cardCornerRadius))
    }

    private var expandedContent: some View {
        LazyVGrid(columns: [
            GridItem(.flexible(), spacing: 10),
            GridItem(.flexible(), spacing: 10)
        ], spacing: 10) {
            ContextInspectorMetric(
                title: "Current App",
                systemImage: "app.badge",
                value: snapshot.foreground?.appName ?? "No active app"
            )
            ContextInspectorMetric(
                title: "Window",
                systemImage: "macwindow",
                value: snapshot.foreground?.windowTitle ?? "Window title unavailable"
            )
            ContextInspectorMetric(
                title: "Selection",
                systemImage: "selection.pin.in.out",
                value: selectionSummary
            )
            ContextInspectorMetric(
                title: "Recent Files",
                systemImage: "doc.on.doc",
                value: recentFilesSummary
            )
        }
    }

    private var compactContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                InspectorChip(systemImage: "app.badge", text: snapshot.foreground?.appName ?? "No active app")
                InspectorChip(systemImage: "selection.pin.in.out", text: compactSelectionSummary)
            }

            if let title = snapshot.foreground?.windowTitle, !title.isEmpty {
                InspectorChip(systemImage: "macwindow", text: title)
            }

            InspectorChip(systemImage: "doc.on.doc", text: recentFilesSummary)
        }
    }

    private var recentFilesSummary: String {
        let names = snapshot.recentFiles.prefix(compact ? 2 : 3).map { URL(fileURLWithPath: $0.path).lastPathComponent }
        if names.isEmpty {
            return "No recent files"
        }
        return names.joined(separator: " • ")
    }

    private var selectionSummary: String {
        guard let selection = snapshot.selection else {
            return "No active selection"
        }

        let age = max(0, Int(Date.now.timeIntervalSince(selection.capturedAt)))
        let recency = age < 15 ? "Selected text available" : "Recent selection"
        if let sourceAppName = selection.sourceAppName, !sourceAppName.isEmpty {
            return "\(recency) • \(selection.text.count) chars • \(sourceAppName)"
        }
        return "\(recency) • \(selection.text.count) chars"
    }

    private var compactSelectionSummary: String {
        guard let selection = snapshot.selection else {
            return "No active selection"
        }
        let age = max(0, Int(Date.now.timeIntervalSince(selection.capturedAt)))
        return age < 15
            ? "Selected text • \(selection.text.count) chars"
            : "Recent selection • \(selection.text.count) chars"
    }

    private var activitySummary: String {
        guard let activity = snapshot.activity else {
            return "Activity unavailable"
        }
        switch activity.state {
        case .active:
            if let focus = activity.focusDurationMin, focus > 0 {
                return "Active • focused \(focus)m"
            }
            return "Active now"
        case .idle:
            return "Idle • \(activity.idleSeconds)s"
        case .away:
            return "Away • \(activity.idleSeconds)s"
        }
    }

    private var contextFreshness: String {
        let delta = max(0, Int(Date.now.timeIntervalSince(snapshot.timestamp)))
        if delta < 15 {
            return "Live"
        }
        if delta < 60 {
            return "\(delta)s ago"
        }
        return "\(delta / 60)m ago"
    }
}

struct PreflightStatusCard: View {
    let backendStatus: AppViewModel.BackendStatus
    let processState: ProcessState
    let doctor: DoctorResponse?
    let permissionStatus: PermissionManager.PermissionStatus
    let onQuickFix: (DoctorCheck) -> AppViewModel.PreflightQuickAction?
    let onRestartBackend: () -> Void
    let onCopyReport: () -> Void
    let onOpenAccessibilitySettings: () -> Void
    let onOpenScreenCaptureSettings: () -> Void

    private var attentionChecks: [DoctorCheck] {
        Array((doctor?.attentionChecks ?? []).prefix(3))
    }

    private var summaryText: String {
        if !permissionStatus.accessibility {
            return "Accessibility permission is still off, so Mantle can inspect context but cannot reliably drive desktop actions."
        }

        if let doctor {
            switch doctor.summary.overallStatus {
            case .pass:
                return "Backend checks are healthy. If something still feels off, copy the report and inspect the details."
            case .warn:
                return "Mantle is usable, but one or more runtime checks need attention before this becomes a daily-driver setup."
            case .fail:
                return "Mantle found a blocking runtime issue. Fix the failing checks below before trusting file or desktop actions."
            }
        }

        switch backendStatus {
        case .disconnected:
            return "agent-core is currently disconnected. Start or restart the backend to continue."
        case .connecting:
            return "Mantle is still checking the local backend and model provider."
        case .connected:
            return "Connected."
        case .error(let message):
            return message
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Preflight")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Design.accentContext)

                    Text("Check backend, permissions, and local runtime health before you trust a run.")
                        .font(.headline)
                        .foregroundStyle(Design.textPrimary)

                    Text(summaryText)
                        .font(.callout)
                        .foregroundStyle(Design.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: 0)

                VStack(alignment: .trailing, spacing: 6) {
                    statusChip(title: backendTitle, tone: backendTone, symbol: backendSymbol)

                    if let doctor {
                        statusChip(
                            title: "Doctor \(doctor.summary.overallStatus.rawValue.capitalized)",
                            tone: tone(for: doctor.summary.overallStatus),
                            symbol: symbol(for: doctor.summary.overallStatus)
                        )
                    }

                    if !permissionStatus.accessibility {
                        statusChip(title: "Accessibility Needed", tone: .warn, symbol: "hand.raised")
                    }
                }
            }

            if !attentionChecks.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(attentionChecks) { check in
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: symbol(for: check.status))
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(color(for: check.status))
                                .frame(width: 16)

                            VStack(alignment: .leading, spacing: 3) {
                                Text(check.title)
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(Design.textPrimary)
                                Text(check.summary)
                                    .font(.caption)
                                    .foregroundStyle(Design.textSecondary)
                                    .fixedSize(horizontal: false, vertical: true)
                                if let fixHint = check.fixHint, !fixHint.isEmpty {
                                    Text("Fix: \(fixHint)")
                                        .font(.caption2)
                                        .foregroundStyle(color(for: check.status))
                                        .fixedSize(horizontal: false, vertical: true)
                                }

                                if let quickFix = onQuickFix(check) {
                                    Button {
                                        quickFix.perform()
                                    } label: {
                                        Label(quickFix.title, systemImage: quickFix.systemImage)
                                    }
                                    .buttonStyle(.bordered)
                                    .controlSize(.small)
                                }
                            }
                        }
                        .padding(10)
                        .background(Design.surfaceMuted, in: RoundedRectangle(cornerRadius: Design.cornerRadius))
                    }
                }
            }

            HStack(spacing: 10) {
                Button {
                    onRestartBackend()
                } label: {
                    Label("Restart Backend", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.borderedProminent)
                .tint(Design.accent)

                SettingsLink {
                    Label("Settings", systemImage: "gearshape")
                }
                .buttonStyle(.bordered)

                Button {
                    onCopyReport()
                } label: {
                    Label("Copy Report", systemImage: "doc.on.doc")
                }
                .buttonStyle(.bordered)

                Spacer(minLength: 0)
            }

            if !permissionStatus.accessibility || !permissionStatus.screenCapture {
                HStack(spacing: 10) {
                    if !permissionStatus.accessibility {
                        Button("Open Accessibility") {
                            onOpenAccessibilitySettings()
                        }
                        .buttonStyle(.bordered)
                    }

                    if !permissionStatus.screenCapture {
                        Button("Open Screen Capture") {
                            onOpenScreenCaptureSettings()
                        }
                        .buttonStyle(.bordered)
                    }
                }
            }
        }
        .padding(Design.panelPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Design.surfaceElevated, in: RoundedRectangle(cornerRadius: Design.panelCornerRadius))
    }

    private var backendTitle: String {
        switch backendStatus {
        case .connected:
            return "Backend Connected"
        case .connecting:
            return "Backend Checking"
        case .disconnected:
            return "Backend Offline"
        case .error:
            return "Backend Error"
        }
    }

    private var backendTone: DoctorCheckStatus {
        switch backendStatus {
        case .connected:
            return .pass
        case .connecting:
            return .warn
        case .disconnected, .error:
            return .fail
        }
    }

    private var backendSymbol: String {
        switch backendStatus {
        case .connected:
            return "checkmark.circle"
        case .connecting:
            return "clock.badge.questionmark"
        case .disconnected, .error:
            return "xmark.octagon"
        }
    }

    private func statusChip(title: String, tone: DoctorCheckStatus, symbol: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: symbol)
                .font(.caption2)
            Text(title)
                .font(.caption2.weight(.semibold))
        }
        .foregroundStyle(color(for: tone))
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(color(for: tone).opacity(0.10), in: Capsule())
    }

    private func tone(for status: DoctorCheckStatus) -> DoctorCheckStatus {
        status
    }

    private func symbol(for status: DoctorCheckStatus) -> String {
        switch status {
        case .pass:
            return "checkmark.circle"
        case .warn:
            return "exclamationmark.triangle"
        case .fail:
            return "xmark.octagon"
        }
    }

    private func color(for status: DoctorCheckStatus) -> Color {
        switch status {
        case .pass:
            return Design.stateSuccess
        case .warn:
            return Design.stateWarning
        case .fail:
            return Design.stateDanger
        }
    }
}

struct MemoryInjectionCard: View {
    let snapshot: MemoryInjectionSnapshot?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Memory Injection")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Design.accentContext)
                Spacer()
                if let snapshot {
                    Text(snapshot.skipped ? "Skipped" : "Injected")
                        .font(.caption2)
                        .foregroundStyle(snapshot.skipped ? Design.textSecondary : Design.stateSuccess)
                }
            }

            if let snapshot {
                Text(summary(for: snapshot))
                    .font(.callout)
                    .foregroundStyle(Design.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)

                if !snapshot.entries.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(snapshot.entries.prefix(3))) { entry in
                            HStack(alignment: .top, spacing: 8) {
                                Text(entry.type.uppercased())
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(Design.accent)
                                    .frame(width: 64, alignment: .leading)

                                Text(entry.content)
                                    .font(.caption)
                                    .foregroundStyle(Design.textSecondary)
                                    .lineLimit(2)
                            }
                        }
                    }
                    .padding(10)
                    .background(Design.surfaceMuted, in: RoundedRectangle(cornerRadius: Design.cornerRadius))
                }
            } else {
                Text("No memory injection details yet for this thread.")
                    .font(.callout)
                    .foregroundStyle(Design.textSecondary)
            }
        }
        .padding(Design.panelPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Design.surfaceElevated, in: RoundedRectangle(cornerRadius: Design.cardCornerRadius))
    }

    private func summary(for snapshot: MemoryInjectionSnapshot) -> String {
        if snapshot.skipped {
            switch snapshot.reason {
            case "budget_zero":
                return "Context budget is currently tight, so Mantle skipped cross-session memory injection for this turn."
            case "no_entries":
                return "There were no saved memories worth injecting for this turn."
            default:
                return "Memory injection was skipped for this turn."
            }
        }

        return "Injected \(snapshot.entries.count) memory item(s) using \(snapshot.estimatedTokens) estimated tokens out of a \(snapshot.budgetTokens)-token budget."
    }
}

private struct ContextInspectorMetric: View {
    let title: String
    let systemImage: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: systemImage)
                    .font(.caption)
                    .foregroundStyle(Design.accentContext)
                Text(title)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Text(value)
                .font(.callout)
                .foregroundStyle(Design.textPrimary)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
        }
        .frame(maxWidth: .infinity, minHeight: 74, alignment: .topLeading)
        .padding(12)
        .background(Design.surfaceMuted, in: RoundedRectangle(cornerRadius: Design.cornerRadius))
    }
}

private struct InspectorChip: View {
    let systemImage: String
    let text: String

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: systemImage)
                .font(.caption2)
                .foregroundStyle(Design.accentContext)
            Text(text)
                .font(.caption)
                .foregroundStyle(Design.textPrimary)
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Design.surfaceMuted, in: Capsule())
    }
}

enum WorkflowCardPresentation {
    case hero
    case compact
}

struct LaunchWorkflowCard: View {
    let workflow: AppViewModel.LaunchWorkflow
    let presentation: WorkflowCardPresentation
    let action: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: presentation == .hero ? 12 : 10) {
                HStack(alignment: .top) {
                    Text("Launch")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Design.accentLaunch)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(Design.accentLaunch.opacity(0.10), in: Capsule())
                    Spacer()
                    Image(systemName: workflow.systemImage)
                        .foregroundStyle(Design.accentLaunch)
                }

                Text(workflow.title)
                    .font(presentation == .hero ? .headline : .callout.weight(.semibold))
                    .foregroundStyle(Design.textPrimary)

                Text(workflow.subtitle)
                    .font(presentation == .hero ? .callout : .caption)
                    .foregroundStyle(Design.textSecondary)
                    .multilineTextAlignment(.leading)

                HStack(spacing: 6) {
                    Image(systemName: "checkmark.shield")
                        .font(.caption2)
                        .foregroundStyle(Design.stateSuccess)
                    Text(workflow.trustCue)
                        .font(.caption)
                        .foregroundStyle(Design.textSecondary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
                .padding(.top, 2)
            }
            .frame(
                maxWidth: .infinity,
                minHeight: presentation == .hero ? Design.launchCardMinHeight : Design.compactLaunchCardMinHeight,
                alignment: .topLeading
            )
            .padding(presentation == .hero ? 16 : 12)
            .background(Design.surfaceElevated, in: RoundedRectangle(cornerRadius: Design.cardCornerRadius))
            .opacity(isHovering ? 0.85 : 1.0)
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            withAnimation(.easeOut(duration: Design.transitionDuration)) {
                isHovering = hovering
            }
        }
    }
}

struct StarterFlowCard: View {
    let starter: AppViewModel.StarterFlow
    let presentation: WorkflowCardPresentation
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: presentation == .hero ? 10 : 8) {
                Image(systemName: starter.systemImage)
                    .foregroundStyle(.secondary)

                Text(starter.title)
                    .font(presentation == .hero ? .headline : .callout.weight(.semibold))
                    .foregroundStyle(Design.textPrimary)

                Text(starter.subtitle)
                    .font(presentation == .hero ? .callout : .caption)
                    .foregroundStyle(Design.textSecondary)
                    .multilineTextAlignment(.leading)
                    .lineLimit(presentation == .hero ? 3 : 2)
            }
            .frame(
                maxWidth: .infinity,
                minHeight: presentation == .hero ? Design.starterCardMinHeight : Design.compactStarterCardMinHeight,
                alignment: .topLeading
            )
            .padding(presentation == .hero ? 16 : 12)
            .background(Design.surfaceElevated, in: RoundedRectangle(cornerRadius: Design.cardCornerRadius))
        }
        .buttonStyle(.plain)
    }
}

struct LaunchWorkflowRow: View {
    let workflow: AppViewModel.LaunchWorkflow
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: workflow.systemImage)
                    .foregroundStyle(Design.accentLaunch)
                    .frame(width: 18)

                VStack(alignment: .leading, spacing: 3) {
                    Text(workflow.title)
                        .font(.callout.weight(.semibold))
                        .foregroundStyle(Design.textPrimary)
                    Text(workflow.trustCue)
                        .font(.caption)
                        .foregroundStyle(Design.textSecondary)
                        .lineLimit(1)
                }

                Spacer()

                Image(systemName: "arrow.up.right")
                    .font(.caption2)
                    .foregroundStyle(Design.accentLaunch.opacity(0.85))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(Design.surfaceElevated, in: RoundedRectangle(cornerRadius: Design.cardCornerRadius))
        }
        .buttonStyle(.plain)
    }
}

struct StarterFlowRow: View {
    let starter: AppViewModel.StarterFlow
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: starter.systemImage)
                    .foregroundStyle(.secondary)
                    .frame(width: 18)

                VStack(alignment: .leading, spacing: 2) {
                    Text(starter.title)
                        .font(.callout)
                        .foregroundStyle(Design.textPrimary)
                    Text(starter.subtitle)
                        .font(.caption)
                        .foregroundStyle(Design.textSecondary)
                        .lineLimit(1)
                }

                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(Design.surfaceElevated, in: RoundedRectangle(cornerRadius: Design.cardCornerRadius))
        }
        .buttonStyle(.plain)
    }
}
