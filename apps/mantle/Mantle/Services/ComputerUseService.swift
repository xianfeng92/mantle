@preconcurrency import ApplicationServices
import AppKit
import Foundation
import os

// MARK: - ComputerUseService
//
// Unified entry point for macOS desktop control.
// Aggregates AXBridge (UI tree) + InputBridge (mouse/keyboard) + ScreenCaptureBridge (screenshots).
//
// This service is called by agent-core tools via the existing HTTP/SSE channel.
// Each method corresponds to one tool in the agent's tool-calling interface.

@Observable
@MainActor
final class ComputerUseService {

    // MARK: - Cached State

    /// Most recent UI tree traversal result (cached for elementByIndex lookups).
    private(set) var lastTree: [AXNode] = []

    /// The AX root element used for the last tree traversal.
    private var lastTreeRoot: AXUIElement?

    // MARK: - Queue

    /// Background queue for AX operations (they're synchronous and can block).
    private nonisolated let axQueue = DispatchQueue(label: "mantle.computer-use.ax", qos: .userInitiated)

    // MARK: - Tool: UI Tree

    /// Get the accessibility tree of the frontmost application's focused window.
    /// Returns a flat list of AXNodes in DFS order, each with an index for later reference.
    ///
    /// Equivalent agent-core tool: `ui_tree`
    func getUITree(maxDepth: Int = 6) async -> [AXNode] {
        let result: [AXNode] = await withCheckedContinuation { cont in
            axQueue.async {
                guard let app = AXBridge.frontmostApp() else {
                    MantleLog.computerUse.warning("[ComputerUse] no frontmost app")
                    cont.resume(returning: [])
                    return
                }

                // Prefer focused window; fall back to app element
                let root = AXBridge.focusedWindow(of: app) ?? app
                let tree = AXBridge.tree(root: root, maxDepth: maxDepth)

                // Cache for later elementByIndex
                Task { @MainActor [weak self] in
                    self?.lastTree = tree
                    self?.lastTreeRoot = root
                }

                cont.resume(returning: tree)
            }
        }
        return result
    }

    /// Get the UI tree as a text summary (compact, suitable for LLM context).
    func getUITreeText(maxDepth: Int = 6) async -> String {
        let nodes = await getUITree(maxDepth: maxDepth)
        if nodes.isEmpty { return "(no UI tree available — is Accessibility permission granted?)" }
        return nodes.map(\.summary).joined(separator: "\n")
    }

    // MARK: - Tool: Screenshot

    enum ScreenshotTarget {
        case fullScreen
        case window(CGWindowID)
        case app(String) // bundleID
    }

    /// Capture a screenshot and return it as base64-encoded JPEG.
    ///
    /// Equivalent agent-core tool: `screenshot`
    func screenshot(target: ScreenshotTarget = .fullScreen, quality: CGFloat = 0.8) async throws -> String {
        let data: Data
        switch target {
        case .fullScreen:
            data = try await ScreenCaptureBridge.captureFullScreen(quality: quality)
        case .window(let id):
            data = try await ScreenCaptureBridge.captureWindow(windowID: id, quality: quality)
        case .app(let bundleID):
            data = try await ScreenCaptureBridge.captureApp(bundleID: bundleID, quality: quality)
        }
        return data.base64EncodedString()
    }

    // MARK: - Tool: Click

    /// Click at screen coordinates.
    ///
    /// Equivalent agent-core tool: `click`
    func click(x: Int, y: Int, button: MouseButton = .left, clickCount: Int = 1) {
        let point = CGPoint(x: x, y: y)
        let btnName = button.rawValue
        MantleLog.computerUse.info("[ComputerUse] click \(btnName) x\(clickCount) at (\(x),\(y))")

        switch (button, clickCount) {
        case (.left, 1):  InputBridge.leftClick(at: point)
        case (.left, 2):  InputBridge.doubleClick(at: point)
        case (.left, 3):  InputBridge.tripleClick(at: point)
        case (.right, _): InputBridge.rightClick(at: point)
        default:          InputBridge.leftClick(at: point)
        }
    }

    enum MouseButton: String, Sendable {
        case left, right
    }

    // MARK: - Tool: Type Text

    /// Type text at the current cursor/focus position.
    ///
    /// Equivalent agent-core tool: `type_text`
    func type(text: String) {
        MantleLog.computerUse.info("[ComputerUse] type: \(text.prefix(50))...")
        InputBridge.typeText(text)
    }

