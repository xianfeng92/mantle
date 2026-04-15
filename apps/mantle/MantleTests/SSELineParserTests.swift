import XCTest
@testable import Cortex

final class SSELineParserTests: XCTestCase {

    // MARK: - Basic parsing with blank-line delimiters (standard SSE)

    func testParseTextDeltaWithBlankLine() throws {
        var parser = SSELineParser()
        XCTAssertNil(parser.feed("event: text_delta"))
        XCTAssertNil(parser.feed("data: {\"delta\":\"Hello\",\"traceId\":\"t1\",\"threadId\":\"th1\"}"))
        let event = parser.feed("")  // blank line flushes

        guard case .textDelta(let data) = event else {
            XCTFail("Expected textDelta, got \(String(describing: event))")
            return
        }
        XCTAssertEqual(data.delta, "Hello")
    }

    // MARK: - Flush on new "event:" line (for .lines which strips empty lines)

    func testFlushOnNewEventLine() throws {
        var parser = SSELineParser()

        // First event
        XCTAssertNil(parser.feed("event: run_started"))
        XCTAssertNil(parser.feed("data: {\"traceId\":\"abc\",\"threadId\":\"t1\",\"mode\":\"run\"}"))

        // Second event — feeding "event:" flushes the first
        let flushed = parser.feed("event: text_delta")!
        guard case .runStarted(let data) = flushed else {
            XCTFail("Expected runStarted, got \(flushed)")
            return
        }
        XCTAssertEqual(data.traceId, "abc")

        // Continue with second event
        XCTAssertNil(parser.feed("data: {\"delta\":\"Hi\"}"))
        let second = parser.flush()
        guard case .textDelta(let delta) = second else {
            XCTFail("Expected textDelta")
            return
        }
        XCTAssertEqual(delta.delta, "Hi")
    }

    func testFlushAtEnd() throws {
        var parser = SSELineParser()
        _ = parser.feed("event: text_delta")
        _ = parser.feed("data: {\"delta\":\"world\"}")
        // No blank line — call flush() at stream end
        let event = parser.flush()
        guard case .textDelta(let data) = event else {
            XCTFail("Expected textDelta")
            return
        }
        XCTAssertEqual(data.delta, "world")
    }

    // MARK: - Run result events

    func testParseRunCompleted() throws {
        var parser = SSELineParser()
        let json = "{\"traceId\":\"t1\",\"status\":\"completed\",\"threadId\":\"th1\",\"interruptCount\":0,\"messages\":[],\"newMessages\":[]}"
        _ = parser.feed("event: run_completed")
        _ = parser.feed("data: \(json)")
        let event = parser.flush()!
        guard case .runCompleted(let result) = event else {
            XCTFail("Expected runCompleted")
            return
        }
        XCTAssertEqual(result.status, .completed)
        XCTAssertEqual(result.threadId, "th1")
    }

    func testParseRunInterrupted() throws {
        var parser = SSELineParser()
        let json = "{\"traceId\":\"t1\",\"status\":\"interrupted\",\"threadId\":\"th1\",\"interruptCount\":1,\"messages\":[],\"newMessages\":[],\"interruptRequest\":{\"actionRequests\":[{\"name\":\"write_file\",\"args\":{\"path\":\"test.txt\",\"content\":\"hello\"}}],\"reviewConfigs\":[{\"actionName\":\"write_file\",\"allowedDecisions\":[\"approve\",\"reject\"]}]}}"
        _ = parser.feed("event: run_interrupted")
        _ = parser.feed("data: \(json)")
        let event = parser.flush()!
        guard case .runInterrupted(let result) = event else {
            XCTFail("Expected runInterrupted")
            return
        }
        XCTAssertEqual(result.status, .interrupted)
        XCTAssertNotNil(result.interruptRequest)
        XCTAssertEqual(result.interruptRequest?.actionRequests.first?.name, "write_file")
    }

    // MARK: - Tool events

    func testParseToolStarted() throws {
        var parser = SSELineParser()
        _ = parser.feed("event: tool_started")
        _ = parser.feed("data: {\"toolName\":\"read_file\",\"input\":{\"path\":\"test.txt\"}}")
        let event = parser.flush()!
        guard case .toolStarted(let data) = event else {
            XCTFail("Expected toolStarted")
            return
        }
        XCTAssertEqual(data.toolName, "read_file")
    }

