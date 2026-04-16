import Foundation
import os

// MARK: - SSE Stream Client
//
// Connects to agent-core's POST /runs/stream and POST /resume/stream
// endpoints, parses SSE events, and yields them as an AsyncStream.
//
// Uses URLSession.bytes.lines for proper UTF-8 decoding.
// The SSELineParser handles the fact that .lines strips empty lines
// by flushing on new "event:" lines instead.
//
// Includes automatic retry on transient network errors with exponential backoff.

actor SSEStreamClient {
    private let baseURL: URL
    private let session: URLSession

    /// Maximum number of reconnection attempts on transient errors
    private let maxRetries: Int

    /// Base delay for exponential backoff (doubled each retry)
    private let baseRetryDelay: TimeInterval

    init(
        baseURL: URL,
        session: URLSession = .shared,
        maxRetries: Int = 3,
        baseRetryDelay: TimeInterval = 1.0
    ) {
        self.baseURL = baseURL
        self.session = session
        self.maxRetries = maxRetries
        self.baseRetryDelay = baseRetryDelay
    }

    // MARK: - Stream Run

    func streamRun(threadId: String, input: String, context: String? = nil, images: [String] = [], scopeKey: String? = nil) -> AsyncStream<StreamEvent> {
        let runInput: RunStreamInput
        if images.isEmpty {
            runInput = .text(input)
        } else {
            var blocks: [ContentBlockPayload] = [.init(type: "text", text: input)]
            for dataUri in images {
                blocks.append(.init(type: "image_url", imageUrl: .init(url: dataUri)))
            }
            runInput = .multimodal(blocks)
        }
        let body = RunStreamRequest(threadId: threadId, input: runInput, context: context, scopeKey: scopeKey)
        return openSSEStream(path: "runs/stream", body: body)
    }

    func streamResume(threadId: String, resume: HITLResponse, scopeKey: String? = nil) -> AsyncStream<StreamEvent> {
        let body = ResumeStreamRequest(threadId: threadId, resume: resume, scopeKey: scopeKey)
        return openSSEStream(path: "resume/stream", body: body)
    }

    // MARK: - Internal

    private func openSSEStream<T: Encodable & Sendable>(path: String, body: T) -> AsyncStream<StreamEvent> {
        let url = baseURL.appendingPathComponent(path)
        let requestBody = body
        let urlSession = session
        let retries = maxRetries
        let retryDelay = baseRetryDelay

        return AsyncStream { continuation in
            let task = Task {
                var attempt = 0
                var hasReceivedEvents = false

                while !Task.isCancelled {
                    do {
                        var request = URLRequest(url: url)
                        request.httpMethod = "POST"
                        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                        request.httpBody = try JSONEncoder().encode(requestBody)
                        request.timeoutInterval = 300

                        let (bytes, response) = try await urlSession.bytes(for: request)

                        guard let httpResponse = response as? HTTPURLResponse else {
                            MantleLog.sse.error("Invalid response type")
                            MantleLog.runtime("sse", "invalid response type path=\(path)")
                            continuation.yield(.error(.init(
                                message: "Invalid response type",
                                phase: nil, rule: nil, source: nil
                            )))
                            continuation.finish()
                            return
                        }

                        // Non-retryable HTTP errors (4xx = client error, not transient)
                        if (400..<500).contains(httpResponse.statusCode) {
                            MantleLog.sse.error("Client error: \(httpResponse.statusCode)")
                            MantleLog.runtime("sse", "client error path=\(path) status=\(httpResponse.statusCode)")
                            continuation.yield(.error(.init(
                                message: "HTTP \(httpResponse.statusCode)",
                                phase: nil, rule: nil, source: nil
                            )))
                            continuation.finish()
                            return
                        }

                        // Server errors (5xx) are retryable
                        guard httpResponse.statusCode == 200 else {
                            MantleLog.sse.error("HTTP error: \(httpResponse.statusCode)")
                            MantleLog.runtime("sse", "http error path=\(path) status=\(httpResponse.statusCode)")
                            throw SSETransientError.httpError(httpResponse.statusCode)
                        }

                        MantleLog.sse.info("Connected (attempt \(attempt + 1))")
                        MantleLog.runtime("sse", "connected path=\(path) attempt=\(attempt + 1)")
                        hasReceivedEvents = false

                        var parser = SSELineParser()

                        for try await line in bytes.lines {
                            if Task.isCancelled { break }

                            if let event = parser.feed(line) {
                                hasReceivedEvents = true
                                continuation.yield(event)

                                // Terminal events — no retry after these
                                if case .runCompleted = event {
                                    if let flushed = parser.flush() { continuation.yield(flushed) }
                                    continuation.finish()
                                    return
                                }
                                if case .runInterrupted = event {
                                    if let flushed = parser.flush() { continuation.yield(flushed) }
                                    continuation.finish()
                                    return
                                }
                                if case .error = event {
                                    if let flushed = parser.flush() { continuation.yield(flushed) }
                                    continuation.finish()
                                    return
                                }
                            }
                        }

                        // Flush the last buffered event
                        if let event = parser.flush() {
                            hasReceivedEvents = true
                            continuation.yield(event)
                        }

                        // If we got terminal events already, we're done
                        if hasReceivedEvents {
                            // Stream ended cleanly (server closed connection after run completed)
                            MantleLog.sse.info("Stream finished")
                            MantleLog.runtime("sse", "stream finished path=\(path)")
                            continuation.finish()
                            return
                        }

                        // Empty response with no events — treat as transient
                        throw SSETransientError.emptyStream

                    } catch is CancellationError {
                        MantleLog.sse.info("Cancelled")
                        MantleLog.runtime("sse", "cancelled path=\(path)")
                        continuation.finish()
                        return
                    } catch let error as SSETransientError {
                        attempt += 1
                        if attempt > retries {
                            MantleLog.sse.error("Max retries (\(retries)) exceeded: \(error)")
                            MantleLog.runtime("sse", "max retries exceeded path=\(path) retries=\(retries) error=\(error.localizedDescription)")
                            continuation.yield(.error(.init(
                                message: "Connection lost after \(retries) retries: \(error.localizedDescription)",
                                phase: nil, rule: nil, source: nil
                            )))
                            continuation.finish()
                            return
                        }

                        let delay = retryDelay * pow(2.0, Double(attempt - 1))
                        MantleLog.sse.warning("Transient error (attempt \(attempt)/\(retries)), retrying in \(delay)s: \(error)")
                        MantleLog.runtime("sse", "transient retry path=\(path) attempt=\(attempt) delay=\(delay)s error=\(error.localizedDescription)")
                        try? await Task.sleep(for: .seconds(delay))
                        continue

                    } catch {
                        // Classify network errors as retryable
                        if Self.isTransientNetworkError(error) {
                            attempt += 1
                            if attempt > retries {
                                MantleLog.sse.error("Max retries (\(retries)) exceeded: \(error)")
                                MantleLog.runtime("sse", "network retries exceeded path=\(path) retries=\(retries) error=\(error.localizedDescription)")
                                continuation.yield(.error(.init(
                                    message: "Connection lost after \(retries) retries: \(error.localizedDescription)",
                                    phase: nil, rule: nil, source: nil
                                )))
                                continuation.finish()
                                return
                            }

                            let delay = retryDelay * pow(2.0, Double(attempt - 1))
                            MantleLog.sse.warning("Network error (attempt \(attempt)/\(retries)), retrying in \(delay)s: \(error)")
                            MantleLog.runtime("sse", "network retry path=\(path) attempt=\(attempt) delay=\(delay)s error=\(error.localizedDescription)")
                            try? await Task.sleep(for: .seconds(delay))
                            continue
                        }

                        // Non-retryable error
                        MantleLog.sse.error("Fatal error: \(error)")
                        MantleLog.runtime("sse", "fatal error path=\(path) error=\(error.localizedDescription)")
                        continuation.yield(.error(.init(
                            message: error.localizedDescription,
                            phase: nil, rule: nil, source: nil
                        )))
                        continuation.finish()
                        return
                    }
                }

                // Task cancelled during retry loop
                continuation.finish()
            }

            continuation.onTermination = { @Sendable _ in
                task.cancel()
            }
        }
    }

    // MARK: - Error Classification

    /// Errors that should trigger a retry
    private enum SSETransientError: LocalizedError {
        case httpError(Int)
        case emptyStream

        var errorDescription: String? {
            switch self {
            case .httpError(let code): "HTTP \(code)"
            case .emptyStream: "Empty stream response"
            }
        }
    }

    /// Check if a network error is transient and worth retrying
    private static func isTransientNetworkError(_ error: Error) -> Bool {
        let nsError = error as NSError
        guard nsError.domain == NSURLErrorDomain else { return false }

        let retryableCodes: Set<Int> = [
            NSURLErrorTimedOut,                     // -1001
            NSURLErrorCannotFindHost,               // -1003
            NSURLErrorCannotConnectToHost,           // -1004
            NSURLErrorNetworkConnectionLost,         // -1005
            NSURLErrorDNSLookupFailed,              // -1006
            NSURLErrorNotConnectedToInternet,        // -1009
            NSURLErrorSecureConnectionFailed,        // -1200
        ]

        return retryableCodes.contains(nsError.code)
    }
}

