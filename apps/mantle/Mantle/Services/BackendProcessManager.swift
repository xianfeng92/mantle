import Foundation
import AppKit
import os

// MARK: - Process State

enum ProcessState: Equatable, Sendable {
    case detecting
    case nodeNotFound
    case starting
    case running
    case restarting(attempt: Int)
    case startFailed(String)
    case crashed(String)
    case stopped
}

// MARK: - Workspace Mode

enum WorkspaceMode: String, CaseIterable, Identifiable, Sendable {
    case repo
    case workspace
    case custom

    var id: String { rawValue }

    var title: String {
        switch self {
        case .repo:
            return "Repo"
        case .workspace:
            return "Workspace"
        case .custom:
            return "Custom"
        }
    }

    var description: String {
        switch self {
        case .repo:
            return "Use the agent-core repository as the default working scope."
        case .workspace:
            return "Use the parent AI workspace that contains agent-core and related projects."
        case .custom:
            return "Pick any folder on disk as the working scope."
        }
    }
}

// MARK: - Path Defaults

enum MantlePathDefaults {
    static var applicationSupportRoot: String {
        let baseURL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSString("~/Library/Application Support").expandingTildeInPath, isDirectory: true)
        return baseURL.appendingPathComponent("Mantle", isDirectory: true).path
    }

    static func defaultAgentCorePath() -> String {
        if let detected = detectedAgentCorePath() {
            return detected
        }
        return NSString("~/mantle/agent-core").expandingTildeInPath
    }

    static func edgeTTSExecutableCandidates() -> [String] {
        var candidates = [applicationSupportPath("piper-env", "bin", "edge-tts")]
        if let scriptsRoot = detectedScriptsRoot() {
            candidates.append(path(in: scriptsRoot, components: ["piper-env", "bin", "edge-tts"]))
        }
        candidates.append(contentsOf: [
            "/opt/homebrew/bin/edge-tts",
            "/usr/local/bin/edge-tts",
        ])
        return uniquePaths(candidates)
    }

    static func piperExecutableCandidates() -> [String] {
        var candidates = [applicationSupportPath("piper-env", "bin", "piper")]
        if let scriptsRoot = detectedScriptsRoot() {
            candidates.append(path(in: scriptsRoot, components: ["piper-env", "bin", "piper"]))
        }
        candidates.append(contentsOf: [
            "/opt/homebrew/bin/piper",
            "/usr/local/bin/piper",
        ])
        return uniquePaths(candidates)
    }

    static func piperVoiceDirectoryCandidates() -> [String] {
        var candidates = [applicationSupportPath("piper-voices")]
        if let scriptsRoot = detectedScriptsRoot() {
            candidates.append(path(in: scriptsRoot, components: ["piper-voices"]))
        }
        return uniquePaths(candidates)
    }

    static func relativePathIfInside(root: String, target: String) -> String? {
        let normalizedRoot = URL(fileURLWithPath: root).standardizedFileURL.path
        let normalizedTarget = URL(fileURLWithPath: target).standardizedFileURL.path
        let relative = URL(fileURLWithPath: normalizedTarget).path.replacingOccurrences(of: normalizedRoot + "/", with: "")

        if normalizedTarget == normalizedRoot {
            return "."
        }

        if relative == normalizedTarget || relative.hasPrefix("/") || relative.hasPrefix("..") {
            return nil
        }

        return relative
    }

    private static func detectedAgentCorePath() -> String? {
        for basePath in searchRoots() {
            if isAgentCoreDirectory(basePath) {
                return basePath
            }

            let candidate = path(in: basePath, components: ["agent-core"])
            if isAgentCoreDirectory(candidate) {
                return candidate
            }

            let monorepoCandidate = path(in: basePath, components: ["packages", "agent-core"])
            if isAgentCoreDirectory(monorepoCandidate) {
                return monorepoCandidate
            }
        }

        for fallback in uniquePaths([
            NSString("~/mantle/agent-core").expandingTildeInPath,
            NSString("~/Mantle/agent-core").expandingTildeInPath,
            NSString("~/mantle-monorepo/packages/agent-core").expandingTildeInPath,
        ]) where isAgentCoreDirectory(fallback) {
            return fallback
        }

        return nil
    }

    private static func detectedScriptsRoot() -> String? {
        for basePath in searchRoots() {
            if looksLikeScriptsRoot(basePath) {
                return basePath
            }

            let candidate = path(in: basePath, components: ["scripts"])
            if looksLikeScriptsRoot(candidate) {
                return candidate
            }
        }

        return nil
    }

    private static func searchRoots() -> [String] {
        uniquePaths(candidateSeeds().flatMap(allAncestorDirectories(for:)))
    }

    private static func candidateSeeds() -> [String] {
        let sourceRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .path

        let seeds: [String?] = [
            ProcessInfo.processInfo.environment["PWD"],
            FileManager.default.currentDirectoryPath,
            sourceRoot,
            Bundle.main.bundleURL.deletingLastPathComponent().path,
            Bundle.main.resourceURL?.path,
        ]

        return uniquePaths(
            seeds
                .compactMap { $0 }
                .filter { !$0.isEmpty }
                .map(normalizedDirectorySeed(_:))
        )
    }

    private static func normalizedDirectorySeed(_ path: String) -> String {
        let expanded = NSString(string: path).expandingTildeInPath
        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: expanded, isDirectory: &isDirectory), !isDirectory.boolValue {
            return URL(fileURLWithPath: expanded).deletingLastPathComponent().path
        }
        return expanded
    }

    private static func allAncestorDirectories(for path: String) -> [String] {
        var results: [String] = []
        var current = normalizedDirectorySeed(path)

        while true {
            results.append(current)
            let parent = URL(fileURLWithPath: current, isDirectory: true).deletingLastPathComponent().path
            if parent == current {
                break
            }
            current = parent
        }

        return results
    }

    private static func uniquePaths(_ paths: [String]) -> [String] {
        var seen = Set<String>()
        var results: [String] = []

        for path in paths {
            let normalized = URL(fileURLWithPath: path).standardizedFileURL.path
            if seen.insert(normalized).inserted {
                results.append(normalized)
            }
        }

        return results
    }

    private static func applicationSupportPath(_ components: String...) -> String {
        path(in: applicationSupportRoot, components: components)
    }

    private static func path(in root: String, components: [String]) -> String {
        components.reduce(root) { partial, component in
            URL(fileURLWithPath: partial, isDirectory: true).appendingPathComponent(component).path
        }
    }

    private static func isAgentCoreDirectory(_ path: String) -> Bool {
        let packageJSON = self.path(in: path, components: ["package.json"])
        let sourceServe = self.path(in: path, components: ["src", "serve.ts"])
        let builtServe = self.path(in: path, components: ["dist", "src", "serve.js"])
        return FileManager.default.fileExists(atPath: packageJSON)
            && (FileManager.default.fileExists(atPath: sourceServe) || FileManager.default.fileExists(atPath: builtServe))
    }

    private static func looksLikeScriptsRoot(_ path: String) -> Bool {
        let piper = self.path(in: path, components: ["piper-env", "bin", "piper"])
        let edgeTTS = self.path(in: path, components: ["piper-env", "bin", "edge-tts"])
        let voices = self.path(in: path, components: ["piper-voices"])
        return FileManager.default.fileExists(atPath: piper)
            || FileManager.default.fileExists(atPath: edgeTTS)
            || FileManager.default.fileExists(atPath: voices)
    }
}

