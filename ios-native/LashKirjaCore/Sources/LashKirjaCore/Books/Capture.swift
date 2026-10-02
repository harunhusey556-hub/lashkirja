import Foundation

/// What the document analysis read from a receipt.
public struct Extracted: Decodable, Sendable, Equatable {
    public let vendor: String?
    public let date: String?
    public let totalAmount: Decimal?
    public let category: String?
    public let notes: String?
    public let type: String?
    public let vatDetails: [VatDetail]?
    public let reference: String?
    public let invoiceNumber: String?
    public let unreadable: Bool?
}

/// `POST /api/receipts` (multipart `file`): read at once, or queued as a job.
public struct UploadResult: Decodable, Sendable {
    public let extracted: Extracted?
    public let jobId: String?
    public let status: String
    public let uploadId: String
    public let originalName: String?
}

public struct Job: Decodable, Sendable {
    public let id: String?
    public let status: String
    public let title: String?
    public let error: String?
    public let extracted: Extracted?
    public var isFinished: Bool { ["done", "failed", "cancelled"].contains(status) }
}

public struct JobResponse: Decodable, Sendable { public let job: Job }

/// `POST /api/receipts/save` (strict body; empty fields are left out).
public struct ReceiptDraft: Encodable, Sendable, Equatable {
    public var uploadId: String
    public var vendor: String = ""
    public var date: String = ""
    public var totalAmount: Decimal?
    public var vatDetails: [VatDetail] = []
    public var category: String = ""
    public var notes: String = ""
    public var type: String = "meno"
    public var reference: String = ""
    public var invoiceNumber: String = ""
    public var forceDuplicate = false

    public init(uploadId: String, extracted: Extracted? = nil) {
        self.uploadId = uploadId
        guard let e = extracted else { return }
        vendor = e.vendor ?? ""
        date = e.date.map { String($0.prefix(10)) } ?? ""
        totalAmount = e.totalAmount
        vatDetails = e.vatDetails ?? []
        category = e.category ?? ""
        notes = e.notes ?? ""
        type = e.type == "tulo" ? "tulo" : "meno"
        reference = e.reference ?? ""
        invoiceNumber = e.invoiceNumber ?? ""
    }

    public var validationError: String? {
        if totalAmount == nil { return "Anna kuitin summa." }
        if vendor.trimmingCharacters(in: .whitespaces).isEmpty { return "Anna myyjän nimi." }
        return nil
    }

    enum CodingKeys: String, CodingKey { case uploadId, vendor, date, totalAmount, vatDetails, category, notes, type, reference, invoiceNumber, forceDuplicate }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(uploadId, forKey: .uploadId)
        func put(_ v: String, _ k: CodingKeys) throws {
            let t = v.trimmingCharacters(in: .whitespacesAndNewlines)
            if !t.isEmpty { try c.encode(t, forKey: k) }
        }
        try put(vendor, .vendor)
        try put(date, .date)
        if let totalAmount { try c.encode(totalAmount, forKey: .totalAmount) }
        if !vatDetails.isEmpty { try c.encode(vatDetails, forKey: .vatDetails) }
        try put(category, .category)
        try put(notes, .notes)
        try c.encode(type, forKey: .type)
        try put(reference, .reference)
        try put(invoiceNumber, .invoiceNumber)
        if forceDuplicate { try c.encode(true, forKey: .forceDuplicate) }
    }
}
