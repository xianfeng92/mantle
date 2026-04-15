import AVFoundation
import Speech
import os
import Accelerate

// MARK: - Speech Service
//
// Provides:
// 1. Speech-to-Text (STT) via Apple's SFSpeechRecognizer (on-device)
// 2. Text-to-Speech (TTS) via Piper (primary) / Apple (fallback)
// 3. Voice Activity Detection (VAD) — energy-based with adaptive threshold
//
// Voice conversation pipeline:
//   mic (continuous) → VAD → speech start → ASR begins streaming
//                     → speech end → ASR finalizes → send to LLM
//                     → LLM reply → TTS → VAD resumes
//
// All audio processing happens on a dedicated serial queue.
// VAD and ASR share the same audio tap — no double-capture.

// MARK: - Energy VAD

/// Lightweight energy-based Voice Activity Detector.
/// Runs in the audio callback thread — no allocations, no locks.
struct EnergyVAD: Sendable {

    // -- Config (tunable) --
    /// RMS energy above this = speech. Auto-calibrated from ambient noise.
    var speechThreshold: Float = 0.015
    /// Seconds of silence after speech before triggering "end"
    var silenceDuration: TimeInterval = 0.5
    /// Seconds of speech before triggering "start" (debounce)
    var speechMinDuration: TimeInterval = 0.15
    /// Frames of ambient noise used for auto-calibration
    var calibrationFrames: Int = 30

    // -- Runtime state --
    private(set) var isSpeechActive: Bool = false
    private var speechStartTime: TimeInterval = 0
    private var silenceStartTime: TimeInterval = 0
    private var frameCount: Int = 0
    private var ambientSum: Float = 0

    /// Feed an audio buffer, returns transition event (if any).
    mutating func process(buffer: AVAudioPCMBuffer, time: TimeInterval) -> VADEvent? {
        let rms = Self.calculateRMS(buffer)
        frameCount += 1

        // Auto-calibrate threshold from first N frames of ambient noise
        if frameCount <= calibrationFrames {
            ambientSum += rms
            if frameCount == calibrationFrames {
                let ambient = ambientSum / Float(calibrationFrames)
                // Set threshold at 3x ambient noise floor, with a minimum
                speechThreshold = max(0.008, ambient * 3.0)
                let thresh = speechThreshold
                MantleLog.app.info("VAD calibrated: ambient=\(ambient) threshold=\(thresh)")
            }
            return nil
        }

        let isSpeech = rms > speechThreshold

        if !isSpeechActive {
            if isSpeech {
                if speechStartTime == 0 {
                    speechStartTime = time
                }
                // Debounce: require sustained speech
                if time - speechStartTime >= speechMinDuration {
                    isSpeechActive = true
                    silenceStartTime = 0
                    return .speechStart
                }
            } else {
                speechStartTime = 0
            }
        } else {
            if isSpeech {
                silenceStartTime = 0
            } else {
                if silenceStartTime == 0 {
                    silenceStartTime = time
                }
                if time - silenceStartTime >= silenceDuration {
                    isSpeechActive = false
                    speechStartTime = 0
                    silenceStartTime = 0
                    return .speechEnd
                }
            }
        }
        return nil
    }

    /// Reset state for a new listening session
    mutating func reset() {
        isSpeechActive = false
        speechStartTime = 0
        silenceStartTime = 0
        frameCount = 0
        ambientSum = 0
    }

    /// Calculate RMS energy of a buffer using Accelerate framework
    @inline(__always)
    nonisolated static func calculateRMS(_ buffer: AVAudioPCMBuffer) -> Float {
        guard let data = buffer.floatChannelData?[0] else { return 0 }
        let count = Int(buffer.frameLength)
        guard count > 0 else { return 0 }
        var rms: Float = 0
        vDSP_rmsqv(data, 1, &rms, vDSP_Length(count))
        return rms
    }
}

enum VADEvent: Sendable {
    case speechStart
    case speechEnd
}

// MARK: - Speech Service

@Observable
@MainActor
final class SpeechService: NSObject {
    private nonisolated static let ttsTemporarilyDisabled = true
    private nonisolated static let ttsDisabledReason =
        "TTS is temporarily disabled while the text-first workflow is being stabilized."

    enum TTSStrategy: String, CaseIterable, Identifiable, Sendable {
        case localFirst
        case systemFirst

        var id: String { rawValue }

        var title: String {
            switch self {
            case .localFirst:
                return "Local First"
            case .systemFirst:
                return "System First"
            }
        }

