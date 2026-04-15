import Foundation
import UserNotifications
import AppKit
import os

// MARK: - Notification Manager
//
// Sends system notifications for:
// - Background task completion
// - HITL approval requests (time-sensitive)
// - Backend errors / crashes

@MainActor
final class NotificationManager: NSObject, @unchecked Sendable {

    static let shared = NotificationManager()

    private override init() {
        super.init()
    }

    // MARK: - Permission

    func requestPermission() {
        // Guard: UNUserNotificationCenter.current() crashes if the app bundle
        // is not properly formed (e.g., running bare executable from DerivedData).
        guard let bid = Bundle.main.bundleIdentifier else {
            MantleLog.app.warning("Notifications: Skipping — no bundle identifier")
            return
        }
        MantleLog.app.info("Notifications: requesting authorization, bundleID=\(bid, privacy: .public)")

        let center = UNUserNotificationCenter.current()
        // 先查当前状态
        center.getNotificationSettings { settings in
            MantleLog.app.info("Notifications: current authorizationStatus=\(settings.authorizationStatus.rawValue) alertSetting=\(settings.alertSetting.rawValue)")
        }
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            if let error {
                MantleLog.app.error("Notifications: requestAuthorization error: \(error.localizedDescription, privacy: .public)")
            } else {
                MantleLog.app.info("Notifications: requestAuthorization granted=\(granted)")
            }
        }
        center.delegate = self
    }

    /// 供调试菜单调用：打印当前权限状态 + 发一条测试通知。
    func debugPrintStatusAndSendTest() {
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            MantleLog.app.info(
                "[NotifDebug] status=\(settings.authorizationStatus.rawValue) alert=\(settings.alertSetting.rawValue) sound=\(settings.soundSetting.rawValue) notificationCenter=\(settings.notificationCenterSetting.rawValue)"
            )
            Task { @MainActor in
                let content = UNMutableNotificationContent()
                content.title = "Mantle 测试通知"
                content.body = "如果你看到这条通知说明权限正常。触发时间 \(Date().description(with: .current))"
                content.sound = .default
                self.send(content, id: "debug-test-\(UUID().uuidString)")
            }
        }
    }

    // MARK: - Notify: Task Completed

    func notifyTaskCompleted(threadTitle: String) {
        guard !NSApplication.shared.isActive else { return } // Skip if app is in foreground

        let content = UNMutableNotificationContent()
        content.title = "Task Completed"
        content.body = "Mantle finished responding in \"\(threadTitle)\""
        content.sound = .default
        content.categoryIdentifier = "TASK_COMPLETED"

        send(content, id: "task-completed-\(UUID().uuidString)")
    }

    // MARK: - Notify: HITL Approval Needed

    func notifyApprovalNeeded(threadTitle: String, toolCount: Int) {
        guard !NSApplication.shared.isActive else { return }

        let content = UNMutableNotificationContent()
        content.title = "Approval Required"
        content.body = "\(toolCount) action\(toolCount > 1 ? "s" : "") pending in \"\(threadTitle)\""
        content.sound = .default
        content.interruptionLevel = .timeSensitive
        content.categoryIdentifier = "HITL_APPROVAL"

        send(content, id: "hitl-approval-\(UUID().uuidString)")
    }

    // MARK: - Notify: Twitter Digest Ready
    //
    // 每晚由 TwitterBookmarkDaemon.generateDailyDigest 调用。
    // userInfo 携带 deep link，点击后通过 NSWorkspace.open 重路由回 Mantle
    // MantleApp.handleDeepLink → 打开 Bookmarks 窗口。

    struct DigestNotificationItem {
        let authorHandle: String
        let headline: String  // 用作 body 预览（summary 的首句）
    }

    func notifyDigestReady(
        date: Date,
        items: [DigestNotificationItem],
        rationale: String?
    ) {
        let content = UNMutableNotificationContent()
        let count = items.count
        content.title = "今日 Twitter 精选 (\(count))"

        // body：前 2 条的 "@author｜headline"；剩余用"..."省略
        let previewLines = items.prefix(2).map { "\($0.authorHandle)｜\($0.headline)" }
        var body = previewLines.joined(separator: "\n")
        if count > 2 {
            body += "\n+\(count - 2) more"
        }
        if let rationale, !rationale.isEmpty {
            body += "\n\n\(rationale)"
        }
        content.body = body
        content.sound = .default
        content.categoryIdentifier = "TWITTER_DIGEST"

        // Deep link：点击通知跳到当日 bookmarks 页
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        df.locale = Locale(identifier: "en_US_POSIX")
        let dateStr = df.string(from: date)
        content.userInfo = [
            "deepLink": "mantle://bookmarks?date=\(dateStr)",
        ]

        send(content, id: "twitter-digest-\(dateStr)")
    }

    // MARK: - Notify: Backend Error

    func notifyBackendError(message: String) {
        guard !NSApplication.shared.isActive else { return }

        let content = UNMutableNotificationContent()
        content.title = "Backend Error"
        content.body = message
        content.sound = .defaultCritical
        content.categoryIdentifier = "BACKEND_ERROR"

        send(content, id: "backend-error-\(UUID().uuidString)")
    }

    // MARK: - Internal

    private func send(_ content: UNMutableNotificationContent, id: String) {
        guard Bundle.main.bundleIdentifier != nil else {
            MantleLog.app.warning("Notifications: send aborted — no bundle identifier")
            return
        }

        let request = UNNotificationRequest(
            identifier: id,
            content: content,
            trigger: nil // Deliver immediately
        )
        UNUserNotificationCenter.current().add(request) { error in
            if let error {
                MantleLog.app.error("Notifications: Failed to send id=\(id, privacy: .public) err=\(error.localizedDescription, privacy: .public)")
            } else {
                MantleLog.app.info("Notifications: sent id=\(id, privacy: .public) title=\(content.title, privacy: .public)")
            }
        }
    }
}

// MARK: - UNUserNotificationCenterDelegate

extension NotificationManager: UNUserNotificationCenterDelegate {

    /// Show notification even when app is in foreground (for errors)
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        let category = notification.request.content.categoryIdentifier
        if category == "BACKEND_ERROR" {
            return [.banner, .sound]
        }
        return [] // Don't show banner if app is active for other types
    }

    /// Handle notification tap — activate app and follow deep link if present.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let userInfo = response.notification.request.content.userInfo
        let deepLink = userInfo["deepLink"] as? String
        await MainActor.run {
            NSApplication.shared.activate(ignoringOtherApps: true)
            if let link = deepLink, let url = URL(string: link) {
                // 走 NSWorkspace，最终回到 MantleApp.onOpenURL / handleDeepLink
                NSWorkspace.shared.open(url)
            }
        }
    }
}
