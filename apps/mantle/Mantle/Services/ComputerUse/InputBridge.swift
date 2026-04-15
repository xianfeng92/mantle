import CoreGraphics
import Foundation
import os

// MARK: - InputBridge
//
// Synthesizes mouse and keyboard events via the CGEvent API.
// All methods are nonisolated and thread-safe (CGEvent is C-level, no shared state).
//
// Requires: Accessibility permission (same as AXBridge).
// Must be non-sandboxed — sandboxed apps cannot post CGEvents.

struct InputBridge: Sendable {

    // MARK: - Mouse

    /// Move the cursor to a screen coordinate (no click).
    static func moveMouse(to point: CGPoint) {
        let event = CGEvent(
            mouseEventSource: source(),
            mouseType: .mouseMoved,
            mouseCursorPosition: point,
            mouseButton: .left
        )
        event?.post(tap: .cghidEventTap)
    }

    /// Left-click at a screen coordinate.
    static func leftClick(at point: CGPoint) {
        postClick(at: point, downType: .leftMouseDown, upType: .leftMouseUp, button: .left)
    }

    /// Right-click at a screen coordinate.
    static func rightClick(at point: CGPoint) {
        postClick(at: point, downType: .rightMouseDown, upType: .rightMouseUp, button: .right)
    }

    /// Double-click at a screen coordinate.
    static func doubleClick(at point: CGPoint) {
        let src = source()

        // First click
        postClick(at: point, downType: .leftMouseDown, upType: .leftMouseUp, button: .left, source: src)
        usleep(20_000) // 20ms gap

        // Second click — must set clickState = 2
        let down = CGEvent(mouseEventSource: src, mouseType: .leftMouseDown,
                           mouseCursorPosition: point, mouseButton: .left)
        down?.setIntegerValueField(.mouseEventClickState, value: 2)
        let up = CGEvent(mouseEventSource: src, mouseType: .leftMouseUp,
                         mouseCursorPosition: point, mouseButton: .left)
        up?.setIntegerValueField(.mouseEventClickState, value: 2)
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
    }

    /// Triple-click at a screen coordinate (select line/paragraph).
    static func tripleClick(at point: CGPoint) {
        let src = source()

        // First click
        postClick(at: point, downType: .leftMouseDown, upType: .leftMouseUp, button: .left, source: src)
        usleep(20_000)

        // Second click
        let d2 = CGEvent(mouseEventSource: src, mouseType: .leftMouseDown,
                         mouseCursorPosition: point, mouseButton: .left)
        d2?.setIntegerValueField(.mouseEventClickState, value: 2)
        let u2 = CGEvent(mouseEventSource: src, mouseType: .leftMouseUp,
                         mouseCursorPosition: point, mouseButton: .left)
        u2?.setIntegerValueField(.mouseEventClickState, value: 2)
        d2?.post(tap: .cghidEventTap)
        u2?.post(tap: .cghidEventTap)
        usleep(20_000)

        // Third click
        let d3 = CGEvent(mouseEventSource: src, mouseType: .leftMouseDown,
                         mouseCursorPosition: point, mouseButton: .left)
        d3?.setIntegerValueField(.mouseEventClickState, value: 3)
        let u3 = CGEvent(mouseEventSource: src, mouseType: .leftMouseUp,
                         mouseCursorPosition: point, mouseButton: .left)
        u3?.setIntegerValueField(.mouseEventClickState, value: 3)
        d3?.post(tap: .cghidEventTap)
        u3?.post(tap: .cghidEventTap)
    }

    /// Scroll at a coordinate. Positive deltaY = scroll up, negative = down.
    static func scroll(at point: CGPoint, deltaY: Int32, deltaX: Int32 = 0) {
        // Move cursor to position first
        moveMouse(to: point)
        usleep(10_000)

        let event = CGEvent(
            scrollWheelEvent2Source: source(),
            units: .pixel,
            wheelCount: 2,
            wheel1: deltaY,
            wheel2: deltaX,
            wheel3: 0
        )
        event?.post(tap: .cghidEventTap)
    }

