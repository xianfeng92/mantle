import SwiftUI

// MARK: - Approval Detail Sheet
//
// Full detail view for reviewing pending tool call arguments.

struct ApprovalDetailSheet: View {
    let request: HITLRequest
    var onSubmit: (HITLResponse) -> Void = { _ in }
    @Environment(\.dismiss) private var dismiss

    @State private var decisions: [PerActionDecision] = []

    private var primaryTarget: String? {
        request.actionRequests
            .compactMap { LedgerPresenter.summary(for: $0).target }
            .first
    }

    private var summaryLine: String {
        if LedgerPresenter.likelySupportsRollback(request) {
            return "File-oriented actions stay reviewable and rollback remains available after execution."
        }

        if request.actionRequests.contains(where: { $0.name == "execute" }) {
            return "Shell commands will stay paused until you approve, edit, or reject them."
        }

        return "Review each planned step before Mantle resumes the current thread."
    }

    var body: some View {
        VStack(spacing: 0) {
            header

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(Array(decisions.enumerated()), id: \.offset) { index, _ in
                        if index < request.actionRequests.count {
                            actionCard(index: index)
                        }
                    }
                }
                .padding(Design.heroSectionPadding)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(Design.surfaceBase)

            Divider()

            footer
        }
        .frame(minWidth: 720, minHeight: 560)
        .onAppear {
            initializeDecisions()
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 16) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Review Planned Actions")
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(Design.textPrimary)

                    Text(summaryLine)
                        .font(.subheadline)
                        .foregroundStyle(Design.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: 0)

