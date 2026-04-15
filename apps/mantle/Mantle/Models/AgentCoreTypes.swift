import Foundation

// MARK: - Serialized Message (mirrors agent-core/src/http.ts SerializedMessage)

struct SerializedMessage: Codable, Identifiable, Sendable {
    let role: MessageRole
    let text: String
    let content: AnyCodable?
    let name: String?
    let toolCallId: String?
    let toolCalls: AnyCodable?

    var id: String {
        // Derive a stable-ish ID from content; callers can override
        "\(role.rawValue)-\(text.prefix(32).hashValue)"
    }
}

enum MessageRole: String, Codable, Sendable {
    case assistant
    case user
    case system
    case tool
    case unknown
}

// MARK: - Run Result (mirrors agent-core/src/http.ts SerializedRunResult)

struct SerializedRunResult: Codable, Sendable {
    let traceId: String
    let status: RunStatus
    let threadId: String
    let interruptCount: Int
    let messages: [SerializedMessage]
    let newMessages: [SerializedMessage]
    let interruptRequest: HITLRequest?
    let contextCompaction: AnyCodable?
}

enum RunStatus: String, Codable, Sendable {
    case completed
    case interrupted
}

// MARK: - Health

struct HealthResponse: Codable, Sendable {
    let ok: Bool
    let service: String?
    let model: String?
    let promptProfile: String?
    let contextWindowSize: Int?
    let workspaceDir: String?
    let workspaceMode: String?
    let virtualMode: Bool?
}

// MARK: - Thread

struct CreateThreadResponse: Codable, Sendable {
    let threadId: String
}

// MARK: - Skills & Subagents

struct SkillMetadata: Codable, Identifiable, Sendable {
    let name: String
    let description: String
    let path: String
    let sourcePath: String
    let license: String?
    let compatibility: String?
    let metadata: [String: String]?
    let allowedTools: [String]?

    var id: String { name }
}

struct SkillsResponse: Codable, Sendable {
    let sources: [SkillSource]
    let skills: [SkillMetadata]
}

struct SkillSource: Codable, Sendable {
    let absolutePath: String
    let backendPath: String
}

struct SubagentMetadata: Codable, Identifiable, Sendable {
    let name: String
    let description: String
    let path: String
    let sourcePath: String
    let model: String?
    let skills: [String]?

    var id: String { name }
}

struct SubagentsResponse: Codable, Sendable {
    let generalPurposeAgent: GeneralPurposeAgent?
    let sources: [SkillSource]
    let subagents: [SubagentMetadata]
}

struct GeneralPurposeAgent: Codable, Sendable {
    let enabled: Bool
    let name: String
    let description: String
    let inheritedSkillSources: [String]
}

// MARK: - Diagnostics

struct DiagnosticsResponse: Codable, Sendable {
    let eventsAnalyzed: Int
    let gemma4: Gemma4Stats
    let runs: RunStats
    let compaction: CompactionStats?
    let contextUsage: ContextUsageStats?
    let staging: StagingStats?
    let verification: VerificationStats?
    let recentErrors: [AnyCodable]?

    var compactionCount: Int? {
        compaction?.count
    }
}

struct Gemma4Stats: Codable, Sendable {
    let toolCallFallbackCount: Int
    let retryCount: Int
    let contextRecoveryCount: Int
    let contextRecoveryFailures: Int?
}

struct RunStats: Codable, Sendable {
    let completed: Int
    let failed: Int
    let avgDurationMs: Double?
    let avgToolCallsPerCompletedRun: Int?
    let maxToolCallsInRun: Int?
    let avgGuiActionStepsPerCompletedRun: Int?
    let maxGuiActionStepsInRun: Int?
}

struct CompactionStats: Codable, Sendable {
    let count: Int
    let ratePercent: Int?
}

struct ContextUsageStats: Codable, Sendable {
    let windowSize: Int
    let lastPromptTokens: Int?
    let lastUsagePercent: Int?
    let avgPromptTokens: Int?
    let maxPromptTokens: Int?
    let peakUsagePercent: Int?
    let sampledRuns: Int
}

struct StagingStats: Codable, Sendable {
    let selections: Int
    let byStage: [String: Int]
    let budgetExhaustedCount: Int
    let guiStepBudget: Int
}

struct VerificationStats: Codable, Sendable {
    let passed: Int
    let failed: Int
    let passRatePercent: Int?
}

// MARK: - Move Tracker Types

struct MoveRecord: Codable, Sendable, Identifiable {
    let id: String
    let timestamp: String
    let threadId: String?
    let sourcePath: String
    let destPath: String
    let rolledBack: Bool?

    var displayDate: String {
        // "2026-04-08T06:12:00.000Z" → "04-08 06:12"
        let parts = timestamp.split(separator: "T")
        guard parts.count == 2 else { return timestamp }
        let date = parts[0].dropFirst(5) // drop year
        let time = parts[1].prefix(5)    // HH:MM
        return "\(date) \(time)"
    }

    var isExpired: Bool {
        guard let ts = ISO8601DateFormatter().date(from: timestamp) else { return true }
        return Date().timeIntervalSince(ts) > 7 * 24 * 3600
    }
}

struct MovesResponse: Codable, Sendable {
    let moves: [MoveRecord]
}

struct RollbackResult: Codable, Sendable {
    let success: Bool
    let error: String?
}

// MARK: - AnyCodable (type-erased JSON value)

struct AnyCodable: Codable, @unchecked Sendable {
    let value: Any

    init(_ value: Any) {
        self.value = value
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()

        if container.decodeNil() {
            value = NSNull()
        } else if let bool = try? container.decode(Bool.self) {
            value = bool
        } else if let int = try? container.decode(Int.self) {
            value = int
        } else if let double = try? container.decode(Double.self) {
            value = double
        } else if let string = try? container.decode(String.self) {
            value = string
        } else if let array = try? container.decode([AnyCodable].self) {
            value = array.map(\.value)
        } else if let dict = try? container.decode([String: AnyCodable].self) {
            value = dict.mapValues(\.value)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "AnyCodable: unsupported type"
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()

        switch value {
        case is NSNull:
            try container.encodeNil()
        case let bool as Bool:
            try container.encode(bool)
        case let int as Int:
            try container.encode(int)
        case let double as Double:
            try container.encode(double)
        case let string as String:
            try container.encode(string)
        case let array as [Any]:
            try container.encode(array.map { AnyCodable($0) })
        case let dict as [String: Any]:
            try container.encode(dict.mapValues { AnyCodable($0) })
        default:
            throw EncodingError.invalidValue(
                value,
                EncodingError.Context(
                    codingPath: encoder.codingPath,
                    debugDescription: "AnyCodable: unsupported type \(type(of: value))"
                )
            )
        }
    }
}
