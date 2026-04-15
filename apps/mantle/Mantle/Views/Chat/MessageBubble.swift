import SwiftUI
import AppKit

// MARK: - Message Bubble

struct MessageBubble: View {
    let message: ChatMessage
    var isStreaming: Bool = false
    var onEdit: ((String, String) -> Void)?        // (messageId, newText)
    var onRegenerate: ((String) -> Void)?           // messageId — only for last assistant msg
    var onDelete: ((String) -> Void)?               // messageId
    var onCopy: (() -> Void)?                       // notify parent to show toast
    var highlightText: String?                      // search keyword to highlight

    @State private var isEditing = false
    @State private var editText = ""
    @State private var showDeleteAlert = false

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            // Avatar
            avatar

            // Content
            VStack(alignment: .leading, spacing: 6) {
                // Role label + edited + timestamp + action buttons
                HStack(spacing: 4) {
                    Text(roleLabel)
                        .font(.caption)
                        .fontWeight(.semibold)
                        .foregroundStyle(roleColor)

                    if message.isEdited {
                        Text("(edited)")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }

                    Spacer()

                    // Edit button for user messages
                    if message.role == .user && onEdit != nil && !isStreaming {
                        Button {
                            editText = message.text
                            isEditing = true
                        } label: {
                            Image(systemName: "pencil")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                        .buttonStyle(.borderless)
                        .help("Edit and resend")
                    }

                    // Regenerate button for last assistant message
                    if message.role == .assistant && onRegenerate != nil && !isStreaming {
                        Button {
                            onRegenerate?(message.id)
                        } label: {
                            Image(systemName: "arrow.counterclockwise")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                        .buttonStyle(.borderless)
                        .help("Regenerate response")
                    }

                    Text(message.timestamp, format: .dateTime.hour().minute())
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }

                // Message text
                if isEditing {
                    editView
                } else if !message.text.isEmpty {
                    if message.role == .assistant {
                        MarkdownContentView(text: message.text, isStreaming: isStreaming)
                            .fixedSize(horizontal: false, vertical: true)
                    } else if let highlight = highlightText, !highlight.isEmpty {
                        highlightedText(message.text, keyword: highlight)
                            .font(.body)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    } else {
                        Text(message.text)
                            .font(.body)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                // Image attachments (camera snapshots)
                if !message.imageAttachments.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(Array(message.imageAttachments.enumerated()), id: \.offset) { _, dataUri in
                                if let nsImage = ChatInputBar.imageFromDataURI(dataUri) {
                                    Image(nsImage: nsImage)
                                        .resizable()
                                        .aspectRatio(contentMode: .fit)
                                        .frame(maxHeight: 120)
                                        .clipShape(RoundedRectangle(cornerRadius: 6))
                                }
                            }
                        }
                    }
                }

                if !message.toolEvents.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 8) {
                            Text("Action Ledger")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(Design.textPrimary)

                            LedgerStatusChip(
                                title: "\(message.toolEvents.count) step\(message.toolEvents.count == 1 ? "" : "s")",
                                tone: .info,
                                systemImage: "list.bullet.rectangle"
                            )
                        }

                        Text("Executed tool steps stay visible here so approvals, results, and rollback-relevant details are easy to scan.")
                            .font(.caption)
                            .foregroundStyle(Design.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)

                        ForEach(message.toolEvents) { event in
                            ToolEventCard(event: event)
                        }
                    }
                    .padding(.top, 4)
                }
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, Design.messagePadding)
        .padding(.vertical, Design.messagePadding)
        .background(backgroundColor, in: RoundedRectangle(cornerRadius: Design.cornerRadius))
        .contextMenu { contextMenuContent }
        .alert("Delete Message", isPresented: $showDeleteAlert) {
            Button("Cancel", role: .cancel) {}
            Button("Delete", role: .destructive) {
                onDelete?(message.id)
            }
        } message: {
            Text("This will delete this message and all messages after it. This cannot be undone.")
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(roleLabel): \(message.text.prefix(200))")
        .accessibilityHint(isStreaming ? "Still generating" : (message.role == .user ? "Double tap pencil to edit" : ""))
    }

    // MARK: - Context Menu

    @ViewBuilder
    private var contextMenuContent: some View {
        // Copy text — always available
        Button {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(message.text, forType: .string)
            onCopy?()
        } label: {
            Label("Copy Text", systemImage: "doc.on.doc")
        }

        // Edit & Resend — user messages only
        if message.role == .user && onEdit != nil && !isStreaming {
            Button {
                editText = message.text
                isEditing = true
            } label: {
                Label("Edit & Resend", systemImage: "pencil")
            }
        }

        // Regenerate — last assistant message only
        if message.role == .assistant && onRegenerate != nil && !isStreaming {
            Button {
                onRegenerate?(message.id)
            } label: {
                Label("Regenerate", systemImage: "arrow.counterclockwise")
            }
        }

        Divider()

        // Delete — with confirmation alert
        if onDelete != nil && !isStreaming {
            Button(role: .destructive) {
                showDeleteAlert = true
            } label: {
                Label("Delete Message", systemImage: "trash")
            }
        }
    }

    // MARK: - Highlighted Text

    private func highlightedText(_ text: String, keyword: String) -> Text {
        var result = Text("")
        var searchStart = text.startIndex

        while let range = text.range(of: keyword, options: .caseInsensitive, range: searchStart..<text.endIndex) {
            let before = text[searchStart..<range.lowerBound]
            if !before.isEmpty {
                result = result + Text(before)
            }
            let match = text[range]
            result = result + Text(match)
                .bold()
                .foregroundColor(Design.accent)
                .underline()
            searchStart = range.upperBound
        }
        let remaining = text[searchStart...]
        if !remaining.isEmpty {
            result = result + Text(remaining)
        }
        return result
    }

    // MARK: - Edit View

    private var editView: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextField("Edit message…", text: $editText, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...10)
                .padding(8)
                .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: Design.cornerRadius))

            HStack(spacing: 8) {
                Button("Cancel") {
                    isEditing = false
                }
                .controlSize(.small)
                .keyboardShortcut(.escape, modifiers: [])

                Button("Resend") {
                    let trimmed = editText.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !trimmed.isEmpty else { return }
                    isEditing = false
                    onEdit?(message.id, trimmed)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(editText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .keyboardShortcut(.return, modifiers: .command)
            }
        }
    }

    // MARK: - Avatar

    private var avatar: some View {
        ZStack {
            Circle()
                .fill(message.role == .assistant ? Design.accent.opacity(0.08) : Color.gray.opacity(0.12))
                .frame(width: Design.avatarSize, height: Design.avatarSize)

            Image(systemName: roleIcon)
                .font(.system(size: 13))
                .foregroundStyle(roleColor)
        }
    }

    // MARK: - Style Helpers

    private var roleLabel: String {
        switch message.role {
        case .user: "You"
        case .assistant: "Mantle"
        case .system: "System"
        case .tool: "Tool"
        }
    }

    private var roleIcon: String {
        switch message.role {
        case .user: "person.fill"
        case .assistant: "brain.head.profile"
        case .system: "gearshape"
        case .tool: "wrench"
        }
    }

    private var roleColor: Color {
        switch message.role {
        case .user: .primary
        case .assistant: Design.accent
        case .system: .secondary
        case .tool: .secondary
        }
    }

    private var backgroundColor: Color {
        switch message.role {
        case .user: Design.surfaceLight.opacity(0.5)
        case .assistant: .clear
        case .system: .clear
        case .tool: Design.surfaceLight.opacity(0.3)
        }
    }
}
