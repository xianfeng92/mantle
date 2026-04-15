import Foundation

// MARK: - AXNode
//
// Lightweight, serializable representation of a macOS accessibility UI element.
// Produced by AXBridge.tree() and consumed by ComputerUseService / agent-core tools.

struct AXNode: Codable, Sendable, Identifiable {
    let id: Int                // unique index within the tree traversal
    let role: String           // AXButton, AXTextField, AXStaticText, AXWindow ...
    let subrole: String?       // AXCloseButton, AXZoomButton, etc.
    let title: String?         // button label, window title
    let value: String?         // text field content, checkbox state
    let roleDescription: String? // human-readable role ("button", "text field")
    let frame: CGRect          // screen coordinates (x, y, width, height)
    let isEnabled: Bool
    let isFocused: Bool
    let depth: Int             // depth in the tree (0 = root)
    let childrenCount: Int     // number of direct children
    let actions: [String]      // available actions (AXPress, AXShowMenu, etc.)

    /// Compact single-line description for LLM consumption.
    /// Example: `[3] AXButton "OK" (120,300 80x24) enabled actions:[press]`
    var summary: String {
        let indent = String(repeating: "  ", count: depth)
        var parts = ["\(indent)[\(id)] \(role)"]
        if let title, !title.isEmpty { parts.append("\"\(title)\"") }
        if let value, !value.isEmpty { parts.append("val=\"\(value)\"") }
        let f = frame
        parts.append("(\(Int(f.origin.x)),\(Int(f.origin.y)) \(Int(f.width))x\(Int(f.height)))")
        if !isEnabled { parts.append("DISABLED") }
        if isFocused { parts.append("FOCUSED") }
        if !actions.isEmpty {
            let names = actions.map { $0.replacingOccurrences(of: "AX", with: "").lowercased() }
            parts.append("actions:[\(names.joined(separator: ","))]")
        }
        return parts.joined(separator: " ")
    }
}

// Note: CGRect already conforms to Codable in CoreGraphics (macOS 14+).