// MARK: - Backend Process Manager

actor BackendProcessManager {

    // MARK: - Configuration

    struct Config: Sendable {
        var nodePath: String?           // nil = auto-detect
        var agentCorePath: String       // default = auto-detected repo path
        var backendPort: Int            // default 8787
        var maxRestarts: Int            // default 3
        var workspaceMode: WorkspaceMode
        var customWorkspacePath: String?
        var virtualMode: Bool

        static var `default`: Config {
            let storedAgentCorePath = UserDefaults.standard.string(forKey: "mantle.agentCorePath")
            let trimmedAgentCorePath = storedAgentCorePath?.trimmingCharacters(in: .whitespacesAndNewlines)
            let agentCorePath = (trimmedAgentCorePath?.isEmpty == false ? trimmedAgentCorePath : nil)
                ?? MantlePathDefaults.defaultAgentCorePath()
            return Config(
                nodePath: UserDefaults.standard.string(forKey: "mantle.nodePath"),
                agentCorePath: agentCorePath,
                backendPort: 8787,
                maxRestarts: 3,
                workspaceMode: UserDefaults.standard.string(forKey: "mantle.workspaceMode")
                    .flatMap(WorkspaceMode.init(rawValue:))
                    ?? .workspace,
                customWorkspacePath: UserDefaults.standard.string(forKey: "mantle.customWorkspacePath"),
                virtualMode: UserDefaults.standard.object(forKey: "mantle.virtualMode") as? Bool ?? false
            )
        }

        var resolvedAgentCorePath: String {
            NSString(string: agentCorePath).expandingTildeInPath
        }

        var resolvedWorkspacePath: String {
            switch workspaceMode {
            case .repo:
                return resolvedAgentCorePath
            case .workspace:
                return URL(fileURLWithPath: resolvedAgentCorePath).deletingLastPathComponent().path
            case .custom:
                let fallback = URL(fileURLWithPath: resolvedAgentCorePath).deletingLastPathComponent().path
                let candidate = customWorkspacePath?.isEmpty == false ? customWorkspacePath! : fallback
                return NSString(string: candidate).expandingTildeInPath
            }
        }
    }

    // MARK: - State Stream

    private let stateContinuation: AsyncStream<ProcessState>.Continuation
    let stateUpdates: AsyncStream<ProcessState>

    private var _state: ProcessState = .detecting {
        didSet { stateContinuation.yield(_state) }
    }

    var state: ProcessState { _state }

    // MARK: - Internals

    private var process: Process?
    private var config: Config
    private var restartCount = 0
    private var resolvedNodePath: String?
    private var stdoutPipe: Pipe?
    private var stderrPipe: Pipe?

    // MARK: - Log Buffer

    private static let maxLogLines = 200
    private var _recentLogs: [String] = []

    /// Recent backend process log lines (up to 200)
    var recentLogs: [String] { _recentLogs }

    private func appendLog(_ line: String) {
        _recentLogs.append(line)
        if _recentLogs.count > Self.maxLogLines {
            _recentLogs.removeFirst(_recentLogs.count - Self.maxLogLines)
        }
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            MantleLog.runtime("backend-process", trimmed)
        }
    }

    // MARK: - Init

    init(config: Config = .default) {
        self.config = config
        let (stream, continuation) = AsyncStream.makeStream(of: ProcessState.self)
        self.stateUpdates = stream
        self.stateContinuation = continuation

        // Register for app termination
        NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            Task { await self.stop() }
        }
    }

    deinit {
        stateContinuation.finish()
    }

    // MARK: - Public API

    func updateConfig(_ config: Config) {
        self.config = config
    }

    func start() async {
        // Step 1: Check if backend is already running
        _state = .detecting
        MantleLog.backend.info("Checking for existing backend")
        MantleLog.runtime("backend", "checking for existing backend on port \(self.config.backendPort)")
        if await isBackendHealthy() {
            MantleLog.backend.info("Backend already running on port \(self.config.backendPort)")
            MantleLog.runtime("backend", "backend already running on port \(self.config.backendPort)")
            _state = .running
            return
        }

        // Step 2: Find node
        guard let nodePath = await detectNode() else {
            MantleLog.backend.error("Node.js not found")
            MantleLog.runtime("backend", "node.js not found")
            _state = .nodeNotFound
            return
        }
        MantleLog.backend.info("Node.js found at \(nodePath)")
        MantleLog.runtime("backend", "node.js found at \(nodePath)")
        resolvedNodePath = nodePath

        // Step 3: Verify agent-core exists
        let servePath = (config.resolvedAgentCorePath as NSString).appendingPathComponent("dist/src/serve.js")
        guard FileManager.default.fileExists(atPath: servePath) else {
            MantleLog.backend.error("agent-core not found at \(self.config.agentCorePath)")
            MantleLog.runtime("backend", "agent-core not found at \(self.config.agentCorePath)")
            _state = .startFailed("agent-core not found at: \(config.agentCorePath)")
            return
        }

        // Step 4: Launch
        MantleLog.backend.info("Launching agent-core from \(self.config.agentCorePath)")
        MantleLog.runtime("backend", "launching agent-core from \(self.config.agentCorePath)")
        await launchProcess(nodePath: nodePath)
    }

    func stop() {
        // Clean up pipe handlers
        stdoutPipe?.fileHandleForReading.readabilityHandler = nil
        stderrPipe?.fileHandleForReading.readabilityHandler = nil

        guard let process, process.isRunning else {
            _state = .stopped
            return
        }

        MantleLog.backend.info("Stopping backend (SIGTERM)")
        process.terminate() // SIGTERM

        // Give it 2 seconds, then SIGKILL
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) { [weak process] in
            guard let process, process.isRunning else { return }
            process.interrupt() // SIGKILL fallback
        }

        self.process = nil
        _state = .stopped
    }

    func restart() async {
        restartCount = 0
        stop()
        try? await Task.sleep(for: .seconds(1))
        await start()
    }

    // MARK: - Node Detection

    private func detectNode() async -> String? {
        // 1. User-configured path
        if let custom = config.nodePath, !custom.isEmpty {
            if await validateNode(at: custom) { return custom }
        }

        // 2. Common install locations
        let candidates = [
            "/opt/homebrew/bin/node",         // Apple Silicon Homebrew
            "/usr/local/bin/node",            // Intel Homebrew / official installer
        ]

        for path in candidates {
            if await validateNode(at: path) { return path }
        }

        // 3. nvm — find latest version
        let nvmBase = NSString("~/.nvm/versions/node").expandingTildeInPath
        if let versions = try? FileManager.default.contentsOfDirectory(atPath: nvmBase) {
            let sorted = versions.sorted { $0.localizedStandardCompare($1) == .orderedDescending }
            for version in sorted {
                let path = (nvmBase as NSString).appendingPathComponent("\(version)/bin/node")
                if await validateNode(at: path) { return path }
            }
        }

        // 4. Volta
        let voltaBase = NSString("~/.volta/tools/image/node").expandingTildeInPath
        if let versions = try? FileManager.default.contentsOfDirectory(atPath: voltaBase) {
            let sorted = versions.sorted { $0.localizedStandardCompare($1) == .orderedDescending }
            for version in sorted {
                let path = (voltaBase as NSString).appendingPathComponent("\(version)/bin/node")
                if await validateNode(at: path) { return path }
            }
        }

        // 5. System PATH fallback via /usr/bin/env
        if await validateNode(at: "/usr/bin/env", args: ["node"]) {
            return "/usr/bin/env"
        }

        return nil
    }

    private func validateNode(at path: String, args: [String] = []) async -> Bool {
        guard FileManager.default.fileExists(atPath: path) || path == "/usr/bin/env" else {
            return false
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = args + ["--version"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()

        do {
            try process.run()
            process.waitUntilExit()

            guard process.terminationStatus == 0 else { return false }

            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            guard let version = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) else {
                return false
            }

            // Parse version: v18.17.0 → 18
            let digits = version.dropFirst() // drop "v"
            guard let major = Int(digits.prefix(while: { $0.isNumber })) else { return false }
            return major >= 18
        } catch {
            return false
        }
    }

    // MARK: - Process Launch

    private func launchProcess(nodePath: String) async {
        _state = .starting

        // Clean up previous pipe handlers before creating new ones
        stdoutPipe?.fileHandleForReading.readabilityHandler = nil
        stderrPipe?.fileHandleForReading.readabilityHandler = nil
        stdoutPipe = nil
        stderrPipe = nil

        let proc = Process()
        if nodePath == "/usr/bin/env" {
            proc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            proc.arguments = ["node", "dist/src/serve.js"]
        } else {
            proc.executableURL = URL(fileURLWithPath: nodePath)
            proc.arguments = ["dist/src/serve.js"]
        }
        proc.currentDirectoryURL = URL(fileURLWithPath: config.resolvedAgentCorePath)

        // Inherit environment + configure agent-core
        var env = ProcessInfo.processInfo.environment
        env["PORT"] = "\(config.backendPort)"
        env["AGENT_CORE_WORKSPACE_MODE"] = config.workspaceMode.rawValue
        env["AGENT_CORE_WORKSPACE_DIR"] = config.resolvedWorkspacePath
        env["AGENT_CORE_VIRTUAL_MODE"] = config.virtualMode ? "true" : "false"
        env["AGENT_CORE_DATA_DIR"] = config.resolvedAgentCorePath + "/.agent-core"
        let skillSourceAbsolute = (config.resolvedAgentCorePath as NSString)
            .appendingPathComponent(".deepagents/skills")
        if let relativeSkillSource = MantlePathDefaults.relativePathIfInside(
            root: config.resolvedWorkspacePath,
            target: skillSourceAbsolute
        ) {
            env["AGENT_CORE_SKILL_SOURCE_PATHS"] = relativeSkillSource
        }
        let subagentSourceAbsolute = (config.resolvedAgentCorePath as NSString)
            .appendingPathComponent(".deepagents/subagents")
        if let relativeSubagentSource = MantlePathDefaults.relativePathIfInside(
            root: config.resolvedWorkspacePath,
            target: subagentSourceAbsolute
        ) {
            env["AGENT_CORE_SUBAGENT_SOURCE_PATHS"] = relativeSubagentSource
        }

        // M3: Safety guardrails — block dangerous commands
        env["AGENT_CORE_BLOCKED_INPUT_TERMS"] = [
            "rm -rf /", "rm -rf ~", "sudo rm", "mkfs", "dd if=",
            "> /dev/", "chmod -R 777", "diskutil erase",
        ].joined(separator: ",")

        proc.environment = env

        // Capture output and read into log buffer
        let stdout = Pipe()
        let stderr = Pipe()
        proc.standardOutput = stdout
        proc.standardError = stderr
        self.stdoutPipe = stdout
        self.stderrPipe = stderr

        // Clear logs for new launch
        _recentLogs = []

        // Read stdout/stderr asynchronously
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let line = String(data: data, encoding: .utf8) else { return }
            Task { [weak self] in
                await self?.appendLog(line)
            }
        }
        stderr.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let line = String(data: data, encoding: .utf8) else { return }
            Task { [weak self] in
                await self?.appendLog("[stderr] \(line)")
            }
        }

        // Termination handler for crash detection
        proc.terminationHandler = { [weak self] terminatedProcess in
            guard let self else { return }
            Task {
                await self.handleTermination(exitCode: terminatedProcess.terminationStatus)
            }
        }

        do {
            try proc.run()
            self.process = proc

            // Poll health check for up to 15 seconds
            var healthy = false
            for _ in 0..<30 {
                try? await Task.sleep(for: .milliseconds(500))
                if await isBackendHealthy() {
                    healthy = true
                    break
                }
                // Check if process died during startup
                if !proc.isRunning {
                    _state = .startFailed("Process exited during startup (code: \(proc.terminationStatus))")
                    return
                }
            }

            if healthy {
                restartCount = 0
                MantleLog.backend.info("Backend ready on port \(self.config.backendPort)")
                MantleLog.runtime("backend", "backend ready on port \(self.config.backendPort)")
                _state = .running
            } else {
                MantleLog.backend.error("Health check timeout after 15s")
                MantleLog.runtime("backend", "health check timeout after 15s")
                _state = .startFailed("Health check timeout after 15s")
                proc.terminate()
                self.process = nil
                stdoutPipe?.fileHandleForReading.readabilityHandler = nil
                stderrPipe?.fileHandleForReading.readabilityHandler = nil
            }
        } catch {
            MantleLog.backend.error("Launch failed: \(error.localizedDescription)")
            MantleLog.runtime("backend", "launch failed: \(error.localizedDescription)")
            _state = .startFailed(error.localizedDescription)
        }
    }

    // MARK: - Crash Handling

    private func handleTermination(exitCode: Int32) {
        // Normal exit or user-initiated stop
        guard _state != .stopped else { return }
        guard exitCode != 0 else {
            _state = .stopped
            return
        }

        restartCount += 1
        MantleLog.backend.warning("Backend crashed, exit code \(exitCode), attempt \(self.restartCount)/\(self.config.maxRestarts)")
        MantleLog.runtime("backend", "backend crashed exitCode=\(exitCode) attempt \(self.restartCount)/\(self.config.maxRestarts)")
        if restartCount <= config.maxRestarts {
            _state = .restarting(attempt: restartCount)
            Task {
                try? await Task.sleep(for: .seconds(2))
                if let nodePath = resolvedNodePath {
                    await launchProcess(nodePath: nodePath)
                } else {
                    MantleLog.backend.error("Node path lost after crash")
                    MantleLog.runtime("backend", "node path lost after crash")
                    _state = .crashed("Node path lost after crash")
                }
            }
        } else {
            MantleLog.backend.error("Max restarts exceeded (\(self.restartCount))")
            MantleLog.runtime("backend", "max restarts exceeded (\(self.restartCount))")
            _state = .crashed("Process crashed \(restartCount) times (last exit code: \(exitCode))")
        }
    }

    // MARK: - Health Check

    private func isBackendHealthy() async -> Bool {
        let url = URL(string: "http://127.0.0.1:\(config.backendPort)/health")!
        var request = URLRequest(url: url)
        request.timeoutInterval = 3

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200 else { return false }

            struct HealthResponse: Decodable { let ok: Bool }
            let health = try JSONDecoder().decode(HealthResponse.self, from: data)
            return health.ok
        } catch {
            return false
        }
    }
}
