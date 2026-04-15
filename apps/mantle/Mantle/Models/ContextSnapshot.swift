import Foundation

// MARK: - Context Snapshot
//
// Represents a point-in-time snapshot of the user's environment.
// Designed to be ~500 tokens when serialized as YAML for system prompt injection.
// All fields are optional — missing data means the monitor couldn't collect it
// (e.g., no Accessibility permission for window title).

struct ContextSnapshot: Codable, Sendable {
    var timestamp: Date
    var foreground: ForegroundInfo?
    var activity: ActivityInfo?
    var selection: SelectionInfo?
    var recentFiles: [RecentFileInfo]
    var focusMode: FocusModeInfo?

    init(
        timestamp: Date = .now,
        foreground: ForegroundInfo? = nil,
        activity: ActivityInfo? = nil,
        selection: SelectionInfo? = nil,
        recentFiles: [RecentFileInfo] = [],
        focusMode: FocusModeInfo? = nil
    ) {
        self.timestamp = timestamp
        self.foreground = foreground
        self.activity = activity
        self.selection = selection
        self.recentFiles = recentFiles
        self.focusMode = focusMode
    }
}

// MARK: - Sub-models

struct ForegroundInfo: Codable, Sendable {
    var appName: String
    var bundleId: String
    var windowTitle: String?
}

struct ActivityInfo: Codable, Sendable {
    var state: ActivityState
    var idleSeconds: Int

    /// Rough focus duration in minutes since last activity state change
    var focusDurationMin: Int?
}

struct SelectionInfo: Codable, Sendable {
    var text: String
    var sourceAppName: String?
    var sourceBundleId: String?
    var capturedAt: Date

    init?(
        rawText: String,
        sourceAppName: String? = nil,
        sourceBundleId: String? = nil,
        capturedAt: Date = .now,
        maxLength: Int = 2400
    ) {
        let trimmed = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        let limitedText = String(trimmed.prefix(maxLength))
        self.text = limitedText
        self.sourceAppName = sourceAppName
        self.sourceBundleId = sourceBundleId
        self.capturedAt = capturedAt
    }
}

enum ActivityState: String, Codable, Sendable {
    case active    // idle < 60s
    case idle      // idle 60s - 600s
    case away      // idle > 600s
}

struct RecentFileInfo: Codable, Sendable {
    var path: String
    var modifiedAt: Date
}

struct FocusModeInfo: Codable, Sendable {
    /// Whether Do Not Disturb / Focus Mode is active
    var isActive: Bool
}

// MARK: - YAML Serialization (for system prompt injection)

extension ContextSnapshot {
    /// Compact YAML representation for system prompt (~500 tokens max).
    /// Follows Aura design doc §4.3 format.
    func toPromptYAML() -> String {
        var lines: [String] = []

        // Instruction header
        lines.append("[Environment Context] The following is a real-time snapshot of the user's macOS desktop. Use it to understand what the user is currently doing. When the user says \"this file\", \"this page\", or asks about their current activity, refer to this context.")
        lines.append("")

        // Foreground
        if let fg = foreground {
            var fgLine = "Current app: \(fg.appName)"
            if let title = fg.windowTitle {
                fgLine += "\nWindow title: \(title)"
            }
            fgLine += "\nBundle ID: \(fg.bundleId)"
            lines.append(fgLine)
        }

        // Selected text
        if let selection {
            let source = selection.sourceAppName ?? "Unknown app"
            let recency = Date.now.timeIntervalSince(selection.capturedAt) < 15 ? "current" : "recent"
            lines.append("\(recency.capitalized) selected text from \(source) (\(selection.text.count) chars):")
            lines.append(selection.text)
        }

        // Recent files
        if !recentFiles.isEmpty {
            let names = recentFiles.prefix(5).map { URL(fileURLWithPath: $0.path).lastPathComponent }
            lines.append("Recently modified files: \(names.joined(separator: ", "))")
        }

        // Activity
        if let act = activity {
            var actLine = "User state: \(act.state.rawValue), idle \(act.idleSeconds)s"
            if let focus = act.focusDurationMin, focus > 0 {
                actLine += ", focused for \(focus) min"
            }
            lines.append(actLine)
        }

        // Focus Mode
        if let focus = focusMode, focus.isActive {
            lines.append("Focus Mode: active (Do Not Disturb is on — minimize interruptions)")
        }

        return lines.joined(separator: "\n")
    }

    /// Short YAML for Settings preview (no instruction header)
    func toPreviewYAML() -> String {
        var lines: [String] = ["# Current environment"]

        if let fg = foreground {
            var fgLine = "foreground: \(fg.appName)"
            if let title = fg.windowTitle {
                fgLine += " — \(title)"
            }
            lines.append(fgLine)
        }

        if let selection {
            var selectionLine = "selection: \(selection.text.count) chars"
            if let sourceAppName = selection.sourceAppName {
                selectionLine += " from \(sourceAppName)"
            }
            lines.append(selectionLine)
        }

        if !recentFiles.isEmpty {
            let names = recentFiles.prefix(5).map { URL(fileURLWithPath: $0.path).lastPathComponent }
            lines.append("recent: \(names.joined(separator: ", "))")
        }

        if let act = activity {
            var actLine = "activity: \(act.state.rawValue), idle \(act.idleSeconds)s"
            if let focus = act.focusDurationMin, focus > 0 {
                actLine += " | focus: \(focus) min"
            }
            lines.append(actLine)
        }

        return lines.joined(separator: "\n")
    }

    /// Pretty JSON for debug display
    func toDebugJSON() -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(self) else { return "{}" }
        return String(data: data, encoding: .utf8) ?? "{}"
    }
}
