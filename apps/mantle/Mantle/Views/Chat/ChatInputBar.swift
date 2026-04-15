import SwiftUI
import UniformTypeIdentifiers

// MARK: - Chat Input Bar
//
// Text field + send/stop button with three states:
// 1. Idle + connected: normal input, send button
// 2. Streaming: disabled input, stop button (with symbol transition)
// 3. Disconnected: disabled input, grayed send, warning banner
//
// Supports file drag-and-drop: text files have content read and appended,
// other files show their path as context.
//
// Camera button: opens a sheet with live webcam preview, capture, and attach.

struct ChatInputBar: View {
    var onSend: (String) -> Void
    @Binding var taskMode: ThreadTaskMode
    var isConnected: Bool = true
    var isStreaming: Bool = false
    var onStop: (() -> Void)?
    /// Camera service for webcam capture
    var cameraService: CameraCaptureService?
    /// Callback when a camera image is accepted (base64 data URI)
    var onCameraImage: ((String) -> Void)?
    /// Currently pending camera images (for preview display)
    var pendingImages: [String] = []
    /// Callback to clear all pending images
    var onClearPendingImages: (() -> Void)?
    /// Speech service for voice input / TTS
    var speechService: SpeechService?
    /// Bound to AppViewModel.shouldFocusInput for hotkey-triggered focus
    @Binding var requestFocus: Bool

    @State private var text = ""
    @State private var isDragOver = false
    @State private var showCamera = false
    @FocusState private var isFocused: Bool

    var body: some View {
        VStack(spacing: 6) {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text("Mode")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text(modeHint)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }

                Picker("Task Mode", selection: $taskMode) {
                    ForEach(ThreadTaskMode.allCases) { mode in
                        Text(mode.title).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .disabled(isStreaming)
            }

            // Disconnected warning
            if !isConnected {
                HStack(spacing: 4) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption2)
                    Text("Backend not connected")
                        .font(.caption)
                }
                .foregroundStyle(Design.stateDanger)
                .padding(.horizontal, 4)
            }

