import Foundation
import os

// MARK: - Chat View Model
//
// Manages sending messages and consuming SSE streams for a single conversation.
// Reports updates back via callback to AppViewModel (which owns thread state).

@Observable
@MainActor
final class ChatViewModel {

    // MARK: - Stream Update (callback payload)

    enum StreamUpdate: Sendable {
        case streamingStarted(traceId: String)
        case textDelta(String)
        case toolStarted(ToolEvent)
        case toolFinished(toolName: String, output: String?)
        case toolFailed(toolName: String, error: String?)
        case contextCompacted(summary: String?)
        case interrupted(HITLRequest)
        case completed(SerializedRunResult)
        case error(String)
    }

    // MARK: - State

    private(set) var isStreaming = false
    private var currentTask: Task<Void, Never>?

    // MARK: - Services

    private let sseClient: SSEStreamClient
    private let apiClient: AgentCoreClient

    init(sseClient: SSEStreamClient, apiClient: AgentCoreClient) {
        self.sseClient = sseClient
        self.apiClient = apiClient
    }

    // MARK: - Send

    func send(text: String, threadId: String, context: String? = nil, images: [String] = [], onUpdate: @escaping @MainActor (StreamUpdate) -> Void) {
        currentTask?.cancel()
        currentTask = nil
        isStreaming = true

        let client = sseClient
        let task = Task.detached { [weak self] in
            MantleLog.chat.info("stream.start threadId=\(threadId) inputLen=\(text.count) images=\(images.count) context=\(context != nil ? "yes" : "none")")
            let stream = await client.streamRun(threadId: threadId, input: text, context: context, images: images)

            for await event in stream {
                if Task.isCancelled { break }

                let update = Self.mapEvent(event)
                if let update {
                    await onUpdate(update)
                }
            }

            MantleLog.chat.info("stream.end threadId=\(threadId)")
            await MainActor.run { [weak self] in
                guard let self, self.currentTask?.isCancelled == false else { return }
                self.isStreaming = false
            }
        }
        currentTask = task
    }

    // MARK: - Resume (HITL)

    func resume(threadId: String, response: HITLResponse, onUpdate: @escaping @MainActor (StreamUpdate) -> Void) {
        currentTask?.cancel()
        currentTask = nil
        isStreaming = true

        let client = sseClient
        let task = Task.detached { [weak self] in
            let stream = await client.streamResume(threadId: threadId, resume: response)

            for await event in stream {
                if Task.isCancelled { break }

                let update = Self.mapEvent(event)
                if let update {
                    await onUpdate(update)
                }
            }

            await MainActor.run { [weak self] in
                guard let self, self.currentTask?.isCancelled == false else { return }
                self.isStreaming = false
            }
        }
        currentTask = task
    }

    // MARK: - Cancel

    func cancel() {
        currentTask?.cancel()
        currentTask = nil
        isStreaming = false
    }

    // MARK: - Event Mapping

    private nonisolated static func mapEvent(_ event: StreamEvent) -> StreamUpdate? {
        switch event {
        case .runStarted(let data):
            return .streamingStarted(traceId: data.traceId)

        case .textDelta(let data):
            return .textDelta(data.delta)

        case .toolStarted(let data):
            let toolEvent = ToolEvent(
                toolName: data.toolName,
                input: describeValue(data.input)
            )
            return .toolStarted(toolEvent)

        case .toolFinished(let data):
            return .toolFinished(
                toolName: data.toolName,
                output: describeValue(data.output)
            )

        case .toolFailed(let data):
            return .toolFailed(
                toolName: data.toolName,
                error: describeValue(data.error)
            )

        case .contextCompacted(let data):
            // Extract summary preview from compaction data if available
            let summary: String?
            if let compaction = data.contextCompaction?.value as? [String: Any] {
                summary = compaction["summaryPreview"] as? String
            } else {
                summary = nil
            }
            return .contextCompacted(summary: summary)

        case .runCompleted(let result):
            return .completed(result)

        case .runInterrupted(let result):
            if let request = result.interruptRequest {
                return .interrupted(request)
            } else {
                return .completed(result)
            }

        case .error(let data):
            return .error(data.message ?? "Unknown error")

        case .decodingError(let eventName, let detail):
            return .error("Failed to parse \(eventName): \(detail)")
        }
    }

    // MARK: - Helpers

    private nonisolated static func describeValue(_ value: AnyCodable?) -> String? {
        guard let value else { return nil }
        guard let data = try? JSONEncoder.prettyPrinting.encode(value) else {
            return String(describing: value.value)
        }
        return String(data: data, encoding: .utf8)
    }
}
