import Foundation
import Carbon
import AppKit
import os

// MARK: - Global Hotkey Service
//
// Registers ⌥Space as a system-wide hotkey using Carbon's RegisterEventHotKey.
// When triggered, fires a callback to toggle Mantle window.

final class GlobalHotkeyService: @unchecked Sendable {

    // MARK: - Singleton

    @MainActor
    static let shared = GlobalHotkeyService()

    // MARK: - Callback

    @MainActor
    var onHotkey: (() -> Void)?

    // MARK: - Internals

    private var hotKeyRef: EventHotKeyRef?
    private var eventHandlerRef: EventHandlerRef?

    private init() {}

    deinit {
        unregister()
    }

    // MARK: - Register / Unregister

    /// Register ⌥Space as a global hotkey
    func register() {
        guard hotKeyRef == nil else { return } // Already registered

        // Define the hotkey: ⌥Space
        var hotKeyID = EventHotKeyID()
        hotKeyID.signature = OSType(0x4358_4858) // "CXHX" — Mantle HotKey
        hotKeyID.id = 1

        // Install Carbon event handler
        var eventType = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )

        let status = InstallEventHandler(
            GetApplicationEventTarget(),
            globalHotkeyHandler,
            1,
            &eventType,
            Unmanaged.passUnretained(self).toOpaque(),
            &eventHandlerRef
        )

        guard status == noErr else {
            MantleLog.app.error("GlobalHotkey: Failed to install event handler: \(status)")
            return
        }

        // Register the hotkey: ⌥Space
        let registerStatus = RegisterEventHotKey(
            UInt32(kVK_Space),
            UInt32(optionKey),
            hotKeyID,
            GetApplicationEventTarget(),
            0,
            &hotKeyRef
        )

        if registerStatus != noErr {
            MantleLog.app.error("GlobalHotkey: Failed to register: \(registerStatus)")
        } else {
            MantleLog.app.info("GlobalHotkey: Registered ⌥Space")
        }
    }

    /// Unregister the hotkey
    func unregister() {
        if let ref = hotKeyRef {
            UnregisterEventHotKey(ref)
            hotKeyRef = nil
        }
        if let handler = eventHandlerRef {
            RemoveEventHandler(handler)
            eventHandlerRef = nil
        }
    }

    // MARK: - Handler (called from C callback)

    fileprivate func fireCallback() {
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                self.onHotkey?()
            }
        }
    }
}

// MARK: - Carbon Event Handler (C function pointer)

private func globalHotkeyHandler(
    _ nextHandler: EventHandlerCallRef?,
    _ event: EventRef?,
    _ userData: UnsafeMutableRawPointer?
) -> OSStatus {
    guard let userData else { return OSStatus(eventNotHandledErr) }
    let service = Unmanaged<GlobalHotkeyService>.fromOpaque(userData).takeUnretainedValue()
    service.fireCallback()
    return noErr
}
