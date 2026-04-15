import Foundation

actor RuntimeLogStore {
    static let shared = RuntimeLogStore()

    private let fileManager = FileManager.default
    private let formatter: ISO8601DateFormatter

    private init() {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        self.formatter = formatter
    }

    func append(category: String, message: String) {
        let line = "[\(formatter.string(from: .now))] [\(category)] \(message)\n"

        guard let data = line.data(using: .utf8) else { return }
        let url = logFileURL()

        do {
            try ensureParentDirectory(for: url)

            if fileManager.fileExists(atPath: url.path) {
                let handle = try FileHandle(forWritingTo: url)
                defer { try? handle.close() }
                try handle.seekToEnd()
                try handle.write(contentsOf: data)
            } else {
                try data.write(to: url, options: .atomic)
            }
        } catch {
            // Best-effort logging only. Avoid recursive logger failures.
        }
    }

    func logFilePath() -> String {
        logFileURL().path
    }

    private func logFileURL() -> URL {
        let baseURL = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSString("~/Library/Application Support").expandingTildeInPath, isDirectory: true)

        return baseURL
            .appendingPathComponent("Mantle", isDirectory: true)
            .appendingPathComponent("logs", isDirectory: true)
            .appendingPathComponent("runtime.log", isDirectory: false)
    }

    private func ensureParentDirectory(for url: URL) throws {
        let directory = url.deletingLastPathComponent()
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
    }
}