        var description: String {
            switch self {
            case .localFirst:
                return "Prefer local Piper voices, then fall back to macOS system speech."
            case .systemFirst:
                return "Prefer macOS system speech, then fall back to Piper if needed."
            }
        }
    }

    private enum TTSRoute {
        case piper
        case apple
    }

    // MARK: - STT State

    enum ListeningState: Equatable, Sendable {
        case idle
        case requesting    // waiting for permission
        case listening     // actively transcribing (manual mode)
        case vadListening  // VAD monitoring, waiting for speech
        case vadSpeech     // VAD detected speech, ASR active
        case error(String)
    }

    private(set) var listeningState: ListeningState = .idle

    /// Live transcription text (updates in real-time while listening)
    private(set) var transcript: String = ""

    /// Whether the recognizer detected a final result (user stopped speaking)
    private(set) var isFinalResult: Bool = false

    /// Current RMS level (for UI visualization)
    private(set) var currentRMS: Float = 0

    // MARK: - TTS State

    private(set) var isSpeaking: Bool = false

    /// User preference: automatically speak assistant responses
    var autoSpeak: Bool {
        didSet { UserDefaults.standard.set(autoSpeak, forKey: "mantle.autoSpeak") }
    }

    /// Configurable TTS routing strategy.
    /// Keeps runtime behavior explicit and predictable.
    var ttsStrategy: TTSStrategy {
        didSet { UserDefaults.standard.set(ttsStrategy.rawValue, forKey: "mantle.ttsStrategy") }
    }

    /// Feature flag for the full hands-free voice loop.
    /// Off by default: the core Mantle workflow should stay text-first.
    var experimentalConversationModeEnabled: Bool {
        didSet {
            UserDefaults.standard.set(
                experimentalConversationModeEnabled,
                forKey: "mantle.experimentalVoiceConversationEnabled"
            )

            if !experimentalConversationModeEnabled {
                if conversationMode {
                    stopSpeaking()
                    stopVADConversation()
                } else {
                    isWaitingForReply = false
                }
            }
        }
    }

    // MARK: - Conversation Mode

    /// When true, creates a full voice loop:
    /// mic (continuous) → VAD → ASR → send → model reply → TTS → VAD resumes
    var conversationMode: Bool = false {
        didSet {
            if conversationMode {
                autoSpeak = true
            }
        }
    }

    /// Set to true while waiting for model response (between send and TTS start)
    var isWaitingForReply: Bool = false

    // MARK: - Private (STT)

    private let speechRecognizer: SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    nonisolated(unsafe) private let audioEngine = AVAudioEngine()

    /// Serial queue for all AVAudioEngine operations (must not run on main thread)
    private nonisolated let audioQueue = DispatchQueue(label: "mantle.speech.audio")

    // MARK: - Private (VAD)

    private nonisolated(unsafe) var vad = EnergyVAD()
    /// Whether the continuous mic is running for VAD mode
    private var vadMicActive: Bool = false
    /// Thread-safe holder so the audio tap always appends to the current ASR request.
    private nonisolated(unsafe) let requestHolder = ASRRequestHolder()

    // MARK: - Private (TTS)

    nonisolated(unsafe) private let synthesizer = AVSpeechSynthesizer()
    private var ttsDelegate: TTSDelegate?

    // MARK: - Init

    override init() {
        self.speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-Hans"))
            ?? SFSpeechRecognizer()
        self.autoSpeak = UserDefaults.standard.bool(forKey: "mantle.autoSpeak")
        self.ttsStrategy = UserDefaults.standard.string(forKey: "mantle.ttsStrategy")
            .flatMap(TTSStrategy.init(rawValue:))
            ?? .systemFirst
        self.experimentalConversationModeEnabled = UserDefaults.standard.bool(
            forKey: "mantle.experimentalVoiceConversationEnabled"
        )
        super.init()

        if !isTTSEnabled {
            autoSpeak = false
            experimentalConversationModeEnabled = false
        }
    }

    var isTTSEnabled: Bool { !Self.ttsTemporarilyDisabled }

    var ttsDisabledExplanation: String { Self.ttsDisabledReason }

    var showsConversationModeControls: Bool {
        isTTSEnabled && (experimentalConversationModeEnabled || conversationMode)
    }

    var ttsAvailabilitySummary: String {
        guard isTTSEnabled else {
            return "Temporarily disabled"
        }
        switch ttsStrategy {
        case .localFirst:
            if Self.piperAvailable {
                return "Piper -> Apple say"
            }
            return "Apple say (Piper unavailable)"
        case .systemFirst:
            if Self.piperAvailable {
                return "Apple say -> Piper"
            }
            return "Apple say"
        }
    }

