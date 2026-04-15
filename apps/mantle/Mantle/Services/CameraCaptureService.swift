import AVFoundation
import AppKit
import os

// MARK: - Camera Capture Service
//
// Manages webcam access on macOS using AVFoundation.
// Provides a live preview layer and single-frame capture → JPEG base64.
//
// Note: AVCaptureSession is not Sendable-safe, so we wrap session operations
// in a dedicated serial queue to satisfy Swift 6 strict concurrency.

@Observable
@MainActor
final class CameraCaptureService: NSObject {

    // MARK: - State

    enum CameraState: Equatable, Sendable {
        case idle
        case starting
        case running
        case error(String)
    }

    private(set) var state: CameraState = .idle
    private(set) var snapshot: NSImage?
    private(set) var snapshotBase64: String?

    // MARK: - AVFoundation

    /// Public for CameraPreviewView binding
    nonisolated(unsafe) let captureSession = AVCaptureSession()

    private let photoOutput = AVCapturePhotoOutput()

    /// Serial queue for all AVCaptureSession mutations
    private nonisolated let sessionQueue = DispatchQueue(label: "mantle.camera.session")

    /// Continuation used by single-frame capture
    private var pendingContinuation: CheckedContinuation<CaptureResult?, Never>?

    // MARK: - Permission

    nonisolated static var authorizationStatus: AVAuthorizationStatus {
        AVCaptureDevice.authorizationStatus(for: .video)
    }

    static func requestAccess() async -> Bool {
        await AVCaptureDevice.requestAccess(for: .video)
    }

    // MARK: - Start / Stop

    func start() async {
        guard state == .idle || isErrorState else { return }
        state = .starting

        // Check permission
        let status = Self.authorizationStatus
        if status == .denied || status == .restricted {
            state = .error("Camera permission denied. Open System Settings > Privacy & Security > Camera to grant access.")
            return
        }
        if status == .notDetermined {
            let granted = await Self.requestAccess()
            if !granted {
                state = .error("Camera permission denied.")
                return
            }
        }

        // Configure and start on session queue
        let session = captureSession
        let output = photoOutput

        let ok: Bool = await withCheckedContinuation { cont in
            sessionQueue.async {
                session.beginConfiguration()
                session.sessionPreset = .high

                // Remove old inputs/outputs
                for input in session.inputs { session.removeInput(input) }
                for out in session.outputs { session.removeOutput(out) }

                guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .unspecified) else {
                    session.commitConfiguration()
                    cont.resume(returning: false)
                    return
                }

                do {
                    let input = try AVCaptureDeviceInput(device: device)
                    if session.canAddInput(input) { session.addInput(input) }
                    if session.canAddOutput(output) { session.addOutput(output) }
                    session.commitConfiguration()
                    session.startRunning()
                    cont.resume(returning: true)
                } catch {
                    session.commitConfiguration()
                    cont.resume(returning: false)
                }
            }
        }

        state = ok ? .running : .error("No camera found or failed to configure.")
    }

    func stop() {
        let session = captureSession
        sessionQueue.async {
            session.stopRunning()
            for input in session.inputs { session.removeInput(input) }
            for out in session.outputs { session.removeOutput(out) }
        }
        snapshot = nil
        snapshotBase64 = nil
        state = .idle
    }

    // MARK: - Capture

    /// Capture a single frame, compress to JPEG, return as base64 data URI.
    func capture() async -> CaptureResult? {
        guard state == .running else { return nil }

        let settings = AVCapturePhotoSettings()
        settings.flashMode = .off

        return await withCheckedContinuation { cont in
            self.pendingContinuation = cont
            self.photoOutput.capturePhoto(with: settings, delegate: self)
        }
    }

    /// Take snapshot and store it locally
    func takeSnapshot() async {
        guard let result = await capture() else { return }
        snapshot = result.image
        snapshotBase64 = result.base64
    }

    /// Discard the current snapshot (back to live preview)
    func clearSnapshot() {
        snapshot = nil
        snapshotBase64 = nil
    }

    /// Accept the snapshot and return the base64, then reset
    func acceptSnapshot() -> String? {
        let b64 = snapshotBase64
        snapshot = nil
        snapshotBase64 = nil
        return b64
    }

    // MARK: - Helpers

    private var isErrorState: Bool {
        if case .error = state { return true }
        return false
    }
}

// MARK: - Capture Result

struct CaptureResult: Sendable {
    let image: NSImage
    let base64: String
}

// MARK: - AVCapturePhotoCaptureDelegate

extension CameraCaptureService: @preconcurrency AVCapturePhotoCaptureDelegate {
    func photoOutput(
        _ output: AVCapturePhotoOutput,
        didFinishProcessingPhoto photo: AVCapturePhoto,
        error: Error?
    ) {
        guard error == nil,
              let data = photo.fileDataRepresentation(),
              let nsImage = NSImage(data: data) else {
            pendingContinuation?.resume(returning: nil)
            pendingContinuation = nil
            return
        }

        // Resize if needed (max 1920x1080) and compress to JPEG
        let resized = Self.resizeImage(nsImage, maxWidth: 1920, maxHeight: 1080)
        let jpegData = Self.jpegData(from: resized, quality: 0.7)
        let base64 = "data:image/jpeg;base64," + jpegData.base64EncodedString()

        let result = CaptureResult(image: resized, base64: base64)
        pendingContinuation?.resume(returning: result)
        pendingContinuation = nil
    }

    // MARK: - Image Processing

    nonisolated private static func resizeImage(_ image: NSImage, maxWidth: CGFloat, maxHeight: CGFloat) -> NSImage {
        let size = image.size
        guard size.width > maxWidth || size.height > maxHeight else { return image }

        let widthRatio = maxWidth / size.width
        let heightRatio = maxHeight / size.height
        let scale = min(widthRatio, heightRatio)

        let newSize = NSSize(width: size.width * scale, height: size.height * scale)
        let resized = NSImage(size: newSize)
        resized.lockFocus()
        image.draw(
            in: NSRect(origin: .zero, size: newSize),
            from: NSRect(origin: .zero, size: size),
            operation: .copy,
            fraction: 1.0
        )
        resized.unlockFocus()
        return resized
    }

    nonisolated private static func jpegData(from image: NSImage, quality: CGFloat) -> Data {
        guard let tiffData = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiffData),
              let jpeg = bitmap.representation(
                  using: .jpeg,
                  properties: [.compressionFactor: quality]
              ) else {
            return Data()
        }
        return jpeg
    }
}
