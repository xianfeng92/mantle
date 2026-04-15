import AppIntents
import Foundation

// MARK: - Ask Mantle Intent
//
// Exposes "Ask Mantle" to Shortcuts.app and Siri.
// Usage: Shortcuts → Ask Mantle → returns text response
// Siri:  "Ask Mantle about my schedule"

struct AskMantleIntent: AppIntent {

    static let title: LocalizedStringResource = "Ask Mantle"
    static let description = IntentDescription(
        "Ask your AI assistant a question and get a text response.",
        categoryName: "AI Assistant"
    )
    static let openAppWhenRun: Bool = false

    @Parameter(title: "Question", description: "The question to ask Mantle")
    var question: String

    @Parameter(title: "Wait for Response",
               description: "If true, waits for the full response. If false, sends the question and returns immediately.",
               default: true)
    var waitForResponse: Bool

    func perform() async throws -> some IntentResult & ReturnsValue<String> {
        let backendURL = UserDefaults.standard.string(forKey: "mantle.backendURL")
            ?? "http://127.0.0.1:8787"
        guard let url = URL(string: backendURL) else {
            return .result(value: "Error: Invalid backend URL")
        }

        let client = AgentCoreClient(baseURL: url)

        if !waitForResponse {
            // Fire-and-forget: create thread and send, don't wait
            Task {
                let threadId = try? await client.createThread()
                if let threadId {
                    _ = try? await client.run(threadId: threadId, input: question)
                }
            }
            return .result(value: "Question sent to Mantle.")
        }

        // Synchronous mode: wait for full response
        do {
            let threadId = try await client.createThread()
            let result = try await client.run(threadId: threadId, input: question)

            // Extract the last assistant message text
            let response = result.newMessages
                .filter { $0.role == .assistant }
                .map(\.text)
                .last ?? "No response received."

            return .result(value: response)
        } catch {
            return .result(value: "Error: \(error.localizedDescription)")
        }
    }
}
