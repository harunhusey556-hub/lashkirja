import Foundation

/// A multipart/form-data body for file uploads (receipts, statements).
public struct Multipart {
    private let boundary: String
    private var body = Data()

    public init(boundary: String = "LashKirja-\(UUID().uuidString)") { self.boundary = boundary }

    public var contentType: String { "multipart/form-data; boundary=\(boundary)" }

    public mutating func addField(_ name: String, _ value: String) {
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".utf8))
    }

    public mutating func addFile(_ name: String, filename: String, mimeType: String, data: Data) {
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"; filename=\"\(filename)\"\r\nContent-Type: \(mimeType)\r\n\r\n".utf8))
        body.append(data)
        body.append(Data("\r\n".utf8))
    }

    public func finalize() -> Data { body + Data("--\(boundary)--\r\n".utf8) }
}
