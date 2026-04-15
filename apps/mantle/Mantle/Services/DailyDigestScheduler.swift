import Foundation
import os

// MARK: - DailyDigestScheduler
//
// 每晚到达 fireHour:fireMinute（默认 22:00）时触发一次 action（通常是 Daemon.generateDailyDigest）。
// 用 app 内 Task loop 而非 UNCalendarNotificationTrigger —— 后者只能调度"显示固定通知"，
// 不能"到点跑代码生成通知"。
//
// Focus Mode 感知：由调用方在 action 里自己处理（scheduler 只负责按时叫起），这样逻辑集中在 Daemon。
//
// 设计取舍：
//   - 不考虑进程被 kill 的场景。Mantle 设计为常驻，被 kill 就跳过那晚；不用 launchd 是为了避开系统级权限。
//   - 跨午夜 / 时区变化 / 夏令时：每次计算下一个 fire 时间时都用 Calendar.current.nextDate，自动处理。

@MainActor
final class DailyDigestScheduler {

    // MARK: Config

    private let fireHour: Int
    private let fireMinute: Int

    // MARK: Runtime

    private var loopTask: Task<Void, Never>?
    private var lastFireDate: Date?

    // MARK: Init

    init(fireHour: Int = 22, fireMinute: Int = 0) {
        self.fireHour = fireHour
        self.fireMinute = fireMinute
    }

    // MARK: - Lifecycle

    /// 启动调度循环。每次 action 结束后再算下一个 fire 时间，避免漂移。
    /// 幂等：重复调用会取消旧 loop。
    func start(action: @escaping @MainActor () async -> Void) {
        stop()
        let hour = fireHour
        let minute = fireMinute
        MantleLog.app.info("[DigestScheduler] started, fireTime=\(hour):\(String(format: "%02d", minute))")

        loopTask = Task { [weak self] in
            while let self, !Task.isCancelled {
                let nextFire = Self.computeNextFireDate(hour: hour, minute: minute, from: .now)
                let interval = nextFire.timeIntervalSinceNow
                MantleLog.app.info("[DigestScheduler] next fire at \(nextFire.description(with: .current)) (in \(Int(interval))s)")

                do {
                    try await Task.sleep(nanoseconds: UInt64(max(1, interval) * 1_000_000_000))
                } catch {
                    // Task.sleep 被取消 → 退出 loop
                    return
                }
                if Task.isCancelled { return }

                // 防重入：同一天多次起 Mantle 不会重复 fire 今天的 22:00
                if let last = self.lastFireDate,
                   Calendar.current.isDate(last, inSameDayAs: nextFire) {
                    MantleLog.app.info("[DigestScheduler] skip duplicate fire for today")
                    continue
                }
                self.lastFireDate = .now
                MantleLog.app.info("[DigestScheduler] firing action")
                await action()
            }
        }
    }

    func stop() {
        loopTask?.cancel()
        loopTask = nil
    }

    // MARK: - Helpers

    /// 计算下一个 hour:minute 的时间点。若今日的该时间点已过，则取明日。
    static func computeNextFireDate(hour: Int, minute: Int, from reference: Date) -> Date {
        let cal = Calendar.current
        var comp = DateComponents()
        comp.hour = hour
        comp.minute = minute
        comp.second = 0
        // matchingPolicy=nextTime → 自动处理夏令时跨越
        let next = cal.nextDate(
            after: reference,
            matching: comp,
            matchingPolicy: .nextTime,
            direction: .forward
        )
        // 兜底：理论上 nextDate 不会返回 nil（因为 HH:MM 每天都有），但保险起见返回一小时后
        return next ?? reference.addingTimeInterval(3600)
    }
}
