import Foundation
import SwiftData

// MARK: - Streaming Stats (token speed tracking)

struct StreamingStats: Sendable {
    var streamStartTime: Date?
    var firstTokenTime: Date?
    var streamEndTime: Date?
    var totalCharacters: Int = 0
    var deltaCount: Int = 0

    /// Time to first token (seconds)
    var ttft: TimeInterval? {
        guard let start = streamStartTime, let first = firstTokenTime else { return nil }
        return first.timeIntervalSince(start)
    }

    /// Total generation duration (seconds)
    var duration: TimeInterval? {
        guard let start = firstTokenTime,
              let end = streamEndTime ?? (totalCharacters > 0 ? .now : nil) else { return nil }
        return end.timeIntervalSince(start)
    }

    /// Estimated token count (~4 chars/token for English, rough heuristic)
    var estimatedTokens: Int {
        max(1, totalCharacters / 4)
    }

    /// Tokens per second (estimated)
    var tokensPerSecond: Double? {
        guard let dur = duration, dur > 0.1 else { return nil }
        return Double(estimatedTokens) / dur
    }

    /// Characters per second
    var charsPerSecond: Double? {
        guard let dur = duration, dur > 0.1 else { return nil }
        return Double(totalCharacters) / dur
    }

    /// Formatted speed string (e.g. "23.4 tok/s")
    var speedText: String? {
        guard let tps = tokensPerSecond else { return nil }
        return String(format: "%.1f tok/s", tps)
    }

    /// Formatted TTFT string (e.g. "TTFT 0.8s")
    var ttftText: String? {
        guard let t = ttft else { return nil }
        return String(format: "TTFT %.1fs", t)
    }

    /// Formatted duration string
    var durationText: String? {
        guard let d = duration else { return nil }
        if d < 60 {
            return String(format: "%.1fs", d)
        } else {
            return String(format: "%.0fm %.0fs", (d / 60).rounded(.down), d.truncatingRemainder(dividingBy: 60))
        }
    }
}

enum ThreadTaskMode: String, Codable, CaseIterable, Sendable, Identifiable {
    case auto
    case coding
    case docs
    case desktopLite

    var id: String { rawValue }

    var title: String {
        switch self {
        case .auto:
            return "Auto"
        case .coding:
            return "Code"
        case .docs:
            return "Docs"
        case .desktopLite:
            return "Desktop"
        }
    }

    var promptContext: String? {
        switch self {
        case .auto:
            return nil
        case .coding:
            return """
            Selected mode: coding
            Preferred behavior: prioritize repository inspection, code reading, file edits, and terminal work. Avoid desktop actions unless the user explicitly asks for them.
            """
        case .docs:
            return """
            Selected mode: docs
            Preferred behavior: prioritize reading, summarizing, comparing, and organizing documents. Prefer read-only tools unless the user asks for edits.
            """
        case .desktopLite:
            return """
            Selected mode: desktop-lite
            Preferred behavior: prioritize observing the current macOS UI, take one step at a time, and verify after each action. Avoid long multi-step desktop plans.
            """
        }
    }
}

// MARK: - Local Thread Model

struct ThreadState: Identifiable, Sendable {
    let id: String
    var title: String
    var taskMode: ThreadTaskMode
    var messages: [ChatMessage]
    var isStreaming: Bool
    var pendingApproval: HITLRequest?
    var lastTraceId: String?
    var error: String?
    let createdAt: Date
    var streamingStats: StreamingStats?
    var lastCompletedStats: StreamingStats?

    init(
        id: String = UUID().uuidString,
        title: String = "New Chat",
        taskMode: ThreadTaskMode = .auto,
        messages: [ChatMessage] = [],
        createdAt: Date = .now
    ) {
        self.id = id
        self.title = title
        self.taskMode = taskMode
        self.messages = messages
        self.isStreaming = false
        self.pendingApproval = nil
        self.lastTraceId = nil
        self.error = nil
        self.createdAt = createdAt
        self.streamingStats = nil
        self.lastCompletedStats = nil
    }
}

// MARK: - Chat Message (UI-facing)

struct ChatMessage: Identifiable, Sendable {
    let id: String
    let role: ChatRole
    var text: String
    var toolEvents: [ToolEvent]
    let timestamp: Date
    var isEdited: Bool
    /// Base64 data URIs of attached images (e.g. camera snapshots)
    var imageAttachments: [String]

    init(
        id: String = UUID().uuidString,
        role: ChatRole,
        text: String,
        toolEvents: [ToolEvent] = [],
        timestamp: Date = .now,
        isEdited: Bool = false,
        imageAttachments: [String] = []
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.toolEvents = toolEvents
        self.timestamp = timestamp
        self.isEdited = isEdited
        self.imageAttachments = imageAttachments
    }
}

enum ChatRole: String, Sendable {
    case user
    case assistant
    case system
    case tool
}

// MARK: - Tool Event (for inline display)

struct ToolEvent: Identifiable, Sendable {
    let id: String
    let toolName: String
    var status: ToolEventStatus
    var input: String?
    var output: String?
    var error: String?
    let timestamp: Date

    init(
        id: String = UUID().uuidString,
        toolName: String,
        status: ToolEventStatus = .running,
        input: String? = nil,
        timestamp: Date = .now
    ) {
        self.id = id
        self.toolName = toolName
        self.status = status
        self.input = input
        self.output = nil
        self.error = nil
        self.timestamp = timestamp
    }
}

enum ToolEventStatus: String, Sendable {
    case running
    case completed
    case failed
}

// MARK: - Convenience

