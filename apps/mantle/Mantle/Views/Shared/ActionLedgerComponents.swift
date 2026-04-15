import Foundation
import SwiftUI

// MARK: - Action Ledger Shared Components

enum LedgerTone {
    case info
    case success
    case warning
    case danger

    var color: Color {
        switch self {
        case .info:
            return Design.accent
        case .success:
            return Design.accent.opacity(0.7)
        case .warning:
            return .secondary
        case .danger:
            return Design.stateDanger
        }
    }
}

struct LedgerStatusChip: View {
    let title: String
    let tone: LedgerTone
    var systemImage: String? = nil

    var body: some View {
        HStack(spacing: 6) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.caption2)
            }
            Text(title)
                .font(.caption2.weight(.semibold))
        }
        .foregroundStyle(tone.color)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(tone.color.opacity(0.08), in: Capsule())
    }
}

struct LedgerInfoRow: View {
    let label: String
    let value: String
    var tone: LedgerTone? = nil

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Text(label.uppercased())
                .font(.caption2.weight(.semibold))
                .foregroundStyle(tone?.color ?? Design.textSecondary)
                .frame(width: 48, alignment: .leading)

            Text(value)
                .font(.caption)
                .foregroundStyle(Design.textSecondary)
                .multilineTextAlignment(.leading)

            Spacer(minLength: 0)
        }
    }
}

struct LedgerSummary {
    let title: String
    let symbol: String
    let summary: String?
    let target: String?
    let result: String?
}

enum LedgerPresenter {
    static func toolDisplayName(_ name: String) -> String {
        switch name {
        case "execute":
            return "Shell Action"
        case "write_file":
            return "Write File"
        case "edit_file":
            return "Edit File"
        case "read_file":
            return "Read File"
        case "list_files":
            return "List Files"
        default:
            return name
                .split(separator: "_")
                .map { $0.prefix(1).uppercased() + $0.dropFirst() }
                .joined(separator: " ")
        }
    }

    static func toolSymbol(_ name: String) -> String {
        switch name {
        case "execute":
            return "terminal"
        case "write_file":
            return "doc.badge.plus"
        case "edit_file":
            return "pencil.line"
        case "read_file":
            return "doc.text.magnifyingglass"
        case "list_files":
            return "folder"
        default:
            return "wrench.and.screwdriver"
        }
    }

    static func tone(for status: ToolEventStatus) -> LedgerTone {
        switch status {
        case .running:
            return .info
        case .completed:
            return .success
        case .failed:
            return .danger
        }
    }

    static func statusSymbol(for status: ToolEventStatus) -> String {
        switch status {
        case .running:
            return "clock.badge.checkmark"
        case .completed:
            return "checkmark.circle"
        case .failed:
            return "xmark.octagon"
        }
    }

    static func statusTitle(for status: ToolEventStatus) -> String {
        switch status {
        case .running:
            return "In Progress"
        case .completed:
            return "Completed"
        case .failed:
            return "Failed"
        }
    }

    static func summary(for event: ToolEvent) -> LedgerSummary {
        let inputObject = parseJSONObjectString(event.input)
        let outputObject = parseJSONObjectString(event.output)

        let summary = firstMeaningful(
            commandSummary(from: inputObject),
            compactPlainText(event.output),
            compactPlainText(event.input)
        )

        let target = firstMeaningful(
            primaryTarget(from: inputObject),
            primaryTarget(from: outputObject)
        )

        let result: String?
        switch event.status {
        case .running:
            result = "Waiting for the tool to finish."
        case .completed:
            result = firstMeaningful(
                compactPlainText(event.output),
                "Action completed."
            )
        case .failed:
            result = firstMeaningful(
                compactPlainText(event.error),
                "Action failed."
            )
        }

        return LedgerSummary(
            title: toolDisplayName(event.toolName),
            symbol: toolSymbol(event.toolName),
            summary: summary,
            target: target,
            result: result
        )
    }

