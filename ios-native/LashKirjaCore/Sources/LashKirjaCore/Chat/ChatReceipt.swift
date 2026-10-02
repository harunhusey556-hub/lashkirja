import Foundation

/// A receipt sent in the chat (`POST /api/ai/chat/receipt`): the file rules and the bubble's states.
public enum ChatReceiptFile {
    /// The server's limit (`maxReceiptBytes`).
    public static let maxBytes = 15 * 1024 * 1024
    /// Photos above this are compressed harder before upload: phones send big files slowly.
    public static let targetImageBytes = 2_500_000
    /// JPEG qualities tried in turn until a photo fits `targetImageBytes`.
    public static let fallbackQualities: [Double] = [0.6, 0.45, 0.3]

    public static let tooLargeMessage = "Tiedosto on liian suuri (enintään 15 Mt)."
    public static let unsupportedMessage = "Valitse PDF tai kuva (JPEG, PNG tai HEIC)."
    public static let unreadableMessage = "Tiedostoa ei voitu lukea."

    /// The bubble's text, the same the server stores for the user's message.
    public static func content(_ name: String) -> String { "Kuitti: \(name)" }

    /// The upload's content type by extension; nil when the server would refuse the file.
    public static func mimeType(forFileName name: String) -> String? {
        switch (name as NSString).pathExtension.lowercased() {
        case "pdf": "application/pdf"
        case "jpg", "jpeg": "image/jpeg"
        case "png": "image/png"
        case "heic", "heif": "image/heic"
        default: nil
        }
    }

    public static func isPDF(_ name: String) -> Bool { mimeType(forFileName: name) == "application/pdf" }

    /// A name safe inside the multipart header: no quotes, slashes or line breaks.
    public static func safeName(_ name: String) -> String {
        let cleaned = name
            .replacingOccurrences(of: "\"", with: "")
            .replacingOccurrences(of: "\r", with: " ")
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "/", with: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? "kuitti" : cleaned
    }

    /// The name a re-encoded image is sent under ("IMG_1234.HEIC" → "IMG_1234.jpg").
    public static func jpegName(_ name: String) -> String {
        let base = (safeName(name) as NSString).deletingPathExtension
        return "\(base.isEmpty ? "kuitti" : base).jpg"
    }

    /// A name for a photo that has none (camera, photo library): "kuitti-20261002-140512.jpg".
    public static func generatedName(_ date: Date = Date(), timeZone: TimeZone = .current) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let c = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        return String(format: "kuitti-%04d%02d%02d-%02d%02d%02d.jpg", c.year ?? 0, c.month ?? 0, c.day ?? 0, c.hour ?? 0, c.minute ?? 0, c.second ?? 0)
    }

    /// A refused upload. The server explains in Finnish (`{error}`); a 413 from a proxy in front of
    /// it has no such body and still says what is wrong.
    public static func failure(status: Int, data: Data) -> LKError {
        let decoded = APIErrorDecoder.decode(status: status, data: data)
        if status == 413 && decoded.message == LKError.unreachable { return LKError(status: status, message: tooLargeMessage) }
        return decoded
    }

    /// Why a file cannot be sent, or nil when it can.
    public static func problem(name: String, bytes: Int) -> String? {
        if mimeType(forFileName: name) == nil { return unsupportedMessage }
        if bytes == 0 { return unreadableMessage }
        if bytes > maxBytes { return tooLargeMessage }
        return nil
    }
}

/// Where a receipt sent in the chat is: the user's bubble shows it.
public enum ChatReceiptPhase: Equatable, Sendable {
    /// Sending the file; the fraction sent so far (0–1).
    case sending(Double)
    /// Sent; the server is reading the receipt.
    case reading
    /// Stored: the server's message has taken the bubble's place.
    case sent
    case failed(String)

    /// After the last byte the server reads the receipt, which takes longer than the upload.
    public static func progress(_ fraction: Double) -> ChatReceiptPhase {
        fraction >= 1 ? .reading : .sending(max(0, fraction))
    }

    public var label: String? {
        switch self {
        case .sending(let fraction): "Lähetetään… \(Int((min(fraction, 1) * 100).rounded()))\u{00A0}%"
        case .reading: "Luetaan kuittia…"
        case .sent: nil
        case .failed(let message): message
        }
    }

    public var isBusy: Bool {
        switch self {
        case .sending, .reading: true
        case .sent, .failed: false
        }
    }

    public var canRetry: Bool {
        if case .failed = self { return true }
        return false
    }
}