    // MARK: - Tool: Key Press

    /// Press a key with optional modifiers.
    ///
    /// Equivalent agent-core tool: `key_press`
    func keyPress(key: String, modifiers: [String] = []) {
        let modStr = modifiers.isEmpty ? "" : " +\(modifiers.joined(separator: "+"))"
        MantleLog.computerUse.info("[ComputerUse] keyPress: \(key)\(modStr)")
        InputBridge.pressKey(name: key, modifiers: modifiers)
    }

    // MARK: - Tool: Scroll

    /// Scroll at a screen coordinate.
    ///
    /// Equivalent agent-core tool: `scroll`
    func scroll(x: Int, y: Int, deltaY: Int, deltaX: Int = 0) {
        MantleLog.computerUse.info("[ComputerUse] scroll at (\(x),\(y)) dy=\(deltaY) dx=\(deltaX)")
        InputBridge.scroll(at: CGPoint(x: x, y: y), deltaY: Int32(deltaY), deltaX: Int32(deltaX))
    }

    // MARK: - Tool: Click Element (by tree index)

    /// Click an element identified by its index from the last `getUITree()` call.
    /// Uses AXPress if available; otherwise clicks at the element's center coordinates.
    ///
    /// Equivalent agent-core tool: `click_element`
    func clickElement(index: Int) async -> Bool {
        guard let root = lastTreeRoot else {
            MantleLog.computerUse.warning("[ComputerUse] clickElement: no cached tree root")
            return false
        }

        let result: Bool = await withCheckedContinuation { cont in
            axQueue.async {
                guard let element = AXBridge.elementByIndex(root: root, index: index) else {
                    MantleLog.computerUse.warning("[ComputerUse] clickElement: index \(index) not found")
                    cont.resume(returning: false)
                    return
                }

                // Try AXPress first (most reliable)
                let actions = AXBridge.actions(element)
                if actions.contains(kAXPressAction as String) {
                    let ok = AXBridge.press(element)
                    MantleLog.computerUse.info("[ComputerUse] clickElement[\(index)] via AXPress: \(ok)")
                    cont.resume(returning: ok)
                    return
                }

                // Fallback: click at center of element's frame
                if let frame = AXBridge.frame(element) {
                    let center = CGPoint(x: frame.midX, y: frame.midY)
                    InputBridge.leftClick(at: center)
                    MantleLog.computerUse.info("[ComputerUse] clickElement[\(index)] via coordinate click at (\(Int(center.x)),\(Int(center.y)))")
                    cont.resume(returning: true)
                } else {
                    MantleLog.computerUse.warning("[ComputerUse] clickElement[\(index)]: no frame")
                    cont.resume(returning: false)
                }
            }
        }
        return result
    }

    // MARK: - Tool: Set Element Value (by tree index)

    /// Set the value of an element (e.g. text field) identified by its tree index.
    ///
    /// Equivalent agent-core tool: `set_element_value`
    func setElementValue(index: Int, value: String) async -> Bool {
        guard let root = lastTreeRoot else {
            MantleLog.computerUse.warning("[ComputerUse] setElementValue: no cached tree root")
            return false
        }

        let result: Bool = await withCheckedContinuation { cont in
            axQueue.async {
                guard let element = AXBridge.elementByIndex(root: root, index: index) else {
                    MantleLog.computerUse.warning("[ComputerUse] setElementValue: index \(index) not found")
                    cont.resume(returning: false)
                    return
                }

                // Focus the element first, then set value
                AXBridge.focus(element)
                let ok = AXBridge.setValue(element, value: value)
                MantleLog.computerUse.info("[ComputerUse] setElementValue[\(index)] = \"\(value.prefix(30))\": \(ok)")
                cont.resume(returning: ok)
            }
        }
        return result
    }

    // MARK: - Tool: Find and Click Button

    /// Find a button by title text and click it.
    func clickButton(title: String) async -> Bool {
        var root = lastTreeRoot
        if root == nil {
            root = await getTreeRoot()
        }
        guard let root else { return false }

        let result: Bool = await withCheckedContinuation { cont in
            axQueue.async {
                guard let element = AXBridge.findElement(root: root, role: "AXButton", title: title) else {
                    MantleLog.computerUse.warning("[ComputerUse] clickButton: \"\(title)\" not found")
                    cont.resume(returning: false)
                    return
                }
                let ok = AXBridge.press(element)
                MantleLog.computerUse.info("[ComputerUse] clickButton \"\(title)\": \(ok)")
                cont.resume(returning: ok)
            }
        }
        return result
    }

