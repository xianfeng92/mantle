import Foundation

// MARK: - HITL Request (from backend when run is interrupted)

struct HITLRequest: Codable, Sendable {
    let actionRequests: [ActionRequest]
    let reviewConfigs: [ReviewConfig]
}

struct ActionRequest: Codable, Identifiable, Sendable {
    let name: String
    let args: [String: AnyCodable]
    let description: String?

    var id: String { "\(name)-\(args.keys.sorted().joined())" }

    /// Pretty-printed args for display
    var argsDescription: String {
        guard let data = try? JSONEncoder.prettyPrinting.encode(args) else {
            return "{}"
        }
        return String(data: data, encoding: .utf8) ?? "{}"
    }
}

struct ReviewConfig: Codable, Sendable {
    let actionName: String
    let allowedDecisions: [DecisionType]
    let argsSchema: AnyCodable?
}

// MARK: - HITL Response (sent by client to resume)

struct HITLResponse: Codable, Sendable {
    let decisions: [HITLDecision]
}

enum DecisionType: String, Codable, Sendable {
    case approve
    case edit
    case reject
}

enum HITLDecision: Codable, Sendable {
    case approve
    case edit(editedAction: EditedAction)
    case reject(message: String?)

    struct EditedAction: Codable, Sendable {
        let name: String
        let args: [String: AnyCodable]
    }

    // Custom coding to match backend's { type: "approve" } / { type: "edit", editedAction: {...} } format
    enum CodingKeys: String, CodingKey {
        case type
        case editedAction
        case message
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .approve:
            try container.encode("approve", forKey: .type)
        case .edit(let action):
            try container.encode("edit", forKey: .type)
            try container.encode(action, forKey: .editedAction)
        case .reject(let message):
            try container.encode("reject", forKey: .type)
            try container.encodeIfPresent(message, forKey: .message)
        }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "approve":
            self = .approve
        case "edit":
            let action = try container.decode(EditedAction.self, forKey: .editedAction)
            self = .edit(editedAction: action)
        case "reject":
            let message = try container.decodeIfPresent(String.self, forKey: .message)
            self = .reject(message: message)
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "Unknown decision type: \(type)"
            )
        }
    }
}

// MARK: - Helpers

extension JSONEncoder {
    static let prettyPrinting: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return encoder
    }()
}