    /// Drag from one point to another.
    static func drag(from start: CGPoint, to end: CGPoint, steps: Int = 20, duration: TimeInterval = 0.3) {
        let src = source()

        // Mouse down at start
        let down = CGEvent(mouseEventSource: src, mouseType: .leftMouseDown,
                           mouseCursorPosition: start, mouseButton: .left)
        down?.post(tap: .cghidEventTap)

        let stepDelay = UInt32(duration / Double(steps) * 1_000_000)

        // Interpolated drag
        for i in 1...steps {
            let fraction = CGFloat(i) / CGFloat(steps)
            let x = start.x + (end.x - start.x) * fraction
            let y = start.y + (end.y - start.y) * fraction

            let drag = CGEvent(mouseEventSource: src, mouseType: .leftMouseDragged,
                               mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)
            drag?.post(tap: .cghidEventTap)
            usleep(stepDelay)
        }

        // Mouse up at end
        let up = CGEvent(mouseEventSource: src, mouseType: .leftMouseUp,
                         mouseCursorPosition: end, mouseButton: .left)
        up?.post(tap: .cghidEventTap)
    }

    // MARK: - Keyboard

    /// Type Unicode text (supports Chinese, emoji, any language).
    /// Chunks into groups of 20 UTF-16 code units per CGEvent.
    static func typeText(_ text: String) {
        let src = source()
        let utf16 = Array(text.utf16)
        let chunkSize = 20

        for offset in stride(from: 0, to: utf16.count, by: chunkSize) {
            let end = min(offset + chunkSize, utf16.count)
            let chunk = Array(utf16[offset..<end])

            let keyDown = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true)
            keyDown?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
            keyDown?.post(tap: .cghidEventTap)

            let keyUp = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false)
            keyUp?.post(tap: .cghidEventTap)

