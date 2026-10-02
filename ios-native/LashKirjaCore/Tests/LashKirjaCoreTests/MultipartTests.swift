import Testing
import Foundation
@testable import LashKirjaCore

@Test func multipartBody() {
    var m = Multipart(boundary: "B")
    m.addField("capturedAt", "2026-10-02T10:00:00Z")
    m.addFile("file", filename: "kuitti.jpg", mimeType: "image/jpeg", data: Data([1, 2]))
    let text = String(decoding: m.finalize(), as: UTF8.self)
    #expect(m.contentType == "multipart/form-data; boundary=B")
    #expect(text.contains("--B\r\nContent-Disposition: form-data; name=\"capturedAt\"\r\n\r\n2026-10-02T10:00:00Z\r\n"))
    #expect(text.contains("Content-Disposition: form-data; name=\"file\"; filename=\"kuitti.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n"))
    #expect(text.hasSuffix("--B--\r\n"))
}
