import Testing
import Foundation
@testable import LashKirjaCore

private func fixture(_ name: String) throws -> Data {
    try Data(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/\(name)"))
}

@Test func decodesRealAlvReport() throws {
    let r = try JSONDecoder().decode(AlvReport.self, from: fixture("alv.json"))
    #expect(r.period.key == "2026-10")
    #expect(r.vatRegistered)
    #expect(r.field301.vat == Decimal(string: "40.98"))
    #expect(r.field308.amount == Decimal(string: "40.98"))
    #expect(r.field308.isRefund == false)
    #expect(r.field307.amount == 0)
    #expect(r.filing == nil)
}

@Test func uploadResultBothShapes() throws {
    let done = try JSONDecoder().decode(UploadResult.self, from: Data(#"{"extracted":{"vendor":"K-Market","date":"2026-10-03","totalAmount":12.9,"type":"meno","category":"tarvikkeet","vatDetails":[{"rate":14,"amount":1.58}]},"uploadId":"u1","filePath":"x.jpg","originalName":"kuitti.jpg","status":"done"}"#.utf8))
    #expect(done.extracted?.vendor == "K-Market")
    #expect(done.jobId == nil)
    let queued = try JSONDecoder().decode(UploadResult.self, from: Data(#"{"jobId":"j1","status":"queued","uploadId":"u1","filePath":"x.jpg","originalName":"kuitti.jpg"}"#.utf8))
    #expect(queued.jobId == "j1")
    let job = try JSONDecoder().decode(JobResponse.self, from: Data(#"{"job":{"id":"j1","status":"done","title":"Kuitin luku","detail":null,"error":null,"extracted":{"vendor":"Ripsitukku","totalAmount":49.8,"type":"meno"}}}"#.utf8))
    #expect(job.job.isFinished)
    #expect(job.job.extracted?.totalAmount == Decimal(string: "49.8"))
}

@Test func receiptSaveBodyFromExtracted() throws {
    let extracted = try JSONDecoder().decode(Extracted.self, from: Data(#"{"vendor":"K-Market","date":"2026-10-03","totalAmount":12.9,"type":"meno","category":"tarvikkeet","vatDetails":[{"rate":14,"amount":1.58}],"unreadable":false}"#.utf8))
    var body = ReceiptDraft(uploadId: "u1", extracted: extracted)
    #expect(body.vendor == "K-Market")
    #expect(body.type == "meno")
    body.notes = ""
    let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as! [String: Any]
    #expect(json["uploadId"] as? String == "u1")
    #expect(json["notes"] == nil)
    #expect((json["vatDetails"] as? [[String: Any]])?.count == 1)
    #expect(body.validationError == nil)
    body.totalAmount = nil
    #expect(body.validationError == "Anna kuitin summa.")
}
