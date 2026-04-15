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
