import SwiftUI

// MARK: - Generation Stats Bar
//
// Compact stats bar shown below the last assistant message after generation completes.
// Displays: TTFT, token count, speed, duration.

struct GenerationStatsBar: View {
    let stats: StreamingStats

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "speedometer")
                .font(.caption2)
                .foregroundStyle(.tertiary)

            // TTFT
            if let ttft = stats.ttftText {
                statChip(ttft)
            }

            // Token count
            if stats.estimatedTokens > 0 {
                statChip("~\(stats.estimatedTokens) tokens")
            }

            // Speed
            if let speed = stats.speedText {
                statChip(speed)
            }

            // Duration
            if let dur = stats.durationText {
                statChip(dur)
            }

            Spacer()
        }
        .padding(.leading, 36)
        .transition(.opacity)
        .animation(.easeIn(duration: Design.transitionDuration), value: stats.estimatedTokens)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityDescription)
    }

    private var accessibilityDescription: String {
        var parts: [String] = ["Generation complete"]
        if let ttft = stats.ttftText { parts.append(ttft) }
        if stats.estimatedTokens > 0 { parts.append("approximately \(stats.estimatedTokens) tokens") }
        if let speed = stats.speedText { parts.append(speed) }
        if let dur = stats.durationText { parts.append("in \(dur)") }
        return parts.joined(separator: ", ")
    }

    private func statChip(_ text: String) -> some View {
        Text(text)
            .font(.caption2)
            .fontDesign(.monospaced)
            .foregroundStyle(.tertiary)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(.quaternary.opacity(0.5), in: Capsule())
    }
}