            // Voice status bar (conversation mode + listening states)
            if let speechService {
                if speechService.listeningState == .listening {
                    HStack(spacing: 6) {
                        Circle()
                            .fill(.red)
                            .frame(width: 8, height: 8)
                            .modifier(PulseModifier())
                        Text(speechService.transcript.isEmpty ? "Listening..." : speechService.transcript)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                        Spacer()
                        Button("Done") {
                            let finalText = speechService.stopListening()
                            if !finalText.isEmpty {
                                text = finalText
                                sendMessage()
                            }
                        }
                        .font(.caption)
                        .buttonStyle(.bordered)
                        .tint(Design.accent)
                    }
                    .padding(.horizontal, 4)
                    .transition(.move(edge: .top).combined(with: .opacity))
                } else if speechService.listeningState == .vadListening {
                    HStack(spacing: 6) {
                        // Audio level indicator
                        RMSLevelView(rms: speechService.currentRMS)
                            .frame(width: 20, height: 12)
                        Text(speechService.conversationMode ? "Voice loop listening..." : "Speak now...")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("Stop") {
                            if speechService.conversationMode {
                                speechService.stopVADConversation()
                            } else {
                                _ = speechService.stopListening()
                            }
                        }
                        .font(.caption)
                        .buttonStyle(.bordered)
                        .tint(speechService.conversationMode ? Design.accent : .secondary)
                    }
                    .padding(.horizontal, 4)
                    .transition(.move(edge: .top).combined(with: .opacity))
                } else if speechService.listeningState == .vadSpeech {
                    HStack(spacing: 6) {
                        Circle()
                            .fill(.red)
                            .frame(width: 8, height: 8)
                            .modifier(PulseModifier())
                        Text(
                            speechService.transcript.isEmpty
                                ? (speechService.conversationMode ? "Voice loop capturing..." : "Transcribing...")
                                : speechService.transcript
                        )
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                        Spacer()
                        Button("Stop") {
                            if speechService.conversationMode {
                                speechService.stopVADConversation()
                            } else {
                                _ = speechService.stopListening()
                            }
                        }
                        .font(.caption)
                        .buttonStyle(.bordered)
                        .tint(speechService.conversationMode ? Design.stateDanger : .secondary)
                    }
                    .padding(.horizontal, 4)
                    .transition(.move(edge: .top).combined(with: .opacity))
                } else if speechService.conversationMode && speechService.isWaitingForReply {
                    HStack(spacing: 6) {
                        ProgressView()
                            .controlSize(.small)
                        Text("Waiting for reply...")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("Stop") {
                            speechService.conversationMode = false
                            speechService.isWaitingForReply = false
                        }
                        .font(.caption)
                        .buttonStyle(.bordered)
                    }
                    .padding(.horizontal, 4)
                    .transition(.move(edge: .top).combined(with: .opacity))
                } else if speechService.conversationMode && speechService.isSpeaking {
                    HStack(spacing: 6) {
                        Image(systemName: "speaker.wave.2.fill")
                            .font(.caption)
                            .foregroundStyle(Design.accent)
                            .modifier(PulseModifier())
                        Text("Speaking...")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("Skip") {
                            speechService.stopSpeaking()
                            // Will auto-restart mic via TTS callback
                        }
                        .font(.caption)
                        .buttonStyle(.bordered)
                    }
                    .padding(.horizontal, 4)
                    .transition(.move(edge: .top).combined(with: .opacity))
                }

                // Speech error
                if case .error(let msg) = speechService.listeningState {
                    HStack(spacing: 4) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.caption2)
                        Text(msg)
                            .font(.caption)
                            .lineLimit(2)
                    }
                    .foregroundStyle(Design.stateDanger)
                    .padding(.horizontal, 4)
                }
            }

            // Pending image previews
            if !pendingImages.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(Array(pendingImages.enumerated()), id: \.offset) { _, dataUri in
                            if let nsImage = Self.imageFromDataURI(dataUri) {
                                Image(nsImage: nsImage)
                                    .resizable()
                                    .aspectRatio(contentMode: .fill)
                                    .frame(width: 56, height: 56)
                                    .clipShape(RoundedRectangle(cornerRadius: 6))
                                    .overlay(
                                        RoundedRectangle(cornerRadius: 6)
                                            .stroke(Design.accent.opacity(0.4), lineWidth: 1)
                                    )
                            }
                        }
                        Button {
                            onClearPendingImages?()
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .buttonStyle(.borderless)
                        .help("Clear attached images")
                    }
                    .padding(.horizontal, 4)
                }
                .frame(height: 60)
            }

            HStack(alignment: .bottom, spacing: 8) {
                // Camera button
                Button {
                    showCamera = true
                } label: {
                    Image(systemName: "camera.fill")
                        .font(.body)
                        .foregroundStyle(Design.accent.opacity(0.8))
                }
                .buttonStyle(.borderless)
                .disabled(isStreaming || !isConnected)
                .help("Open camera (capture and attach)")
                .accessibilityLabel("Open camera")

                // Microphone button (voice input)
                if let speechService {
                    let isVoiceActive = switch speechService.listeningState {
                        case .listening, .vadListening, .vadSpeech, .requesting: true
                        default: false
                    }
                    Button {
                        let currentState = speechService.listeningState
                        MantleLog.app.info("[MIC TAP] state=\(String(describing: currentState))")
                        Task {
                            switch currentState {
                            case .listening, .vadSpeech, .vadListening:
                                // Stop and send whatever we have
                                let finalText = speechService.stopListening()
                                MantleLog.app.info("[MIC TAP] stopListening returned: \"\(finalText)\"")
                                if !finalText.isEmpty {
                                    onSend(finalText)
                                    text = ""
                                }
                            case .idle, .error:
                                MantleLog.app.info("[MIC TAP] starting listening")
                                await speechService.startListening()
                            default:
                                break
                            }
                        }
                    } label: {
                        Image(systemName: isVoiceActive ? "mic.fill" : "mic")
                            .font(.body)
                            .foregroundStyle(isVoiceActive ? .red : Design.accent.opacity(0.8))
                            .contentTransition(.symbolEffect(.replace))
                    }
                    .buttonStyle(.borderless)
                    .disabled(isStreaming || !isConnected)
                    .help(isVoiceActive ? "Stop listening" : "Voice input")
                }

                // Conversation mode toggle (voice loop: mic → VAD → ASR → model → TTS → mic)
                if let speechService, speechService.showsConversationModeControls {
                    Button {
                        if speechService.conversationMode {
                            // Stop conversation mode (VAD + everything)
                            speechService.stopSpeaking()
                            speechService.stopVADConversation()
                        } else {
                            // Start VAD conversation mode
                            Task { await speechService.startVADConversation() }
                        }
                    } label: {
                        Image(systemName: speechService.conversationMode
                              ? "waveform.circle.fill"
                              : "waveform.circle")
                            .font(.body)
                            .foregroundStyle(speechService.conversationMode
                                            ? Design.accent : .secondary)
                            .contentTransition(.symbolEffect(.replace))
                    }
                    .buttonStyle(.borderless)
                    .disabled(isStreaming || !isConnected)
                    .help(speechService.conversationMode
                          ? "Stop experimental voice conversation"
                          : "Start experimental voice conversation")
                    .accessibilityLabel(speechService.conversationMode
                                        ? "Stop experimental voice conversation"
                                        : "Start experimental voice conversation")
                }

                // Text editor with drop zone
                TextField(placeholderText, text: $text, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...6)
                    .focused($isFocused)
                    .disabled(isStreaming || !isConnected)
                    .onSubmit {
                        sendMessage()
                    }
                    .padding(8)
                    .background(
                        .quaternary.opacity(isStreaming || !isConnected ? 0.3 : 0.5),
                        in: RoundedRectangle(cornerRadius: Design.cornerRadius)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: Design.cornerRadius)
                            .stroke(isDragOver ? Design.accent : .clear, lineWidth: 2)
                    )
                    .overlay {
                        if isDragOver {
                            VStack(spacing: 4) {
                                Image(systemName: "doc.badge.plus")
                                    .font(.title3)
                                Text("Drop file")
                                    .font(.caption)
                            }
                            .foregroundStyle(Design.accent)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: Design.cornerRadius))
                        }
                    }
                    .onDrop(of: [.fileURL], isTargeted: $isDragOver) { providers in
                        handleDrop(providers)
                    }

                // Send / Stop button
                Button {
                    if isStreaming {
                        onStop?()
                    } else {
                        sendMessage()
                    }
                } label: {
                    Image(systemName: isStreaming ? "stop.circle.fill" : "arrow.up.circle.fill")
                        .font(.title2)
                        .foregroundStyle(buttonColor)
                        .contentTransition(.symbolEffect(.replace))
                }
                .buttonStyle(.borderless)
                .disabled(!isStreaming && !canSend)
                .keyboardShortcut(isStreaming ? .escape : .return, modifiers: [])
                .help(isStreaming ? "Stop generating (Esc)" : "Send message (Return)")
                .accessibilityLabel(isStreaming ? "Stop generating" : "Send message")
                .accessibilityHint(isStreaming ? "Press to stop the current response" : "Press to send your message")
            }
        }
        .animation(.easeInOut(duration: 0.2), value: isStreaming)
        .animation(.easeInOut(duration: 0.2), value: isConnected)
        .animation(.easeInOut(duration: 0.2), value: pendingImages.count)
        .onAppear {
            isFocused = true
        }
        .onChange(of: requestFocus) { _, newValue in
            if newValue {
                isFocused = true
                requestFocus = false
            }
        }
        .onChange(of: speechService?.listeningState) { oldValue, newValue in
            MantleLog.app.info("[onChange] listeningState: \(String(describing: oldValue)) → \(String(describing: newValue))")
        }
        .sheet(isPresented: $showCamera) {
            CameraCaptureSheet(
                cameraService: cameraService,
                onAccept: { dataUri in
                    onCameraImage?(dataUri)
                    showCamera = false
                },
                onCancel: {
                    showCamera = false
                }
            )
        }
    }

    // MARK: - Helpers

    private var canSend: Bool {
        isConnected && (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pendingImages.isEmpty)
    }

    private var buttonColor: Color {
        if isStreaming { return .red }
        if canSend { return Design.accent }
        return .gray
    }

    private var placeholderText: String {
        switch taskMode {
        case .auto:
            return "Ask Mantle..."
        case .coding:
            return "Describe the code change or bug..."
        case .docs:
            return "Ask for a summary, comparison, or rewrite..."
        case .desktopLite:
            return "Ask Mantle to observe the current UI first..."
        }
    }

    private var modeHint: String {
        switch taskMode {
        case .auto:
            return "Let Mantle choose the lane"
        case .coding:
            return "Favor repo, files, and terminal work"
        case .docs:
            return "Favor reading and summarizing"
        case .desktopLite:
            return "Favor observe → act → verify"
        }
    }

    private func sendMessage() {
        guard canSend else { return }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        // Allow sending with just an image (empty text becomes a default prompt)
        let finalText = trimmed.isEmpty ? "What do you see in this image?" : trimmed
        onSend(finalText)
        text = ""
    }

    // MARK: - File Drop

    private func handleDrop(_ providers: [NSItemProvider]) -> Bool {
        for provider in providers {
            provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier) { item, _ in
                guard let data = item as? Data,
                      let url = URL(dataRepresentation: data, relativeTo: nil) else { return }

                let content = Self.readFileContent(url: url)

                DispatchQueue.main.async {
                    if text.isEmpty {
                        text = content
                    } else {
                        text += "\n\n" + content
                    }
                }
            }
        }
        return true
    }

    /// Read file content: text files -> inline content, others -> path reference
    nonisolated private static func readFileContent(url: URL) -> String {
        let textExtensions: Set<String> = [
            "txt", "md", "swift", "py", "js", "ts", "jsx", "tsx",
            "json", "yaml", "yml", "toml", "xml", "html", "css",
            "sh", "bash", "zsh", "rs", "go", "java", "kt", "c", "h",
            "cpp", "hpp", "rb", "php", "sql", "csv", "log", "conf",
            "env", "gitignore", "dockerfile"
        ]

        let ext = url.pathExtension.lowercased()
        let fileName = url.lastPathComponent

        if textExtensions.contains(ext) || ext.isEmpty {
            // Try to read as text
            if let content = try? String(contentsOf: url, encoding: .utf8),
               content.count < 50_000 {  // Limit: 50KB text
                return "File: \(fileName)\n```\n\(content)\n```"
            }
        }

        // Non-text or too large — just reference the path
        return "File: \(url.path)"
    }

    // MARK: - Data URI → NSImage

    static func imageFromDataURI(_ dataUri: String) -> NSImage? {
        guard let commaIndex = dataUri.firstIndex(of: ",") else { return nil }
        let base64 = String(dataUri[dataUri.index(after: commaIndex)...])
        guard let data = Data(base64Encoded: base64) else { return nil }
        return NSImage(data: data)
    }
}