    func testParseToolFinished() throws {
        var parser = SSELineParser()
        _ = parser.feed("event: tool_finished")
        _ = parser.feed("data: {\"toolName\":\"read_file\",\"output\":\"file contents\"}")
        let event = parser.flush()!
        guard case .toolFinished(let data) = event else {
            XCTFail("Expected toolFinished")
            return
        }
        XCTAssertEqual(data.toolName, "read_file")
    }

    func testParseToolFailed() throws {
        var parser = SSELineParser()
        _ = parser.feed("event: tool_failed")
        _ = parser.feed("data: {\"toolName\":\"execute\",\"error\":\"Permission denied\"}")
        let event = parser.flush()!
        guard case .toolFailed(let data) = event else {
            XCTFail("Expected toolFailed")
            return
        }
        XCTAssertEqual(data.toolName, "execute")
    }

    // MARK: - Error & context events

    func testParseError() throws {
        var parser = SSELineParser()
        _ = parser.feed("event: error")
        _ = parser.feed("data: {\"message\":\"Something went wrong\"}")
        let event = parser.flush()!
        guard case .error(let data) = event else {
            XCTFail("Expected error")
            return
        }
        XCTAssertEqual(data.message, "Something went wrong")
    }

    func testParseContextCompacted() throws {
        var parser = SSELineParser()
        _ = parser.feed("event: context_compacted")
        _ = parser.feed("data: {\"traceId\":\"t1\",\"threadId\":\"th1\"}")
        let event = parser.flush()!
        guard case .contextCompacted = event else {
            XCTFail("Expected contextCompacted")
            return
        }
    }

    // MARK: - Edge cases

    func testIgnoreComments() {
        var parser = SSELineParser()
        XCTAssertNil(parser.feed(": this is a comment"))
        XCTAssertNil(parser.flush())
    }

    func testBlankLineWithoutData() {
        var parser = SSELineParser()
        XCTAssertNil(parser.feed(""))
    }

    func testUnknownEventName() {
        var parser = SSELineParser()
        _ = parser.feed("event: unknown_event_type")
        _ = parser.feed("data: {\"foo\":\"bar\"}")
        XCTAssertNil(parser.flush())
    }

    func testResetClearsState() {
        var parser = SSELineParser()
        _ = parser.feed("event: text_delta")
        _ = parser.feed("data: {\"delta\":\"partial\"}")
        parser.reset()
        XCTAssertNil(parser.flush())
    }

    // MARK: - Multiple events sequence (simulating .lines output)

    func testMultipleEventsWithoutBlankLines() {
        var parser = SSELineParser()
        var events: [StreamEvent] = []

        // Simulate .lines which strips empty lines between events
        if let e = parser.feed("event: run_started") { events.append(e) }
        if let e = parser.feed("data: {\"traceId\":\"t1\",\"threadId\":\"th1\",\"mode\":\"run\"}") { events.append(e) }
        // Next event: "event:" flushes previous
        if let e = parser.feed("event: text_delta") { events.append(e) }
        if let e = parser.feed("data: {\"delta\":\"Hi\"}") { events.append(e) }
        if let e = parser.feed("event: text_delta") { events.append(e) }
        if let e = parser.feed("data: {\"delta\":\" there\"}") { events.append(e) }
        // Final flush
        if let e = parser.flush() { events.append(e) }

        XCTAssertEqual(events.count, 3)
        guard case .runStarted = events[0] else { XCTFail("Expected runStarted"); return }
        guard case .textDelta(let d1) = events[1] else { XCTFail("Expected textDelta"); return }
        XCTAssertEqual(d1.delta, "Hi")
        guard case .textDelta(let d2) = events[2] else { XCTFail("Expected textDelta"); return }
        XCTAssertEqual(d2.delta, " there")
    }

    // MARK: - HITL encoding

    func testHITLDecisionEncoding() throws {
        let response = HITLResponse(decisions: [
            .approve,
            .edit(editedAction: .init(name: "write_file", args: ["path": AnyCodable("new.txt")])),
            .reject(message: "Not allowed"),
        ])
        let data = try JSONEncoder().encode(response)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let decisions = json["decisions"] as! [[String: Any]]
        XCTAssertEqual(decisions[0]["type"] as? String, "approve")
        XCTAssertEqual(decisions[1]["type"] as? String, "edit")
        XCTAssertNotNil(decisions[1]["editedAction"])
        XCTAssertEqual(decisions[2]["type"] as? String, "reject")
        XCTAssertEqual(decisions[2]["message"] as? String, "Not allowed")
    }
}
