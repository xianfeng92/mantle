import Foundation

// MARK: - SSE Line Parser
//
// Stateful parser for Server-Sent Events format.
//
// NOTE: URLSession.bytes.lines strips empty lines, so we cannot rely on
// blank-line delimiters. Instead, we flush the previous event whenever
// a new "event:" line arrives, or when the stream ends via flush().

struct SSELineParser: Sendable {
    private var currentEvent: String = ""
    private var currentData: String = ""
    private var hasData: Bool = false

    /// Feed a single line from the SSE stream.
    /// Returns a parsed `StreamEvent` when a complete event boundary is detected.
    mutating func feed(_ line: String) -> StreamEvent? {
        // Blank line = event boundary (works when empty lines ARE preserved)
        if line.isEmpty {
            return flushIfReady()
        }

        // Comment lines start with ":"
        if line.hasPrefix(":") {
            return nil
        }

        // New "event:" line — flush previous event if any, then start new one
        if line.hasPrefix("event:") {
            let result = flushIfReady()
            let value = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
            currentEvent = value
            return result
        }

        // "data:" line
        if line.hasPrefix("data:") {
            let value = String(line.dropFirst(5).drop(while: { $0 == " " }))
            if hasData {
                currentData += "\n" + value
            } else {
                currentData = value
                hasData = true
            }
            return nil
        }

        // "id:" and "retry:" — ignored
        if line.hasPrefix("id:") || line.hasPrefix("retry:") {
            return nil
        }

        return nil
    }

    /// Force-flush any buffered event. Call when stream ends.
    mutating func flush() -> StreamEvent? {
        return flushIfReady()
    }

    /// Reset parser state
    mutating func reset() {
        currentEvent = ""
        currentData = ""
        hasData = false
    }

    // MARK: - Internal

    private mutating func flushIfReady() -> StreamEvent? {
        guard hasData else { return nil }

        let eventName = currentEvent.isEmpty ? "message" : currentEvent
        let data = currentData

        // Reset for next event
        currentEvent = ""
        currentData = ""
        hasData = false

        guard let jsonData = data.data(using: .utf8) else { return nil }
        return StreamEvent.parse(eventName: eventName, jsonData: jsonData)
    }
}
