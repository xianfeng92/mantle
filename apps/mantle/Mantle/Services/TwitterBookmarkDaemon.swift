import Foundation
import os

// MARK: - TwitterBookmarkDaemon
//
// Ambient 阅读系统的调度层。每 15 分钟（可配）轮询未处理的 bookmark，
// 打包调 agent-core 的 /twitter/digest (mode=summarize)，把 summary/qualityScore/tags 回写 DB。
//
// 独立于 ContextDaemon（后者是环境感知，这里是数据处理）。
//
// 职责：
//   1. processPending(): 批量消化 → 给 Stage B 用
//   2. generateDailyDigest(date:): 挑今日 topPicks → 给 Stage C 用
//   3. generateWeeklyReport(week:): 主题聚类 → 给 Stage D 用
//
// 当前只实现 1；2/3 作为接口桩，等到对应 Stage 再填实体逻辑。

@MainActor
final class TwitterBookmarkDaemon {

    // MARK: Dependencies

    private let store: TwitterBookmarkStore
    private let client: AgentCoreClient

    /// 查询当前是否"安静时刻"（不在 Focus Mode 且 idle 足够久）。
    /// 由 AppViewModel 注入，避免 Daemon 直接依赖 ContextDaemon。
    /// nil 表示不做 Focus Mode gating（老逻辑）。
    var quietTimeProvider: (@MainActor () -> Bool)?

    // MARK: Config

    /// 轮询间隔（秒）。默认 15 分钟。
    private let tickInterval: TimeInterval

    /// 单批最大处理条数。从 15 降到 8：gemma + LM Studio 输出截断风险随 batch
    /// 增大显著上升（一次输出 4-5KB JSON 已是极限）。8 条留足安全 margin。
    /// 同时配合 agent-core ChatOpenAI maxTokens=4096。
    private let batchSize: Int = 8

    /// Focus Mode gating 时，每隔多久重试一次 quiet time。
    private let focusGateRetryInterval: TimeInterval = 60

    /// Focus Mode gating 最长等待时间，超过就算了（避免用户连续多日 Focus 导致无限推迟）。
    private let focusGateMaxWait: TimeInterval = 6 * 3600 // 6 小时

    // MARK: Runtime

    private var tickTask: Task<Void, Never>?
    /// 防止单次 processPending 并发多开。
    private var processing: Bool = false

    // MARK: Init

    init(
        store: TwitterBookmarkStore,
        client: AgentCoreClient,
        tickInterval: TimeInterval = 15 * 60
    ) {
        self.store = store
        self.client = client
        self.tickInterval = tickInterval
    }

    // MARK: - Lifecycle

    /// 启动周期性消化循环。幂等：重复调用会 cancel 旧 task。
    func start() {
        stop()
        MantleLog.app.info("[TwitterDaemon] started, tickInterval=\(Int(self.tickInterval))s")
        tickTask = Task { [weak self] in
            while let self, !Task.isCancelled {
                await self.tickSafely()
                try? await Task.sleep(nanoseconds: UInt64(self.tickInterval * 1_000_000_000))
            }
        }
    }

    func stop() {
        tickTask?.cancel()
        tickTask = nil
    }

    /// 立即触发一次 processPending，用于调试 / 首次启动预热。
    func triggerNow() {
        Task { [weak self] in
            await self?.tickSafely()
        }
    }

    // MARK: - Tick