extension ThreadState {
    /// Derive title from first user message
    mutating func deriveTitle() {
        guard title == "New Chat",
              let firstUserMsg = messages.first(where: { $0.role == .user }) else {
            return
        }
        let preview = firstUserMsg.text.prefix(40)
        title = preview.count < firstUserMsg.text.count
            ? "\(preview)..."
            : String(preview)
    }
}

// MARK: - SwiftData Conversion

extension ThreadState {
    /// Initialize from a persisted SwiftData model
    init(from persisted: PersistedThread) {
        self.id = persisted.id
        self.title = persisted.title
        self.taskMode = ThreadTaskMode(rawValue: persisted.taskModeRaw) ?? .auto
        self.createdAt = persisted.createdAt

        let sortedMessages = persisted.messages.sorted { $0.sortOrder < $1.sortOrder }
        self.messages = sortedMessages.map { ChatMessage(from: $0) }

        // Transient fields reset to defaults
        self.isStreaming = false
        self.pendingApproval = nil
        self.lastTraceId = persisted.lastTraceId
        self.error = nil
    }

    /// Save (upsert) to SwiftData context
    func save(to context: ModelContext) {
        let threadId = self.id

        // Fetch existing or create new
        var descriptor = FetchDescriptor<PersistedThread>(
            predicate: #Predicate { $0.id == threadId }
        )
        descriptor.fetchLimit = 1

        let persisted: PersistedThread
        if let existing = try? context.fetch(descriptor).first {
            persisted = existing
        } else {
            persisted = PersistedThread(id: id, title: title, createdAt: createdAt)
            context.insert(persisted)
        }

        // Update fields
        persisted.title = title
        persisted.taskModeRaw = taskMode.rawValue
        persisted.updatedAt = .now
        persisted.lastTraceId = lastTraceId
        persisted.errorMessage = error

        // Sync messages: O(n) via dictionary lookup instead of O(n²) first(where:)
        let existingMap = Dictionary(uniqueKeysWithValues: persisted.messages.map { ($0.id, $0) })
        let currentMessageIds = Set(messages.map(\.id))

        // Delete removed messages
        for msg in persisted.messages where !currentMessageIds.contains(msg.id) {
            context.delete(msg)
        }

        // Upsert messages
        for (index, chatMsg) in messages.enumerated() {
            if let existing = existingMap[chatMsg.id] {
                // Update existing — O(1) lookup
                existing.text = chatMsg.text
                existing.sortOrder = index
                chatMsg.syncToolEvents(to: existing, context: context)
            } else {
                // Insert new
                let newMsg = PersistedMessage(
                    id: chatMsg.id,
                    role: chatMsg.role.rawValue,
                    text: chatMsg.text,
                    timestamp: chatMsg.timestamp,
                    sortOrder: index
                )
                newMsg.thread = persisted
                context.insert(newMsg)
                chatMsg.syncToolEvents(to: newMsg, context: context)
            }
        }

        try? context.save()
    }

    /// Delete from SwiftData context
    static func delete(id: String, from context: ModelContext) {
        var descriptor = FetchDescriptor<PersistedThread>(
            predicate: #Predicate { $0.id == id }
        )
        descriptor.fetchLimit = 1

        if let existing = try? context.fetch(descriptor).first {
            context.delete(existing) // cascade deletes messages + tool events
            try? context.save()
        }
    }
}

extension ChatMessage {
    /// Initialize from a persisted SwiftData model
    init(from persisted: PersistedMessage) {
        self.id = persisted.id
        self.role = ChatRole(rawValue: persisted.role) ?? .assistant
        self.text = persisted.text
        self.timestamp = persisted.timestamp

        let sortedEvents = persisted.toolEvents.sorted { $0.sortOrder < $1.sortOrder }
        self.toolEvents = sortedEvents.map { ToolEvent(from: $0) }
        self.isEdited = false
        self.imageAttachments = []  // Images are transient, not persisted
    }

    /// Sync tool events to a persisted message
    func syncToolEvents(to persisted: PersistedMessage, context: ModelContext) {
        let existingIds = Set(persisted.toolEvents.map(\.id))
        let currentIds = Set(toolEvents.map(\.id))

        // Delete removed
        for event in persisted.toolEvents where !currentIds.contains(event.id) {
            context.delete(event)
        }

        // Upsert
        for (index, toolEvent) in toolEvents.enumerated() {
            if existingIds.contains(toolEvent.id) {
                if let existing = persisted.toolEvents.first(where: { $0.id == toolEvent.id }) {
                    existing.statusRaw = toolEvent.status.rawValue
                    existing.output = toolEvent.output
                    existing.error = toolEvent.error
                    existing.sortOrder = index
                }
            } else {
                let newEvent = PersistedToolEvent(
                    id: toolEvent.id,
                    toolName: toolEvent.toolName,
                    statusRaw: toolEvent.status.rawValue,
                    input: toolEvent.input,
                    output: toolEvent.output,
                    error: toolEvent.error,
                    timestamp: toolEvent.timestamp,
                    sortOrder: index
                )
                newEvent.message = persisted
                context.insert(newEvent)
            }
        }
    }
}

extension ToolEvent {
    /// Initialize from a persisted SwiftData model
    init(from persisted: PersistedToolEvent) {
        self.id = persisted.id
        self.toolName = persisted.toolName
        self.status = ToolEventStatus(rawValue: persisted.statusRaw) ?? .running
        self.input = persisted.input
        self.output = persisted.output
        self.error = persisted.error
        self.timestamp = persisted.timestamp
    }
}
