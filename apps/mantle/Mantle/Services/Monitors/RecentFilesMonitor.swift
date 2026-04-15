import Foundation
import os

// MARK: - Recent Files Monitor
//
// Tracks recently modified files using Spotlight (NSMetadataQuery).
// No special permissions needed — Spotlight indexes user-accessible files.
// Scopes to ~/Desktop and ~/Documents (and ~/Downloads for Aura scenario B).

@Observable
@MainActor
final class RecentFilesMonitor {

    /// Most recently modified files (up to 5)
    private(set) var recentFiles: [RecentFileInfo] = []

    private var query: NSMetadataQuery?
    private var refreshTask: Task<Void, Never>?

    /// Start periodic refresh (every 30 seconds)
    func startPeriodicRefresh() {
        stopPeriodicRefresh()

        // Initial fetch
        fetchRecentFiles()

        refreshTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                self?.fetchRecentFiles()
            }
        }

        MantleLog.context.info("RecentFilesMonitor started")
    }

    func stopPeriodicRefresh() {
        refreshTask?.cancel()
        refreshTask = nil
        query?.stop()
        query = nil
    }

    // MARK: - Spotlight Query

    private func fetchRecentFiles() {
        let mdQuery = NSMetadataQuery()

        // Only regular files, modified in last 24 hours
        mdQuery.predicate = NSPredicate(
            format: "kMDItemContentTypeTree == 'public.data' AND kMDItemFSContentChangeDate >= %@",
            Calendar.current.date(byAdding: .hour, value: -24, to: .now)! as NSDate
        )

        // Scope to user's key directories
        let home = FileManager.default.homeDirectoryForCurrentUser
        mdQuery.searchScopes = [
            home.appendingPathComponent("Desktop").path,
            home.appendingPathComponent("Documents").path,
            home.appendingPathComponent("Downloads").path
        ]

        // Sort by modification date, limit to 10 (we'll take top 5)
        mdQuery.sortDescriptors = [
            NSSortDescriptor(key: NSMetadataItemFSContentChangeDateKey, ascending: false)
        ]

        // Gather results synchronously on this call
        // NSMetadataQuery needs RunLoop, so we use a notification-based approach
        let nc = NotificationCenter.default
        var observer: NSObjectProtocol?

        observer = nc.addObserver(
            forName: .NSMetadataQueryDidFinishGathering,
            object: mdQuery,
            queue: .main
        ) { [weak self] notification in
            guard let query = notification.object as? NSMetadataQuery else { return }
            query.stop()

            var files: [RecentFileInfo] = []
            let count = min(query.resultCount, 5)

            for i in 0..<count {
                guard let item = query.result(at: i) as? NSMetadataItem,
                      let path = item.value(forAttribute: NSMetadataItemPathKey) as? String,
                      let date = item.value(forAttribute: NSMetadataItemFSContentChangeDateKey) as? Date
                else { continue }

                // Skip hidden files and system files
                let filename = URL(fileURLWithPath: path).lastPathComponent
                guard !filename.hasPrefix(".") else { continue }

                files.append(RecentFileInfo(path: path, modifiedAt: date))
            }

            self?.recentFiles = files

            if let observer {
                nc.removeObserver(observer)
            }
        }

        mdQuery.start()

        // Store reference to keep it alive
        self.query = mdQuery
    }
}
