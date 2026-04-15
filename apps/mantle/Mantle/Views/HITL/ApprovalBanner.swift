import SwiftUI

// MARK: - Approval Banner
//
// Inline review surface shown when the agent run pauses for human approval.

struct ApprovalBanner: View {
    let request: HITLRequest
    var onApproveAll: () -> Void
    var onRejectAll: () -> Void
    var onSubmitDecisions: (HITLResponse) -> Void = { _ in }

    @State private var showDetail = false
    @State private var borderPulse = false

    private var visibleActions: [ActionRequest] {
        Array(request.actionRequests.prefix(3))
    }

    private var remainingCount: Int {
        max(0, request.actionRequests.count - visibleActions.count)
    }

    private var primaryTarget: String? {
        request.actionRequests
            .compactMap { LedgerPresenter.summary(for: $0).target }
            .first
    }

    private var riskSummary: String {
        let highestRisk = request.actionRequests.compactMap(\.risk).max { lhs, rhs in
            riskRank(lhs.level) < riskRank(rhs.level)
        }
        if let highestRisk {
            return highestRisk.estimatedImpact ?? highestRisk.summary
        }

        let names = Set(request.actionRequests.map(\.name))

        if names.contains("execute") {
            return "Shell commands are paused until you review them."
        }

        if names.contains("write_file") || names.contains("edit_file") {
            return LedgerPresenter.likelySupportsRollback(request)
                ? "File changes are paused and rollback will stay available after execution."
                : "File changes are paused until you approve them."
        }

        return "Mantle paused before executing planned actions in this thread."
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 8) {
                            LedgerStatusChip(
                                title: "Review Required",
                                tone: .warning,
                                systemImage: "checklist"
                            )

                            LedgerStatusChip(
                                title: "\(request.actionRequests.count) planned",
                                tone: .info,
                                systemImage: "square.stack.3d.up"
                            )

                        if LedgerPresenter.likelySupportsRollback(request) {
                            LedgerStatusChip(
                                title: "Rollback Available",
                                tone: .success,
                                systemImage: "arrow.uturn.backward.circle"
                            )
                        }

                        if let highestRisk = request.actionRequests.compactMap(\.risk).max(by: {
                            riskRank($0.level) < riskRank($1.level)
                        }) {
                            LedgerStatusChip(
                                title: LedgerPresenter.title(for: highestRisk.level),
                                tone: LedgerPresenter.tone(for: highestRisk.level),
                                systemImage: LedgerPresenter.symbol(for: highestRisk.level)
                            )
                        }
                    }

                        Text("Review planned actions before Mantle continues")
                            .font(.headline)
                            .foregroundStyle(Design.textPrimary)

                        Text(riskSummary)
                            .font(.subheadline)
                            .foregroundStyle(Design.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    Spacer(minLength: 0)

                    Button {
                        showDetail = true
                    } label: {
                        Image(systemName: "slider.horizontal.3")
                            .font(.callout.weight(.semibold))
                            .foregroundStyle(Design.textSecondary)
                            .frame(width: 30, height: 30)
                            .background(Design.surfaceBase, in: RoundedRectangle(cornerRadius: 10))
                    }
                    .buttonStyle(.plain)
                    .help("Review each action in detail")
                }

                if let primaryTarget {
                    LedgerInfoRow(label: "Target", value: primaryTarget)
                }
            }

            VStack(alignment: .leading, spacing: 10) {
                ForEach(visibleActions) { action in
                    actionRow(action)
                }

                if remainingCount > 0 {
                    Text("+\(remainingCount) more action\(remainingCount == 1 ? "" : "s") in Review Details")
                        .font(.caption)
                        .foregroundStyle(Design.textSecondary)
                        .padding(.leading, 6)
                }
            }

            HStack(spacing: 12) {
                Button {
                    onApproveAll()
                } label: {
                    Label("Approve All", systemImage: "checkmark.circle.fill")
                }
                .buttonStyle(.borderedProminent)
                .tint(Design.accent)
                .controlSize(.regular)

                Button(role: .destructive) {
                    onRejectAll()
                } label: {
                    Label("Reject All", systemImage: "xmark.circle")
                }
                .buttonStyle(.bordered)
                .controlSize(.regular)

                Spacer(minLength: 0)

                Button {
                    showDetail = true
                } label: {
                    Label("Review Details", systemImage: "list.bullet.rectangle")
                }
                .buttonStyle(.bordered)
                .controlSize(.regular)
                .help("Review and decide each action individually")
            }
        }
        .padding(Design.panelPadding)
        .background(Design.surfaceElevated, in: RoundedRectangle(cornerRadius: Design.panelCornerRadius))
        .sheet(isPresented: $showDetail) {
            ApprovalDetailSheet(
                request: request,
                onSubmit: { response in
                    onSubmitDecisions(response)
                }
            )
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Review required for \(request.actionRequests.count) planned tool actions")
    }

    private func actionRow(_ action: ActionRequest) -> some View {
        let summary = LedgerPresenter.summary(for: action)

        return HStack(alignment: .top, spacing: 12) {
            Image(systemName: summary.symbol)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Design.accent)
                .frame(width: 28, height: 28)
                .background(Design.accent.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))

            VStack(alignment: .leading, spacing: 5) {
                Text(summary.title)
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(Design.textPrimary)

                if let summaryText = summary.summary {
                    Text(summaryText)
                        .font(.caption)
                        .foregroundStyle(Design.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let target = summary.target {
                    Text(target)
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(Design.textSecondary)
                        .lineLimit(1)
                }

                if let risk = action.risk {
                    HStack(spacing: 6) {
                        Image(systemName: LedgerPresenter.symbol(for: risk.level))
                            .font(.caption2)
                            .foregroundStyle(LedgerPresenter.tone(for: risk.level).color)
                        Text(LedgerPresenter.title(for: risk.level))
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(LedgerPresenter.tone(for: risk.level).color)
                    }
                }
            }

            Spacer(minLength: 0)
        }
        .padding(12)
        .background(Design.surfaceBase, in: RoundedRectangle(cornerRadius: Design.cardCornerRadius))
    }

    private func riskRank(_ level: ActionRiskLevel) -> Int {
        switch level {
        case .low:
            return 0
        case .medium:
            return 1
        case .high:
            return 2
        }
    }
}
