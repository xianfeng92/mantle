import SwiftUI

// MARK: - Tool Event Card
//
// Ledger-style card showing an executed tool step inside an assistant message.

struct ToolEventCard: View {
    let event: ToolEvent

    @State private var isExpanded = false

    private var summary: LedgerSummary {
        LedgerPresenter.summary(for: event)
    }

    private var tone: LedgerTone {
        LedgerPresenter.tone(for: event.status)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: summary.symbol)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(tone.color)
                        .frame(width: 30, height: 30)
                        .background(tone.color.opacity(0.10), in: RoundedRectangle(cornerRadius: 10))

                    VStack(alignment: .leading, spacing: 10) {
                        HStack(alignment: .top, spacing: 8) {
                            LedgerStatusChip(
                                title: LedgerPresenter.statusTitle(for: event.status),
                                tone: tone,
                                systemImage: LedgerPresenter.statusSymbol(for: event.status)
                            )

                            Spacer(minLength: 0)

                            Text(event.timestamp, format: .dateTime.hour().minute())
                                .font(.caption2)
                                .foregroundStyle(Design.textSecondary)
                                .monospacedDigit()
                        }

                        VStack(alignment: .leading, spacing: 4) {
                            Text(summary.title)
                                .font(.callout.weight(.semibold))
                                .foregroundStyle(Design.textPrimary)

                            if let summaryText = summary.summary {
                                Text(summaryText)
                                    .font(.subheadline)
                                    .foregroundStyle(Design.textSecondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }

                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .padding(.top, 6)
                }
                .contentShape(RoundedRectangle(cornerRadius: Design.cardCornerRadius))
            }
            .buttonStyle(.plain)

            VStack(alignment: .leading, spacing: 8) {
                if let target = summary.target {
                    LedgerInfoRow(label: "Target", value: target)
                }

                if let result = summary.result {
                    LedgerInfoRow(
                        label: "Result",
                        value: result,
                        tone: event.status == .failed ? .danger : nil
                    )
                }
            }

            HStack(spacing: 8) {
                footerChip

                if shouldShowAuditChip {
                    LedgerStatusChip(
                        title: "Audit Recorded",
                        tone: .info,
                        systemImage: "list.bullet.rectangle"
                    )
                }
            }

            if isExpanded {
                Divider()
                    .overlay(Design.borderSubtle)

                VStack(alignment: .leading, spacing: 10) {
                    if let input = event.input {
                        detailSection("Input", content: input)
                    }

                    if let output = event.output {
                        detailSection("Output", content: output)
                    }

                    if let error = event.error {
                        detailSection("Error", content: error, tone: .danger)
                    }
                }
            }
        }
        .padding(Design.panelPadding)
        .background(Design.surfaceElevated, in: RoundedRectangle(cornerRadius: Design.cardCornerRadius))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Action ledger item: \(summary.title), \(LedgerPresenter.statusTitle(for: event.status))")
        .accessibilityHint(isExpanded ? "Collapse to hide raw tool details" : "Expand to review raw tool details")
    }

    private var footerChip: some View {
        let config: (String, LedgerTone, String) = {
            switch event.status {
            case .running:
                return ("Live Step", .info, "waveform.path.ecg")
            case .completed:
                return ("Action Recorded", .success, "checkmark.seal")
            case .failed:
                return ("Needs Review", .danger, "exclamationmark.octagon")
            }
        }()

        return LedgerStatusChip(
            title: config.0,
            tone: config.1,
            systemImage: config.2
        )
    }

    private var shouldShowAuditChip: Bool {
        event.status != .running || event.toolName == "execute"
    }

    private func detailSection(_ title: String, content: String, tone: LedgerTone? = nil) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(title.uppercased())
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(tone?.color ?? Design.textSecondary)

                Spacer(minLength: 0)

                if title == "Error" {
                    LedgerStatusChip(title: "Inspect", tone: .danger, systemImage: "ant")
                }
            }

            Text(String(content.prefix(1200)))
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(tone?.color ?? Design.textPrimary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(Design.surfaceMuted, in: RoundedRectangle(cornerRadius: Design.cardCornerRadius))
        }
    }
}
