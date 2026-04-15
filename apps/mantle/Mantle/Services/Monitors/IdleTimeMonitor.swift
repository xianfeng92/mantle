import Foundation
import CoreGraphics

// MARK: - Idle Time Monitor
//
// Tracks how long since the user's last keyboard/mouse/trackpad input.
// Uses CGEventSource — no permissions needed, no polling of its own
// (called by ContextDaemon's 10-second polling loop).

@Observable
@MainActor
final class IdleTimeMonitor {

    /// Seconds since last user input event (keyboard, mouse, trackpad)
    var currentIdleSeconds: Int {
        let idle = CGEventSource.secondsSinceLastEventType(
            .combinedSessionState,
            eventType: CGEventType(rawValue: ~0)!  // All event types
        )
        return max(0, Int(idle))
    }
}
