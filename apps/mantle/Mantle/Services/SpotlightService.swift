import CoreSpotlight
import UniformTypeIdentifiers
import os

// MARK: - Spotlight Service
//
// Indexes Mantle chat threads into Spotlight so users can
// search their conversation history from anywhere in macOS.
//
// Clicking a Spotlight result opens the thread via mantle://thread/{id}.

@MainActor
final class SpotlightService {

    static let shared = SpotlightService()
    private let index = CSSearchableIndex.default()
    private static let domainId = "com.mantle.threads"

    private init() {}

    // MARK: - Index a Thread

    func indexThread(_ thread: PersistedThread) {
        let attributes = CSSearchableItemAttributeSet(contentType: .text)
        attributes.title = thread.title
        attributes.contentDescription = buildDescription(for: thread)
        attributes.lastUsedDate = thread.updatedAt
        attributes.keywords = extractKeywords(from: thread)
        attributes.relatedUniqueIdentifier = thread.id

        let item = CSSearchableItem(
            uniqueIdentifier: threadIdentifier(thread.id),
            domainIdentifier: Self.domainId,
            attributeSet: attributes
        )
        // Keep items searchable for 90 days after last update
        item.expirationDate = thread.updatedAt.addingTimeInterval(90 * 24 * 3600)

        index.indexSearchableItems([item]) { error in
            if let error {
                MantleLog.app.warning("Spotlight index failed for thread \(thread.id): \(error)")
            }
        }
    }

    // MARK: - Remove a Thread

    func removeThread(id: String) {
        index.deleteSearchableItems(withIdentifiers: [threadIdentifier(id)]) { error in
            if let error {
                MantleLog.app.warning("Spotlight remove failed for thread \(id): \(error)")
            }
        }
    }

    // MARK: - Remove All

    func removeAll() {
        index.deleteSearchableItems(withDomainIdentifiers: [Self.domainId]) { error in
            if let error {
                MantleLog.app.warning("Spotlight removeAll failed: \(error)")
            }
        }
    }

    // MARK: - Batch Index

    func indexThreads(_ threads: [PersistedThread]) {
        let items = threads.map { thread -> CSSearchableItem in
            let attributes = CSSearchableItemAttributeSet(contentType: .text)
            attributes.title = thread.title
            attributes.contentDescription = buildDescription(for: thread)
            attributes.lastUsedDate = thread.updatedAt
            attributes.keywords = extractKeywords(from: thread)

            let item = CSSearchableItem(
                uniqueIdentifier: threadIdentifier(thread.id),
                domainIdentifier: Self.domainId,
                attributeSet: attributes
            )
            item.expirationDate = thread.updatedAt.addingTimeInterval(90 * 24 * 3600)
            return item
        }

        index.indexSearchableItems(items) { error in
            if let error {
                MantleLog.app.warning("Spotlight batch index failed: \(error)")
            } else {
                MantleLog.app.info("Spotlight indexed \(items.count) threads")
            }
        }
    }

    // MARK: - Helpers

    private func threadIdentifier(_ id: String) -> String {
        "mantle-thread-\(id)"
    }

    /// Extract thread ID from a Spotlight unique identifier.
    static func threadId(from spotlightIdentifier: String) -> String? {
        guard spotlightIdentifier.hasPrefix("mantle-thread-") else { return nil }
        return String(spotlightIdentifier.dropFirst("mantle-thread-".count))
    }

    private func buildDescription(for thread: PersistedThread) -> String {
        // Use the last few message previews as the description
        let messages = thread.messages
            .sorted { $0.sortOrder < $1.sortOrder }
            .suffix(3)
            .map { msg in
                let prefix = msg.role == "user" ? "Q" : "A"
                let preview = String(msg.text.prefix(100))
                return "\(prefix): \(preview)"
            }
        return messages.joined(separator: "\n")
    }

    private func extractKeywords(from thread: PersistedThread) -> [String] {
        // Extract keywords from title + recent messages
        var words = Set<String>()

        // Title words
        for word in thread.title.split(separator: " ") {
            let w = String(word).lowercased().trimmingCharacters(in: .punctuationCharacters)
            if w.count >= 3 { words.insert(w) }
        }

        // Message content keywords (last 5 messages)
        let recentMessages = thread.messages
            .sorted { $0.sortOrder < $1.sortOrder }
            .suffix(5)

        for message in recentMessages {
            for word in message.text.prefix(500).split(separator: " ") {
                let w = String(word).lowercased().trimmingCharacters(in: .punctuationCharacters)
                if w.count >= 3 && words.count < 30 { words.insert(w) }
            }
        }

        return Array(words)
    }
}
