import SwiftUI

// MARK: - Code Block View

struct CodeBlockView: View {
    let language: String?
    let code: String

    @Environment(\.colorScheme) private var colorScheme
    @State private var highlightedCode: AttributedString?
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Top bar: language label + copy button
            HStack {
                Text(language ?? "code")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Spacer()

                Button {
                    copyToClipboard()
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .font(.caption)
                        .foregroundStyle(copied ? Design.accent : .secondary)
                        .contentTransition(.symbolEffect(.replace))
                }
                .buttonStyle(.borderless)
                .help("Copy code")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(colorScheme == .dark ? Color.white.opacity(0.05) : Color.black.opacity(0.06))

            // Code area
            ScrollView(.horizontal, showsIndicators: false) {
                Text(highlightedCode ?? AttributedString(code))
                    .font(.system(.callout, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .background(colorScheme == .dark ? Design.surfaceDark : Design.surfaceLight)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .task(id: code) {
            highlightedCode = await SyntaxHighlighter.highlight(code, language: language, isDark: colorScheme == .dark)
        }
        .onChange(of: colorScheme) {
            Task {
                highlightedCode = await SyntaxHighlighter.highlight(code, language: language, isDark: colorScheme == .dark)
            }
        }
    }

    private func copyToClipboard() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(code, forType: .string)
        copied = true
        Task {
            try? await Task.sleep(for: .seconds(1.5))
            copied = false
        }
    }
}

// MARK: - Syntax Highlighter (Lightweight Regex)

enum SyntaxHighlighter {

    static func highlight(_ code: String, language: String?, isDark: Bool = true) async -> AttributedString {
        let lang = language?.lowercased() ?? ""
        let palette = isDark ? darkPalette : lightPalette
        let keywords = Self.keywords(for: lang)
        guard !keywords.isEmpty else {
            // No highlighting — just return with base color
            var result = AttributedString(code)
            result.foregroundColor = palette.base
            return result
        }

        var result = AttributedString(code)
        result.foregroundColor = palette.base

        // Apply patterns in priority order
        applyPattern(&result, in: code, pattern: #"//.*"#, color: palette.comment)             // line comments
        applyPattern(&result, in: code, pattern: #"/\*[\s\S]*?\*/"#, color: palette.comment)   // block comments
        applyPattern(&result, in: code, pattern: #"#.*"#, color: palette.comment, languages: ["python", "shell", "bash", "sh", "yaml", "yml"], lang: lang)
        applyPattern(&result, in: code, pattern: #""(?:[^"\\]|\\.)*""#, color: palette.string)  // double-quoted strings
        applyPattern(&result, in: code, pattern: #"'(?:[^'\\]|\\.)*'"#, color: palette.string)  // single-quoted strings
        applyPattern(&result, in: code, pattern: #"`(?:[^`\\]|\\.)*`"#, color: palette.string)  // backtick strings
        applyPattern(&result, in: code, pattern: #"\b\d+(\.\d+)?\b"#, color: palette.number)    // numbers
        applyKeywords(&result, in: code, keywords: keywords, color: palette.keyword)
        applyPattern(&result, in: code, pattern: #"\b[A-Z][a-zA-Z0-9_]+\b"#, color: palette.type) // types
        applyPattern(&result, in: code, pattern: #"\b(\w+)\s*\("#, color: palette.function, group: 1) // function calls

        return result
    }

    // MARK: - Color Palette

    private struct Palette {
        let base: Color
        let comment: Color
        let string: Color
        let number: Color
        let keyword: Color
        let type: Color
        let function: Color
    }

    // Dark: Catppuccin Mocha / One Dark inspired
    private static let darkPalette = Palette(
        base:     Color(nsColor: NSColor(red: 0.804, green: 0.839, blue: 0.957, alpha: 1.0)),  // #cdd6f4
        comment:  Color(nsColor: NSColor(red: 0.361, green: 0.384, blue: 0.443, alpha: 1.0)),  // #5c6270
        string:   Color(nsColor: NSColor(red: 0.596, green: 0.765, blue: 0.475, alpha: 1.0)),  // #98c379
        number:   Color(nsColor: NSColor(red: 0.820, green: 0.604, blue: 0.400, alpha: 1.0)),  // #d19a66
        keyword:  Color(nsColor: NSColor(red: 0.776, green: 0.490, blue: 0.867, alpha: 1.0)),  // #c678dd
        type:     Color(nsColor: NSColor(red: 0.898, green: 0.753, blue: 0.482, alpha: 1.0)),  // #e5c07b
        function: Color(nsColor: NSColor(red: 0.380, green: 0.686, blue: 0.937, alpha: 1.0))   // #61afef
    )

    // Light: Xcode-inspired light palette
    private static let lightPalette = Palette(
        base:     Color(nsColor: NSColor(red: 0.157, green: 0.165, blue: 0.212, alpha: 1.0)),  // #282a36 dark text
        comment:  Color(nsColor: NSColor(red: 0.463, green: 0.502, blue: 0.545, alpha: 1.0)),  // #76808b
        string:   Color(nsColor: NSColor(red: 0.769, green: 0.220, blue: 0.161, alpha: 1.0)),  // #c43829 red-brown
        number:   Color(nsColor: NSColor(red: 0.110, green: 0.380, blue: 0.718, alpha: 1.0)),  // #1c61b7 blue
        keyword:  Color(nsColor: NSColor(red: 0.608, green: 0.141, blue: 0.576, alpha: 1.0)),  // #9b2493 magenta
        type:     Color(nsColor: NSColor(red: 0.196, green: 0.392, blue: 0.467, alpha: 1.0)),  // #326477 teal
        function: Color(nsColor: NSColor(red: 0.200, green: 0.400, blue: 0.580, alpha: 1.0))   // #336694 steel blue
    )

    // MARK: - Keyword Tables

    private static func keywords(for lang: String) -> Set<String> {
        switch lang {
        case "swift":
            return ["import", "func", "var", "let", "struct", "class", "enum", "protocol",
                    "if", "else", "guard", "switch", "case", "default", "for", "while", "repeat",
                    "return", "throw", "throws", "try", "catch", "async", "await",
                    "self", "Self", "nil", "true", "false", "init", "deinit",
                    "private", "public", "internal", "fileprivate", "open", "static",
                    "override", "final", "mutating", "nonmutating", "weak", "unowned",
                    "some", "any", "where", "in", "is", "as", "typealias", "extension",
                    "defer", "do", "break", "continue", "fallthrough"]
        case "python", "py":
            return ["def", "class", "if", "elif", "else", "for", "while", "return",
                    "import", "from", "as", "try", "except", "finally", "raise",
                    "with", "yield", "lambda", "pass", "break", "continue",
                    "and", "or", "not", "in", "is", "True", "False", "None",
                    "self", "async", "await", "global", "nonlocal"]
        case "javascript", "js", "typescript", "ts", "jsx", "tsx":
            return ["function", "const", "let", "var", "if", "else", "for", "while",
                    "return", "throw", "try", "catch", "finally", "class", "extends",
                    "import", "export", "default", "from", "async", "await",
                    "new", "this", "super", "typeof", "instanceof", "void",
                    "true", "false", "null", "undefined", "switch", "case", "break",
                    "continue", "do", "yield", "of", "in", "type", "interface", "enum"]
        case "go":
            return ["func", "var", "const", "type", "struct", "interface", "map",
                    "if", "else", "for", "range", "switch", "case", "default",
                    "return", "break", "continue", "go", "defer", "select",
                    "chan", "package", "import", "true", "false", "nil",
                    "make", "new", "append", "len", "cap"]
        case "rust", "rs":
            return ["fn", "let", "mut", "const", "struct", "enum", "impl", "trait",
                    "if", "else", "for", "while", "loop", "match", "return",
                    "use", "mod", "pub", "crate", "self", "Self", "super",
                    "async", "await", "move", "ref", "type", "where",
                    "true", "false", "Some", "None", "Ok", "Err", "unsafe"]
        case "shell", "bash", "sh", "zsh":
            return ["if", "then", "else", "elif", "fi", "for", "while", "do", "done",
                    "case", "esac", "function", "return", "exit",
                    "echo", "export", "local", "readonly", "set", "unset",
                    "true", "false", "in"]
        case "html":
            return ["html", "head", "body", "div", "span", "p", "a", "img",
                    "script", "style", "link", "meta", "title", "form", "input",
                    "button", "table", "tr", "td", "th", "ul", "ol", "li",
                    "section", "header", "footer", "nav", "main", "article"]
        case "css":
            return ["color", "background", "margin", "padding", "border", "display",
                    "position", "width", "height", "font", "text", "flex",
                    "grid", "align", "justify", "overflow", "transition", "animation",
                    "important", "none", "auto", "inherit", "initial"]
        case "json":
            return ["true", "false", "null"]
        case "yaml", "yml":
            return ["true", "false", "null", "yes", "no", "on", "off"]
        default:
            return []
        }
    }

    // MARK: - Pattern Application

    private static func applyPattern(
        _ result: inout AttributedString,
        in code: String,
        pattern: String,
        color: Color,
        group: Int = 0,
        languages: [String]? = nil,
        lang: String = ""
    ) {
        if let languages, !languages.contains(lang) { return }

        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.dotMatchesLineSeparators]) else { return }
        let nsString = code as NSString
        let matches = regex.matches(in: code, range: NSRange(location: 0, length: nsString.length))

        for match in matches {
            let range = group < match.numberOfRanges ? match.range(at: group) : match.range
            guard range.location != NSNotFound,
                  let swiftRange = Range(range, in: code),
                  let attrRange = Range(swiftRange, in: result) else { continue }
            result[attrRange].foregroundColor = color
        }
    }

    private static func applyKeywords(
        _ result: inout AttributedString,
        in code: String,
        keywords: Set<String>,
        color: Color
    ) {
        guard !keywords.isEmpty else { return }
        // Single alternation regex instead of per-keyword loops: O(n) vs O(n*k)
        let escaped = keywords.map { NSRegularExpression.escapedPattern(for: $0) }
        let pattern = "\\b(?:\(escaped.joined(separator: "|")))\\b"
        applyPattern(&result, in: code, pattern: pattern, color: color)
    }
}
