import Foundation
import Observation
import os

// MARK: - ReturnsService
//
// Pulls the Returns Plane from agent-core:
//   - GET  /returns?unackedOnly=true   → initial list
//   - GET  /returns/stream              → SSE subscription for new entries
//   - POST /returns/:id/ack             → mark as read
//
// Minimal consumer for the menu-bar Inbox button. Keeps in-memory state only;
// server's JSONL is the source of truth and survives restarts.

@Observable
@MainActor
final class ReturnsService {
    private let baseURL: URL
    private let session: URLSession
    private let decoder = JSONDecoder()

    /// Most recent entries, newest first. Capped to displayedCap.
    private(set) var entries: [ReturnEntry] = []
    /// Whether the SSE stream is currently open.
    private(set) var isStreaming: Bool = false
    /// Last error message, if any (surfaced in UI when stream can't recover).
    private(set) var lastError: String?

    private var sseTask: Task<Void, Never>?
    private let displayedCap = 100

    init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    // MARK: - Public API

    var unreadCount: Int {
        entries.filter { !$0.isAcked }.count
    }

    /// Start or restart: fetch the initial list and open the SSE subscription.
    /// Safe to call multiple times — previous subscription is cancelled.
    func start() {
        stop()
        Task { await refreshUnread() }
        sseTask = Task { await runSubscription() }
    }

    /// Stop the SSE subscription. Entries stay in memory.
    func stop() {
        sseTask?.cancel()
        sseTask = nil
        isStreaming = false
    }

    /// Fetch the current unacked entries from the server, replacing local state.
    func refreshUnread() async {
        do {
            let response: ReturnsListResponse = try await get(
                path: "returns",
                query: [
                    URLQueryItem(name: "unackedOnly", value: "true"),
                    URLQueryItem(name: "limit", value: "\(displayedCap)"),
                ]
            )
            self.entries = response.entries
            self.lastError = nil
        } catch {
            self.lastError = error.localizedDescription
            MantleLog.api.error("GET /returns failed: \(String(describing: error))")
        }
    }

    /// Mark a single entry as read on the server and remove it from the local list.
    func ack(_ entry: ReturnEntry) async {
        do {
            let _: ReturnEntryEnvelope = try await postEmpty(path: "returns/\(entry.id)/ack")
            self.entries.removeAll { $0.id == entry.id }
        } catch {
            self.lastError = error.localizedDescription
            MantleLog.api.error("POST /returns/:id/ack failed: \(String(describing: error))")
        }
    }

    /// Mark every currently-visible unread entry as read. Fires the server calls
    /// concurrently; local state is updated as each ack completes.
    func ackAllVisible() async {
        let toAck = entries.filter { !$0.isAcked }
        await withTaskGroup(of: Void.self) { group in
            for entry in toAck {
                group.addTask { [weak self] in
                    await self?.ack(entry)
                }
            }
        }
    }

    // MARK: - SSE Subscription

    private func runSubscription() async {
        let url = baseURL.appendingPathComponent("returns/stream")
        var backoff: TimeInterval = 1.0
        let maxBackoff: TimeInterval = 30.0

        while !Task.isCancelled {
            do {
                var request = URLRequest(url: url)
                request.httpMethod = "GET"
                request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                // SSE should never time out; agent-core sends 30s keep-alives.
                request.timeoutInterval = 600

                let (bytes, response) = try await session.bytes(for: request)

                guard let http = response as? HTTPURLResponse else {
                    throw ReturnsSSEError.transient("invalid response")
                }
                if (400..<500).contains(http.statusCode) {
                    // Client error — no point retrying.
                    lastError = "HTTP \(http.statusCode)"
                    return
                }
                guard http.statusCode == 200 else {
                    throw ReturnsSSEError.transient("HTTP \(http.statusCode)")
                }

                isStreaming = true
                lastError = nil
                backoff = 1.0

                var pendingEvent: String? = nil
                for try await line in bytes.lines {
                    if Task.isCancelled { break }

                    if line.isEmpty {
                        pendingEvent = nil
                        continue
                    }
                    if line.hasPrefix(":") {
                        // Server keep-alive comment.
                        continue
                    }
                    if line.hasPrefix("event:") {
                        pendingEvent = line.dropFirst("event:".count)
                            .trimmingCharacters(in: .whitespaces)
                        continue
                    }
                    if line.hasPrefix("data:"),
                       pendingEvent == "return.created" {
                        let jsonString = line
                            .dropFirst("data:".count)
                            .trimmingCharacters(in: .whitespaces)
                        if let data = jsonString.data(using: .utf8),
                           let entry = try? decoder.decode(ReturnEntry.self, from: data) {
                            ingest(entry)
                        }
                    }
                }

                // Stream closed cleanly. Treat as transient and reconnect.
                isStreaming = false
                throw ReturnsSSEError.transient("stream closed")

            } catch is CancellationError {
                isStreaming = false
                return
            } catch {
                isStreaming = false
                if Task.isCancelled { return }
                // Exponential backoff, capped.
                try? await Task.sleep(for: .seconds(backoff))
                backoff = min(maxBackoff, backoff * 2)
                continue
            }
        }
    }

    private func ingest(_ entry: ReturnEntry) {
        // Dedupe by id (server-authoritative).
        if let existing = entries.firstIndex(where: { $0.id == entry.id }) {
            entries[existing] = entry
            return
        }
        entries.insert(entry, at: 0)
        if entries.count > displayedCap {
            entries.removeLast(entries.count - displayedCap)
        }
    }

    // MARK: - HTTP helpers

    private func get<T: Decodable>(path: String, query: [URLQueryItem] = []) async throws -> T {
        var components = URLComponents(
            url: baseURL.appendingPathComponent(path),
            resolvingAgainstBaseURL: false
        )!
        if !query.isEmpty { components.queryItems = query }
        var request = URLRequest(url: components.url!)
        request.httpMethod = "GET"
        request.timeoutInterval = 10

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw ReturnsSSEError.httpError(
                (response as? HTTPURLResponse)?.statusCode ?? 0
            )
        }
        return try decoder.decode(T.self, from: data)
    }

    private func postEmpty<T: Decodable>(path: String) async throws -> T {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)
        request.timeoutInterval = 10

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw ReturnsSSEError.httpError(
                (response as? HTTPURLResponse)?.statusCode ?? 0
            )
        }
        return try decoder.decode(T.self, from: data)
    }
}

enum ReturnsSSEError: LocalizedError {
    case transient(String)
    case httpError(Int)

    var errorDescription: String? {
        switch self {
        case .transient(let reason): return "Returns stream: \(reason)"
        case .httpError(let code): return "HTTP \(code)"
        }
    }
}
