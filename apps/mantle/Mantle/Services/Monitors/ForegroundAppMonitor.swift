import Foundation
import AppKit
import os

// MARK: - Foreground App Monitor
//
// Tracks the currently active (frontmost) application.
// Uses NSWorkspace notifications — event-driven, zero polling, no permissions needed.

struct ForegroundAppInfo: Sendable {
    let appName: String
    let bundleId: String
    let pid: pid_t
}

@Observable
@MainActor
final class ForegroundAppMonitor {

    private(set) var currentApp: ForegroundAppInfo?

    private var observer: NSObjectProtocol?

    func start() {
        // Capture initial state
        updateFromFrontmost()

        // Listen for app activation changes
        observer = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            self?.update(from: app)
        }

        MantleLog.context.info("ForegroundAppMonitor started")
    }

    func stop() {
        if let observer {
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
        }
        observer = nil
    }

    private func updateFromFrontmost() {
        guard let app = NSWorkspace.shared.frontmostApplication else { return }
        update(from: app)
    }

    private func update(from app: NSRunningApplication) {
        let info = ForegroundAppInfo(
            appName: app.localizedName ?? "Unknown",
            bundleId: app.bundleIdentifier ?? "",
            pid: app.processIdentifier
        )
        currentApp = info
        MantleLog.context.debug("Foreground → \(info.appName) (\(info.bundleId))")
    }
}
