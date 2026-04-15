import Foundation
import SwiftData
import os

// MARK: - TwitterBookmarkStore
//
// 封装 TwitterBookmark 的增删查。生产者：ComputerUseServer 的 /bookmarks/ingest 路由。
// 消费者：TwitterBookmarkDaemon（digest）、TwitterDigestListView（UI）。
//
// 幂等：tweetId 作为唯一键，重复 ingest 同一条推文不会产生新行。
// 线程：@MainActor，ModelContext 非线程安全。

@MainActor
final class TwitterBookmarkStore {

    private let modelContext: ModelContext

    init(modelContext: ModelContext) {
        self.modelContext = modelContext
    }

    // MARK: - Ingest

    struct IngestResult {
        let bookmark: TwitterBookmark
        /// true 表示这条 tweetId 已存在（仅更新 capturedAt），false 表示新增
        let deduped: Bool
    }

    /// 幂等插入。如果 tweetId 已存在，返回现有记录且 deduped=true。
    func insert(
        tweetId: String,
        url: String,
        authorHandle: String,
        text: String,
        quotedText: String? = nil,
        mediaUrls: [String] = [],
        capturedAt: Date = .now
    ) throws -> IngestResult {
        if let existing = try fetch(tweetId: tweetId) {
            // 已存在；不覆盖 AI 字段，仅在旧 capturedAt 更晚时刷新（避免时间倒流）
            if existing.capturedAt < capturedAt {
                existing.capturedAt = capturedAt
            }
            return IngestResult(bookmark: existing, deduped: true)
        }

        let bookmark = TwitterBookmark(
            tweetId: tweetId,
            url: url,
            authorHandle: authorHandle,
            text: text,
            quotedText: quotedText,
            mediaUrls: mediaUrls,
            capturedAt: capturedAt
        )
        modelContext.insert(bookmark)
        try modelContext.save()
        MantleLog.app.info("[TwitterBookmark] inserted tweetId=\(tweetId, privacy: .public) author=\(authorHandle, privacy: .public)")
        return IngestResult(bookmark: bookmark, deduped: false)
    }

    // MARK: - Fetch

    /// 按 tweetId 查单条。
    func fetch(tweetId: String) throws -> TwitterBookmark? {
        var descriptor = FetchDescriptor<TwitterBookmark>(
            predicate: #Predicate { $0.tweetId == tweetId }
        )
        descriptor.fetchLimit = 1
        return try modelContext.fetch(descriptor).first
    }

    /// 拉未经 AI 处理的 bookmarks（digestedAt == nil），用于 Daemon 批量消化。
    func fetchUndigested(limit: Int = 15) throws -> [TwitterBookmark] {
        var descriptor = FetchDescriptor<TwitterBookmark>(
            predicate: #Predicate { $0.digestedAt == nil },
            sortBy: [SortDescriptor(\.capturedAt, order: .forward)]
        )
        descriptor.fetchLimit = limit
        return try modelContext.fetch(descriptor)
    }

    /// 取某一天 capturedAt 范围内的所有 bookmarks，供 daily digest 生成用。
    func fetchForDay(_ date: Date, calendar: Calendar = .current) throws -> [TwitterBookmark] {
        let startOfDay = calendar.startOfDay(for: date)
        guard let endOfDay = calendar.date(byAdding: .day, value: 1, to: startOfDay) else {
            return []
        }
        let descriptor = FetchDescriptor<TwitterBookmark>(
            predicate: #Predicate {
                $0.capturedAt >= startOfDay && $0.capturedAt < endOfDay
            },
            sortBy: [SortDescriptor(\.capturedAt, order: .forward)]
        )
        return try modelContext.fetch(descriptor)
    }

    /// 取某一周 capturedAt 范围内的所有 bookmarks，供 weekly cluster 用。
    /// 周定义：包含 date 所在日的周一 00:00 到下周一 00:00。
    func fetchForWeek(containing date: Date, calendar: Calendar = .current) throws -> [TwitterBookmark] {
        var cal = calendar
        cal.firstWeekday = 2 // Monday
        guard let weekInterval = cal.dateInterval(of: .weekOfYear, for: date) else {
            return []
        }
        let start = weekInterval.start
        let end = weekInterval.end
        let descriptor = FetchDescriptor<TwitterBookmark>(
            predicate: #Predicate {
                $0.capturedAt >= start && $0.capturedAt < end
            },
            sortBy: [SortDescriptor(\.capturedAt, order: .forward)]
        )
        return try modelContext.fetch(descriptor)
    }

    /// 统计总数，供 /bookmarks/status 路由返回。
    func totalCount() throws -> Int {
        let descriptor = FetchDescriptor<TwitterBookmark>()
        return try modelContext.fetchCount(descriptor)
    }

    /// 统计未经 AI 处理的数量。
    func undigestedCount() throws -> Int {
        let descriptor = FetchDescriptor<TwitterBookmark>(
            predicate: #Predicate { $0.digestedAt == nil }
        )
        return try modelContext.fetchCount(descriptor)
    }

    // MARK: - Update (AI 回写)

    /// Daemon 在 agent-core 返回 digest 后调用，把 summary/score/tags 写回。
    func applyDigest(
        to bookmark: TwitterBookmark,
        summary: String,
        qualityScore: Int,
        tags: [String],
        digestedAt: Date = .now
    ) throws {
        bookmark.summary = summary
        bookmark.qualityScore = max(1, min(10, qualityScore))
        bookmark.tags = tags
        bookmark.digestedAt = digestedAt
        try modelContext.save()
    }

    /// Weekly 聚类结果回写。
    func applyWeeklyCluster(
        to bookmark: TwitterBookmark,
        cluster: String
    ) throws {
        bookmark.weeklyCluster = cluster
        try modelContext.save()
    }
}
