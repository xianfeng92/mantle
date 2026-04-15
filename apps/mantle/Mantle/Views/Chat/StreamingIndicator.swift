import SwiftUI

// MARK: - Streaming Indicator
//
// Animated typing indicator with live token generation speed.

struct StreamingIndicator: View {
    var stats: StreamingStats?

    @State private var dotOffset: CGFloat = 0
    @State private var displayedSpeed: Double = 0
    @State private var refreshTick = false

    var body: some View {
        HStack(spacing: 8) {
            // Bouncing dots
            HStack(spacing: 4) {
                ForEach(0..<3, id: \.self) { index in
                    Circle()
                        .fill(Design.accent.opacity(0.7))
                        .frame(width: 7, height: 7)
                        .offset(y: dotOffset)
                        .animation(
                            .easeInOut(duration: 0.4)
                                .repeatForever(autoreverses: true)
                                .delay(Double(index) * 0.15),
                            value: dotOffset
                        )
                }
            }

            // Live speed display
            if let stats, stats.firstTokenTime != nil {
                let _ = refreshTick  // Force refresh on tick
                HStack(spacing: 6) {
                    if let speed = stats.tokensPerSecond {
                        Text(String(format: "%.1f tok/s", speed))
                            .font(.caption2)
                            .fontDesign(.monospaced)
                            .foregroundStyle(speedColor(speed))
                    }

                    if let tokens = tokenCountText(stats) {
                        Text(tokens)
                            .font(.caption2)
                            .fontDesign(.monospaced)
                            .foregroundStyle(.tertiary)
                    }
                }
                .transition(.opacity.combined(with: .move(edge: .leading)))
            }
        }
        .padding(.leading, 36)
        .padding(.vertical, 8)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityDescription)
        .accessibilityAddTraits(.updatesFrequently)
        .onAppear {
            dotOffset = -4
        }
        .task {
            // Refresh speed calculation every 500ms
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(500))
                refreshTick.toggle()
            }
        }
    }

    private var accessibilityDescription: String {
        guard let stats, let speed = stats.tokensPerSecond else {
            return "Generating response"
        }
        return "Generating at \(String(format: "%.0f", speed)) tokens per second, approximately \(stats.estimatedTokens) tokens"
    }

    private func tokenCountText(_ stats: StreamingStats) -> String? {
        guard stats.estimatedTokens > 0 else { return nil }
        return "~\(stats.estimatedTokens) tokens"
    }

    private func speedColor(_ speed: Double) -> Color {
        if speed > 15 { return Design.accent }
        if speed < 5 { return .secondary }
        return .secondary
    }
}