    static func summary(for action: ActionRequest) -> LedgerSummary {
        let argsObject = action.args.mapValues(\.value)

        let summary = firstMeaningful(
            action.description,
            commandSummary(from: argsObject),
            compactPlainText(renderJSONObject(argsObject))
        )

        let target = primaryTarget(from: argsObject)

        return LedgerSummary(
            title: toolDisplayName(action.name),
            symbol: toolSymbol(action.name),
            summary: compactPlainText(summary, limit: 140),
            target: target,
            result: nil
        )
    }

    static func actionTone(for decision: DecisionType) -> LedgerTone {
        switch decision {
        case .approve:
            return .success
        case .edit:
            return .info
        case .reject:
            return .danger
        }
    }

    static func decisionTitle(for decision: DecisionType) -> String {
        switch decision {
        case .approve:
            return "Approve"
        case .edit:
            return "Edit"
        case .reject:
            return "Reject"
        }
    }

    static func decisionSymbol(for decision: DecisionType) -> String {
        switch decision {
        case .approve:
            return "checkmark.circle"
        case .edit:
            return "slider.horizontal.3"
        case .reject:
            return "xmark.circle"
        }
    }

    static func likelySupportsRollback(_ request: HITLRequest) -> Bool {
        request.actionRequests.contains { action in
            let flattened = [
                action.name.lowercased(),
                action.description?.lowercased() ?? "",
                renderJSONObject(action.args.mapValues(\.value)).lowercased()
            ].joined(separator: " ")

            return flattened.hasPrefix("mv ")
                || flattened.contains(" mv ")
                || flattened.contains("move ")
                || flattened.contains("destpath")
                || flattened.contains("sourcepath")
        }
    }

    private static func firstMeaningful(_ values: String?...) -> String? {
        values.first(where: { value in
            guard let value else { return false }
            return !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }) ?? nil
    }

    private static func commandSummary(from object: Any?) -> String? {
        if let dict = object as? [String: Any] {
            if let command = dict["command"] as? String {
                return compactCommand(command)
            }
            if let path = dict["path"] as? String {
                return "Operate on \(shortenPath(path))"
            }
        }

        if let string = object as? String {
            return compactCommand(string)
        }

        return nil
    }

    private static func primaryTarget(from object: Any?) -> String? {
        guard let object else { return nil }

        if let dict = object as? [String: Any] {
            for key in ["path", "filePath", "sourcePath", "destPath", "target", "directory", "cwd", "url"] {
                if let value = dict[key] as? String, !value.isEmpty {
                    return shortenPath(value)
                }
            }

            if let paths = dict["paths"] as? [String], let first = paths.first {
                return shortenPath(first)
            }

            if let files = dict["files"] as? [String], let first = files.first {
                return shortenPath(first)
            }
        }

        if let string = object as? String, string.contains("/") {
            return shortenPath(string)
        }

        return nil
    }

    private static func parseJSONObjectString(_ text: String?) -> Any? {
        guard let text, let data = text.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: data)
    }

    private static func renderJSONObject(_ value: Any) -> String {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]),
              let string = String(data: data, encoding: .utf8) else {
            return String(describing: value)
        }
        return string
    }

    static func compactPlainText(_ text: String?, limit: Int = 120) -> String? {
        guard let text else { return nil }
        let cleaned = text
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\t", with: " ")
            .replacingOccurrences(of: "  +", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)

        guard !cleaned.isEmpty else { return nil }
        if cleaned.count <= limit {
            return cleaned
        }
        let index = cleaned.index(cleaned.startIndex, offsetBy: limit)
        return "\(cleaned[..<index])…"
    }

    private static func compactCommand(_ command: String) -> String? {
        let trimmed = command
            .split(separator: "\n")
            .first
            .map(String.init)?
            .trimmingCharacters(in: .whitespacesAndNewlines)

        return compactPlainText(trimmed, limit: 90)
    }

    private static func shortenPath(_ path: String) -> String {
        let components = path.split(separator: "/").suffix(3)
        if components.isEmpty {
            return path
        }
        return components.joined(separator: "/")
    }
}