    // MARK: - Tool: Open App

    /// Open a macOS application by name or bundle ID.
    func openApp(name: String?, bundleId: String?) async -> Bool {
        let workspace = NSWorkspace.shared

        if let bundleId {
            // Try opening by bundle ID first (most reliable)
            let url = workspace.urlForApplication(withBundleIdentifier: bundleId)
            if let url {
                do {
                    try await workspace.openApplication(at: url, configuration: .init())
                    MantleLog.computerUse.info("[ComputerUse] opened app by bundleId: \(bundleId)")
                    // Brief delay for app to become frontmost
                    try? await Task.sleep(for: .milliseconds(500))
                    return true
                } catch {
                    MantleLog.computerUse.warning("[ComputerUse] failed to open \(bundleId): \(error)")
                }
            }
        }

        if let name {
            // First try `open -a` (works for English app names like "Notes")
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            process.arguments = ["-a", name]
            do {
                try process.run()
                process.waitUntilExit()
                if process.terminationStatus == 0 {
                    MantleLog.computerUse.info("[ComputerUse] opened app by name: \(name)")
                    try? await Task.sleep(for: .milliseconds(500))
                    return true
                }
            } catch {
                MantleLog.computerUse.warning("[ComputerUse] open -a '\(name)' failed: \(error)")
            }

            // Fallback: search by localized display name (e.g., "备忘录" → Notes.app)
            if let url = Self.findAppByLocalizedName(name) {
                do {
                    try await workspace.openApplication(at: url, configuration: .init())
                    MantleLog.computerUse.info("[ComputerUse] opened app by localized name: \(name)")
                    try? await Task.sleep(for: .milliseconds(500))
                    return true
                } catch {
                    MantleLog.computerUse.warning("[ComputerUse] failed to open localized '\(name)': \(error)")
                }
            }
        }

        return false
    }

    // MARK: - Permissions

    var isAccessibilityGranted: Bool {
        AXBridge.isAccessibilityGranted
    }

    func isScreenCaptureGranted() async -> Bool {
        await ScreenCaptureBridge.isScreenCaptureGranted()
    }

    func requestAccessibility() {
        AXBridge.requestAccessibility()
    }

    func openScreenCaptureSettings() {
        ScreenCaptureBridge.openScreenCaptureSettings()
    }

    // MARK: - App Lookup

    /// Search /Applications and /System/Applications for an app matching a localized display name.
    private static func findAppByLocalizedName(_ name: String) -> URL? {
        let searchDirs = [
            URL(fileURLWithPath: "/Applications"),
            URL(fileURLWithPath: "/System/Applications"),
            URL(fileURLWithPath: "/System/Applications/Utilities"),
        ]
        let fm = FileManager.default
        let lowered = name.lowercased()

        for dir in searchDirs {
            guard let urls = try? fm.contentsOfDirectory(
                at: dir, includingPropertiesForKeys: nil,
                options: [.skipsHiddenFiles]
            ) else { continue }

            for url in urls where url.pathExtension == "app" {
                // Check localized name from bundle
                if let bundle = Bundle(url: url),
                   let displayName = bundle.localizedInfoDictionary?["CFBundleDisplayName"] as? String
                    ?? bundle.localizedInfoDictionary?["CFBundleName"] as? String
                    ?? bundle.infoDictionary?["CFBundleDisplayName"] as? String
                    ?? bundle.infoDictionary?["CFBundleName"] as? String {
                    if displayName.lowercased() == lowered {
                        return url
                    }
                }
                // Also check filename without extension (e.g., "Notes" from "Notes.app")
                if url.deletingPathExtension().lastPathComponent.lowercased() == lowered {
                    return url
                }
            }
        }
        return nil
    }

    // MARK: - Private

    private func getTreeRoot() async -> AXUIElement? {
        await withCheckedContinuation { cont in
            axQueue.async {
                let app = AXBridge.frontmostApp()
                let root = app.flatMap { AXBridge.focusedWindow(of: $0) } ?? app
                cont.resume(returning: root)
            }
        }
    }
}