    // MARK: - STT: Permission

    nonisolated static var microphoneStatus: AVAudioApplication.recordPermission {
        AVAudioApplication.shared.recordPermission
    }

    nonisolated static var speechStatus: SFSpeechRecognizerAuthorizationStatus {
        SFSpeechRecognizer.authorizationStatus()
    }

    static func requestPermissions() async -> Bool {
        let micGranted: Bool = await withCheckedContinuation { cont in
            AVAudioApplication.requestRecordPermission { granted in
                cont.resume(returning: granted)
            }
        }
        guard micGranted else { return false }
        let speechGranted: Bool = await withCheckedContinuation { cont in
            SFSpeechRecognizer.requestAuthorization { status in
                cont.resume(returning: status == .authorized)
            }
        }
        return speechGranted
    }

    // MARK: - Manual STT: Start / Stop
    //
    // Manual mode now also uses VAD: mic starts → VAD waits for speech →
    // speech detected → ASR begins → silence detected → auto-stop + send.
    // The only difference from conversation mode: manual mode stops after one utterance.

    func startListening() async {
        guard listeningState == .idle || isErrorState else { return }

        listeningState = .requesting
        transcript = ""
        isFinalResult = false
        conversationMode = false

        if Self.microphoneStatus != .granted || Self.speechStatus != .authorized {
            let granted = await Self.requestPermissions()
            if !granted {
                listeningState = .error("Microphone or speech recognition permission denied.")
                return
            }
        }
        guard let speechRecognizer, speechRecognizer.isAvailable else {
            listeningState = .error("Speech recognizer not available.")
            return
        }
        do {
            try await startAudioSessionVAD()
            listeningState = .vadListening
            MantleLog.app.info("[STT] manual mode: VAD listening started")
        } catch {
            listeningState = .error("Failed to start audio: \(error.localizedDescription)")
        }
    }

    func stopListening() -> String {
        let result = transcript
        let currentState = String(describing: listeningState)
        MantleLog.app.info("[STT] stopListening: transcript=\"\(result)\" state=\(currentState)")
        recognitionRequest?.endAudio()
        recognitionRequest = nil
        requestHolder.request = nil
        recognitionTask?.cancel()
        recognitionTask = nil
        let engine = audioEngine
        audioQueue.async {
            if engine.isRunning {
                engine.stop()
                engine.inputNode.removeTap(onBus: 0)
            }
        }
        listeningState = .idle
        vadMicActive = false
        if conversationMode && !result.isEmpty {
            isWaitingForReply = true
        }
        MantleLog.app.info("[STT] stopListening returning: \"\(result)\"")
        return result
    }

    // MARK: - VAD Conversation: Start / Stop

    /// Start continuous mic with VAD. When speech detected → ASR starts.
    /// When silence detected → ASR finalizes → callback fires.
    func startVADConversation() async {
        guard listeningState == .idle || isErrorState else { return }
        guard isTTSEnabled else {
            listeningState = .error("Voice conversation is temporarily unavailable because TTS is disabled.")
            return
        }
        guard experimentalConversationModeEnabled else {
            listeningState = .error("Experimental voice conversation is disabled in Settings.")
            return
        }

        listeningState = .requesting
        transcript = ""
        isFinalResult = false

        if Self.microphoneStatus != .granted || Self.speechStatus != .authorized {
            let granted = await Self.requestPermissions()
            if !granted {
                conversationMode = false
                listeningState = .error("Microphone or speech recognition permission denied.")
                return
            }
        }
        guard let speechRecognizer, speechRecognizer.isAvailable else {
            conversationMode = false
            listeningState = .error("Speech recognizer not available.")
            return
        }

        do {
            try await startAudioSessionVAD()
            conversationMode = true
            listeningState = .vadListening
        } catch {
            conversationMode = false
            listeningState = .error("Failed to start audio: \(error.localizedDescription)")
        }
    }

    func stopVADConversation() {
        conversationMode = false
        isWaitingForReply = false
        recognitionRequest?.endAudio()
        recognitionRequest = nil
        requestHolder.request = nil
        recognitionTask?.cancel()
        recognitionTask = nil
        let engine = audioEngine
        audioQueue.async {
            if engine.isRunning {
                engine.stop()
                engine.inputNode.removeTap(onBus: 0)
            }
        }
        vadMicActive = false
        listeningState = .idle
    }

