import Foundation

/// The file name a download gives itself in its `Content-Disposition` header, read as the web reads
/// it (`fileNameFromDisposition`, app/src/lib/authed-file.ts): the extended `filename*=UTF-8''…`
/// form wins (RFC 6266), then the plain one. The app named an export after the API's type key
/// instead ('profit-loss-2026.csv' for the server's 'tuloslaskelma-2026.csv', X084).
public enum ContentDisposition {
    public static func fileName(_ header: String?, fallback: String) -> String {
        guard let header else { return fallback }
        var extended: String?
        var plain: String?
        // The server's names carry no ';' (csvAttachmentHeaders, inlineContentDisposition).
        for part in header.split(separator: ";") {
            let pair = part.split(separator: "=", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
            guard pair.count == 2 else { continue }
            let value = unquoted(pair[1])
            switch pair[0].lowercased() {
            case "filename*":
                let pieces = value.components(separatedBy: "''")
                if pieces.count == 2, let decoded = pieces[1].removingPercentEncoding { extended = safe(decoded) }
            case "filename":
                plain = safe(value)
            default:
                break
            }
        }
        return extended ?? plain ?? fallback
    }

    private static func unquoted(_ value: String) -> String {
        guard value.count >= 2, value.hasPrefix("\""), value.hasSuffix("\"") else { return value }
        return String(value.dropFirst().dropLast())
    }

    /// The last path component only, without control characters: the name is written inside the
    /// download's own folder and must never lead out of it.
    private static func safe(_ name: String) -> String? {
        let last = name.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? ""
        var scalars = String.UnicodeScalarView()
        scalars.append(contentsOf: last.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) })
        let cleaned = String(scalars).trimmingCharacters(in: .whitespaces)
        return cleaned.isEmpty || cleaned == "." || cleaned == ".." ? nil : cleaned
    }
}
