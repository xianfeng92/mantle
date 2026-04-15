import Foundation
import SwiftData

// MARK: - Persisted Thread

@Model
final class PersistedThread {
    @Attribute(.unique) var id: String
    var title: String
    var taskModeRaw: String
    var createdAt: Date
    var updatedAt: Date
    var lastTraceId: String?
    var errorMessage: String?

    @Relationship(deleteRule: .cascade, inverse: \PersistedMessage.thread)
    var messages: [PersistedMessage]

    init(
        id: String = UUID().uuidString,
        title: String = "New Chat",
        taskModeRaw: String = "auto",
        createdAt: Date = .now,
        updatedAt: Date = .now
    ) {
        self.id = id
        self.title = title
        self.taskModeRaw = taskModeRaw
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.lastTraceId = nil
        self.errorMessage = nil
        self.messages = []
    }
}

// MARK: - Persisted Message

@Model
final class PersistedMessage {
    @Attribute(.unique) var id: String
    var role: String          // "user" | "assistant" | "system" | "tool"
    var text: String
    var timestamp: Date
    var sortOrder: Int

    var thread: PersistedThread?

    @Relationship(deleteRule: .cascade, inverse: \PersistedToolEvent.message)
    var toolEvents: [PersistedToolEvent]

    init(
        id: String = UUID().uuidString,
        role: String,
        text: String,
        timestamp: Date = .now,
        sortOrder: Int = 0
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.timestamp = timestamp
        self.sortOrder = sortOrder
        self.toolEvents = []
    }
}

// MARK: - Twitter Bookmark
//
// Ambient 阅读系统：Chrome 扩展捕获的推文 bookmark。
// 一条 bookmark 的生命周期：
//   1. ingest：Chrome 扩展 POST 进来，存基础字段（author/text/url/...）
//   2. digest：TwitterBookmarkDaemon 批量调 agent-core，回写 summary/qualityScore/tags
//   3. weekly：周报生成时被归到某个 cluster（weeklyCluster 字段）

@Model
final class TwitterBookmark {
    /// 内部 UUID，避免用 tweetId 作为主键（便于未来多源扩展）
    @Attribute(.unique) var id: String
    /// X/Twitter 推文 ID，跨端唯一；用于去重
    @Attribute(.unique) var tweetId: String
    var url: String
    var authorHandle: String
    var text: String
    var quotedText: String?
    /// 媒体 URL 列表（JSON 编码为 String，SwiftData 不直接支持 [String]）
    var mediaUrlsJSON: String
    var capturedAt: Date

    // MARK: Digest 字段（AI 处理后回写）
    var summary: String?
    var qualityScore: Int?        // 1-10
    /// 1-3 个 tag，JSON 编码
    var tagsJSON: String
    var digestedAt: Date?
    var weeklyCluster: String?

    init(
        id: String = UUID().uuidString,
        tweetId: String,
        url: String,
        authorHandle: String,
        text: String,
        quotedText: String? = nil,
        mediaUrls: [String] = [],
        capturedAt: Date = .now
    ) {
        self.id = id
        self.tweetId = tweetId
        self.url = url
        self.authorHandle = authorHandle
        self.text = text
        self.quotedText = quotedText
        self.mediaUrlsJSON = (try? JSONEncoder().encode(mediaUrls))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        self.capturedAt = capturedAt
        self.summary = nil
        self.qualityScore = nil
        self.tagsJSON = "[]"
        self.digestedAt = nil
        self.weeklyCluster = nil
    }

    // MARK: 便捷访问器

    var mediaUrls: [String] {
        get {
            guard let data = mediaUrlsJSON.data(using: .utf8),
                  let arr = try? JSONDecoder().decode([String].self, from: data)
            else { return [] }
            return arr
        }
        set {
            mediaUrlsJSON = (try? JSONEncoder().encode(newValue))
                .flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        }
    }

    var tags: [String] {
        get {
            guard let data = tagsJSON.data(using: .utf8),
                  let arr = try? JSONDecoder().decode([String].self, from: data)
            else { return [] }
            return arr
        }
        set {
            tagsJSON = (try? JSONEncoder().encode(newValue))
                .flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        }
    }

    var isDigested: Bool { digestedAt != nil }
}

// MARK: - Persisted Tool Event

@Model
final class PersistedToolEvent {
    @Attribute(.unique) var id: String
    var toolName: String
    var statusRaw: String     // "running" | "completed" | "failed"
    var input: String?        // JSON String
    var output: String?       // JSON String
    var error: String?
    var timestamp: Date
    var sortOrder: Int

    var message: PersistedMessage?

    init(
        id: String = UUID().uuidString,
        toolName: String,
        statusRaw: String = "running",
        input: String? = nil,
        output: String? = nil,
        error: String? = nil,
        timestamp: Date = .now,
        sortOrder: Int = 0
    ) {
        self.id = id
        self.toolName = toolName
        self.statusRaw = statusRaw
        self.input = input
        self.output = output
        self.error = error
        self.timestamp = timestamp
        self.sortOrder = sortOrder
    }
}