    /// Resume VAD listening after TTS finishes (mic stays on, just reset VAD)
    func resumeVADListening() async {
        guard conversationMode else { return }

        // If mic is still running, just reset VAD and switch state
        if vadMicActive {
            vad.reset()
            transcript = ""
            isFinalResult = false
            listeningState = .vadListening
            return
        }

        // Otherwise restart the full pipeline
        await startVADConversation()
    }

    // (Manual mode now uses startAudioSessionVAD — no separate audio session needed)

    // MARK: - Audio Session: VAD Mode

    /// Exactly mirrors the proven-working manual audio session, with VAD added in the tap.
    /// Key: audioQueue does NOT capture [weak self], tap captures request directly.
    private func startAudioSessionVAD() async throws {
        recognitionTask?.cancel()
        recognitionTask = nil

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        if #available(macOS 13, *) {
            request.requiresOnDeviceRecognition = speechRecognizer?.supportsOnDeviceRecognition ?? false
        }
        self.recognitionRequest = request
        self.requestHolder.request = request
        vad.reset()

        let engine = audioEngine
        let holder = requestHolder

        let startResult: Result<Void, Error> = await withCheckedContinuation { cont in
            audioQueue.async {
                let inputNode = engine.inputNode
                let fmt = inputNode.outputFormat(forBus: 0)
                guard fmt.sampleRate > 0, fmt.channelCount > 0 else {
                    cont.resume(returning: .failure(SpeechError.noInputDevice))
                    return
                }
                // VAD state lives on the audio thread — no cross-thread sharing
                var localVAD = EnergyVAD()

                inputNode.installTap(onBus: 0, bufferSize: 1024, format: fmt) { [weak self] buffer, when in
                    // Always feed ASR via holder (so swapping request for next utterance works)
                    holder.append(buffer)

                    // VAD: runs entirely on audio thread
                    let rms = EnergyVAD.calculateRMS(buffer)
                    let time = Double(when.sampleTime) / fmt.sampleRate
                    let event = localVAD.process(buffer: buffer, time: time)

                    // Dispatch state changes to MainActor
                    Task { @MainActor [weak self] in
                        guard let self else { return }
                        self.currentRMS = rms
                        if let event {
                            switch event {
                            case .speechStart:
                                MantleLog.app.info("[VAD] speech start")
                                if self.listeningState == .vadListening {
                                    self.listeningState = .vadSpeech
                                }
                            case .speechEnd:
                                MantleLog.app.info("[VAD] speech end")
                                self.onVADSpeechEnd()
                            }
                        }
                    }
                }
                engine.prepare()
                do {
                    try engine.start()
                    cont.resume(returning: .success(()))
                } catch {
                    cont.resume(returning: .failure(error))
                }
            }
        }
        try startResult.get()
        vadMicActive = true

