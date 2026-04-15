import Foundation
import AppKit
import os

// MARK: - Text Selection Service
//
// Implements NSServices provider for "Ask Mantle" context menu.
// When user selects text in any app and chooses Services → Ask Mantle,
// the selected text is passed to this handler.

@MainActor
final class TextSelectionService: NSObject {

    // MARK: - Callback

    /// Called with the selected text when "Ask Mantle" is invoked from Services menu
    var onTextReceived: (@MainActor (SelectionInfo) -> Void)?

    // MARK: - Register

    /// Register this object as the Services provider.
    /// Must be called once at app startup.
    func register() {
        NSApp.servicesProvider = self
        // Force system to update Services menu
        NSUpdateDynamicServices()
        MantleLog.app.info("TextSelectionService registered")
    }
}

// MARK: - Service Handler

extension TextSelectionService {

    /// Called by the system when "Ask Mantle" is selected from the Services menu.
    /// Method name must match NSMessage in Info.plist.
    @objc nonisolated func askMantle(
        _ pasteboard: NSPasteboard,
        userData: String,
        error errorPointer: AutoreleasingUnsafeMutablePointer<NSString?>
    ) {
        guard let text = pasteboard.string(forType: .string),
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            errorPointer.pointee = "No text selected" as NSString
            return
        }

        let trimmedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
        MantleLog.app.info("TextSelectionService received \(trimmedText.count) chars")
        let sourceApp = NSWorkspace.shared.frontmostApplication
        guard let selection = SelectionInfo(
            rawText: trimmedText,
            sourceAppName: sourceApp?.localizedName,
            sourceBundleId: sourceApp?.bundleIdentifier,
            capturedAt: .now
        ) else {
            errorPointer.pointee = "No text selected" as NSString
            return
        }

        // Dispatch to main actor
        DispatchQueue.main.async {
            NSApplication.shared.activate(ignoringOtherApps: true)
            MainActor.assumeIsolated {
                self.onTextReceived?(selection)
            }
        }
    }
}
