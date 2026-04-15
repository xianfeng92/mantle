import ApplicationServices
import Foundation
import os

// MARK: - AXBridge
//
// Swift wrapper around macOS Accessibility API (AXUIElement).
// Reads UI element trees, queries attributes, and performs actions.
//
// All public methods are nonisolated and thread-safe — they call the
// synchronous AX C API and never touch MainActor state.
//
// Important: requires Accessibility permission (System Settings > Privacy > Accessibility).

struct AXBridge: Sendable {

    // MARK: - Query: Applications & Windows

    /// Get the AXUIElement for the system-wide accessibility object.
    static func systemWide() -> AXUIElement {
        AXUIElementCreateSystemWide()
    }

    /// Get the frontmost (focused) application element.
    static func frontmostApp() -> AXUIElement? {
        let sys = systemWide()
        var value: AnyObject?
        let err = AXUIElementCopyAttributeValue(sys, kAXFocusedApplicationAttribute as CFString, &value)
        guard err == .success else {
            MantleLog.computerUse.warning("[AX] frontmostApp failed: \(err.rawValue)")
            return nil
        }
        return (value as! AXUIElement)
    }

    /// Get the focused window of an application element.
    static func focusedWindow(of app: AXUIElement) -> AXUIElement? {
        return attribute(app, kAXFocusedWindowAttribute)
    }

    /// Get all windows of an application element.
    static func windows(of app: AXUIElement) -> [AXUIElement] {
        return attribute(app, kAXWindowsAttribute) ?? []
    }

    /// Create an application element from a PID.
    static func application(pid: pid_t) -> AXUIElement {
        AXUIElementCreateApplication(pid)
    }

    // MARK: - Query: Element Attributes

    /// Get the role of an element (e.g. "AXButton", "AXTextField").
    static func role(_ element: AXUIElement) -> String? {
        attribute(element, kAXRoleAttribute)
    }

    /// Get the subrole (e.g. "AXCloseButton").
    static func subrole(_ element: AXUIElement) -> String? {
        attribute(element, kAXSubroleAttribute)
    }

    /// Get the title / label.
    static func title(_ element: AXUIElement) -> String? {
        attribute(element, kAXTitleAttribute)
    }

