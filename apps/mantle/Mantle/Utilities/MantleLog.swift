import Foundation
import os

/// Unified logging for Mantle using Apple's os.Logger.
///
/// Usage:
///   MantleLog.backend.info("process started", metadata: ["port": 8787])
///   MantleLog.sse.error("connection failed", metadata: ["error": error.localizedDescription])
///
/// View logs in Console.app → filter by subsystem "com.mantle.app"
enum MantleLog {
    private static let subsystem = Bundle.main.bundleIdentifier ?? "com.mantle.app"

    /// Backend process management (start, stop, crash, health)
    static let backend = Logger(subsystem: subsystem, category: "backend")

    /// SSE streaming (connect, disconnect, events, retry)
    static let sse = Logger(subsystem: subsystem, category: "sse")

    /// Agent-core REST API calls (health, threads, skills, diagnostics)
    static let api = Logger(subsystem: subsystem, category: "api")

    /// Environment context (daemon, monitors, snapshots)
    static let context = Logger(subsystem: subsystem, category: "context")

    /// Chat & messaging (send, receive, HITL, streaming)
    static let chat = Logger(subsystem: subsystem, category: "chat")

    /// App lifecycle (launch, hotkey, persistence, migration)
    static let app = Logger(subsystem: subsystem, category: "app")

    /// Computer use (AX tree, input synthesis, screenshots)
    static let computerUse = Logger(subsystem: subsystem, category: "computer-use")
}
