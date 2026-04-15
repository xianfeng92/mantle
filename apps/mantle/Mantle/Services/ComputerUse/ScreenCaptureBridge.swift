import AppKit
import Foundation
import ScreenCaptureKit
import os

// MARK: - ScreenCaptureBridge
//
// Captures screenshots via ScreenCaptureKit (macOS 14+).
//
// Requires: Screen Recording permission (System Settings > Privacy > Screen Recording).

struct ScreenCaptureBridge: Sendable {

    // MARK: - Public API

    /// Capture the full screen and return compressed JPEG data.
    ///
    /// - Parameter quality: JPEG compression quality (0.0–1.0). Default 0.8.
    /// - Returns: JPEG image data.
    static func captureFullScreen(quality: CGFloat = 0.8) async throws -> Data {
        let cgImage = try await captureFullScreenRaw()
        guard let data = jpegData(from: cgImage, quality: quality) else {
            throw CaptureError.compressionFailed
        }
        MantleLog.computerUse.info("[Screenshot] full screen: \(data.count) bytes")
        return data
    }

    /// Capture a specific window by its CGWindowID.
    static func captureWindow(windowID: CGWindowID, quality: CGFloat = 0.8) async throws -> Data {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
            throw CaptureError.windowNotFound
        }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let config = makeConfig(width: Int(window.frame.width), height: Int(window.frame.height))
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        guard let data = jpegData(from: image, quality: quality) else {
            throw CaptureError.compressionFailed
        }
        MantleLog.computerUse.info("[Screenshot] window \(windowID): \(data.count) bytes")
        return data
    }

    /// Capture all windows of a specific application.
    static func captureApp(bundleID: String, quality: CGFloat = 0.8) async throws -> Data {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else {
            throw CaptureError.noDisplay
        }
        guard let app = content.applications.first(where: { $0.bundleIdentifier == bundleID }) else {
            throw CaptureError.appNotFound
        }

        let filter = SCContentFilter(display: display, including: [app], exceptingWindows: [])
        let config = makeConfig(width: display.width, height: display.height)
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        guard let data = jpegData(from: image, quality: quality) else {
            throw CaptureError.compressionFailed
        }
        MantleLog.computerUse.info("[Screenshot] app \(bundleID): \(data.count) bytes")
        return data
    }

    /// Capture full screen and return the raw CGImage (for local processing).
    static func captureFullScreenRaw() async throws -> CGImage {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else {
            throw CaptureError.noDisplay
        }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = makeConfig(width: display.width, height: display.height)
        config.showsCursor = true
        return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    }

    // MARK: - Permission

    /// Check if Screen Recording permission is granted.
    /// This is async because the only reliable way is to try calling SCShareableContent.
    static func isScreenCaptureGranted() async -> Bool {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            return !content.displays.isEmpty
        } catch {
            return false
        }
    }

    /// Open Screen Recording settings in System Settings.
    @MainActor
    static func openScreenCaptureSettings() {
        let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!
        NSWorkspace.shared.open(url)
    }

    // MARK: - Private

    private static func makeConfig(width: Int, height: Int) -> SCStreamConfiguration {
        let scale = Int(NSScreen.main?.backingScaleFactor ?? 2)
        let config = SCStreamConfiguration()
        config.width = width * scale
        config.height = height * scale
        config.showsCursor = false
        config.captureResolution = .best
        return config
    }

    private static func jpegData(from image: CGImage, quality: CGFloat) -> Data? {
        let bitmap = NSBitmapImageRep(cgImage: image)
        return bitmap.representation(using: .jpeg, properties: [.compressionFactor: quality])
    }

    // MARK: - Errors

    enum CaptureError: LocalizedError {
        case noDisplay
        case windowNotFound
        case appNotFound
        case compressionFailed

        var errorDescription: String? {
            switch self {
            case .noDisplay: return "No display found"
            case .windowNotFound: return "Window not found"
            case .appNotFound: return "Application not found"
            case .compressionFailed: return "Image compression failed"
            }
        }
    }
}
