import SwiftUI

// MARK: - Diagnostics Panel
//
// Displays runtime diagnostics fetched from agent-core GET /diagnostics.
// Shows: run stats, Gemma 4 resilience metrics, recent errors.

struct DiagnosticsPanel: View {
    let client: AgentCoreClient

    @State private var data: DiagnosticsResponse?
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var lastRefresh: Date?

    var body: some View {
        Group {
            if isLoading && data == nil {
                ProgressView("Loading diagnostics…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error = errorMessage, data == nil {
                errorState(error)
            } else if let data {
                contentView(data)
            }
        }
        .task { await loadData() }
    }

    // MARK: - Content

    private func contentView(_ diag: DiagnosticsResponse) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                // Refresh bar
                HStack {
                    if let lastRefresh {
                        Text("Updated \(lastRefresh, format: .dateTime.hour().minute().second())")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    Spacer()
                    Button {
                        Task { await loadData() }
                    } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                            .font(.caption)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(isLoading)
                    .accessibilityLabel("Refresh diagnostics")
                }

                // Run Stats
                sectionHeader("Runs", icon: "play.circle")
                HStack(spacing: 12) {
                    statCard(
                        value: "\(diag.runs.completed)",
                        label: "Completed",
                        color: Design.accent,
                        icon: "checkmark.circle"
                    )
                    statCard(
                        value: "\(diag.runs.failed)",
                        label: "Failed",
                        color: diag.runs.failed > 0 ? .red : .gray,
                        icon: "xmark.circle"
                    )
                    statCard(
                        value: diag.runs.avgDurationMs.map { formatDuration($0) } ?? "—",
                        label: "Avg Duration",
                        color: Design.accent,
                        icon: "clock"
                    )
                }

                Divider()

                // Gemma 4 Resilience
                sectionHeader("Gemma 4 Resilience", icon: "shield.checkered")
                HStack(spacing: 12) {
                    statCard(
                        value: "\(diag.gemma4.toolCallFallbackCount)",
                        label: "Tool Fallback",
                        color: diag.gemma4.toolCallFallbackCount > 0 ? Design.stateDanger : .gray,
                        icon: "wrench.and.screwdriver"
                    )
                    statCard(
                        value: "\(diag.gemma4.retryCount)",
                        label: "Retries",
                        color: diag.gemma4.retryCount > 0 ? .yellow : .gray,
                        icon: "arrow.clockwise"
                    )
                    statCard(
                        value: "\(diag.gemma4.contextRecoveryCount)",
                        label: "Recovery",
                        color: diag.gemma4.contextRecoveryCount > 0 ? Design.accent : .gray,
                        icon: "arrow.uturn.backward"
                    )
                }

                if let failures = diag.gemma4.contextRecoveryFailures, failures > 0 {
                    HStack(spacing: 4) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.caption)
                            .foregroundStyle(.red)
                        Text("\(failures) recovery failure(s)")
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                    .padding(.leading, 4)
                }

                if let compaction = diag.compactionCount, compaction > 0 {
                    HStack(spacing: 4) {
                        Image(systemName: "arrow.triangle.2.circlepath")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text("\(compaction) context compaction(s)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.leading, 4)
                }

                Divider()

                // Recent Errors
                sectionHeader("Recent Errors", icon: "exclamationmark.bubble")

                if let errors = diag.recentErrors, !errors.isEmpty {
                    ForEach(Array(errors.enumerated()), id: \.offset) { _, error in
                        errorRow(error)
                    }
                } else {
                    HStack(spacing: 6) {
                        Image(systemName: "checkmark.seal.fill")
                            .foregroundStyle(Design.accent)
                        Text("No recent errors")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.leading, 4)
                }

                // Footer
                Text("Based on \(diag.eventsAnalyzed) trace events")
                    .font(.caption2)
                    .foregroundStyle(.quaternary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: - Stat Card

    private func statCard(value: String, label: String, color: Color, icon: String) -> some View {
        VStack(spacing: 6) {
            Image(systemName: icon)
                .font(.title3)
                .foregroundStyle(color)
            Text(value)
                .font(.title2)
                .fontWeight(.semibold)
                .fontDesign(.monospaced)
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 10)
        .background(color.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label): \(value)")
    }

    // MARK: - Error Row

    private func errorRow(_ error: AnyCodable) -> some View {
        let dict = error.value as? [String: Any] ?? [:]
        let kind = dict["kind"] as? String ?? "unknown"
        let message = dict["error"] as? String ?? "—"
        let timestamp = dict["timestamp"] as? String ?? ""

        return HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.caption)
                .foregroundStyle(Design.stateDanger)

            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(kind)
                        .font(.caption)
                        .fontWeight(.medium)
                        .fontDesign(.monospaced)
                    Spacer()
                    if !timestamp.isEmpty {
                        Text(formatTimestamp(timestamp))
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            }
        }
        .padding(8)
        .background(Design.stateDanger.opacity(0.06), in: RoundedRectangle(cornerRadius: 6))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Error: \(kind). \(message)")
    }

    // MARK: - Helpers

    private func sectionHeader(_ title: String, icon: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .foregroundStyle(.secondary)
            Text(title)
                .font(.headline)
        }
    }

    private func errorState(_ message: String) -> some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 32))
                .foregroundStyle(Design.stateDanger)
            Text(message)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("Retry") { Task { await loadData() } }
                .buttonStyle(.bordered)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func loadData() async {
        isLoading = true
        errorMessage = nil

        do {
            data = try await client.diagnostics()
            lastRefresh = .now
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    private func formatDuration(_ ms: Double) -> String {
        if ms < 1000 {
            return String(format: "%.0fms", ms)
        } else {
            return String(format: "%.1fs", ms / 1000)
        }
    }

    private func formatTimestamp(_ iso: String) -> String {
        // Show just time portion from ISO string
        if let tIndex = iso.firstIndex(of: "T"),
           let dotIndex = iso.firstIndex(of: ".") ?? iso.firstIndex(of: "Z") {
            let timeStr = iso[iso.index(after: tIndex)..<dotIndex]
            return String(timeStr)
        }
        return iso
    }
}