            usleep(10_000) // 10ms between chunks
        }
        MantleLog.computerUse.debug("[Input] typed \(utf16.count) chars")
    }

    /// Type text via clipboard (more reliable for complex text / CJK input methods).
    /// Saves and restores the previous clipboard content.
    static func typeTextViaClipboard(_ text: String) {
        // TODO: implement clipboard-based typing as fallback
        // 1. Save current pasteboard
        // 2. Set text to pasteboard
        // 3. Cmd+V
        // 4. Restore original pasteboard
        typeText(text) // for now, delegate to direct typing
    }

    /// Press a key with optional modifiers.
    ///
    /// - Parameters:
    ///   - keyCode: Virtual key code (see KeyCode constants below).
    ///   - flags: Modifier flags (.maskCommand, .maskShift, .maskAlternate, .maskControl).
    static func pressKey(_ keyCode: CGKeyCode, flags: CGEventFlags = []) {
        let src = source()

        let keyDown = CGEvent(keyboardEventSource: src, virtualKey: keyCode, keyDown: true)
        keyDown?.flags = flags
        keyDown?.post(tap: .cghidEventTap)

        let keyUp = CGEvent(keyboardEventSource: src, virtualKey: keyCode, keyDown: false)
        keyUp?.flags = flags
        keyUp?.post(tap: .cghidEventTap)
    }

    /// Press a key combination by name.
    ///
    /// - Parameters:
    ///   - key: Key name (see `keyCodeFromName`).
    ///   - modifiers: Modifier names: "cmd", "shift", "alt"/"option", "ctrl"/"control".
    static func pressKey(name key: String, modifiers: [String] = []) {
        guard let code = keyCodeFromName(key) else {
            MantleLog.computerUse.warning("[Input] unknown key name: \(key)")
            return
        }

        var flags: CGEventFlags = []
        for mod in modifiers {
            switch mod.lowercased() {
            case "cmd", "command": flags.insert(.maskCommand)
            case "shift": flags.insert(.maskShift)
            case "alt", "option": flags.insert(.maskAlternate)
            case "ctrl", "control": flags.insert(.maskControl)
            default:
                MantleLog.computerUse.warning("[Input] unknown modifier: \(mod)")
            }
        }
        pressKey(code, flags: flags)
    }

    // MARK: - Convenience Shortcuts

    static func copy()      { pressKey(0x08, flags: .maskCommand) } // Cmd+C
    static func paste()     { pressKey(0x09, flags: .maskCommand) } // Cmd+V
    static func cut()       { pressKey(0x07, flags: .maskCommand) } // Cmd+X
    static func undo()      { pressKey(0x06, flags: .maskCommand) } // Cmd+Z
    static func redo()      { pressKey(0x06, flags: [.maskCommand, .maskShift]) }
    static func selectAll() { pressKey(0x00, flags: .maskCommand) } // Cmd+A
    static func save()      { pressKey(0x01, flags: .maskCommand) } // Cmd+S
    static func tab()       { pressKey(0x30) }
    static func enter()     { pressKey(0x24) }
    static func escape()    { pressKey(0x35) }
    static func delete()    { pressKey(0x33) }
    static func space()     { pressKey(0x31) }

    // MARK: - Private Helpers

    private static func source() -> CGEventSource? {
        CGEventSource(stateID: .hidSystemState)
    }

    private static func postClick(
        at point: CGPoint,
        downType: CGEventType,
        upType: CGEventType,
        button: CGMouseButton,
        source src: CGEventSource? = nil
    ) {
        let s = src ?? source()
        let down = CGEvent(mouseEventSource: s, mouseType: downType,
                           mouseCursorPosition: point, mouseButton: button)
        let up = CGEvent(mouseEventSource: s, mouseType: upType,
                         mouseCursorPosition: point, mouseButton: button)
        down?.post(tap: .cghidEventTap)
        usleep(10_000) // 10ms dwell
        up?.post(tap: .cghidEventTap)
    }

    // MARK: - Key Code Mapping

    /// Map human-readable key names to macOS virtual key codes.
    static func keyCodeFromName(_ name: String) -> CGKeyCode? {
        // Single printable character → look up in table
        if name.count == 1, let ch = name.lowercased().first, let code = charToKeyCode[ch] {
            return code
        }
        return specialKeyCode[name.lowercased()]
    }

    private static let specialKeyCode: [String: CGKeyCode] = [
        "return": 0x24, "enter": 0x24,
        "tab": 0x30,
        "space": 0x31,
        "delete": 0x33, "backspace": 0x33,
        "escape": 0x35, "esc": 0x35,
        "left": 0x7B, "right": 0x7C,
        "down": 0x7D, "up": 0x7E,
        "home": 0x73, "end": 0x77,
        "pageup": 0x74, "pagedown": 0x79,
        "f1": 0x7A, "f2": 0x78, "f3": 0x63, "f4": 0x76,
        "f5": 0x60, "f6": 0x61, "f7": 0x62, "f8": 0x64,
        "f9": 0x65, "f10": 0x6D, "f11": 0x67, "f12": 0x6F,
        "forwarddelete": 0x75,
    ]

    /// US keyboard layout character → key code map (covers a-z, 0-9, common symbols).
    private static let charToKeyCode: [Character: CGKeyCode] = [
        "a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04, "g": 0x05,
        "z": 0x06, "x": 0x07, "c": 0x08, "v": 0x09, "b": 0x0B, "q": 0x0C,
        "w": 0x0D, "e": 0x0E, "r": 0x0F, "y": 0x10, "t": 0x11, "1": 0x12,
        "2": 0x13, "3": 0x14, "4": 0x15, "6": 0x16, "5": 0x17, "=": 0x18,
        "9": 0x19, "7": 0x1A, "-": 0x1B, "8": 0x1C, "0": 0x1D, "]": 0x1E,
        "o": 0x1F, "u": 0x20, "[": 0x21, "i": 0x22, "p": 0x23, "l": 0x25,
        "j": 0x26, "'": 0x27, "k": 0x28, ";": 0x29, "\\": 0x2A, ",": 0x2B,
        "/": 0x2C, "n": 0x2D, "m": 0x2E, ".": 0x2F, "`": 0x32,
    ]
}
