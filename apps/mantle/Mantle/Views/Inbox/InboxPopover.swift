import SwiftUI

// MARK: - InboxPopover
//
// Compact list of unread Return Plane entries.
// Click-to-ack on each row; "Clear all" at the bottom.
//
// Intentionally minimal — entries are server-persisted, so this view is
// just a reactive window onto /returns?unackedOnly=true + /returns/stream.

struct InboxPopover: View {
    let service: ReturnsService

    private var unread: [ReturnEntry] {
        service.entries.filter { !$0.isAcked }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()

            if unread.isEmpty {
                emptyState
            } else {
                entryList
            }

            if !unread.isEmpty {
                Divider()
                footer
            }
        }
        .task {
            await service.refreshUnread()
        }
    }

    // MARK: - Sections

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "tray.full")
                .foregroundStyle(.secondary)
            Text("Inbox")
                .font(.headline)
            if service.isStreaming {
                Circle()
                    .fill(Color.green)
                    .frame(width: 6, height: 6)
                    .help("Live")
            } else {
                Circle()
                    .fill(Color.secondary.opacity(0.4))
                    .frame(width: 6, height: 6)
                    .help("Not subscribed")
            }
            Spacer()
            Text("\(unread.count)")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            Spacer()
            Image(systemName: "checkmark.circle")
                .font(.title2)
                .foregroundStyle(.secondary)
            Text("All caught up")
                .font(.callout)
                .foregroundStyle(.secondary)
            if let err = service.lastError {
                Text(err)
                    .font(.caption2)
                    .foregroundStyle(.red)
                    .padding(.top, 4)
            }
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var entryList: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                ForEach(unread) { entry in
                    InboxRow(entry: entry) {
                        Task { await service.ack(entry) }
                    }
                    Divider().padding(.leading, 12)
                }
            }
        }
    }

    private var footer: some View {
        HStack {
            Button("Refresh") {
                Task { await service.refreshUnread() }
            }
            Spacer()
            Button("Clear all") {
                Task { await service.ackAllVisible() }
            }
            .keyboardShortcut(.delete, modifiers: [.command])
        }
        .buttonStyle(.borderless)
        .font(.caption)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
}

// MARK: - Row

private struct InboxRow: View {
    let entry: ReturnEntry
    let onAck: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            icon
            VStack(alignment: .leading, spacing: 3) {
                Text(entry.title)
                    .font(.callout).bold()
                    .lineLimit(2)
                if let summary = entry.summary, !summary.isEmpty {
                    Text(summary)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }
                HStack(spacing: 6) {
                    Text(relativeTime)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    if !entry.tags.isEmpty {
                        Text("·")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                        Text(entry.tags.prefix(3).joined(separator: " · "))
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                }
            }
            Spacer()
            Button(action: onAck) {
                Image(systemName: "checkmark.circle")
                    .font(.body)
            }
            .buttonStyle(.borderless)
            .help("Mark as read")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }

    private var icon: some View {
        Image(systemName: iconName)
            .foregroundStyle(.secondary)
            .frame(width: 18)
            .padding(.top, 2)
    }

    private var iconName: String {
        switch entry.kind {
        case let k where k.hasPrefix("twitter-digest"): return "bird"
        case "heartbeat": return "waveform.path.ecg"
        default: return "doc"
        }
    }

    private var relativeTime: String {
        guard let date = entry.createdAtDate else { return entry.createdAt }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}