// MARK: - RMS Level View

/// Simple audio level bars for VAD listening state
private struct RMSLevelView: View {
    var rms: Float
    private var level: CGFloat { CGFloat(min(rms * 20, 1.0)) }

    var body: some View {
        HStack(spacing: 1.5) {
            ForEach(0..<3, id: \.self) { i in
                RoundedRectangle(cornerRadius: 1)
                    .fill(barColor(index: i))
                    .frame(width: 3, height: barHeight(index: i))
            }
        }
    }

    private func barHeight(index: Int) -> CGFloat {
        let threshold = CGFloat(index) * 0.33
        return level > threshold ? max(4, 12 * min((level - threshold) * 3, 1.0)) : 3
    }

    private func barColor(index: Int) -> Color {
        let threshold = CGFloat(index) * 0.33
        return level > threshold ? Design.accent : Design.accent.opacity(0.3)
    }
}

// MARK: - Pulse Modifier

private struct PulseModifier: ViewModifier {
    @State private var isPulsing = false

    func body(content: Content) -> some View {
        content
            .opacity(isPulsing ? 0.3 : 1.0)
            .animation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true), value: isPulsing)
            .onAppear { isPulsing = true }
    }
}

// MARK: - Camera Capture Sheet

struct CameraCaptureSheet: View {
    var cameraService: CameraCaptureService?
    var onAccept: (String) -> Void
    var onCancel: () -> Void

