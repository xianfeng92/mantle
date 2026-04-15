import Foundation
import SwiftUI
import Markdown

// MARK: - Render Segment

enum RenderSegment: Identifiable {
    case text(AttributedString)
    case codeBlock(language: String?, code: String)
    case blockquote(AttributedString)

    var id: String {
        switch self {
        case .text(let str): "text-\(str.hashValue)"
        case .codeBlock(let lang, let code): "code-\(lang ?? "none")-\(code.prefix(20).hashValue)"
        case .blockquote(let str): "quote-\(str.hashValue)"
        }
    }
}

// MARK: - Markdown Renderer

struct MarkdownRenderer {

    /// Parse markdown text into renderable segments
    static func render(_ markdown: String) -> [RenderSegment] {
        let document = Document(parsing: markdown)
        var walker = SegmentWalker()
        walker.visit(document)
        walker.flushText()
        return walker.segments
    }
}

// MARK: - AST Walker

private struct SegmentWalker: MarkupWalker {

    var segments: [RenderSegment] = []

    private var currentText = AttributedString()
    private var listDepth = 0
    private var orderedListCounter = 0
    private var isInOrderedList = false

    // MARK: - Flush accumulated text as a segment

    mutating func flushText() {
        guard !currentText.characters.isEmpty else { return }
        segments.append(.text(currentText))
        currentText = AttributedString()
    }

    // MARK: - Block elements

    mutating func visitHeading(_ heading: Heading) {
        flushText()

        var text = AttributedString(heading.plainText)
        let font: Font = switch heading.level {
        case 1: .title.bold()
        case 2: .title2.bold()
        case 3: .title3.bold()
        default: .headline
        }
        text.font = font
        currentText.append(text)
        currentText.append(AttributedString("\n"))
    }

    mutating func visitParagraph(_ paragraph: Paragraph) {
        // Walk children to handle inline markup
        descendInto(paragraph)
        currentText.append(AttributedString("\n\n"))
    }

    mutating func visitCodeBlock(_ codeBlock: CodeBlock) {
        flushText()
        let language = codeBlock.language?.isEmpty == false ? codeBlock.language : nil
        let code = codeBlock.code.hasSuffix("\n")
            ? String(codeBlock.code.dropLast())
            : codeBlock.code
        segments.append(.codeBlock(language: language, code: code))
    }

    mutating func visitBlockQuote(_ blockQuote: BlockQuote) {
        flushText()

        // Render blockquote children into a separate attributed string
        var innerWalker = SegmentWalker()
        for child in blockQuote.children {
            innerWalker.visit(child)
        }
        innerWalker.flushText()

        // Merge inner segments into a single attributed string for the blockquote
        var quoteText = AttributedString()
        for segment in innerWalker.segments {
            switch segment {
            case .text(let str):
                quoteText.append(str)
            case .codeBlock(_, let code):
                var codeStr = AttributedString(code)
                codeStr.font = .system(.body, design: .monospaced)
                quoteText.append(codeStr)
            case .blockquote(let str):
                quoteText.append(str)
            }
        }
        quoteText.foregroundColor = .secondary

        segments.append(.blockquote(quoteText))
    }

    mutating func visitThematicBreak(_ thematicBreak: ThematicBreak) {
        flushText()
        var divider = AttributedString("───────────────────────────\n")
        divider.foregroundColor = .secondary
        currentText.append(divider)
    }

    // MARK: - List elements

    mutating func visitUnorderedList(_ unorderedList: UnorderedList) {
        listDepth += 1
        isInOrderedList = false
        descendInto(unorderedList)
        listDepth -= 1
    }

    mutating func visitOrderedList(_ orderedList: OrderedList) {
        listDepth += 1
        isInOrderedList = true
        orderedListCounter = 0
        descendInto(orderedList)
        listDepth -= 1
        isInOrderedList = false
    }

    mutating func visitListItem(_ listItem: ListItem) {
        let indent = String(repeating: "  ", count: max(0, listDepth - 1))
        let bullet: String
        if isInOrderedList {
            orderedListCounter += 1
            bullet = "\(indent)\(orderedListCounter). "
        } else {
            bullet = "\(indent)• "
        }
        currentText.append(AttributedString(bullet))
        descendInto(listItem)
        // Ensure newline after list item
        if currentText.characters.last != "\n" {
            currentText.append(AttributedString("\n"))
        }
    }

    // MARK: - Inline elements

    mutating func visitText(_ text: Markdown.Text) {
        currentText.append(AttributedString(text.string))
    }

    mutating func visitStrong(_ strong: Strong) {
        var inner = AttributedString(strong.plainText)
        inner.font = .body.bold()
        currentText.append(inner)
    }

    mutating func visitEmphasis(_ emphasis: Emphasis) {
        var inner = AttributedString(emphasis.plainText)
        inner.font = .body.italic()
        currentText.append(inner)
    }

    mutating func visitInlineCode(_ inlineCode: InlineCode) {
        var code = AttributedString(inlineCode.code)
        code.font = .system(.body, design: .monospaced)
        code.backgroundColor = .secondary.opacity(0.15)
        currentText.append(code)
    }

    mutating func visitLink(_ link: Markdown.Link) {
        let linkText = link.plainText
        var str = AttributedString(linkText)
        if let destination = link.destination, let url = URL(string: destination) {
            str.link = url
            str.foregroundColor = Color(red: 0/255, green: 113/255, blue: 227/255) // Apple Blue
        }
        currentText.append(str)
    }

