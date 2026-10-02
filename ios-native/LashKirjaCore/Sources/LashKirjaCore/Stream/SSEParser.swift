import Foundation

/// Incremental Server-Sent Events reader: bytes in, complete `data:` payloads out.
/// Buffers raw bytes, so a chunk boundary inside a line or a UTF-8 character is safe.
public struct SSEParser {
    private var buffer: [UInt8] = []
    private var lines: [String] = []

    public init() {}

    public mutating func feed(_ bytes: Data) -> [String] {
        buffer.append(contentsOf: bytes)
        var events: [String] = []
        while let newline = buffer.firstIndex(of: 0x0A) {
            var lineBytes = Array(buffer[..<newline])
            buffer.removeSubrange(...newline)
            if lineBytes.last == 0x0D { lineBytes.removeLast() }
            let line = String(decoding: lineBytes, as: UTF8.self)
            if line.isEmpty {
                if !lines.isEmpty { events.append(lines.joined(separator: "\n")) }
                lines.removeAll()
            } else if line.hasPrefix("data:") {
                var value = String(line.dropFirst(5))
                if value.hasPrefix(" ") { value.removeFirst() }
                lines.append(value)
            }
        }
        return events
    }
}
