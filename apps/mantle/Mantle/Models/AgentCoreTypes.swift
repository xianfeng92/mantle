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

// MARK: - Doctor

struct DoctorResponse: Codable, Sendable {
    let ok: Bool
    let service: String
    let checkedAt: String
    let summary: DoctorSummary
    let runtime: DoctorRuntime
    let checks: [DoctorCheck]

    var attentionChecks: [DoctorCheck] {
        checks.filter { $0.status != .pass }
    }
}

struct DoctorSummary: Codable, Sendable {
    let overallStatus: DoctorCheckStatus
    let passCount: Int
    let warnCount: Int
    let failCount: Int
}

struct DoctorRuntime: Codable, Sendable {
    let model: String
    let promptProfile: String
    let contextWindowSize: Int
    let workspaceDir: String
    let dataDir: String
    let memoryFilePath: String
    let workspaceMode: String
    let virtualMode: Bool
    let baseUrl: String?
    let sandboxLevel: Int
    let skillCount: Int
    let subagentCount: Int
}

struct DoctorCheck: Codable, Sendable, Identifiable {
    let id: String
    let title: String
    let status: DoctorCheckStatus
    let summary: String
    let details: String?
    let fixHint: String?
}

enum DoctorCheckStatus: String, Codable, Sendable {
    case pass
    case warn
    case fail
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

// MARK: - Heartbeat

struct HeartbeatAnnouncePayload: Codable, Hashable, Sendable {
    let channels: [String]
    let urgency: String?
}

struct HeartbeatTaskDefPayload: Codable, Hashable, Sendable, Identifiable {
    let id: String
    let schedule: String
    let handler: String
    let prompt: String?
    let announce: HeartbeatAnnouncePayload?
    let tags: [String]?
    let enabled: Bool?
}

struct HeartbeatTaskStatePayload: Codable, Hashable, Sendable {
    let lastFiredAt: String?
    let lastStatus: String?
    let lastReturnId: String?
    let lastError: String?
}

struct HeartbeatTaskStatus: Codable, Hashable, Sendable, Identifiable {
    let def: HeartbeatTaskDefPayload
    let state: HeartbeatTaskStatePayload
    let nextFireAt: String?

    var id: String { def.id }
}

struct HeartbeatTasksResponse: Codable, Sendable {
    let enabled: Bool
    let tasks: [HeartbeatTaskStatus]
    let parseErrors: [String]
}

struct HeartbeatRunNowResponse: Codable, Sendable {
    let taskId: String
    let state: HeartbeatTaskStatePayload
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

// MARK: - Memory Injection

struct MemoryInjectionEnvelope: Codable, Sendable {
    let threadId: String
    let snapshot: MemoryInjectionSnapshot?
}

struct MemoryInjectionSnapshot: Codable, Sendable {
    let threadId: String
    let updatedAt: String
    let budgetTokens: Int
    let skipped: Bool
    let reason: String?
    let estimatedTokens: Int
    let entries: [MemoryEntry]
}

struct MemoryEntry: Codable, Sendable, Identifiable {
    let id: String
    let type: String
    let content: String
    let source: MemoryEntrySource
    let tags: [String]
}

struct MemoryEntrySource: Codable, Sendable {
    let threadId: String
    let traceId: String
    let createdAt: String
}

// MARK: - Run Snapshots

struct RunSnapshotsResponse: Codable, Sendable {
    let runs: [RunSnapshotRecord]
}

struct RunSnapshotEnvelope: Codable, Sendable {
    let run: RunSnapshotRecord
}

struct RunSnapshotRecord: Codable, Sendable, Identifiable {
    let traceId: String
    let threadId: String
    let mode: RunSnapshotMode
    let status: RunSnapshotStatus
    let startedAt: String
    let completedAt: String?
    let inputPreview: String?
    let actions: [RunSnapshotActionRecord]
    let files: [RunSnapshotFileRecord]
    let summary: RunSnapshotSummary
    let restoreHistory: [RunSnapshotRestoreHistoryEntry]?

    var id: String { traceId }
}

enum RunSnapshotMode: String, Codable, Sendable {
    case run
    case resume
}

enum RunSnapshotStatus: String, Codable, Sendable {
    case running
    case completed
    case interrupted
    case failed
}

struct RunSnapshotActionRecord: Codable, Sendable, Identifiable {
    let id: String
    let timestamp: String
    let toolName: String
    let status: RunSnapshotActionStatus
    let summary: String
    let touchedPaths: [String]
    let moveIds: [String]?
    let error: String?
}

enum RunSnapshotActionStatus: String, Codable, Sendable {
    case completed
    case failed
}

struct RunSnapshotFileRecord: Codable, Sendable, Identifiable {
    let path: String
    let changeType: RunSnapshotChangeType
    let moveRole: String?
    let before: RunSnapshotFileVersion
    let after: RunSnapshotFileVersion
    let restorable: Bool

    var id: String { path }
}

enum RunSnapshotChangeType: String, Codable, Sendable {
    case created
    case updated
    case deleted
    case moved_in
    case moved_out
    case unchanged
}

struct RunSnapshotFileVersion: Codable, Sendable {
    let exists: Bool
    let blobPath: String?
    let size: Int?
    let modifiedAt: String?
    let sha256: String?
    let preview: String?
    let binary: Bool?
    let truncated: Bool?
    let captureError: String?
}

struct RunSnapshotSummary: Codable, Sendable {
    let changedFiles: Int
    let createdFiles: Int
    let updatedFiles: Int
    let deletedFiles: Int
    let movedFiles: Int
    let restorableFiles: Int
}

struct RunSnapshotRestoreHistoryEntry: Codable, Sendable, Identifiable {
    let timestamp: String
    let dryRun: Bool
    let restoredFiles: Int
    let conflicts: Int

    var id: String { "\(timestamp)-\(dryRun)-\(restoredFiles)-\(conflicts)" }
}

struct RunSnapshotRestoreResult: Codable, Sendable {
    let ok: Bool
    let dryRun: Bool
    let traceId: String
    let summary: RunSnapshotSummary
    let conflicts: [String]
    let results: [RunSnapshotRestoreResultEntry]
    let restoredAt: String
}

struct RunSnapshotRestoreResultEntry: Codable, Sendable, Identifiable {
    let path: String
    let action: String
    let ok: Bool
    let conflict: Bool
    let reason: String?

    var id: String { "\(path)-\(action)" }
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
