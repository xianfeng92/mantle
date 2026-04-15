import SwiftUI

// MARK: - Rollback Panel
//
// Recovery center for both run-level checkpoints and the older move-only rollback log.

struct RollbackPanel: View {
    let client: AgentCoreClient

    @State private var snapshots: [RunSnapshotRecord] = []
    @State private var moves: [MoveRecord] = []

    @State private var isLoadingSnapshots = false
    @State private var isLoadingMoves = false

    @State private var snapshotErrorMessage: String?
    @State private var moveErrorMessage: String?

    @State private var rollbackingId: String?
    @State private var previewingTraceId: String?
    @State private var restoringTraceId: String?

    @State private var selectedSnapshotTraceId: String?
    @State private var selectedRestorePreview: RunSnapshotRestoreResult?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Recovery Center")
                        .font(.headline)
                    Text("Compare recent runs, preview restores, and undo tracked file moves from the last 7 days.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                Button {
                    Task { await loadAll() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .disabled(isLoadingSnapshots || isLoadingMoves)
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    runSnapshotsSection
                    Divider()
                    movesSection
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding()
        .task {
            await loadAll()
        }
        .sheet(
            isPresented: Binding(
                get: { selectedSnapshotTraceId != nil },
                set: { isPresented in
                    if !isPresented {
                        selectedSnapshotTraceId = nil
                        selectedRestorePreview = nil
                    }
                }
            )
        ) {
            if let snapshot = currentSelectedSnapshot {
                RunSnapshotDetailSheet(
                    snapshot: snapshot,
                    restorePreview: selectedRestorePreview,
                    isPreviewing: previewingTraceId == snapshot.traceId,
                    isRestoring: restoringTraceId == snapshot.traceId,
                    onPreviewRestore: {
                        Task { await previewRestore(snapshot) }
                    },
                    onRestoreNow: {
                        Task { await restoreSnapshot(snapshot) }
                    }
                )
            } else {
                VStack(spacing: 12) {
                    ProgressView()
                    Text("Loading checkpoint details…")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                .frame(minWidth: 560, minHeight: 360)
                .padding()
            }
        }
    }

    private var currentSelectedSnapshot: RunSnapshotRecord? {
        guard let traceId = selectedSnapshotTraceId else { return nil }
        return snapshots.first { $0.traceId == traceId }
    }

    // MARK: - Run Snapshots

    private var runSnapshotsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Run Checkpoints")
                        .font(.headline)
                    Text("Each run tracks touched files so you can compare changes and safely roll them back after a dry-run preflight.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                if isLoadingSnapshots {
                    ProgressView()
                        .controlSize(.small)
                }
            }

            if let error = snapshotErrorMessage, snapshots.isEmpty {
                ContentUnavailableView {
                    Label("Unable to Load Checkpoints", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(error)
                        .font(.caption)
                }
            } else if snapshots.isEmpty {
                ContentUnavailableView(
                    "No Checkpoints Yet",
                    systemImage: "square.stack.3d.up",
                    description: Text("Once a run changes files through write, edit, or tracked move actions, it will appear here.")
                )
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(snapshots.prefix(12)) { snapshot in
                        snapshotRow(snapshot)
                    }
                }

                if let error = snapshotErrorMessage {
                    inlineErrorRow(error)
                }
            }
        }
    }

    @ViewBuilder
    private func snapshotRow(_ snapshot: RunSnapshotRecord) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        checkpointStatusChip(snapshot.status)
                        if snapshot.summary.changedFiles > 0 {
                            checkpointMetricChip("\(snapshot.summary.changedFiles) changed")
                        }
                        if snapshot.summary.restorableFiles > 0 {
                            checkpointMetricChip("\(snapshot.summary.restorableFiles) restorable")
                        }
                    }

                    Text(snapshot.inputPreview ?? "No input preview captured for this run.")
                        .font(.callout)
                        .foregroundStyle(.primary)
                        .lineLimit(3)

                    Text(snapshotMetaLine(snapshot))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                VStack(alignment: .trailing, spacing: 8) {
                    Button("Compare") {
                        selectedSnapshotTraceId = snapshot.traceId
                        selectedRestorePreview = nil
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Design.accent)
                    .controlSize(.small)

                    if snapshot.summary.restorableFiles > 0 {
                        Button("Preview Restore") {
                            selectedSnapshotTraceId = snapshot.traceId
                            Task { await previewRestore(snapshot) }
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .disabled(previewingTraceId != nil || restoringTraceId != nil)
                    }
                }
            }

            if !snapshot.files.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(snapshot.files.filter { $0.changeType != .unchanged }.prefix(3))) { file in
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: icon(for: file.changeType))
                                .foregroundStyle(color(for: file.changeType))
                                .frame(width: 16)

                            VStack(alignment: .leading, spacing: 2) {
                                Text(shortenPath(file.path))
                                    .font(.system(.caption, design: .monospaced))
                                    .foregroundStyle(.primary)
                                    .lineLimit(1)
                                Text(label(for: file.changeType))
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }

                            Spacer()
                        }
                    }
                }
                .padding(10)
                .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 8))
            }
        }
        .padding(12)
        .background(.quaternary.opacity(0.18), in: RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Moves

    private var movesSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Recent Moves (7 days)")
                        .font(.headline)
                    Text("Legacy move tracking remains available for Desktop and Downloads organization workflows.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                if isLoadingMoves {
                    ProgressView()
                        .controlSize(.small)
                }
            }

            if let error = moveErrorMessage, moves.isEmpty {
                ContentUnavailableView {
                    Label("Unable to Load Moves", systemImage: "exclamationmark.triangle")
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
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(moves) { move in
                        moveRow(move)
                    }
                }

                if let error = moveErrorMessage {
                    inlineErrorRow(error)
                }
            }
        }
    }

    @ViewBuilder
    private func moveRow(_ move: MoveRecord) -> some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
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

    // MARK: - Loading

    private func loadAll() async {
        async let snapshotsTask: Void = loadSnapshots()
        async let movesTask: Void = loadMoves()
        _ = await (snapshotsTask, movesTask)
    }

    private func loadSnapshots() async {
        isLoadingSnapshots = true
        snapshotErrorMessage = nil
        do {
            let response = try await client.runSnapshots(limit: 25)
            snapshots = response.runs
            if let traceId = selectedSnapshotTraceId,
               !snapshots.contains(where: { $0.traceId == traceId }) {
                selectedSnapshotTraceId = nil
                selectedRestorePreview = nil
            }
        } catch {
            snapshotErrorMessage = error.localizedDescription
        }
        isLoadingSnapshots = false
    }

    private func loadMoves() async {
        isLoadingMoves = true
        moveErrorMessage = nil
        do {
            let response = try await client.moves(days: 7)
            moves = response.moves
        } catch {
            moveErrorMessage = error.localizedDescription
        }
        isLoadingMoves = false
    }

    // MARK: - Actions

    private func previewRestore(_ snapshot: RunSnapshotRecord) async {
        previewingTraceId = snapshot.traceId
        snapshotErrorMessage = nil
        do {
            selectedRestorePreview = try await client.restoreRunSnapshot(traceId: snapshot.traceId, dryRun: true)
        } catch {
            snapshotErrorMessage = error.localizedDescription
        }
        previewingTraceId = nil
    }

    private func restoreSnapshot(_ snapshot: RunSnapshotRecord) async {
        restoringTraceId = snapshot.traceId
        snapshotErrorMessage = nil
        do {
            selectedRestorePreview = try await client.restoreRunSnapshot(traceId: snapshot.traceId, dryRun: false)
            await loadSnapshots()
            await loadMoves()
        } catch {
            snapshotErrorMessage = error.localizedDescription
        }
        restoringTraceId = nil
    }

    private func performRollback(_ moveId: String) async {
        rollbackingId = moveId
        moveErrorMessage = nil
        do {
            let result = try await client.rollbackMove(id: moveId)
            if result.success {
                await loadMoves()
            } else {
                moveErrorMessage = result.error ?? "Rollback failed"
            }
        } catch {
            moveErrorMessage = error.localizedDescription
        }
        rollbackingId = nil
    }

    // MARK: - Helpers

    private func shortenPath(_ path: String) -> String {
        let home = NSHomeDirectory()
        if path.hasPrefix(home) {
            return "~" + path.dropFirst(home.count)
        }
        return path
    }

    private func snapshotMetaLine(_ snapshot: RunSnapshotRecord) -> String {
        let started = formatDate(snapshot.startedAt)
        let trace = snapshot.traceId.prefix(8)
        return "Trace \(trace) • \(snapshot.mode.rawValue.capitalized) • \(snapshot.status.rawValue.capitalized) • \(started)"
    }

    private func formatDate(_ value: String) -> String {
        guard let date = ISO8601DateFormatter().date(from: value) else {
            return value
        }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    private func label(for changeType: RunSnapshotChangeType) -> String {
        switch changeType {
        case .created:
            return "Created during the run"
        case .updated:
            return "Updated during the run"
        case .deleted:
            return "Deleted during the run"
        case .moved_in:
            return "Moved into this path"
        case .moved_out:
            return "Moved out of this path"
        case .unchanged:
            return "Unchanged"
        }
    }

    private func icon(for changeType: RunSnapshotChangeType) -> String {
        switch changeType {
        case .created:
            return "plus.circle"
        case .updated:
            return "pencil.circle"
        case .deleted:
            return "trash.circle"
        case .moved_in, .moved_out:
            return "arrow.left.arrow.right.circle"
        case .unchanged:
            return "minus.circle"
        }
    }

    private func color(for changeType: RunSnapshotChangeType) -> Color {
        switch changeType {
        case .created:
            return Design.stateSuccess
        case .updated:
            return Design.accent
        case .deleted:
            return Design.stateDanger
        case .moved_in, .moved_out:
            return Design.stateWarning
        case .unchanged:
            return .secondary
        }
    }

    private func checkpointStatusChip(_ status: RunSnapshotStatus) -> some View {
        HStack(spacing: 6) {
            Image(systemName: checkpointStatusIcon(status))
                .font(.caption2)
            Text(status.rawValue.capitalized)
                .font(.caption2.weight(.semibold))
        }
        .foregroundStyle(checkpointStatusColor(status))
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(checkpointStatusColor(status).opacity(0.10), in: Capsule())
    }

    private func checkpointMetricChip(_ text: String) -> some View {
        Text(text)
            .font(.caption2)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(.quaternary.opacity(0.35), in: Capsule())
    }

    private func checkpointStatusIcon(_ status: RunSnapshotStatus) -> String {
        switch status {
        case .running:
            return "clock.badge.questionmark"
        case .completed:
            return "checkmark.circle"
        case .interrupted:
            return "pause.circle"
        case .failed:
            return "xmark.octagon"
        }
    }

    private func checkpointStatusColor(_ status: RunSnapshotStatus) -> Color {
        switch status {
        case .running:
            return Design.stateWarning
        case .completed:
            return Design.stateSuccess
        case .interrupted:
            return Design.accent
        case .failed:
            return Design.stateDanger
        }
    }

    private func inlineErrorRow(_ message: String) -> some View {
        HStack {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(Design.stateDanger)
            Text(message)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - Run Snapshot Detail Sheet

struct RunSnapshotDetailSheet: View {
    let snapshot: RunSnapshotRecord
    let restorePreview: RunSnapshotRestoreResult?
    let isPreviewing: Bool
    let isRestoring: Bool
    let onPreviewRestore: () -> Void
    let onRestoreNow: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Checkpoint Details")
                        .font(.title3.weight(.semibold))
                    Spacer()
                    Text(snapshot.traceId)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                }

                Text(snapshot.inputPreview ?? "No input preview captured for this run.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: 8) {
                    summaryChip("\(snapshot.summary.changedFiles) changed", tone: .secondary)
                    summaryChip("\(snapshot.summary.restorableFiles) restorable", tone: Design.stateSuccess)
                    summaryChip(snapshot.status.rawValue.capitalized, tone: checkpointColor(snapshot.status))
                }
            }

            HStack(spacing: 10) {
                Button {
                    onPreviewRestore()
                } label: {
                    if isPreviewing {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Label("Preview Restore", systemImage: "eye")
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(Design.accent)
                .disabled(isPreviewing || isRestoring)

                Button {
                    onRestoreNow()
                } label: {
                    if isRestoring {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Label("Restore Now", systemImage: "arrow.uturn.backward")
                    }
                }
                .buttonStyle(.bordered)
                .disabled(!canRestoreNow || isRestoring || isPreviewing)

                Spacer()
            }

            if let restorePreview {
                restorePreviewCard(restorePreview)
            } else {
                Text("Run a dry-run restore first to check for drift or conflicts before applying changes.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if !snapshot.actions.isEmpty {
                        detailSection(title: "Actions") {
                            VStack(alignment: .leading, spacing: 8) {
                                ForEach(snapshot.actions) { action in
                                    VStack(alignment: .leading, spacing: 4) {
                                        HStack {
                                            Text(action.summary)
                                                .font(.callout.weight(.medium))
                                            Spacer()
                                            Text(action.status.rawValue.capitalized)
                                                .font(.caption2)
                                                .foregroundStyle(action.status == .completed ? Design.stateSuccess : Design.stateDanger)
                                        }

                                        if !action.touchedPaths.isEmpty {
                                            Text(action.touchedPaths.joined(separator: " • "))
                                                .font(.system(.caption, design: .monospaced))
                                                .foregroundStyle(.secondary)
                                                .lineLimit(2)
                                        }

                                        if let error = action.error, !error.isEmpty {
                                            Text(error)
                                                .font(.caption)
                                                .foregroundStyle(Design.stateDanger)
                                        }
                                    }
                                    .padding(10)
                                    .background(.quaternary.opacity(0.22), in: RoundedRectangle(cornerRadius: 8))
                                }
                            }
                        }
                    }

                    detailSection(title: "Changed Files") {
                        VStack(alignment: .leading, spacing: 10) {
                            ForEach(snapshot.files.filter { $0.changeType != .unchanged }) { file in
                                runSnapshotFileCard(file)
                            }
                        }
                    }
                }
            }
        }
        .padding(20)
        .frame(minWidth: 720, minHeight: 620)
    }

    private var canRestoreNow: Bool {
        guard let restorePreview else { return false }
        guard restorePreview.conflicts.isEmpty else { return false }
        guard !restorePreview.results.isEmpty else { return false }
        return restorePreview.results.allSatisfy { $0.ok }
    }

    private func restorePreviewCard(_ preview: RunSnapshotRestoreResult) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(preview.conflicts.isEmpty ? "Dry-run passed" : "Dry-run found conflicts")
                    .font(.headline)
                Spacer()
                Text(preview.dryRun ? "Preview" : "Applied")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(preview.ok ? Design.stateSuccess : Design.stateWarning)
            }

            Text(
                preview.conflicts.isEmpty
                    ? "The current workspace still matches the post-run snapshot, so Mantle can safely restore these files."
                    : "Some files changed after the run finished. Review the conflicts below before retrying restore."
            )
            .font(.callout)
            .foregroundStyle(.secondary)

            if !preview.conflicts.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(preview.conflicts, id: \.self) { conflict in
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundStyle(Design.stateWarning)
                            Text(conflict)
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .padding(12)
        .background(
            (preview.conflicts.isEmpty ? Design.stateSuccess : Design.stateWarning).opacity(0.10),
            in: RoundedRectangle(cornerRadius: 10)
        )
    }

    private func detailSection<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.headline)
            content()
        }
    }

    private func runSnapshotFileCard(_ file: RunSnapshotFileRecord) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: icon(for: file.changeType))
                    .foregroundStyle(color(for: file.changeType))
                    .frame(width: 18)

                VStack(alignment: .leading, spacing: 4) {
                    Text(file.path)
                        .font(.system(.callout, design: .monospaced))
                        .foregroundStyle(.primary)
                    Text(label(for: file.changeType))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer()
            }

            HStack(alignment: .top, spacing: 10) {
                snapshotVersionColumn(title: "Before", version: file.before)
                snapshotVersionColumn(title: "After", version: file.after)
            }
        }
        .padding(12)
        .background(.quaternary.opacity(0.22), in: RoundedRectangle(cornerRadius: 10))
    }

    private func snapshotVersionColumn(title: String, version: RunSnapshotFileVersion) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)

            Text(versionSummary(version))
                .font(.caption)
                .foregroundStyle(.secondary)

            if let preview = version.preview, !preview.isEmpty {
                Text(preview)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.primary)
                    .textSelection(.enabled)
                    .lineLimit(8)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                    .padding(8)
                    .background(.background, in: RoundedRectangle(cornerRadius: 8))
            } else if let captureError = version.captureError, !captureError.isEmpty {
                Text(captureError)
                    .font(.caption)
                    .foregroundStyle(Design.stateDanger)
            } else {
                Text(version.exists ? (version.binary == true ? "Binary file snapshot" : "No text preview captured") : "File absent")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    private func versionSummary(_ version: RunSnapshotFileVersion) -> String {
        guard version.exists else { return "Absent" }
        var parts: [String] = []
        if let size = version.size {
            parts.append(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))
        }
        if version.binary == true {
            parts.append("binary")
        }
        if version.truncated == true {
            parts.append("preview truncated")
        }
        return parts.isEmpty ? "File captured" : parts.joined(separator: " • ")
    }

    private func label(for changeType: RunSnapshotChangeType) -> String {
        switch changeType {
        case .created:
            return "Created during the run"
        case .updated:
            return "Updated during the run"
        case .deleted:
            return "Deleted during the run"
        case .moved_in:
            return "Moved into this path"
        case .moved_out:
            return "Moved out of this path"
        case .unchanged:
            return "Unchanged"
        }
    }

    private func icon(for changeType: RunSnapshotChangeType) -> String {
        switch changeType {
        case .created:
            return "plus.circle"
        case .updated:
            return "pencil.circle"
        case .deleted:
            return "trash.circle"
        case .moved_in, .moved_out:
            return "arrow.left.arrow.right.circle"
        case .unchanged:
            return "minus.circle"
        }
    }

    private func color(for changeType: RunSnapshotChangeType) -> Color {
        switch changeType {
        case .created:
            return Design.stateSuccess
        case .updated:
            return Design.accent
        case .deleted:
            return Design.stateDanger
        case .moved_in, .moved_out:
            return Design.stateWarning
        case .unchanged:
            return .secondary
        }
    }

    private func checkpointColor(_ status: RunSnapshotStatus) -> Color {
        switch status {
        case .running:
            return Design.stateWarning
        case .completed:
            return Design.stateSuccess
        case .interrupted:
            return Design.accent
        case .failed:
            return Design.stateDanger
        }
    }

    private func summaryChip(_ text: String, tone: Color) -> some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(tone)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(tone.opacity(0.10), in: Capsule())
    }
}