    private func tickSafely() async {
        do {
            try await processPending()
        } catch {
            MantleLog.app.error("[TwitterDaemon] tick error: \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: - processPending

    /// 消化一批 undigested bookmarks。无数据直接 return。
    func processPending() async throws {
        guard !processing else {
            MantleLog.app.info("[TwitterDaemon] skip tick (already processing)")
            return
        }
        processing = true
        defer { processing = false }

        let batch = try store.fetchUndigested(limit: batchSize)
        guard !batch.isEmpty else {
            MantleLog.app.debug("[TwitterDaemon] nothing to digest")
            return
        }
        MantleLog.app.info("[TwitterDaemon] processing \(batch.count) bookmarks")

        let request = SummarizeRequest(
            mode: "summarize",
            bookmarks: batch.map { bm in
                SummarizeInputBookmark(
                    id: bm.tweetId,
                    author: bm.authorHandle,
                    text: bm.text,
                    quotedText: bm.quotedText
                )
            }
        )

        let response: SummarizeResponse = try await client.postJSON(
            path: "twitter/digest",
            body: request,
            timeout: 240
        )

        // 用 tweetId 索引 batch，O(1) 查找
        let byTweetId = Dictionary(uniqueKeysWithValues: batch.map { ($0.tweetId, $0) })
        var applied = 0
        for item in response.items {
            guard let bm = byTweetId[item.id] else {
                MantleLog.app.warning("[TwitterDaemon] digest returned unknown id=\(item.id, privacy: .public)")
                continue
            }
            try store.applyDigest(
                to: bm,
                summary: item.summary,
                qualityScore: item.qualityScore,
                tags: item.tags
            )
            applied += 1
        }
        MantleLog.app.info("[TwitterDaemon] digest applied to \(applied)/\(batch.count)")
    }

    // MARK: - Daily digest（Stage C 核心）

    /// 生成当日精选并推送系统通知。由 DailyDigestScheduler 每晚 22:00 调用，
    /// 也可以通过 `mantle://twitter/digest-daily-now` 手动触发。
    ///
    /// 完整流程：
    ///   1. 如果 quietTimeProvider 返回 false（Focus Mode / 用户活跃中）→ 延后轮询，最多等 6 小时
    ///   2. 取当日所有已 digested 的 bookmarks
    ///   3. <1 条直接返回（没什么好推的）；只有 1-2 条也直接推，不调 agent-core 省时间
    ///   4. 调 agent-core /twitter/digest mode=daily 挑 topPicks
    ///   5. 推送系统通知（点击走 deep link 回跳 Bookmarks 窗口）
    @discardableResult
    func generateDailyDigest(date: Date = .now) async throws -> DailyPicks? {
        try await waitForQuietTime()

        let allOfDay = try store.fetchForDay(date).filter { $0.isDigested }
        MantleLog.app.info("[TwitterDaemon] daily digest: \(allOfDay.count) digested bookmarks today")

        guard !allOfDay.isEmpty else {
            MantleLog.app.info("[TwitterDaemon] daily: nothing to push")
            return nil
        }

        // 少量推文直接按 score 排序前 N 条，跳过 agent-core 调用
        let picks: DailyPicks
        if allOfDay.count <= 3 {
            let sorted = allOfDay.sorted { ($0.qualityScore ?? 0) > ($1.qualityScore ?? 0) }
            picks = DailyPicks(
                topPickTweetIds: sorted.map { $0.tweetId },
                rationale: "今天 mark 的条数较少，全部呈现。"
            )
        } else {
            let request = DailyRequest(
                mode: "daily",
                bookmarks: allOfDay.map { bm in
                    DigestedBookmarkWire(
                        id: bm.tweetId,
                        author: bm.authorHandle,
                        summary: bm.summary ?? "",
                        qualityScore: bm.qualityScore ?? 5,
                        tags: bm.tags
                    )
                }
            )
            let response: DailyResponse = try await client.postJSON(
                path: "twitter/digest",
                body: request,
                timeout: 120
            )
            picks = DailyPicks(topPickTweetIds: response.topPicks, rationale: response.rationale)
        }

        // 把 picks 映射回 TwitterBookmark 生成通知
        let byId = Dictionary(uniqueKeysWithValues: allOfDay.map { ($0.tweetId, $0) })
        let pickedBookmarks: [TwitterBookmark] = picks.topPickTweetIds.compactMap { byId[$0] }

        let items = pickedBookmarks.map { bm in
            NotificationManager.DigestNotificationItem(
                authorHandle: bm.authorHandle,
                headline: firstSentence(bm.summary ?? bm.text)
            )
        }
        NotificationManager.shared.notifyDigestReady(
            date: date,
            items: items,
            rationale: picks.rationale
        )
        MantleLog.app.info("[TwitterDaemon] daily digest notification sent, picks=\(pickedBookmarks.count)")
        return picks
    }

    // MARK: - Focus Mode gating

    private func waitForQuietTime() async throws {
        guard let probe = quietTimeProvider else {
            return // 未注入 provider：不做 gating
        }
        if probe() { return }

        MantleLog.app.info("[TwitterDaemon] Focus/活跃中，启动 quiet-time 轮询")
        let deadline = Date.now.addingTimeInterval(focusGateMaxWait)
        while !Task.isCancelled {
            if Date.now >= deadline {
                MantleLog.app.warning("[TwitterDaemon] quiet-time 等待超时（>6h），强制触发")
                return
            }
            try await Task.sleep(nanoseconds: UInt64(focusGateRetryInterval * 1_000_000_000))
            if probe() {
                MantleLog.app.info("[TwitterDaemon] 进入 quiet time，继续 daily digest")
                return
            }
        }
    }

    /// 取 summary / text 的首句（遇 "。" "." "\n" 截断），限制 40 字。
    private func firstSentence(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let terminators: [Character] = ["。", ".", "\n", "！", "!", "？", "?"]
        if let idx = trimmed.firstIndex(where: { terminators.contains($0) }) {
            return String(trimmed[..<idx])
        }
        if trimmed.count > 40 {
            let end = trimmed.index(trimmed.startIndex, offsetBy: 40)
            return String(trimmed[..<end]) + "…"
        }
        return trimmed
    }
}

// MARK: - Wire types

extension TwitterBookmarkDaemon {

    // Input (summarize mode)
    struct SummarizeInputBookmark: Encodable {
        let id: String
        let author: String
        let text: String
        let quotedText: String?
    }

    struct SummarizeRequest: Encodable {
        let mode: String
        let bookmarks: [SummarizeInputBookmark]
    }

    // Input (daily/weekly mode)
    struct DigestedBookmarkWire: Encodable {
        let id: String
        let author: String
        let summary: String
        let qualityScore: Int
        let tags: [String]
    }

    struct DailyRequest: Encodable {
        let mode: String
        let bookmarks: [DigestedBookmarkWire]
    }

    // Output (summarize mode)
    struct SummarizeItem: Decodable {
        let id: String
        let summary: String
        let qualityScore: Int
        let tags: [String]
    }

    struct SummarizeResponse: Decodable {
        let items: [SummarizeItem]
    }

    // Output (daily mode)
    struct DailyResponse: Decodable {
        let topPicks: [String]
        let rationale: String
    }

    /// 对 UI/NotificationManager 暴露的结构体。
    struct DailyPicks {
        let topPickTweetIds: [String]
        let rationale: String
    }
}
