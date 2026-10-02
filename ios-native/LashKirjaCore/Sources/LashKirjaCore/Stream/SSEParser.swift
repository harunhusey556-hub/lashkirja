import Foundation

/// Incremental Server-Sent Events reader: bytes in, complete `data:` payloads out.
/// Buffers raw bytes, so a chunk boundary inside a line or a UTF-8 character is safe.
public struct SSEParser {
    private var buffer: [UInt8] = []
    private var start = 0
    private var lines: [String] = []

    public init() {}

    public mutating func feed(_ bytes: Data) -> [String] {
        buffer.append(contentsOf: bytes)
        var events: [String] = []
        var index = start
        while index < buffer.count {
            if buffer[index] == 0x0A {
                var end = index
                if end > start, buffer[end - 1] == 0x0D { end -= 1 }
                handle(String(decoding: buffer[start..<end], as: UTF8.self), into: &events)
                start = index + 1
            }
            index += 1
        }
        // Drop consumed bytes once in a while, not per line.
        if start > 4096 || start == buffer.count {
            buffer.removeSubrange(0..<start)
            start = 0
        }
        return events
    }

    /// The stream ended: a last event without its blank line still counts.
    public mutating func finish() -> [String] {
        var events: [String] = []
        if start < buffer.count {
            handle(String(decoding: buffer[start...], as: UTF8.self), into: &events)
        }
        buffer.removeAll()
        start = 0
        if !lines.isEmpty { events.append(lines.joined(separator: "\n")) }
        lines.removeAll()
        return events
    }

    private mutating func handle(_ line: String, into events: inout [String]) {
        if line.isEmpty {
            if !lines.isEmpty { events.append(lines.joined(separator: "\n")) }
            lines.removeAll()
        } else if line.hasPrefix("data:") {
            var value = String(line.dropFirst(5))
            if value.hasPrefix(" ") { value.removeFirst() }
            lines.append(value)
        }
    }
}
