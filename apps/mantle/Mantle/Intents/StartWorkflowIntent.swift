import AppIntents
import AppKit
import Foundation

// MARK: - Start Workflow Intent
//
// Launches a Mantle workflow by name via Shortcuts.app.
// Opens the app and starts the workflow in the UI.

struct StartWorkflowIntent: AppIntent {

    static let title: LocalizedStringResource = "Start Mantle Workflow"
    static let description = IntentDescription(
        "Start a predefined Mantle workflow by name.",
        categoryName: "AI Assistant"
    )
    static let openAppWhenRun: Bool = true

    @Parameter(title: "Workflow Name", description: "The name or ID of the workflow to start")
    var workflowName: String

    @MainActor
    func perform() async throws -> some IntentResult {
        // Open Mantle via URL scheme — this triggers the deep link handler
        // which finds and starts the matching workflow.
        let encoded = workflowName.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? workflowName
        if let url = URL(string: "mantle://workflow/\(encoded)") {
            NSWorkspace.shared.open(url)
        }
        return .result()
    }
}
