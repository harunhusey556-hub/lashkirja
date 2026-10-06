import Foundation

/// A reply's text split into the blocks the chat draws: SwiftUI's inline-only markdown has no
/// lists or headings, so those are recognised here and each block's text stays inline markdown.
public enum ChatMarkdownBlock: Equatable, Sendable {
    case paragraph(String)
    case heading(String)
    case bullets([String])
    case numbered([String])
}

public enum ChatMarkdown {
    public static func blocks(_ text: String) -> [ChatMarkdownBlock] {
        var blocks: [ChatMarkdownBlock] = []
        var paragraph: [String] = []
        var bullets: [String] = []
        var numbered: [String] = []

        func flush() {
            if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))); paragraph = [] }
            if !bullets.isEmpty { blocks.append(.bullets(bullets)); bullets = [] }
            if !numbered.isEmpty { blocks.append(.numbered(numbered)); numbered = [] }
        }

        for rawLine in text.replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n", omittingEmptySubsequences: false) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.isEmpty { flush(); continue }
            if let item = bulletItem(line) {
                if bullets.isEmpty { flush() }
                bullets.append(item)
            } else if let item = numberedItem(line) {
                if numbered.isEmpty { flush() }
                numbered.append(item)
            } else if let title = headingText(line) {
                flush()
                blocks.append(.heading(title))
            } else {
                if !bullets.isEmpty || !numbered.isEmpty { flush() }
                paragraph.append(line)
            }
        }
        flush()
        return blocks
    }

    /// "**bold** text" starts with "*" but not "* ", so the space check keeps it a paragraph.
    private static func bulletItem(_ line: String) -> String? {
        guard let first = line.first, "-*•".contains(first) else { return nil }
        let rest = line.dropFirst()
        guard rest.first == " " else { return nil }
        let item = rest.trimmingCharacters(in: .whitespaces)
        return item.isEmpty ? nil : item
    }

    private static func numberedItem(_ line: String) -> String? {
        let digits = line.prefix { $0.isNumber }
        guard !digits.isEmpty, digits.count <= 3 else { return nil }
        let rest = line.dropFirst(digits.count)
        guard let mark = rest.first, mark == "." || mark == ")" else { return nil }
        let item = rest.dropFirst().trimmingCharacters(in: .whitespaces)
        return item.isEmpty ? nil : item
    }

    private static func headingText(_ line: String) -> String? {
        let hashes = line.prefix { $0 == "#" }
        guard (1...4).contains(hashes.count) else { return nil }
        let rest = line.dropFirst(hashes.count)
        guard rest.first == " " else { return nil }
        let title = rest.trimmingCharacters(in: .whitespaces)
        return title.isEmpty ? nil : title
    }
}
