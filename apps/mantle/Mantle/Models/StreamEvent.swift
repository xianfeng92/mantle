import Foundation
import os

// MARK: - SSE Stream Events (mirrors agent-core/src/http.ts serializeStreamEvent)

enum StreamEvent: Sendable {
    case runStarted(RunStartedData)
    case textDelta(TextDeltaData)
    case toolStarted(ToolStartedData)
    case toolFinished(ToolFinishedData)
    case toolFailed(ToolFailedData)
    case contextCompacted(ContextCompactedData)
    case runCompleted(SerializedRunResult)
    case runInterrupted(SerializedRunResult)
    case error(ErrorData)
    case decodingError(eventName: String, detail: String)

    struct RunStartedData: Codable, Sendable {
        let traceId: String
        let threadId: String
        let mode: String
    }

    struct TextDeltaData: Codable, Sendable {
        let traceId: String?
        let threadId: String?
        let delta: String
        let runId: String?
        let nodeName: String?
    }

    struct ToolStartedData: Codable, Sendable {
        let traceId: String?
        let threadId: String?
        let toolName: String
        let input: AnyCodable?
        let runId: String?
    }

    struct ToolFinishedData: Codable, Sendable {
        let traceId: String?
        let threadId: String?
        let toolName: String
        let output: AnyCodable?
        let runId: String?
    }

    struct ToolFailedData: Codable, Sendable {
        let traceId: String?
        let threadId: String?
        let toolName: String
        let error: AnyCodable?
        let runId: String?
    }

    struct ContextCompactedData: Codable, Sendable {
        let traceId: String?
        let threadId: String?
        let contextCompaction: AnyCodable?
    }

    struct ErrorData: Codable, Sendable {
        let message: String?
        let phase: String?
        let rule: String?
        let source: String?
    }
}

// MARK: - Parsing from SSE event name + JSON data

extension StreamEvent {
    static func parse(eventName: String, jsonData: Data) -> StreamEvent? {
        let decoder = JSONDecoder()

        do {
            switch eventName {
            case "run_started":
                return .runStarted(try decoder.decode(RunStartedData.self, from: jsonData))
            case "text_delta":
                return .textDelta(try decoder.decode(TextDeltaData.self, from: jsonData))
            case "tool_started":
                return .toolStarted(try decoder.decode(ToolStartedData.self, from: jsonData))
            case "tool_finished":
                return .toolFinished(try decoder.decode(ToolFinishedData.self, from: jsonData))
            case "tool_failed":
                return .toolFailed(try decoder.decode(ToolFailedData.self, from: jsonData))
            case "context_compacted":
                return .contextCompacted(try decoder.decode(ContextCompactedData.self, from: jsonData))
            case "run_completed":
                return .runCompleted(try decoder.decode(SerializedRunResult.self, from: jsonData))
            case "run_interrupted":
                return .runInterrupted(try decoder.decode(SerializedRunResult.self, from: jsonData))
            case "error":
                return .error(try decoder.decode(ErrorData.self, from: jsonData))
            default:
                return nil
            }
        } catch {
            MantleLog.sse.warning("Failed to parse event '\(eventName)': \(error)")
            return .decodingError(eventName: eventName, detail: error.localizedDescription)
        }
    }
}
