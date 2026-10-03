import Foundation

/// A file picked from Files, sized from its metadata before a byte is read, and read or copied
/// off the caller's actor: a 20 MB PDF must not freeze the screen, and one over the server's
/// limit is refused without loading it at all. The caller holds any security-scoped access.
public enum LocalFile {
    /// `app/src/lib/storage.ts` MAX_STATEMENT_BYTES (the receipt limit is `ReceiptUploadQueue.maxBytes`).
    public static let statementMaxBytes = 20 * 1024 * 1024

    public enum Problem: Error, Equatable, Sendable {
        case unreadable, empty, tooLarge

        /// The server's and the web's wording (`validateUploadBuffer`, `validateUploadFile`).
        public func message(maxBytes: Int) -> String {
            switch self {
            case .unreadable: "Tiedostoa ei voitu lukea."
            case .empty: "Tiedosto on tyhjä"
            case .tooLarge: "Tiedosto on liian suuri (enintään \(maxBytes / 1024 / 1024) Mt)"
            }
        }
    }

    public struct Copied: Equatable, Sendable {
        public let url: URL
        public let size: Int
    }

    public static func read(_ url: URL, maxBytes: Int) async -> Result<Data, Problem> {
        await Task.detached(priority: .userInitiated) { () -> Result<Data, Problem> in
            if let problem = check(url, maxBytes: maxBytes).problem { return .failure(problem) }
            guard let data = try? Data(contentsOf: url) else { return .failure(.unreadable) }
            // The metadata may have been wrong (a file still being written): the bytes decide.
            if data.isEmpty { return .failure(.empty) }
            if data.count > maxBytes { return .failure(.tooLarge) }
            return .success(data)
        }.value
    }

    /// Copies the file into the app's temporary folder (named `prefix-<uuid>.<ext>`) so it can be
    /// read after the picker's access ends.
    public static func copyToTemporary(_ url: URL, prefix: String, maxBytes: Int) async -> Result<Copied, Problem> {
        await Task.detached(priority: .userInitiated) { () -> Result<Copied, Problem> in
            let checked = check(url, maxBytes: maxBytes)
            if let problem = checked.problem { return .failure(problem) }
            var copy = FileManager.default.temporaryDirectory.appendingPathComponent("\(prefix)-\(UUID().uuidString)")
            if !url.pathExtension.isEmpty { copy.appendPathExtension(url.pathExtension) }
            do {
                try FileManager.default.copyItem(at: url, to: copy)
            } catch {
                return .failure(.unreadable)
            }
            let size = (try? copy.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? checked.size ?? 0
            return .success(Copied(url: copy, size: size))
        }.value
    }

    private static func check(_ url: URL, maxBytes: Int) -> (size: Int?, problem: Problem?) {
        guard FileManager.default.isReadableFile(atPath: url.path) else { return (nil, .unreadable) }
        // No size from the metadata (some providers): the read itself is checked.
        guard let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize else { return (nil, nil) }
        if size == 0 { return (size, .empty) }
        if size > maxBytes { return (size, .tooLarge) }
        return (size, nil)
    }
}
