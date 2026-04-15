import Foundation
import AppKit
import os

// MARK: - Window Title Monitor
//
// Reads the focused window title of the frontmost application via Accessibility API.
// Requires "Accessibility" permission in System Settings > Privacy & Security.
// Graceful degradation: if no permission, `currentTitle` stays nil.

@Observable
@MainActor
final class WindowTitleMonitor {

    /// Title of the currently focused window, or nil if unavailable
    private(set) var currentTitle: String?

    private var observer: NSObjectProtocol?

    func start() {
        // Capture initial state
        updateTitle()

        // Re-read title whenever frontmost app changes
        observer = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            // Small delay for the window to actually come to front
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(200))
                self?.updateTitle()
            }
        }

        MantleLog.context.info("WindowTitleMonitor started (accessibility: \(Self.hasAccessibilityPermission))")
    }

    func stop() {
        if let observer {
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
        }
        observer = nil
    }

    /// Force refresh (called by ContextDaemon on each polling cycle)
    func refresh() {
        updateTitle()
    }

    // MARK: - Accessibility

    static var hasAccessibilityPermission: Bool {
        AXIsProcessTrusted()
    }

    /// Request accessibility permission with a prompt (shows system dialog)
    static func requestAccessibilityPermission() {
        let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
        AXIsProcessTrustedWithOptions(options)
    }

    // MARK: - Private

    private func updateTitle() {
        guard Self.hasAccessibilityPermission else {
            currentTitle = nil
            return
        }

        guard let frontApp = NSWorkspace.shared.frontmostApplication else {
            currentTitle = nil
            return
        }

        let pid = frontApp.processIdentifier
        let appElement = AXUIElementCreateApplication(pid)

        // Get focused window
        var focusedWindow: AnyObject?
        let windowResult = AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &focusedWindow)

        guard windowResult == .success, let window = focusedWindow else {
            currentTitle = nil
            return
        }

        // Get window title
        var titleValue: AnyObject?
        let titleResult = AXUIElementCopyAttributeValue(window as! AXUIElement, kAXTitleAttribute as CFString, &titleValue)

        if titleResult == .success, let title = titleValue as? String, !title.isEmpty {
            currentTitle = title
        } else {
            currentTitle = nil
        }
    }
}
