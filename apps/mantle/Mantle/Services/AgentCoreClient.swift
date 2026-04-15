import Foundation
import os

// MARK: - Agent Core REST Client
//
// Non-streaming HTTP calls to agent-core backend.

actor AgentCoreClient {
    let baseURL: URL
    private let session: URLSession
    private let decoder = JSONDecoder()

    init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    // MARK: - Health

    /// Check if backend is reachable and healthy.
    func health() async throws -> HealthResponse {
        try await get("health")
    }

    /// Quick boolean health check (swallows errors).
    func isHealthy() async -> Bool {
        do {
            let response: HealthResponse = try await get("health")
            return response.ok
        } catch {
            return false
        }
    }

    // MARK: - Threads

    /// Create a new thread. Returns the assigned threadId.
    func createThread(threadId: String? = nil) async throws -> String {
        struct Body: Encodable { let threadId: String? }
        struct Response: Decodable { let threadId: String }
        let response: Response = try await post("threads", body: Body(threadId: threadId))
        return response.threadId
    }

    /// Delete / reset a thread.
    func deleteThread(threadId: String) async throws {
        let url = baseURL.appendingPathComponent("threads/\(threadId)")
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        request.timeoutInterval = 10

        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw AgentCoreClientError.httpError(
                statusCode: (response as? HTTPURLResponse)?.statusCode ?? 0,
                message: "Failed to delete thread"
            )
        }
    }

    // MARK: - Skills & Subagents

    func skills() async throws -> SkillsResponse {
        try await get("skills")
    }

    func subagents() async throws -> SubagentsResponse {
        try await get("subagents")
    }

    // MARK: - Diagnostics

    func diagnostics() async throws -> DiagnosticsResponse {
        try await get("diagnostics")
    }

    // MARK: - Moves / Rollback

    func moves(days: Int = 7) async throws -> MovesResponse {
        try await getWithQuery("moves", queryItems: [URLQueryItem(name: "days", value: "\(days)")])
    }

    func rollbackMove(id: String) async throws -> RollbackResult {
        struct Empty: Encodable {}
        return try await post("moves/\(id)/rollback", body: Empty())
    }

    // MARK: - Non-streaming Run (for simple cases)

    func run(threadId: String, input: String, maxInterrupts: Int? = nil) async throws -> SerializedRunResult {
        struct Body: Encodable {
            let threadId: String
            let input: String
            let maxInterrupts: Int?
        }
        return try await post("runs", body: Body(threadId: threadId, input: input, maxInterrupts: maxInterrupts))
    }

    // MARK: - Internal Helpers

    private func getWithQuery<T: Decodable>(_ path: String, queryItems: [URLQueryItem]) async throws -> T {
        var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        components.queryItems = queryItems
        let url = components.url!
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 10

        let (data, response) = try await session.data(for: request)

        guard let http = response as? HTTPURLResponse else {
            throw AgentCoreClientError.invalidResponse
        }

        guard (200..<300).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? ""
            throw AgentCoreClientError.httpError(statusCode: http.statusCode, message: body)
        }

        return try decoder.decode(T.self, from: data)
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        let url = baseURL.appendingPathComponent(path)
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 10

        let (data, response) = try await session.data(for: request)

        guard let http = response as? HTTPURLResponse else {
            MantleLog.api.error("GET /\(path) — invalid response")
            throw AgentCoreClientError.invalidResponse
        }

        guard (200..<300).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? ""
            MantleLog.api.error("GET /\(path) — \(http.statusCode): \(body.prefix(200))")
            throw AgentCoreClientError.httpError(statusCode: http.statusCode, message: body)
        }

        return try decoder.decode(T.self, from: data)
    }

    // MARK: - Generic JSON POST

    /// 通用 JSON POST，供 Twitter Digest 等批量长任务使用。
    /// 区别于内部 `post(_:body:)`：对外暴露，且支持自定义 timeout（digest 最长可能 ~60s）。
    func postJSON<T: Decodable, B: Encodable>(
        path: String,
        body: B,
        timeout: TimeInterval = 240
    ) async throws -> T {
        let url = baseURL.appendingPathComponent(path)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        request.timeoutInterval = timeout

        MantleLog.api.info("POST /\(path) (postJSON, timeout=\(Int(timeout))s)")
        let (data, response) = try await session.data(for: request)

        guard let http = response as? HTTPURLResponse else {
            MantleLog.api.error("POST /\(path) — invalid response")
            throw AgentCoreClientError.invalidResponse
        }

        guard (200..<300).contains(http.statusCode) else {
            let bodyStr = String(data: data, encoding: .utf8) ?? ""
            MantleLog.api.error("POST /\(path) — \(http.statusCode): \(bodyStr.prefix(200))")
            throw AgentCoreClientError.httpError(statusCode: http.statusCode, message: bodyStr)
        }

        return try decoder.decode(T.self, from: data)
    }

    // MARK: - Internal POST (legacy)

    private func post<T: Decodable, B: Encodable>(_ path: String, body: B) async throws -> T {
        let url = baseURL.appendingPathComponent(path)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        request.timeoutInterval = 120

        MantleLog.api.info("POST /\(path)")
        let (data, response) = try await session.data(for: request)

        guard let http = response as? HTTPURLResponse else {
            MantleLog.api.error("POST /\(path) — invalid response")
            throw AgentCoreClientError.invalidResponse
        }

        guard (200..<300).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? ""
            MantleLog.api.error("POST /\(path) — \(http.statusCode): \(body.prefix(200))")
            throw AgentCoreClientError.httpError(statusCode: http.statusCode, message: body)
        }

        return try decoder.decode(T.self, from: data)
    }
}

// MARK: - Errors

enum AgentCoreClientError: LocalizedError {
    case invalidResponse
    case httpError(statusCode: Int, message: String)

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "Invalid response from agent-core"
        case .httpError(let code, let message):
            return "HTTP \(code): \(message)"
        }
    }
}
