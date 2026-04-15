import SwiftUI
import SwiftData
import CoreSpotlight
import os

// MARK: - App Delegate

@MainActor
final class MantleAppDelegate: NSObject, NSApplicationDelegate {

    let textService = TextSelectionService()
    var onReopen: (() -> Void)?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Register "Ask Mantle" in Services menu
        textService.register()
    }

    /// Called when user clicks the Dock icon while app is already running
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            onReopen?()
        }
        return true
    }
}

// MARK: - App Entry Point

@main
struct MantleApp: App {
    @NSApplicationDelegateAdaptor(MantleAppDelegate.self) var appDelegate

    let container: ModelContainer
    @State private var appVM: AppViewModel
    @Environment(\.openWindow) private var openWindow
    /// 从通知 deep link 带过来的日期，用于 TwitterDigestListView 高亮当日
    @State private var bookmarksHighlightDate: Date?

    /// Resolved storage URL for display in Settings
    static var resolvedStorageURL: URL? {
        if let custom = UserDefaults.standard.string(forKey: "mantle.storagePath"), !custom.isEmpty {
            return URL(fileURLWithPath: custom)
        }
        return nil  // nil = SwiftData default
    }

    /// Default SwiftData storage directory
    static var defaultStorageDirectory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("Mantle")
    }

    init() {
        let container: ModelContainer
        do {
            let config: ModelConfiguration
            if let customPath = UserDefaults.standard.string(forKey: "mantle.storagePath"),
               !customPath.isEmpty {
                // User-specified storage location
                let dirURL = URL(fileURLWithPath: customPath)
                // Ensure directory exists
                try? FileManager.default.createDirectory(at: dirURL, withIntermediateDirectories: true)
                let storeURL = dirURL.appendingPathComponent("Mantle.store")
                config = ModelConfiguration(url: storeURL)
                MantleLog.app.info("Using custom storage: \(storeURL.path)")
            } else {
                // Default SwiftData location
                config = ModelConfiguration()
                MantleLog.app.info("Using default storage location")
            }

            container = try ModelContainer(
                for: PersistedThread.self,
                PersistedMessage.self,
                PersistedToolEvent.self,
                TwitterBookmark.self,
                configurations: config
            )
        } catch {
            // If schema is corrupt, try in-memory fallback so app doesn't crash
            MantleLog.app.error("ModelContainer failed: \(error). Using in-memory store.")
            container = try! ModelContainer(
                for: PersistedThread.self,
                PersistedMessage.self,
                PersistedToolEvent.self,
                TwitterBookmark.self,
                configurations: ModelConfiguration(isStoredInMemoryOnly: true)
            )
        }
        self.container = container
        self._appVM = State(
            initialValue: AppViewModel(modelContext: container.mainContext)
        )
    }

    var body: some Scene {
        // Main window — single instance
        Window("Mantle", id: "main") {
            MainWindowView()
                .environment(appVM)
                .frame(minWidth: 600, minHeight: 400)
                .onAppear {
                    setupServices()
                    // Allow Dock click to reopen main window
                    appDelegate.onReopen = { [self] in
                        openWindow(id: "main")
                        NSApplication.shared.activate(ignoringOtherApps: true)
                    }
                }
                .onOpenURL { url in
                    handleDeepLink(url)
                }
                .onContinueUserActivity(CSSearchableItemActionType) { activity in
                    // Handle Spotlight search result clicks
                    if let identifier = activity.userInfo?[CSSearchableItemActivityIdentifier] as? String,
                       let threadId = SpotlightService.threadId(from: identifier) {
                        appVM.activeThreadId = threadId
                        activateMantle()
                    }
                }
        }
        .defaultSize(width: 900, height: 700)
        .modelContainer(container)

        // Bookmarks window — separate scene, opened via mantle://bookmarks or MenuBar
        Window("Bookmarks", id: "bookmarks") {
            TwitterDigestListView(highlightDate: bookmarksHighlightDate)
                .environment(appVM)
                .frame(minWidth: 480, minHeight: 500)
        }
        .defaultSize(width: 640, height: 720)
        .modelContainer(container)

        // Menu bar icon with popover
        MenuBarExtra {
            PopoverView(
                onExpandToWindow: { openWindow(id: "main") }
            )
            .environment(appVM)
            .frame(width: 420, height: 600)
        } label: {
            Image(systemName: "brain.head.profile")
        }
        .menuBarExtraStyle(.window)

        // Settings
        Settings {
            SettingsView()
                .environment(appVM)
        }
        .commands {
            // ⌘N — New Chat
            CommandGroup(after: .newItem) {
                Button("New Chat") {
                    appVM.createThread()
                }
                .keyboardShortcut("n", modifiers: .command)
            }

            // ⌘Shift+C — Copy Chat as Markdown
            CommandGroup(after: .pasteboard) {
                Button("Copy Chat as Markdown") {
                    appVM.copyActiveThreadAsMarkdown()
                }
                .keyboardShortcut("c", modifiers: [.command, .shift])
                .disabled(appVM.activeThread == nil)
            }

            // Twitter Digest 调试 / 快捷入口
            CommandMenu("Bookmarks") {
                Button("Open Bookmarks Window") {
                    bookmarksHighlightDate = nil
                    openWindow(id: "bookmarks")
                }
                .keyboardShortcut("b", modifiers: [.command, .shift])

                Divider()

                Button("Fire Daily Digest Now (debug)") {
                    appVM.fireDailyDigestNow()
                }
                .keyboardShortcut("d", modifiers: [.command, .option])

                Button("Trigger Ingest Digest Now (debug)") {
                    appVM.triggerTwitterDigestNow()
                }

                Divider()

                Button("Test Notification (debug)") {
                    NotificationManager.shared.debugPrintStatusAndSendTest()
                }

                Button("Re-request Notification Permission") {
                    NotificationManager.shared.requestPermission()
                }
            }
        }
    }

    // MARK: - Service Setup

    private func setupServices() {
        // Global hotkey: ⌥Space
        let hotkey = GlobalHotkeyService.shared
        hotkey.onHotkey = { [self] in
            _ = appVM.contextDaemon.captureSelectionForLaunch()
            activateMantle()
        }
        hotkey.register()

        // Text selection service: "Ask Mantle" → send as message
        appDelegate.textService.onTextReceived = { [self] selection in
            activateMantle()
            appVM.startRewriteSelectionWorkflow(selection: selection)
        }
    }

    // MARK: - Deep Links (mantle://)

    private func handleDeepLink(_ url: URL) {
        guard url.scheme == "mantle" else { return }

        let host = url.host() ?? ""
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let queryItems = components?.queryItems ?? []

        func param(_ name: String) -> String? {
            queryItems.first(where: { $0.name == name })?.value
        }

        switch host {
        case "ask":
            // mantle://ask?q={question}&context={base64}
            activateMantle()
            if let question = param("q"), !question.isEmpty {
                appVM.createThread()
                appVM.send(question)
            }

        case "thread":
            // mantle://thread/{id}
            let threadId = url.pathComponents.dropFirst().first ?? ""
            if !threadId.isEmpty, appVM.threads.contains(where: { $0.id == threadId }) {
                appVM.activeThreadId = threadId
            }
            activateMantle()

        case "workflow":
            // mantle://workflow/{name}
            let workflowName = url.pathComponents.dropFirst().first ?? ""
            if let workflow = appVM.launchWorkflows.first(where: {
                $0.id == workflowName || $0.title.lowercased() == workflowName.lowercased()
            }) {
                activateMantle()
                appVM.startLaunchWorkflow(workflow)
            }

        case "settings":
            // mantle://settings
            NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)

        case "twitter":
            // mantle://twitter/digest-now — 立即消化 undigested（Stage B 调试）
            // mantle://twitter/digest-daily-now — 立即生成并推送今日 digest 通知（Stage C 调试）
            let sub = url.pathComponents.dropFirst().first ?? ""
            switch sub {
            case "digest-now":
                appVM.triggerTwitterDigestNow()
            case "digest-daily-now":
                appVM.fireDailyDigestNow()
            default:
                break
            }

        case "bookmarks":
            // mantle://bookmarks[?date=YYYY-MM-DD] — 打开 Bookmarks 窗口，高亮指定日期
            if let dateStr = param("date") {
                let df = DateFormatter()
                df.dateFormat = "yyyy-MM-dd"
                df.locale = Locale(identifier: "en_US_POSIX")
                bookmarksHighlightDate = df.date(from: dateStr)
            } else {
                bookmarksHighlightDate = nil
            }
            openWindow(id: "bookmarks")
            activateMantle()

        default:
            // Unknown route — just activate
            activateMantle()
        }
    }

    // MARK: - Window Toggle

    private func activateMantle() {
        let app = NSApplication.shared

        if app.isActive,
           let mainWindow = app.windows.first(where: { $0.title == "Mantle" && $0.isVisible }) {
            // Window is visible AND app is frontmost → hide
            mainWindow.orderOut(nil)
            app.hide(nil)
        } else if let mainWindow = app.windows.first(where: { $0.title == "Mantle" && $0.isVisible }) {
            // Window visible but not focused → bring to front
            app.activate(ignoringOtherApps: true)
            mainWindow.makeKeyAndOrderFront(nil)
            appVM.shouldFocusInput = true
        } else {
            // No visible window → open and focus
            openWindow(id: "main")
            app.activate(ignoringOtherApps: true)
            appVM.shouldFocusInput = true
        }
    }
}
