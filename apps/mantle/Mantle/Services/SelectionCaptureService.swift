import Foundation
import AppKit
import ApplicationServices
import os

// MARK: - Selection Capture Service
//
// Best-effort selected-text capture for the current frontmost application.
// Uses Accessibility when available and gracefully returns nil when the focused
// element does not expose selected text.

@MainActor
final class SelectionCaptureService {

    func captureCurrentSelection() -> SelectionInfo? {
        guard let frontApp = NSWorkspace.shared.frontmostApplication else {
            return nil
        }
        return captureSelection(from: frontApp)
    }

    func captureSelection(from app: NSRunningApplication) -> SelectionInfo? {
        guard AXIsProcessTrusted() else { return nil }
        guard let rawText = selectedText(from: app) else { return nil }

        return SelectionInfo(
            rawText: rawText,
            sourceAppName: app.localizedName,
            sourceBundleId: app.bundleIdentifier,
            capturedAt: .now
        )
    }

    private func selectedText(from app: NSRunningApplication) -> String? {
        let appElement = AXUIElementCreateApplication(app.processIdentifier)

        if let focusedElement = copyElementAttribute(kAXFocusedUIElementAttribute as CFString, from: appElement),
           let focusedText = copyStringAttribute(kAXSelectedTextAttribute as CFString, from: focusedElement) {
            return focusedText
        }

        if let focusedWindow = copyElementAttribute(kAXFocusedWindowAttribute as CFString, from: appElement),
           let windowText = copyStringAttribute(kAXSelectedTextAttribute as CFString, from: focusedWindow) {
            return windowText
        }

        return copyStringAttribute(kAXSelectedTextAttribute as CFString, from: appElement)
    }

    private func copyElementAttribute(_ attribute: CFString, from element: AXUIElement) -> AXUIElement? {
        var value: AnyObject?
        let result = AXUIElementCopyAttributeValue(element, attribute, &value)
        guard result == .success, let value else { return nil }
        return (value as! AXUIElement)
    }

    private func copyStringAttribute(_ attribute: CFString, from element: AXUIElement) -> String? {
        var value: AnyObject?
        let result = AXUIElementCopyAttributeValue(element, attribute, &value)
        guard result == .success, let value else { return nil }

        if let string = value as? String {
            return string
        }

        if let attributed = value as? NSAttributedString {
            return attributed.string
        }

        return nil
    }
}
