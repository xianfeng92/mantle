import Foundation
import ServiceManagement
import os

// MARK: - Launch At Login Manager
//
// Uses SMAppService (macOS 13+) to manage login item registration.
// No external dependency needed.

@MainActor
enum LaunchAtLoginManager {

    /// Whether the app is currently registered as a login item
    static var isEnabled: Bool {
        SMAppService.mainApp.status == .enabled
    }

    /// Enable or disable launch at login
    static func setEnabled(_ enabled: Bool) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
                MantleLog.app.info("Registered as login item")
            } else {
                try SMAppService.mainApp.unregister()
                MantleLog.app.info("Unregistered as login item")
            }
        } catch {
            MantleLog.app.error("LaunchAtLogin: Failed to \(enabled ? "register" : "unregister"): \(error)")
        }
    }
}