    mutating func visitStrikethrough(_ strikethrough: Strikethrough) {
        var str = AttributedString(strikethrough.plainText)
        str.strikethroughStyle = .single
        str.foregroundColor = .secondary
        currentText.append(str)
    }

    mutating func visitImage(_ image: Markdown.Image) {
        // Render as clickable link placeholder — native image loading not supported
        let alt = image.plainText.isEmpty ? "Image" : image.plainText
        if let dest = image.source, let url = URL(string: dest) {
            var str = AttributedString("🖼 \(alt)")
            str.link = url
            str.foregroundColor = Color(red: 0/255, green: 113/255, blue: 227/255)
            currentText.append(str)
        } else {
            var str = AttributedString("🖼 \(alt)")
            str.foregroundColor = .secondary
            currentText.append(str)
        }
    }

    mutating func visitInlineHTML(_ inlineHTML: InlineHTML) {
        // Render raw HTML as dimmed inline code
        var str = AttributedString(inlineHTML.rawHTML)
        str.font = .system(.body, design: .monospaced)
        str.foregroundColor = .secondary
        currentText.append(str)
    }

    mutating func visitSoftBreak(_ softBreak: SoftBreak) {
        currentText.append(AttributedString(" "))
    }

    mutating func visitLineBreak(_ lineBreak: LineBreak) {
        currentText.append(AttributedString("\n"))
    }

    // MARK: - Table (simple text fallback)

    mutating func visitTable(_ table: Markdown.Table) {
        flushText()
        // Render as plain monospace text
        var tableStr = AttributedString(formatTable(table))
        tableStr.font = Font.system(.callout).monospaced()
        currentText.append(tableStr)
        currentText.append(AttributedString("\n"))
    }

    private func formatTable(_ table: Markdown.Table) -> String {
        var lines: [String] = []
        let headerCells = table.head.cells.map { $0.plainText }
        lines.append("| " + headerCells.joined(separator: " | ") + " |")
        lines.append("|" + headerCells.map { _ in "---" }.joined(separator: "|") + "|")
        for row in table.body.rows {
            let cells = row.cells.map { $0.plainText }
            lines.append("| " + cells.joined(separator: " | ") + " |")
        }
        return lines.joined(separator: "\n")
    }
}

// MARK: - Markdown Content View

struct MarkdownContentView: View {
    let text: String
    var isStreaming: Bool = false

    /// Base throttle interval — adapts based on text length
    private static let baseThrottleInterval: TimeInterval = 0.3

    @State private var renderedSegments: [RenderSegment] = []
    @State private var lastRenderTime: Date = .distantPast
    @State private var lastRenderedLength: Int = 0
    @State private var trailingRawText: String = ""
    @State private var renderTask: Task<Void, Never>?

    /// Adaptive throttle: longer text gets longer intervals to avoid jank
    private var currentThrottleInterval: TimeInterval {
        let count = text.count
        if count >= 5000 { return 0.8 }
        if count >= 2000 { return 0.5 }
        return Self.baseThrottleInterval
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(renderedSegments) { segment in
                switch segment {
                case .text(let attributed):
                    Text(attributed)
                        .textSelection(.enabled)

                case .codeBlock(let lang, let code):
                    CodeBlockView(language: lang, code: code)

                case .blockquote(let attributed):
                    HStack(spacing: 8) {
                        RoundedRectangle(cornerRadius: 1)
                            .fill(.secondary.opacity(0.4))
                            .frame(width: 3)
                        Text(attributed)
                            .textSelection(.enabled)
                    }
                    .padding(.leading, 4)
                }
            }

            // Trailing raw text shown between throttled renders during streaming
            if isStreaming && !trailingRawText.isEmpty {
                Text(trailingRawText)
                    .font(.body)
                    .foregroundStyle(.primary)
            }
        }
        .onChange(of: text) { _, newValue in
            renderIfNeeded(newValue)
        }
        .onChange(of: isStreaming) { oldValue, newValue in
            // When streaming ends, cancel pending render and do final synchronous render
            if oldValue && !newValue {
                renderTask?.cancel()
                renderTask = nil
                renderedSegments = MarkdownRenderer.render(text)
                trailingRawText = ""
                lastRenderedLength = text.count
                lastRenderTime = .now
            }
        }
        .onAppear {
            renderedSegments = MarkdownRenderer.render(text)
            lastRenderedLength = text.count
            lastRenderTime = .now
        }
    }

    private func renderIfNeeded(_ newText: String) {
        if isStreaming {
            let now = Date.now
            if now.timeIntervalSince(lastRenderTime) >= currentThrottleInterval {
                lastRenderTime = now
                trailingRawText = ""
                // Async render on background thread to avoid blocking UI
                renderTask?.cancel()
                let snapshot = newText
                renderTask = Task.detached(priority: .userInitiated) {
                    let segments = MarkdownRenderer.render(snapshot)
                    await MainActor.run {
                        renderedSegments = segments
                        lastRenderedLength = snapshot.count
                    }
                }
            } else {
                // Between renders: show new text as raw trailing text
                if newText.count > lastRenderedLength {
                    trailingRawText = String(newText.suffix(newText.count - lastRenderedLength))
                }
            }
        } else {
            // Not streaming — synchronous full render
            renderedSegments = MarkdownRenderer.render(newText)
            trailingRawText = ""
            lastRenderedLength = newText.count
            lastRenderTime = .now
        }
    }
}
