import SwiftUI

// MARK: - Heartbeat Panel
//
// Reads `GET /heartbeat/tasks` from agent-core and shows each task's schedule,
// last run, and next fire. One-click Reload (re-parses HEARTBEAT.md) and
// Run Now (manual trigger) per task.
//
// Results land in the Returns Plane, so output shows up in the menu-bar Inbox
// — not inline here.

struct HeartbeatPanel: View {
    let client: AgentCoreClient

    @State private var response: HeartbeatTasksResponse?
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var runningTaskId: String?
    @State private var lastRunNotice: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().padding(.vertical, 8)

            if isLoading {
                ProgressView("Loading heartbeat…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error = errorMessage {
                errorState(error)
            } else {
                content
            }
        }
        .padding()
        .task { await refresh() }
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Image(systemName: "waveform.path.ecg")
                    .font(.title3)
                    .foregroundStyle(Design.accent)
                Text("Heartbeat")
                    .font(.title3).bold()
                if let response, response.enabled {
                    stateChip(label: "enabled", color: .green)
                } else if response != nil {
                    stateChip(label: "disabled", color: .secondary)
                }
                Spacer()
                Button {
                    Task { await reload() }
                } label: {
                    Label("Reload HEARTBEAT.md", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(isLoading)
            }

            Text("Time-triggered tasks defined in HEARTBEAT.md at the agent-core workspace. Results land in the Inbox.")
                .font(.caption)
                .foregroundStyle(.secondary)

            if let lastRunNotice {
                Text(lastRunNotice)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .transition(.opacity)
            }
        }
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        if let response {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if !response.parseErrors.isEmpty {
                        parseErrorsCard(response.parseErrors)
                    }

                    if response.tasks.isEmpty {
                        emptyCard
                    } else {
                        ForEach(response.tasks) { task in
                            taskCard(task)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var emptyCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("No tasks defined")
                .font(.body).bold()
            Text("Edit HEARTBEAT.md in the workspace root and click Reload. See the spec for the format.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Design.surfaceMuted, in: RoundedRectangle(cornerRadius: Design.cornerRadius))
    }

    private func parseErrorsCard(_ errors: [String]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(Design.stateDanger)
                Text("Parse errors")
                    .font(.callout).bold()
            }
            ForEach(errors, id: \.self) { err in
                Text(err)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Design.stateDanger.opacity(0.08), in: RoundedRectangle(cornerRadius: Design.cornerRadius))
    }

    // MARK: - Task Card

    private func taskCard(_ task: HeartbeatTaskStatus) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(task.def.id)
                    .font(.body).bold()
                if task.def.enabled == false {
                    stateChip(label: "disabled", color: .secondary)
                }
                statusChip(task.state)
                Spacer()
                Button {
                    Task { await runNow(taskId: task.def.id) }
                } label: {
                    if runningTaskId == task.def.id {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Label("Run now", systemImage: "play.circle")
                    }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(runningTaskId != nil || task.def.enabled == false)
            }

            HStack(spacing: 8) {
                chip(task.def.schedule, icon: "clock")
                chip(task.def.handler, icon: "gearshape.2")
                if let tags = task.def.tags, !tags.isEmpty {
                    chip(tags.joined(separator: " · "), icon: "tag")
                }
            }

            if let prompt = task.def.prompt, !prompt.isEmpty {
                Text(prompt)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            }

            VStack(alignment: .leading, spacing: 2) {
                if let fired = task.state.lastFiredAt {
                    Text("Last fired: \(formatTimestamp(fired))")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                if let next = task.nextFireAt {
                    Text("Next fire: \(formatTimestamp(next))")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                if let err = task.state.lastError {
                    Text("Last error: \(err)")
                        .font(.caption2)
                        .foregroundStyle(Design.stateDanger)
                        .lineLimit(2)
                }
            }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Design.surfaceMuted, in: RoundedRectangle(cornerRadius: Design.cornerRadius))
    }

    // MARK: - Bits

    private func chip(_ text: String, icon: String) -> some View {
        HStack(spacing: 4) {
            Image(systemName: icon)
                .font(.caption2)
            Text(text)
                .font(.caption2)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .background(Design.surfaceMuted, in: Capsule())
        .foregroundStyle(Design.textSecondary)
    }

    private func stateChip(label: String, color: Color) -> some View {
        Text(label)
            .font(.caption2)
            .foregroundStyle(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.12), in: Capsule())
    }

    private func statusChip(_ state: HeartbeatTaskStatePayload) -> some View {
        Group {
            switch state.lastStatus {
            case "ok":
                stateChip(label: "ok", color: .green)
            case "error":
                stateChip(label: "error", color: Design.stateDanger)
            default:
                stateChip(label: "pending", color: .secondary)
            }
        }
    }

    private func errorState(_ message: String) -> some View {
        VStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle")
                .font(.title2)
                .foregroundStyle(Design.stateDanger)
            Text(message)
                .font(.callout)
                .foregroundStyle(.secondary)
            Button("Retry") {
                Task { await refresh() }
            }
            .buttonStyle(.bordered)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Actions

    private func refresh() async {
        isLoading = true
        errorMessage = nil
        do {
            let result = try await client.heartbeatTasks()
            self.response = result
        } catch {
            self.errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    private func reload() async {
        do {
            let result = try await client.heartbeatReload()
            self.response = result
            self.errorMessage = nil
            self.lastRunNotice = "Reloaded HEARTBEAT.md · \(result.tasks.count) task(s)"
        } catch {
            self.errorMessage = error.localizedDescription
        }
    }

    private func runNow(taskId: String) async {
        runningTaskId = taskId
        defer { runningTaskId = nil }
        do {
            let result = try await client.heartbeatRunNow(taskId: taskId)
            self.lastRunNotice = "Ran \(result.taskId) · status=\(result.state.lastStatus ?? "?") — check the Inbox"
            await refresh()
        } catch {
            self.lastRunNotice = "Run \(taskId) failed: \(error.localizedDescription)"
        }
    }

    private func formatTimestamp(_ iso: String) -> String {
        let isoFormatter = ISO8601DateFormatter()
        isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = isoFormatter.date(from: iso)
            ?? { () -> Date? in
                let alt = ISO8601DateFormatter()
                alt.formatOptions = [.withInternetDateTime]
                return alt.date(from: iso)
            }()
        guard let date else { return iso }
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        formatter.timeStyle = .medium
        return formatter.string(from: date)
    }
}
