import Foundation

// MARK: - Returns Plane Types
//
// Mirror of packages/agent-core/src/returns.ts::ReturnEntry.
// Spec: packages/agent-core/docs/specs/2026-04-16-returns-plane-spec.md

struct ReturnAnnounce: Codable, Hashable, Sendable {
    let channels: [String]
    let urgency: String?
}

struct ReturnEntrySource: Codable, Hashable, Sendable {
    let taskId: String?
    let traceId: String?
}

struct ReturnEntry: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let kind: String
    let title: String
    let summary: String?
    let payload: JSONValue?
    let tags: [String]
    let createdAt: String
    let source: ReturnEntrySource
    let announce: ReturnAnnounce?
    let ackedAt: String?

    var createdAtDate: Date? {
        ReturnsPlaneDateParser.parse(createdAt)
    }

    var ackedAtDate: Date? {
        ackedAt.flatMap { ReturnsPlaneDateParser.parse($0) }
    }

    var isAcked: Bool { ackedAt != nil }
}

struct ReturnsListResponse: Codable, Sendable {
    let entries: [ReturnEntry]
    let count: Int
}

struct ReturnEntryEnvelope: Codable, Sendable {
    let entry: ReturnEntry
}

/// Parse the ISO8601 timestamps agent-core writes (always UTC, millisecond
/// precision). Kept as a free function to stay Sendable-safe under Swift 6
/// strict concurrency — ISO8601DateFormatter itself is not Sendable.
enum ReturnsPlaneDateParser {
    static func parse(_ string: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: string) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: string)
    }
}

// MARK: - JSONValue (opaque payload decoder)
//
// The `payload` field can be anything (each kind defines its own schema).
// We store it as a recursive JSON value so views can introspect when needed
// without forcing every consumer to declare its shape upfront.

enum JSONValue: Codable, Hashable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let b = try? container.decode(Bool.self) {
            self = .bool(b)
        } else if let n = try? container.decode(Double.self) {
            self = .number(n)
        } else if let s = try? container.decode(String.self) {
            self = .string(s)
        } else if let arr = try? container.decode([JSONValue].self) {
            self = .array(arr)
        } else if let obj = try? container.decode([String: JSONValue].self) {
            self = .object(obj)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Unsupported JSON value"
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null:
            try container.encodeNil()
        case .bool(let v):
            try container.encode(v)
        case .number(let v):
            try container.encode(v)
        case .string(let v):
            try container.encode(v)
        case .array(let v):
            try container.encode(v)
        case .object(let v):
            try container.encode(v)
        }
    }
}