    /// Get the value (text content, checkbox state, etc.).
    static func value(_ element: AXUIElement) -> String? {
        var raw: AnyObject?
        let err = AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &raw)
        guard err == .success, let raw else { return nil }
        // Value can be various types; coerce to string
        if let s = raw as? String { return s }
        if let n = raw as? NSNumber { return n.stringValue }
        return String(describing: raw)
    }

    /// Get the human-readable role description.
    static func roleDescription(_ element: AXUIElement) -> String? {
        attribute(element, kAXRoleDescriptionAttribute)
    }

    /// Whether the element is enabled.
    static func isEnabled(_ element: AXUIElement) -> Bool {
        let val: NSNumber? = attribute(element, kAXEnabledAttribute)
        return val?.boolValue ?? true
    }

    /// Whether the element has keyboard focus.
    static func isFocused(_ element: AXUIElement) -> Bool {
        let val: NSNumber? = attribute(element, kAXFocusedAttribute)
        return val?.boolValue ?? false
    }

    /// Get the screen-coordinate frame (position + size) of an element.
    static func frame(_ element: AXUIElement) -> CGRect? {
        guard let pos: CGPoint = axValueAttribute(element, kAXPositionAttribute, .cgPoint),
              let size: CGSize = axValueAttribute(element, kAXSizeAttribute, .cgSize) else {
            return nil
        }
        return CGRect(origin: pos, size: size)
    }

    /// Get the list of available actions for an element.
    static func actions(_ element: AXUIElement) -> [String] {
        var names: CFArray?
        let err = AXUIElementCopyActionNames(element, &names)
        guard err == .success, let names else { return [] }
        return names as? [String] ?? []
    }

    /// Get direct children of an element.
    static func children(_ element: AXUIElement) -> [AXUIElement] {
        attribute(element, kAXChildrenAttribute) ?? []
    }

    // MARK: - Query: Tree Traversal

    /// Traverse the UI tree from a root element and return a flat list of AXNodes.
    ///
    /// - Parameters:
    ///   - root: The root AXUIElement (typically a window or application).
    ///   - maxDepth: Maximum traversal depth (default 6). Deeper trees are truncated.
    ///   - timeout: Per-element messaging timeout in seconds (default 1.0).
    /// - Returns: Array of AXNode in DFS order.
    static func tree(root: AXUIElement, maxDepth: Int = 6, timeout: Float = 1.0) -> [AXNode] {
        var result: [AXNode] = []
        var index = 0

        func visit(_ element: AXUIElement, depth: Int) {
            guard depth <= maxDepth else { return }

            // Set timeout to avoid hanging on unresponsive apps
            AXUIElementSetMessagingTimeout(element, timeout)

            let elementChildren = children(element)
            let elementActions = actions(element)
            let elementRole = role(element) ?? "AXUnknown"

            // Skip invisible / zero-size elements
            let elementFrame = frame(element) ?? .zero
            if elementFrame.width <= 0 && elementFrame.height <= 0 && depth > 0 {
                return
            }

            let node = AXNode(
                id: index,
                role: elementRole,
                subrole: subrole(element),
                title: title(element),
                value: value(element),
                roleDescription: roleDescription(element),
                frame: elementFrame,
                isEnabled: isEnabled(element),
                isFocused: isFocused(element),
                depth: depth,
                childrenCount: elementChildren.count,
                actions: elementActions
            )
            result.append(node)
            index += 1

            // Recurse into children
            for child in elementChildren {
                visit(child, depth: depth + 1)
            }
        }

        visit(root, depth: 0)
        MantleLog.computerUse.info("[AX] tree traversal: \(result.count) nodes, maxDepth=\(maxDepth)")
        return result
    }

    // MARK: - Actions

    /// Perform the press action (AXPress) on an element.
    @discardableResult
    static func press(_ element: AXUIElement) -> Bool {
        let err = AXUIElementPerformAction(element, kAXPressAction as CFString)
        if err != .success {
            MantleLog.computerUse.warning("[AX] press failed: \(err.rawValue)")
        }
        return err == .success
    }

    /// Set the value of an element (e.g. text field content).
    @discardableResult
    static func setValue(_ element: AXUIElement, value: String) -> Bool {
        let err = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFTypeRef)
        if err != .success {
            MantleLog.computerUse.warning("[AX] setValue failed: \(err.rawValue)")
        }
        return err == .success
    }

    /// Set keyboard focus to an element.
    @discardableResult
    static func focus(_ element: AXUIElement) -> Bool {
        let err = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, true as CFTypeRef)
        return err == .success
    }

    /// Raise a window to the front.
    @discardableResult
    static func raise(_ element: AXUIElement) -> Bool {
        let err = AXUIElementPerformAction(element, kAXRaiseAction as CFString)
        return err == .success
    }

    // MARK: - Find Elements

    /// BFS search for an element matching role and/or title.
    static func findElement(
        root: AXUIElement,
        role targetRole: String? = nil,
        title targetTitle: String? = nil,
        timeout: Float = 1.0
    ) -> AXUIElement? {
        var queue: [AXUIElement] = [root]

        while !queue.isEmpty {
            let current = queue.removeFirst()
            AXUIElementSetMessagingTimeout(current, timeout)

            let currentRole = role(current)
            let currentTitle = title(current)

            let roleMatch = targetRole == nil || currentRole == targetRole
            let titleMatch = targetTitle == nil || currentTitle == targetTitle

            if roleMatch && titleMatch && (targetRole != nil || targetTitle != nil) {
                return current
            }

            queue.append(contentsOf: children(current))
        }
        return nil
    }

    /// Find an element by its index in a previous tree() traversal.
    /// Re-traverses the tree to the same DFS order.
    static func elementByIndex(root: AXUIElement, index targetIndex: Int, maxDepth: Int = 6, timeout: Float = 1.0) -> AXUIElement? {
        var current = 0

        func visit(_ element: AXUIElement, depth: Int) -> AXUIElement? {
            guard depth <= maxDepth else { return nil }
            AXUIElementSetMessagingTimeout(element, timeout)

            let elementFrame = frame(element) ?? .zero
            if elementFrame.width <= 0 && elementFrame.height <= 0 && depth > 0 {
                return nil
            }

            if current == targetIndex {
                return element
            }
            current += 1

            for child in children(element) {
                if let found = visit(child, depth: depth + 1) {
                    return found
                }
            }
            return nil
        }

        return visit(root, depth: 0)
    }

    // MARK: - Permission

    /// Check if Accessibility permission is granted (synchronous).
    static var isAccessibilityGranted: Bool {
        AXIsProcessTrusted()
    }

    /// Prompt the user for Accessibility permission (shows system dialog once).
    static func requestAccessibility() {
        let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
        AXIsProcessTrustedWithOptions(options)
    }

    // MARK: - Private Helpers

    /// Generic attribute getter with type casting.
    private static func attribute<T>(_ element: AXUIElement, _ attr: String) -> T? {
        var value: AnyObject?
        let err = AXUIElementCopyAttributeValue(element, attr as CFString, &value)
        guard err == .success else { return nil }
        return value as? T
    }

    /// Attribute getter for AXValue-wrapped types (CGPoint, CGSize, CGRect).
    private static func axValueAttribute<T>(_ element: AXUIElement, _ attr: String, _ type: AXValueType) -> T? {
        var raw: AnyObject?
        let err = AXUIElementCopyAttributeValue(element, attr as CFString, &raw)
        guard err == .success, let axVal = raw, CFGetTypeID(axVal) == AXValueGetTypeID() else { return nil }

        let size = MemoryLayout<T>.size
        let ptr = UnsafeMutableRawPointer.allocate(byteCount: size, alignment: MemoryLayout<T>.alignment)
        defer { ptr.deallocate() }

        guard AXValueGetValue(axVal as! AXValue, type, ptr) else { return nil }
        return ptr.load(as: T.self)
    }
}
