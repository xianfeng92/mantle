import Foundation
import AppKit


// MARK: - Permission Manager
//
// Tracks macOS privacy permissions needed by Mantle/Aura.
// Provides deep links to System Settings panels and explanation text.
// Follows Aura design doc §6.1: progressive permission requests.

@Observable
@MainActor
final class PermissionManager {

    // MARK: - Permission Status

    struct PermissionStatus: Sendable {
        let accessibility: Bool
        let screenCapture: Bool
    }

    /// Current permission status (accessibility is synchronous, screenCapture is cached).
    var status: PermissionStatus {
        PermissionStatus(
            accessibility: AXIsProcessTrusted(),
            screenCapture: screenCaptureGranted
        )
    }

    /// Cached screen capture permission status (updated via `refreshScreenCaptureStatus()`).
    private(set) var screenCaptureGranted: Bool = false

    /// Refresh the screen capture permission status (async — must try a capture).
    func refreshScreenCaptureStatus() async {
        screenCaptureGranted = await ScreenCaptureBridge.isScreenCaptureGranted()
    }

    // MARK: - Permission Requests

    /// Request Accessibility permission (shows system prompt if needed)
    func requestAccessibility() {
        let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
        AXIsProcessTrustedWithOptions(options)
    }

    /// Open System Settings directly to the Accessibility privacy panel
    func openAccessibilitySettings() {
        let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!
        NSWorkspace.shared.open(url)
    }

    /// Open System Settings directly to the Screen Recording privacy panel
    func openScreenCaptureSettings() {
        let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!
        NSWorkspace.shared.open(url)
    }

    /// Open System Settings directly to the Full Disk Access panel (for future use)
    func openFullDiskAccessSettings() {
        let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")!
        NSWorkspace.shared.open(url)
    }

    // MARK: - Permission Descriptions

    static let accessibilityDescription = PermissionDescription(
        title: "Accessibility",
        icon: "hand.raised.fill",
        why: "Read UI elements and control mouse/keyboard so Mantle can operate your Mac.",
        without: "Mantle can see which app is active, but cannot read UI structure or automate actions.",
        withIt: "Mantle can read buttons, menus, text fields and perform clicks, typing, and scrolling."
    )

    static let screenCaptureDescription = PermissionDescription(
        title: "Screen Recording",
        icon: "rectangle.dashed.badge.record",
        why: "Capture screenshots for visual understanding when the accessibility tree isn't enough.",
        without: "Mantle relies solely on the UI element tree (works for most apps).",
        withIt: "Mantle can take screenshots to understand complex layouts, images, and visual content."
    )

    struct PermissionDescription {
        let title: String
        let icon: String
        let why: String
        let without: String
        let withIt: String
    }
}