                Button("Close") {
                    dismiss()
                }
                .buttonStyle(.bordered)
            }

            HStack(spacing: 8) {
                LedgerStatusChip(
                    title: "\(approvedCount)/\(decisions.count) approved",
                    tone: .success,
                    systemImage: "checkmark.circle"
                )

                LedgerStatusChip(
                    title: "\(decisions.count) actions",
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
            }

            if let primaryTarget {
                LedgerInfoRow(label: "Target", value: primaryTarget)
            }
        }
        .padding(Design.heroSectionPadding)
        .background(Design.surfaceElevated)
    }

    private var footer: some View {
        HStack(spacing: 12) {
            Button("Approve All") {
                for i in decisions.indices {
                    decisions[i].type = .approve
                    decisions[i].isEditing = false
                }
            }
            .controlSize(.regular)

            Button("Reject All") {
                for i in decisions.indices {
                    decisions[i].type = .reject
                    decisions[i].isEditing = false
                }
            }
            .controlSize(.regular)

            Spacer()

            Button("Cancel") {
                dismiss()
            }
            .keyboardShortcut(.escape, modifiers: [])

            Button("Continue Run") {
                submitDecisions()
            }
            .buttonStyle(.borderedProminent)
            .tint(Design.accent)
            .disabled(!allDecided)
            .keyboardShortcut(.return, modifiers: .command)
        }
        .padding(Design.heroSectionPadding)
        .background(Design.surfaceElevated)
    }

    private func actionCard(index: Int) -> some View {
        let action = request.actionRequests[index]
        let config = index < request.reviewConfigs.count ? request.reviewConfigs[index] : nil
        let allowed = config?.allowedDecisions ?? [.approve, .reject]
        let summary = LedgerPresenter.summary(for: action)
        let tone = LedgerPresenter.actionTone(for: decisions[index].type)

        return VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 14) {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 8) {
                        Text("ACTION \(index + 1)")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(Design.textSecondary)

                        LedgerStatusChip(
                            title: LedgerPresenter.decisionTitle(for: decisions[index].type),
                            tone: tone,
                            systemImage: LedgerPresenter.decisionSymbol(for: decisions[index].type)
                        )
                    }

                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: summary.symbol)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(tone.color)
                            .frame(width: 32, height: 32)
                            .background(tone.color.opacity(0.10), in: RoundedRectangle(cornerRadius: 10))

                        VStack(alignment: .leading, spacing: 6) {
                            Text(summary.title)
                                .font(.headline)
                                .foregroundStyle(Design.textPrimary)

                            if let summaryText = summary.summary {
                                Text(summaryText)
                                    .font(.callout)
                                    .foregroundStyle(Design.textSecondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }

                Spacer(minLength: 0)

                Picker("Decision", selection: $decisions[index].type) {
                    if allowed.contains(.approve) {
                        Label("Approve", systemImage: "checkmark")
                            .tag(DecisionType.approve)
                    }
                    if allowed.contains(.edit) {
                        Label("Edit", systemImage: "slider.horizontal.3")
                            .tag(DecisionType.edit)
                    }
                    if allowed.contains(.reject) {
                        Label("Reject", systemImage: "xmark")
                            .tag(DecisionType.reject)
                    }
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 260)
                .onChange(of: decisions[index].type) { _, newValue in
                    decisions[index].isEditing = (newValue == .edit)
                }
            }

            if let target = summary.target {
                LedgerInfoRow(label: "Target", value: target)
            }

            LedgerInfoRow(label: "Policy", value: reviewPolicyText(allowed))

            if decisions[index].isEditing {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Edit Arguments")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Design.textSecondary)

                    TextEditor(text: $decisions[index].editedArgsJSON)
                        .font(.system(.caption, design: .monospaced))
                        .frame(minHeight: 120, maxHeight: 240)
                        .scrollContentBackground(.hidden)
                        .padding(10)
                        .background(Design.surfaceMuted, in: RoundedRectangle(cornerRadius: Design.cardCornerRadius))

                    if !isValidJSON(decisions[index].editedArgsJSON) {
                        Text("Invalid JSON. Fix the payload before continuing.")
                            .font(.caption2)
                            .foregroundStyle(Design.stateDanger)
                    }
                }
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Arguments")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Design.textSecondary)

                    Text(action.argsDescription)
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Design.surfaceMuted, in: RoundedRectangle(cornerRadius: Design.cardCornerRadius))
                }
            }

            if decisions[index].type == .reject {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Optional rejection reason")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Design.textSecondary)

                    TextField("Tell Mantle why this action should not run", text: $decisions[index].rejectMessage)
                        .textFieldStyle(.roundedBorder)
                        .font(.callout)
                }
            }
        }
        .padding(Design.panelPadding)
        .background(Design.surfaceElevated, in: RoundedRectangle(cornerRadius: Design.cardCornerRadius))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Action \(index + 1): \(summary.title), decision \(LedgerPresenter.decisionTitle(for: decisions[index].type))")
    }

    private struct PerActionDecision {
        var type: DecisionType = .approve
        var isEditing: Bool = false
        var editedArgsJSON: String = "{}"
        var rejectMessage: String = ""
    }

    private func initializeDecisions() {
        decisions = request.actionRequests.map { action in
            PerActionDecision(
                type: .approve,
                editedArgsJSON: action.argsDescription
            )
        }
    }

    private var allDecided: Bool {
        guard decisions.count == request.actionRequests.count else { return false }
        return !decisions.contains { $0.isEditing && !isValidJSON($0.editedArgsJSON) }
    }

    private var approvedCount: Int {
        decisions.filter { $0.type == .approve }.count
    }

    private func submitDecisions() {
        var hitlDecisions: [HITLDecision] = []

        for (index, decision) in decisions.enumerated() {
            switch decision.type {
            case .approve:
                hitlDecisions.append(.approve)
            case .edit:
                let action = request.actionRequests[index]
                if let data = decision.editedArgsJSON.data(using: .utf8),
                   let parsed = try? JSONDecoder().decode([String: AnyCodable].self, from: data) {
                    hitlDecisions.append(.edit(editedAction: .init(name: action.name, args: parsed)))
                } else {
                    hitlDecisions.append(.approve)
                }
            case .reject:
                let message = decision.rejectMessage.isEmpty ? nil : decision.rejectMessage
                hitlDecisions.append(.reject(message: message))
            }
        }

        onSubmit(HITLResponse(decisions: hitlDecisions))
        dismiss()
    }

    private func reviewPolicyText(_ allowed: [DecisionType]) -> String {
        let titles = allowed.map(LedgerPresenter.decisionTitle(for:))
        return "Allowed decisions: \(titles.joined(separator: ", "))"
    }

    private func isValidJSON(_ text: String) -> Bool {
        guard let data = text.data(using: .utf8) else { return false }
        return (try? JSONSerialization.jsonObject(with: data)) != nil
    }

    private func jsonValidationColor(_ text: String) -> Color {
        isValidJSON(text) ? Design.accent.opacity(0.30) : Design.stateDanger.opacity(0.45)
    }
}
