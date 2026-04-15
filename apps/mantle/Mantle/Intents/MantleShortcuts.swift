import AppIntents

// MARK: - Shortcuts Provider
//
// Registers Mantle actions with Shortcuts.app and Siri.
// Users can say "Ask Mantle" to trigger via Siri.

struct MantleShortcutsProvider: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AskMantleIntent(),
            phrases: [
                "Ask \(.applicationName) a question",
                "Ask \(.applicationName) something"
            ],
            shortTitle: "Ask Mantle",
            systemImageName: "brain.head.profile"
        )

        AppShortcut(
            intent: StartWorkflowIntent(),
            phrases: [
                "Start \(.applicationName) workflow",
                "Run \(.applicationName) workflow"
            ],
            shortTitle: "Start Workflow",
            systemImageName: "play.circle"
        )
    }
}