// MARK: - Request Bodies

/// Multimodal input: either plain text or an array of content blocks.
private enum RunStreamInput: Encodable, Sendable {
    case text(String)
    case multimodal([ContentBlockPayload])

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .text(let string):
            try container.encode(string)
        case .multimodal(let blocks):
            try container.encode(blocks)
        }
    }
}

/// A single content block in the OpenAI-compatible multimodal format.
private struct ContentBlockPayload: Encodable, Sendable {
    let type: String
    var text: String?
    var imageUrl: ImageUrlPayload?

    enum CodingKeys: String, CodingKey {
        case type
        case text
        case imageUrl = "image_url"
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)
        if let text { try container.encode(text, forKey: .text) }
        if let imageUrl { try container.encode(imageUrl, forKey: .imageUrl) }
    }
}

private struct ImageUrlPayload: Encodable, Sendable {
    let url: String
}

private struct RunStreamRequest: Encodable, Sendable {
    let threadId: String
    let input: RunStreamInput
    /// Optional environment context (YAML) injected as system message on the backend
    let context: String?
    /// Interruption scope key — same-scope requests abort the previous on the server
    let scopeKey: String?
}

private struct ResumeStreamRequest: Encodable, Sendable {
    let threadId: String
    let resume: HITLResponse
    /// Interruption scope key — same-scope requests abort the previous on the server
    let scopeKey: String?
}
