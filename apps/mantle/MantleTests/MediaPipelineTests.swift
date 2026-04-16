import XCTest
@testable import Mantle

final class MediaPipelineTests: XCTestCase {

    // MARK: - Data URI decoding

    func testInvalidDataUriReturnsNilOCR() async {
        let pipeline = MediaPipeline()
        let result = await pipeline.processImage(base64DataUri: "not-a-data-uri")
        XCTAssertNil(result.ocrText)
    }

    func testEmptyBase64ReturnsNilOCR() async {
        let pipeline = MediaPipeline()
        let result = await pipeline.processImage(base64DataUri: "data:image/png;base64,")
        XCTAssertNil(result.ocrText)
    }

    // MARK: - Enrichment

    func testEnrichTextWithNoImagesPassesThrough() async {
        let pipeline = MediaPipeline()
        let enriched = await pipeline.enrichText("hello", withImages: [])
        XCTAssertEqual(enriched, "hello")
    }

    func testEnrichTextWithBadImageAddsNoTextDetected() async {
        let pipeline = MediaPipeline()
        let enriched = await pipeline.enrichText("hello", withImages: ["bad-uri"])
        XCTAssertTrue(enriched.contains("[Image: (no text detected)]"))
        XCTAssertTrue(enriched.contains("hello"))
    }

    // MARK: - Real OCR (requires macOS Vision framework at test runtime)

    func testOCROnTextImage() async throws {
        // Create a simple image with known text using NSAttributedString rendering.
        let text = "Hello OCR Test 2026"
        guard let imageData = renderTextToJPEG(text) else {
            throw XCTSkip("Could not render test image on this platform")
        }
        let dataUri = "data:image/jpeg;base64," + imageData.base64EncodedString()

        let pipeline = MediaPipeline()
        let result = await pipeline.processImage(base64DataUri: dataUri)

        // Vision OCR should find at least part of the rendered text.
        XCTAssertNotNil(result.ocrText, "OCR should detect text in the rendered image")
        if let ocr = result.ocrText {
            XCTAssertTrue(
                ocr.localizedCaseInsensitiveContains("Hello") ||
                ocr.localizedCaseInsensitiveContains("OCR") ||
                ocr.localizedCaseInsensitiveContains("2026"),
                "OCR text should contain part of '\(text)', got: \(ocr)"
            )
        }
    }

    // MARK: - Helpers

    /// Render a string into a 400×100 JPEG image. Returns nil if rendering fails.
    private func renderTextToJPEG(_ text: String) -> Data? {
        let size = NSSize(width: 400, height: 100)
        let image = NSImage(size: size)
        image.lockFocus()
        NSColor.white.set()
        NSRect(origin: .zero, size: size).fill()
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 28),
            .foregroundColor: NSColor.black,
        ]
        (text as NSString).draw(at: NSPoint(x: 20, y: 30), withAttributes: attributes)
        image.unlockFocus()

        guard let tiff = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff),
              let jpeg = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.9]) else {
            return nil
        }
        return jpeg
    }
}
