import Foundation
import Vision
import AppKit
import os

// MARK: - MediaPipeline
//
// Pre-processes attached images before they reach the LLM. For non-vision
// models (Gemma, etc.) the OCR-extracted text is the *only* way the model
// sees what's in the image. For vision models the OCR text is a helpful
// supplement that's already in the prompt.
//
// Pipeline stages (MVP):
//   1. Decode base64 data URI → CGImage
//   2. VNRecognizeTextRequest (Apple Neural Engine, on-device, zh + en)
//   3. Return extracted text
//
// Runs off the main actor to avoid blocking the UI during recognition.

struct MediaPipelineResult: Sendable {
    /// OCR-extracted text, nil if the image contains no recognizable text.
    let ocrText: String?
}

enum MediaPipelineError: LocalizedError {
    case invalidDataUri
    case decodeFailed
    case recognitionFailed(String)

    var errorDescription: String? {
        switch self {
        case .invalidDataUri: return "Invalid data URI format"
        case .decodeFailed: return "Failed to decode image data"
        case .recognitionFailed(let msg): return "OCR failed: \(msg)"
        }
    }
}

actor MediaPipeline {
    private static let log = Logger(subsystem: "com.xforg.Mantle", category: "media-pipeline")

    /// Process a single image (base64 data URI) and return OCR text.
    /// Returns nil ocrText when the image has no recognizable text — this is
    /// not an error (blank photo, diagram without text, etc.).
    func processImage(base64DataUri: String) async -> MediaPipelineResult {
        do {
            let cgImage = try decodeDataUri(base64DataUri)
            let text = try await runOCR(cgImage)
            return MediaPipelineResult(ocrText: text)
        } catch {
            Self.log.warning("processImage failed: \(error.localizedDescription)")
            return MediaPipelineResult(ocrText: nil)
        }
    }

    /// Process multiple images concurrently, return results in the same order.
    func processImages(_ dataUris: [String]) async -> [MediaPipelineResult] {
        await withTaskGroup(of: (Int, MediaPipelineResult).self) { group in
            for (i, uri) in dataUris.enumerated() {
                group.addTask { [self] in
                    let result = await self.processImage(base64DataUri: uri)
                    return (i, result)
                }
            }
            var results = Array(repeating: MediaPipelineResult(ocrText: nil), count: dataUris.count)
            for await (i, result) in group {
                results[i] = result
            }
            return results
        }
    }

    // MARK: - Decode

    private func decodeDataUri(_ uri: String) throws -> CGImage {
        // Expected format: "data:image/jpeg;base64,/9j/4AAQ..."
        guard let commaIndex = uri.firstIndex(of: ",") else {
            throw MediaPipelineError.invalidDataUri
        }
        let base64String = String(uri[uri.index(after: commaIndex)...])
        guard let data = Data(base64Encoded: base64String, options: .ignoreUnknownCharacters) else {
            throw MediaPipelineError.decodeFailed
        }
        guard let nsImage = NSImage(data: data),
              let cgImage = nsImage.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            throw MediaPipelineError.decodeFailed
        }
        return cgImage
    }

    // MARK: - OCR

    private func runOCR(_ image: CGImage) async throws -> String? {
        try await withCheckedThrowingContinuation { continuation in
            let request = VNRecognizeTextRequest { request, error in
                if let error {
                    continuation.resume(throwing: MediaPipelineError.recognitionFailed(error.localizedDescription))
                    return
                }
                guard let observations = request.results as? [VNRecognizedTextObservation] else {
                    continuation.resume(returning: nil)
                    return
                }
                let lines = observations.compactMap { observation in
                    observation.topCandidates(1).first?.string
                }
                let joined = lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
                continuation.resume(returning: joined.isEmpty ? nil : joined)
            }
            request.recognitionLevel = .accurate
            request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]
            request.usesLanguageCorrection = true

            let handler = VNImageRequestHandler(cgImage: image, options: [:])
            do {
                try handler.perform([request])
            } catch {
                continuation.resume(throwing: MediaPipelineError.recognitionFailed(error.localizedDescription))
            }
        }
    }
}

// MARK: - Enrichment helper

extension MediaPipeline {
    /// Given user text and image data URIs, run OCR on each image and prepend
    /// `[Image N: <ocr text>]` tags to the text. Returns the enriched text.
    /// Images with no OCR result get `[Image N: (no text detected)]`.
    func enrichText(_ text: String, withImages images: [String]) async -> String {
        guard !images.isEmpty else { return text }
        let results = await processImages(images)
        var prefix = ""
        for (i, result) in results.enumerated() {
            let label = images.count == 1 ? "Image" : "Image \(i + 1)"
            if let ocr = result.ocrText {
                prefix += "[\(label): \(ocr)]\n"
            } else {
                prefix += "[\(label): (no text detected)]\n"
            }
        }
        return prefix + "\n" + text
    }
}
