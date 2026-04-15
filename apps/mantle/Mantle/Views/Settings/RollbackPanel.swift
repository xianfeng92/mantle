import SwiftUI

// MARK: - Rollback Panel
//
// Shows recent file move operations from desktop organization.
// Each entry can be rolled back within 7 days.

struct RollbackPanel: View {
    let client: AgentCoreClient

    @State private var moves: [MoveRecord] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var rollbackingId: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Recent Moves (7 days)")
                    .font(.headline)
                Spacer()
                Button {
                    Task { await loadMoves() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .disabled(isLoading)
            }

            if isLoading && moves.isEmpty {
                ProgressView("Loading...")
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding()
            } else if let error = errorMessage, moves.isEmpty {
                // Error state — show error instead of empty state
                ContentUnavailableView {
                    Label("Unable to Load", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(error)
                        .font(.caption)
                }
            } else if moves.isEmpty {
                ContentUnavailableView(
                    "No Moves",
                    systemImage: "tray",
                    description: Text("File moves from desktop organization will appear here.")
                )
            } else {
                ScrollView {
                    LazyVStack(spacing: 8) {
                        ForEach(moves) { move in
                            moveRow(move)
                        }
                    }
                }

                // Inline error when there are existing moves (e.g. rollback failed)
                if let error = errorMessage {
                    HStack {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(Design.stateDanger)
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding()
        .task {
            await loadMoves()
        }
    }

    // MARK: - Move Row

    @ViewBuilder
    private func moveRow(_ move: MoveRecord) -> some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                // Source → Dest
                HStack(spacing: 4) {
                    Image(systemName: "doc")
                        .foregroundStyle(.secondary)
                    Text(shortenPath(move.sourcePath))
                        .font(.system(.body, design: .monospaced))
                        .lineLimit(1)
                }

                HStack(spacing: 4) {
                    Image(systemName: "arrow.right")
                        .foregroundStyle(Design.accent)
                    Text(shortenPath(move.destPath))
                        .font(.system(.body, design: .monospaced))
                        .lineLimit(1)
                }

                Text(move.displayDate)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            if move.rolledBack == true {
                Label("Rolled Back", systemImage: "checkmark.circle")
                    .font(.caption)
                    .foregroundStyle(.green)
            } else if move.isExpired {
                Text("Expired")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Button {
                    Task { await performRollback(move.id) }
                } label: {
                    if rollbackingId == move.id {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Label("Undo", systemImage: "arrow.uturn.backward")
                    }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(rollbackingId != nil)
            }
        }
        .padding(10)
        .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 8))
        .opacity(move.rolledBack == true || move.isExpired ? 0.6 : 1)
    }

    // MARK: - Actions

    private func loadMoves() async {
        isLoading = true
        errorMessage = nil
        do {
            let response = try await client.moves(days: 7)
            moves = response.moves
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    private func performRollback(_ moveId: String) async {
        rollbackingId = moveId
        errorMessage = nil
        do {
            let result = try await client.rollbackMove(id: moveId)
            if result.success {
                await loadMoves() // Refresh
            } else {
                errorMessage = result.error ?? "Rollback failed"
            }
        } catch {
            errorMessage = error.localizedDescription
        }
        rollbackingId = nil
    }

    // MARK: - Helpers

    private func shortenPath(_ path: String) -> String {
        // Replace home dir with ~
        let home = NSHomeDirectory()
        if path.hasPrefix(home) {
            return "~" + path.dropFirst(home.count)
        }
        return path
    }
}
