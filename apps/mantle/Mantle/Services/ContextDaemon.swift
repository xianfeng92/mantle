import Foundation
import Combine
import ApplicationServices
import os

// MARK: - Context Daemon
//
// Lightweight always-on service that collects environment snapshots.
// Design goals (from Aura spec §3.2):
// - Memory: < 50 MB overhead
// - CPU: < 1% average
// - Graceful degradation: if any monitor fails, snapshot just misses that field

@Observable
@MainActor
final class ContextDaemon {

    // MARK: - Public State

    /// The latest environment snapshot, updated by monitors
    private(set) var currentSnapshot = ContextSnapshot()

    /// Whether the daemon is actively collecting
    private(set) var isRunning = false

    // MARK: - Monitors

    private let foregroundMonitor = ForegroundAppMonitor()
    private let idleMonitor = IdleTimeMonitor()
    private let windowTitleMonitor = WindowTitleMonitor()
    private let recentFilesMonitor = RecentFilesMonitor()
    private let selectionCaptureService = SelectionCaptureService()

    // MARK: - Internal

    private var pollingTask: Task<Void, Never>?
    private var focusStartTime: Date = .now
    private var lastSelection: SelectionInfo?
    private let cachedSelectionTTL: TimeInterval = 120

    // MARK: - Lifecycle

    func start() {
        guard !isRunning else { return }
        isRunning = true

        // Log accessibility state
        let axTrusted = AXIsProcessTrusted()
        MantleLog.context.info("AXIsProcessTrusted: \(axTrusted), bundleId: \(Bundle.main.bundleIdentifier ?? "nil")")

        // Request Accessibility if not yet granted
        if !axTrusted {
            MantleLog.context.info("Requesting accessibility permission")
            WindowTitleMonitor.requestAccessibilityPermission()
        }

        // Start event-driven monitors
        foregroundMonitor.start()
        windowTitleMonitor.start()
        recentFilesMonitor.startPeriodicRefresh()

        // Start polling loop for time-based monitors
        pollingTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.collectSnapshot()
                try? await Task.sleep(for: .seconds(10))
            }
        }

        MantleLog.context.info("ContextDaemon started")
    }

    func stop() {
        pollingTask?.cancel()
        pollingTask = nil

        foregroundMonitor.stop()
        windowTitleMonitor.stop()
        recentFilesMonitor.stopPeriodicRefresh()

        isRunning = false
        MantleLog.context.info("ContextDaemon stopped")
    }

    func captureSelectionForLaunch() -> SelectionInfo? {
        if let liveSelection = selectionCaptureService.captureCurrentSelection() {
            rememberSelection(liveSelection)
            return liveSelection
        }

        let cachedSelection = freshCachedSelection(referenceTime: .now)
        if let cachedSelection {
            currentSnapshot.selection = cachedSelection
        }
        return cachedSelection
    }

    func seedSelection(_ selection: SelectionInfo) {
        rememberSelection(selection)
    }

    // MARK: - Snapshot Assembly

    private func collectSnapshot() {
        let now = Date.now
        windowTitleMonitor.refresh()

        // Foreground info
        var foreground: ForegroundInfo?
        if let app = foregroundMonitor.currentApp {
            foreground = ForegroundInfo(
                appName: app.appName,
                bundleId: app.bundleId,
                windowTitle: windowTitleMonitor.currentTitle
            )
        }

        // Activity info
        let idleSeconds = idleMonitor.currentIdleSeconds
        let state: ActivityState = {
            if idleSeconds < 60 { return .active }
            if idleSeconds < 600 { return .idle }
            return .away
        }()

        // Track focus duration: reset when state changes from active to idle/away
        if state == .active && currentSnapshot.activity?.state != .active {
            focusStartTime = now
        }
        let focusMin = state == .active
            ? Int(now.timeIntervalSince(focusStartTime) / 60)
            : nil

        let activity = ActivityInfo(
            state: state,
            idleSeconds: idleSeconds,
            focusDurationMin: focusMin
        )

        // Recent files (async query, use last result if pending)
        let recentFiles = recentFilesMonitor.recentFiles

        // Selection snapshot
        let liveSelection = selectionCaptureService.captureCurrentSelection()
        if let liveSelection {
            rememberSelection(liveSelection)
        }

        let selection: SelectionInfo? = {
            if let liveSelection {
                return liveSelection
            }
            if foreground?.bundleId == Bundle.main.bundleIdentifier {
                return freshCachedSelection(referenceTime: now)
            }
            return nil
        }()

        // Focus Mode / DND detection
        let focusMode = detectFocusMode()

        // Assemble
        currentSnapshot = ContextSnapshot(
            timestamp: now,
            foreground: foreground,
            activity: activity,
            selection: selection,
            recentFiles: recentFiles,
            focusMode: focusMode
        )
    }

    private func rememberSelection(_ selection: SelectionInfo) {
        lastSelection = selection
        currentSnapshot.selection = selection
    }

    /// Detect whether macOS Focus Mode (Do Not Disturb) is active.
    /// Uses the DND preferences plist which is readable without special entitlements.
    private nonisolated func detectFocusMode() -> FocusModeInfo? {
        // macOS stores DND state in com.apple.controlcenter plist or
        // via the notification center database. The most reliable lightweight
        // approach is checking the dndMirroredState in defaults.
        let defaults = UserDefaults(suiteName: "com.apple.controlcenter")
        let isActive = defaults?.bool(forKey: "NSDoNotDisturbEnabled") ?? false

        // Fallback: check via DistributedNotificationCenter posted state
        // (some macOS versions use a different key)
        if !isActive {
            let ncDefaults = UserDefaults(suiteName: "com.apple.notificationcenterui")
            let dndEnabled = ncDefaults?.bool(forKey: "doNotDisturb") ?? false
            if dndEnabled {
                return FocusModeInfo(isActive: true)
            }
        }

        return FocusModeInfo(isActive: isActive)
    }

    private func freshCachedSelection(referenceTime: Date) -> SelectionInfo? {
        guard let lastSelection else { return nil }
        guard referenceTime.timeIntervalSince(lastSelection.capturedAt) <= cachedSelectionTTL else {
            return nil
        }
        return lastSelection
    }
}