    @State private var snapshot: NSImage?
    @State private var snapshotBase64: String?
    @State private var isCapturing = false

    var body: some View {
        VStack(spacing: 16) {
            // Header
            HStack {
                Text("Camera")
                    .font(.headline)
                Spacer()
                Button("Cancel") { stopAndCancel() }
                    .buttonStyle(.borderless)
            }

            if let cameraService {
                switch cameraService.state {
                case .idle, .starting:
                    ProgressView("Starting camera...")
                        .frame(height: 240)

                case .error(let msg):
                    VStack(spacing: 8) {
                        Image(systemName: "camera.badge.exclamationmark")
                            .font(.largeTitle)
                            .foregroundStyle(Design.stateDanger)
                        Text(msg)
                            .font(.caption)
                            .multilineTextAlignment(.center)
                            .foregroundStyle(.secondary)
                    }
                    .frame(height: 240)

                case .running:
                    if let snapshot {
                        // Show captured snapshot
                        Image(nsImage: snapshot)
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .frame(maxHeight: 320)
                            .clipShape(RoundedRectangle(cornerRadius: 8))

                        HStack(spacing: 12) {
                            Button("Retake") {
                                self.snapshot = nil
                                self.snapshotBase64 = nil
                            }
                            .buttonStyle(.bordered)

                            Button("Use Photo") {
                                if let b64 = snapshotBase64 {
                                    cameraService.stop()
                                    onAccept(b64)
                                }
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(Design.accent)
                        }
                    } else {
                        // Live preview
                        CameraPreviewView(session: cameraService.captureSession)
                            .frame(height: 320)
                            .clipShape(RoundedRectangle(cornerRadius: 8))

                        Button {
                            capturePhoto()
                        } label: {
                            Label("Capture", systemImage: "camera.shutter.button")
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(Design.accent)
                        .disabled(isCapturing)
                    }
                }
            } else {
                Text("Camera not available")
                    .foregroundStyle(.secondary)
                    .frame(height: 240)
            }
        }
        .padding(20)
        .frame(width: 460)
        .task {
            await cameraService?.start()
        }
    }

    private func capturePhoto() {
        guard let cameraService else { return }
        isCapturing = true
        Task {
            if let result = await cameraService.capture() {
                snapshot = result.image
                snapshotBase64 = result.base64
            }
            isCapturing = false
        }
    }

    private func stopAndCancel() {
        cameraService?.stop()
        onCancel()
    }
}

// MARK: - Camera Preview (AVCaptureSession → NSView)

import AVFoundation

struct CameraPreviewView: NSViewRepresentable {
    let session: AVCaptureSession

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        let previewLayer = AVCaptureVideoPreviewLayer(session: session)
        previewLayer.videoGravity = .resizeAspectFill
        previewLayer.frame = view.bounds
        previewLayer.autoresizingMask = [.layerWidthSizable, .layerHeightSizable]
        view.layer = CALayer()
        view.layer?.addSublayer(previewLayer)
        view.wantsLayer = true
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        // Layer auto-resizes via autoresizingMask
    }
}