        // Recognition task AFTER engine (proven working order)
        MantleLog.app.info("[ASR] creating recognition task")
        recognitionTask = speechRecognizer?.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if let result {
                    self.transcript = result.bestTranscription.formattedString
                    self.isFinalResult = result.isFinal
                    MantleLog.app.info("[ASR] \"\(result.bestTranscription.formattedString)\" isFinal=\(result.isFinal)")
                }
                if let error {
                    let nsError = error as NSError
                    // 216/209 = expected errors when endAudio() is called, ignore silently
                    if nsError.domain == "kAFAssistantErrorDomain" && (nsError.code == 216 || nsError.code == 209) {
                        return
                    }
                    MantleLog.app.warning("[ASR] error: \(error)")
                }
            }
        }
        let taskOk = recognitionTask != nil
        MantleLog.app.info("[ASR] recognitionTask created: \(taskOk)")
    }

    /// Called when VAD detects speech end — deliver transcript immediately.
    /// We already have the latest partial from real-time ASR, no need to wait for isFinal
    /// (which never fires for Chinese SFSpeechRecognizer anyway).
    private func onVADSpeechEnd() {
        guard listeningState == .vadSpeech else {
            let state = String(describing: listeningState)
            MantleLog.app.warning("[VAD] onVADSpeechEnd ignored — state=\(state)")
            return
        }

        // Stop ASR immediately — we already have the transcript from partials
        recognitionRequest?.endAudio()
        recognitionRequest = nil
        requestHolder.request = nil
        recognitionTask?.cancel()
        recognitionTask = nil

        MantleLog.app.info("[VAD] onVADSpeechEnd → delivering immediately")
        deliverVADResult()
    }

    /// Deliver the VAD→ASR result to the model
    private func deliverVADResult() {
        let finalText = transcript
        let isConvo = conversationMode
        MantleLog.app.info("[VAD] deliverVADResult: \"\(finalText)\" conversationMode=\(isConvo)")

        if !finalText.isEmpty {
            if conversationMode {
                // Conversation mode: send + restart ASR for next utterance
                isWaitingForReply = true
                listeningState = .vadListening
                transcript = ""
                isFinalResult = false
                // Restart ASR (mic tap is still running, just need a new recognition request)
                restartASRForNextUtterance()
                onVADResult?(finalText)
            } else {
                // Manual mode: send + stop mic completely
                let engine = audioEngine
                audioQueue.async {
                    if engine.isRunning {
                        engine.stop()
                        engine.inputNode.removeTap(onBus: 0)
                    }
                }
                vadMicActive = false
                listeningState = .idle
                isFinalResult = true
                MantleLog.app.info("[VAD] manual mode: stopping mic, firing onVADResult")
                onVADResult?(finalText)
            }
        } else {
            MantleLog.app.info("[VAD] deliverVADResult: empty transcript, resuming")
            if conversationMode {
                // Nothing recognized, restart ASR and resume VAD
                listeningState = .vadListening
                vad.reset()
                restartASRForNextUtterance()
            } else {
                // Manual mode: nothing heard, just go idle
                let engine = audioEngine
                audioQueue.async {
                    if engine.isRunning {
                        engine.stop()
                        engine.inputNode.removeTap(onBus: 0)
                    }
                }
                vadMicActive = false
                listeningState = .idle
            }
        }
    }

    /// Create a fresh ASR recognition request/task while the mic tap keeps running.
    /// The tap reads from `requestHolder`, so swapping the request here takes effect immediately.
    private func restartASRForNextUtterance() {
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        if #available(macOS 13, *) {
            request.requiresOnDeviceRecognition = speechRecognizer?.supportsOnDeviceRecognition ?? false
        }
        self.recognitionRequest = request
        self.requestHolder.request = request

        recognitionTask = speechRecognizer?.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if let result {
                    self.transcript = result.bestTranscription.formattedString
                    self.isFinalResult = result.isFinal
                    MantleLog.app.info("[ASR] \"\(result.bestTranscription.formattedString)\" isFinal=\(result.isFinal)")
                }
                if let error {
                    let nsError = error as NSError
                    if nsError.domain == "kAFAssistantErrorDomain" && (nsError.code == 216 || nsError.code == 209) {
                        return
                    }
                    MantleLog.app.warning("[ASR] error: \(error)")
                }
            }
        }
        MantleLog.app.info("[ASR] restarted recognition for next utterance")
    }

    /// Callback for when VAD+ASR produces a final text result.
    /// Set by AppViewModel to wire into send().
    var onVADResult: ((String) -> Void)?

    // MARK: - TTS: Speak

    /// Active audio player for TTS playback
    private var audioPlayer: AVAudioPlayer?
    private var piperTask: Process?
    private var edgeTask: Process?
    private var sayTask: Process?

    func speak(_ text: String) {
        guard isTTSEnabled else {
            MantleLog.app.info("TTS temporarily disabled; skipping speech output")
            isSpeaking = false
            isWaitingForReply = false
            return
        }

        // Stop any current speech
        stopSpeaking()

        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }

        // Strip markdown formatting for cleaner speech
        let cleaned = Self.stripMarkdown(text)

        isSpeaking = true
        isWaitingForReply = false

        speakWithPreferredTTS(cleaned)
    }

    func stopSpeaking() {
        edgeTask?.terminate()
        edgeTask = nil
        piperTask?.terminate()
        piperTask = nil
        sayTask?.terminate()
        sayTask = nil
        audioPlayer?.stop()
        audioPlayer = nil
        if synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
        }
        isSpeaking = false
    }

    private func speakWithPreferredTTS(_ text: String) {
        switch ttsStrategy {
        case .localFirst:
            if Self.piperAvailable {
                speakWithPiper(text, fallbackRoute: .apple)
            } else {
                speakWithApple(text, fallbackRoute: nil)
            }
        case .systemFirst:
            speakWithApple(text, fallbackRoute: Self.piperAvailable ? .piper : nil)
        }
    }

    private func fallbackTTS(for text: String, route: TTSRoute?) {
        guard let route else {
            isSpeaking = false
            ttsDidFinish()
            return
        }

        switch route {
        case .piper:
            speakWithPiper(text, fallbackRoute: nil)
        case .apple:
            speakWithApple(text, fallbackRoute: nil)
        }
    }

    // MARK: - Edge TTS (legacy helper — no longer part of the default runtime path)

    private nonisolated static let edgeTTSBin: String = {
        let candidates = MantlePathDefaults.edgeTTSExecutableCandidates()
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) } ?? ""
    }()

    nonisolated static var edgeTTSAvailable: Bool { !edgeTTSBin.isEmpty }

    private func speakWithEdgeTTS(_ text: String) {
        guard Self.edgeTTSAvailable else {
            // Fallback to Piper
            if Self.piperAvailable {
                speakWithPiper(text, fallbackRoute: .apple)
            } else {
                speakWithApple(text, fallbackRoute: nil)
            }
            return
        }

        let isChinese = Self.containsChinese(text)
        let voice = isChinese ? "zh-CN-XiaoxiaoNeural" : "en-US-AriaNeural"
        let outputPath = NSTemporaryDirectory() + "mantle_edge_\(UUID().uuidString).mp3"

        Task.detached { [weak self] in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: Self.edgeTTSBin)
            process.arguments = [
                "--voice", voice,
                "--text", text,
                "--write-media", outputPath,
            ]
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice

            do {
                try process.run()
                await MainActor.run { [weak self] in
                    self?.edgeTask = process
                }
                process.waitUntilExit()

                guard process.terminationStatus == 0 else {
                    MantleLog.app.warning("Edge TTS exited with status \(process.terminationStatus), falling back")
                    await MainActor.run { [weak self] in
                        guard let self, self.isSpeaking else { return }
                        self.edgeTask = nil
                        if Self.piperAvailable {
                            self.speakWithPiper(text, fallbackRoute: .apple)
                        } else {
                            self.speakWithApple(text, fallbackRoute: nil)
                        }
                    }
                    return
                }

                await MainActor.run { [weak self] in
                    guard let self, self.isSpeaking else {
                        try? FileManager.default.removeItem(atPath: outputPath)
                        return
                    }
                    self.edgeTask = nil
                    self.playAudioFile(at: outputPath)
                }
            } catch {
                MantleLog.app.error("Edge TTS failed: \(error)")
                await MainActor.run { [weak self] in
                    guard let self, self.isSpeaking else { return }
                    if Self.piperAvailable {
                        self.speakWithPiper(text, fallbackRoute: .apple)
                    } else {
                        self.speakWithApple(text, fallbackRoute: nil)
                    }
                }
            }
        }
    }

    // MARK: - Piper TTS (offline fallback)

    /// Paths resolved once at launch
    private nonisolated static let piperBin: String = {
        let candidates = MantlePathDefaults.piperExecutableCandidates()
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) } ?? ""
    }()

    private nonisolated static let piperVoicesDir: String = {
        MantlePathDefaults.piperVoiceDirectoryCandidates().first(
            where: { FileManager.default.fileExists(atPath: $0) }
        ) ?? ""
    }()

    nonisolated static var piperAvailable: Bool {
        !piperBin.isEmpty && FileManager.default.fileExists(atPath: piperVoicesDir + "/en_US-lessac-medium.onnx")
    }

    /// Use Piper: pipe text → piper process → WAV file → AVAudioPlayer
    private func speakWithPiper(_ text: String, fallbackRoute: TTSRoute?) {
        let isChinese = Self.containsChinese(text)
        let modelName = isChinese ? "zh_CN-huayan-medium" : "en_US-lessac-medium"
        let modelPath = Self.piperVoicesDir + "/\(modelName).onnx"

        guard FileManager.default.fileExists(atPath: modelPath) else {
            MantleLog.app.warning("Piper model not found: \(modelPath), falling back")
            fallbackTTS(for: text, route: fallbackRoute)
            return
        }

        let outputPath = NSTemporaryDirectory() + "mantle_tts_\(UUID().uuidString).wav"

        Task.detached { [weak self] in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: Self.piperBin)
            process.arguments = ["--model", modelPath, "--output_file", outputPath]

            let pipe = Pipe()
            process.standardInput = pipe
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice

            do {
                try process.run()
                // Write text to stdin, then close to signal EOF
                if let data = text.data(using: .utf8) {
                    pipe.fileHandleForWriting.write(data)
                }
                pipe.fileHandleForWriting.closeFile()
                process.waitUntilExit()

                // Play the generated WAV on main thread
                await MainActor.run { [weak self] in
                    guard let self, self.isSpeaking else {
                        // Stopped while generating
                        try? FileManager.default.removeItem(atPath: outputPath)
                        return
                    }
                    self.playAudioFile(at: outputPath)
                }
            } catch {
                MantleLog.app.error("Piper process failed: \(error)")
                await MainActor.run { [weak self] in
                    self?.fallbackTTS(for: text, route: fallbackRoute)
                }
            }
        }
    }

    /// Play any audio file (MP3, WAV, AIFF) using AVAudioPlayer
    private func playAudioFile(at path: String) {
        let url = URL(fileURLWithPath: path)
        do {
            let player = try AVAudioPlayer(contentsOf: url)
            player.delegate = getOrCreatePlayerDelegate()
            self.audioPlayer = player
            player.play()
        } catch {
            MantleLog.app.error("Failed to play audio: \(error)")
            isSpeaking = false
            ttsDidFinish()
            try? FileManager.default.removeItem(atPath: path)
        }
    }

    /// Delegate for AVAudioPlayer completion (created once in init)
    private var piperPlayerDelegate_: PiperPlayerDelegate?

    private func getOrCreatePlayerDelegate() -> PiperPlayerDelegate {
        if let existing = piperPlayerDelegate_ { return existing }
        let delegate = PiperPlayerDelegate { [weak self] in
            Task { @MainActor [weak self] in
                guard let self else { return }
                // Cleanup temp file
                if let url = self.audioPlayer?.url {
                    try? FileManager.default.removeItem(at: url)
                }
                self.audioPlayer = nil
                self.isSpeaking = false
                self.ttsDidFinish()
            }
        }
        piperPlayerDelegate_ = delegate
        return delegate
    }

    // MARK: - Apple TTS (fallback — uses `say` command for better quality)

    private func speakWithApple(_ text: String, fallbackRoute: TTSRoute?) {
        let voice = Self.bestSystemVoiceName(for: text)

        Task.detached { [weak self] in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/say")
            var args = [text]
            if let voice {
                args = ["-v", voice] + args
            }
            // Generate to WAV for AVAudioPlayer (enables completion callback)
            let outputPath = NSTemporaryDirectory() + "mantle_say_\(UUID().uuidString).aiff"
            args += ["-o", outputPath]
            process.arguments = args
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice

            do {
                try process.run()
                await MainActor.run { [weak self] in
                    self?.sayTask = process
                }
                process.waitUntilExit()

                await MainActor.run { [weak self] in
                    guard let self, self.isSpeaking else {
                        try? FileManager.default.removeItem(atPath: outputPath)
                        return
                    }
                    self.sayTask = nil
                    self.playAudioFile(at: outputPath)
                }
            } catch {
                MantleLog.app.error("say command failed: \(error)")
                await MainActor.run { [weak self] in
                    self?.fallbackTTS(for: text, route: fallbackRoute)
                }
            }
        }
    }

    /// Pick the best installed system voice by name.
    /// Prefers Premium > Enhanced > default for the detected language.
    nonisolated private static func bestSystemVoiceName(for text: String) -> String? {
        let isChinese = containsChinese(text)

        if isChinese {
            // Prefer Premium Chinese voices
            let zhPreferred = ["Tingting", "Sinji", "Meijia"]
            for name in zhPreferred {
                if isVoiceInstalled(name) { return name }
            }
            return nil // use system default
        } else {
            // Prefer Premium English voices
            let enPreferred = ["Ava", "Zoe", "Samantha", "Allison", "Tom", "Evan", "Karen", "Daniel"]
            for name in enPreferred {
                if isVoiceInstalled(name) { return name }
            }
            return nil
        }
    }

    /// Check if a voice name is installed (via AVSpeechSynthesisVoice)
    nonisolated private static func isVoiceInstalled(_ name: String) -> Bool {
        AVSpeechSynthesisVoice.speechVoices().contains { $0.name == name }
    }

    // MARK: - TTS Completion (shared)

    private func ttsDidFinish() {
        // Conversation mode: TTS done → resume VAD listening
        if conversationMode {
            Task { await resumeVADListening() }
        }
    }

    // MARK: - TTS: Auto-speak assistant response

    /// Call this when an assistant response completes.
    /// If autoSpeak is on, reads the full response aloud.
    /// In conversation mode, TTS completion will auto-restart the mic via VAD.
    func speakIfAutoEnabled(_ text: String) {
        isWaitingForReply = false
        guard isTTSEnabled else { return }
        guard autoSpeak, !text.isEmpty else {
            // Even if not speaking, resume VAD in conversation mode
            if conversationMode {
                Task { await resumeVADListening() }
            }
            return
        }
        speak(text)
    }

    // MARK: - Helpers

    private var isErrorState: Bool {
        if case .error = listeningState { return true }
        return false
    }

    // MARK: - Errors

    private enum SpeechError: LocalizedError {
        case noInputDevice

        var errorDescription: String? {
            switch self {
            case .noInputDevice:
                return "No audio input device found. Check that a microphone is connected."
            }
        }
    }

    /// Pick the best quality voice available for a given language.
    /// Priority: premium > enhanced > default.
    /// Users can download better voices in System Settings > Accessibility > Spoken Content > System Voice > Manage Voices.
    nonisolated private static func bestVoice(for language: String) -> AVSpeechSynthesisVoice? {
        let allVoices = AVSpeechSynthesisVoice.speechVoices()
        let matching = allVoices.filter { $0.language.hasPrefix(language.prefix(2).lowercased()) }

        // Prefer premium quality
        if let premium = matching.first(where: { $0.quality == .premium }) {
            return premium
        }
        // Then enhanced
        if let enhanced = matching.first(where: { $0.quality == .enhanced }) {
            return enhanced
        }
        // Fallback to default for the exact language
        if let defaultVoice = AVSpeechSynthesisVoice(language: language) {
            return defaultVoice
        }
        return matching.first
    }

    /// Log available voices (for debugging — call once to see what's installed)
    func logAvailableVoices() {
        let voices = AVSpeechSynthesisVoice.speechVoices()
        let zhVoices = voices.filter { $0.language.hasPrefix("zh") }
        let enVoices = voices.filter { $0.language.hasPrefix("en") }

        MantleLog.app.info("Chinese voices: \(zhVoices.map { "\($0.name) [\($0.quality.rawValue)]" })")
        MantleLog.app.info("English voices: \(enVoices.map { "\($0.name) [\($0.quality.rawValue)]" })")
    }

    /// Remove common markdown syntax for cleaner TTS
    nonisolated private static func stripMarkdown(_ text: String) -> String {
        var s = text
        // Remove code blocks
        s = s.replacingOccurrences(of: "```[\\s\\S]*?```", with: "", options: .regularExpression)
        // Remove inline code
        s = s.replacingOccurrences(of: "`[^`]+`", with: "", options: .regularExpression)
        // Remove headers
        s = s.replacingOccurrences(of: "^#{1,6}\\s+", with: "", options: .regularExpression)
        // Remove bold/italic markers
        s = s.replacingOccurrences(of: "[*_]{1,3}", with: "", options: .regularExpression)
        // Remove link syntax [text](url) → text
        s = s.replacingOccurrences(of: "\\[([^]]+)\\]\\([^)]+\\)", with: "$1", options: .regularExpression)
        // Remove image syntax
        s = s.replacingOccurrences(of: "!\\[[^]]*\\]\\([^)]+\\)", with: "", options: .regularExpression)
        // Collapse multiple newlines
        s = s.replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression)
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Simple check if text contains Chinese characters
    nonisolated private static func containsChinese(_ text: String) -> Bool {
        text.unicodeScalars.contains { scalar in
            (0x4E00...0x9FFF).contains(scalar.value) || // CJK Unified
            (0x3400...0x4DBF).contains(scalar.value)    // CJK Extension A
        }
    }
}

// MARK: - ASR Request Holder (thread-safe)

/// Allows the audio tap (running on audio thread) to always append to the current
/// ASR recognition request, even after it's been swapped for a new utterance.
private final class ASRRequestHolder: @unchecked Sendable {
    private let lock = NSLock()
    private var _request: SFSpeechAudioBufferRecognitionRequest?

    var request: SFSpeechAudioBufferRecognitionRequest? {
        get { lock.lock(); defer { lock.unlock() }; return _request }
        set { lock.lock(); _request = newValue; lock.unlock() }
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        let req = _request
        lock.unlock()
        req?.append(buffer)
    }
}

// MARK: - TTS Delegate

/// Bridges AVSpeechSynthesizerDelegate back to @MainActor via callback.
private final class TTSDelegate: NSObject, AVSpeechSynthesizerDelegate, @unchecked Sendable {
    private let onFinish: @Sendable () -> Void

    init(onFinish: @escaping @Sendable () -> Void) {
        self.onFinish = onFinish
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        onFinish()
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        onFinish()
    }
}

// MARK: - Piper AVAudioPlayer Delegate

/// Bridges AVAudioPlayerDelegate back to @MainActor via callback.
private final class PiperPlayerDelegate: NSObject, AVAudioPlayerDelegate, @unchecked Sendable {
    private let onFinish: @Sendable () -> Void

    init(onFinish: @escaping @Sendable () -> Void) {
        self.onFinish = onFinish
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        onFinish()
    }

    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        onFinish()
    }
}
