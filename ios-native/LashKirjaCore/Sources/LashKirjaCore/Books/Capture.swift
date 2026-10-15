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
    // What `AutoAccept` judges a reading by (the server's `extractedJson`; absent on older readings).
    public let confidence: Double?
    public let fieldConfidence: FieldConfidence?
    /// "manual" means nothing could be read.
    public let source: String?
    /// "receipt", "invoice", "marketing" or "other" when the reading names it.
    public let documentType: String?
    /// ISO 4217 of the document ("USD"); nil or "EUR" for a euro document.
    public let currency: String?
    /// The total in `currency`, read from a non-euro document.
    public let originalAmount: Decimal?
    /// Euros per one unit of `currency`, with its date and origin ("document" or the ECB's), when
    /// the document printed a rate or the server priced it (`totalAmount` is then in euros).
    public let fxRate: Double?
    public let fxRateDate: String?
    public let fxSource: String?
    /// The document is a credit note (hyvityslasku). `totalAmount` and the VAT rows stay positive
    /// here, as the form shows them; the server books them negative when the reading is saved.
    public let isCreditNote: Bool?
    /// The number of the invoice the credit note corrects, when the document prints it.
    public let creditsInvoiceNumber: String?

    /// "Hyvityslasku" for a credit note's reading, nil otherwise.
    public var creditNoteLabel: String? { isCreditNote == true ? CreditNoteText.label : nil }
}

/// The one Finnish name the app gives a credit note, read or saved.
public enum CreditNoteText {
    public static let label = "Hyvityslasku"
}

/// Per-field recognition scores, 0...1.
public struct FieldConfidence: Decodable, Sendable, Equatable {
    public let vendor: Double?
    public let date: Double?
    public let totalAmount: Double?
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
    /// ISO 4217; "EUR" unless the document is in another currency. Always sent, as the web does.
    public var currency = ReceiptCurrency.base
    /// The total in `currency` for a non-euro document; `totalAmount` stays in euros.
    public var originalAmount: Decimal?
    /// The rate the reading carried, shown under the total; never sent (the save body is strict).
    public var fx: ReceiptFxReading?
    /// Ask the server to approve the receipt as it saves it when nothing is missing; it decides,
    /// and answers `autoApproved`. Off for a draft that is only displayed or kept.
    public var autoApprove = false

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
        currency = ReceiptCurrency.code(e.currency)
        if currency != ReceiptCurrency.base {
            originalAmount = e.originalAmount
            if let rate = e.fxRate, ReceiptFx.isUsable(rate) {
                fx = ReceiptFxReading(currency: currency, rate: rate, date: e.fxRateDate, source: e.fxSource)
            }
        }
    }

    public var validationError: String? {
        if totalAmount == nil { return "Anna kuitin summa." }
        if vendor.trimmingCharacters(in: .whitespaces).isEmpty { return "Anna myyjän nimi." }
        return nil
    }

    enum CodingKeys: String, CodingKey { case uploadId, vendor, date, totalAmount, vatDetails, category, notes, type, reference, invoiceNumber, currency, originalAmount, fx, forceDuplicate, autoApprove }

    /// Set on the encoder that writes a reading to the phone (`UnfinishedReadingStore`): `fx` is part
    /// of the reading there, but the strict body of the save must never carry it.
    public static var keepsReadingKey: CodingUserInfoKey { CodingUserInfoKey(rawValue: "ReceiptDraft.keepsReading")! }

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
        let code = ReceiptCurrency.code(currency)
        try c.encode(code, forKey: .currency)
        if code != ReceiptCurrency.base, let originalAmount { try c.encode(originalAmount, forKey: .originalAmount) }
        if encoder.userInfo[Self.keepsReadingKey] as? Bool == true, let fx { try c.encode(fx, forKey: .fx) }
        if forceDuplicate { try c.encode(true, forKey: .forceDuplicate) }
        if autoApprove { try c.encode(true, forKey: .autoApprove) }
    }
}

/// Read back from the phone (`UnfinishedReadingStore`): a reading not yet saved outlives the app.
/// A field `encode` left out comes back empty, as it was.
extension ReceiptDraft: Decodable {
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(uploadId: try c.decode(String.self, forKey: .uploadId))
        vendor = try c.decodeIfPresent(String.self, forKey: .vendor) ?? ""
        date = try c.decodeIfPresent(String.self, forKey: .date) ?? ""
        totalAmount = try c.decodeIfPresent(Decimal.self, forKey: .totalAmount)
        vatDetails = try c.decodeIfPresent([VatDetail].self, forKey: .vatDetails) ?? []
        category = try c.decodeIfPresent(String.self, forKey: .category) ?? ""
        notes = try c.decodeIfPresent(String.self, forKey: .notes) ?? ""
        type = try c.decodeIfPresent(String.self, forKey: .type) ?? "meno"
        reference = try c.decodeIfPresent(String.self, forKey: .reference) ?? ""
        invoiceNumber = try c.decodeIfPresent(String.self, forKey: .invoiceNumber) ?? ""
        let readCurrency = try c.decodeIfPresent(String.self, forKey: .currency)
        currency = ReceiptCurrency.code(readCurrency)
        originalAmount = try c.decodeIfPresent(Decimal.self, forKey: .originalAmount)
        fx = try c.decodeIfPresent(ReceiptFxReading.self, forKey: .fx)
        forceDuplicate = try c.decodeIfPresent(Bool.self, forKey: .forceDuplicate) ?? false
        autoApprove = try c.decodeIfPresent(Bool.self, forKey: .autoApprove) ?? false
    }
}

/// The answer of `POST /api/receipts/save`: the new receipt, whether the server approved it as it
/// saved it (only when `autoApprove` was sent), and what became of a bill: the ostolasku filed for
/// it (`purchaseInvoice`) or why none was (`purchaseInvoiceSkipped`).
public struct ReceiptSaveResult: Decodable, Sendable, Equatable {
    public struct Stored: Decodable, Sendable, Equatable { public let id: String }
    /// The ostolasku the server created from the receipt; only what the app tells the owner.
    public struct Filed: Decodable, Sendable, Equatable {
        public let id: String?
        /// "YYYY-MM-DD"
        public let dueDate: String?
        public let isCreditNote: Bool?

        public init(id: String? = nil, dueDate: String? = nil, isCreditNote: Bool? = nil) {
            self.id = id
            self.dueDate = dueDate
            self.isCreditNote = isCreditNote
        }

        /// "ostolasku luotu, eräpäivä 14.10.2026" (or "hyvityslasku luotu"): the same words after a
        /// save and after the queue row's "Kuitti ⇄ Ostolasku".
        public var note: String {
            if isCreditNote == true { return "hyvityslasku luotu" }
            if let dueDate, APIDate.day(String(dueDate.prefix(10))) != nil {
                return "ostolasku luotu, eräpäivä \(APIDate.displayDay(dueDate))"
            }
            return "ostolasku luotu"
        }
    }

    public let receipt: Stored
    public let autoApproved: Bool?
    public let purchaseInvoice: Filed?
    /// "not_an_invoice", "sales_document", "no_supplier", "no_date", "no_amount", "duplicate" or "already_filed".
    public let purchaseInvoiceSkipped: String?

    public init(receipt: Stored, autoApproved: Bool? = nil, purchaseInvoice: Filed? = nil, purchaseInvoiceSkipped: String? = nil) {
        self.receipt = receipt
        self.autoApproved = autoApproved
        self.purchaseInvoice = purchaseInvoice
        self.purchaseInvoiceSkipped = purchaseInvoiceSkipped
    }

    private enum CodingKeys: String, CodingKey { case receipt, autoApproved, purchaseInvoice, purchaseInvoiceSkipped }

    /// The receipt is already saved when this is read: a surprise in the extras must never make the
    /// save look failed (the owner would save it twice), so they are read leniently.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        receipt = try c.decode(Stored.self, forKey: .receipt)
        autoApproved = try c.decodeIfPresent(Bool.self, forKey: .autoApproved)
        purchaseInvoice = try? c.decodeIfPresent(Filed.self, forKey: .purchaseInvoice)
        purchaseInvoiceSkipped = try? c.decodeIfPresent(String.self, forKey: .purchaseInvoiceSkipped)
    }

    /// Absent from a server that does not auto-approve: then the receipt waits for review.
    public var approved: Bool { autoApproved ?? false }

    /// What the owner is told about the bill, after "Tallennettu ·": "ostolasku luotu, eräpäivä 14.10.2026".
    /// Nil for an ordinary receipt and for a reason the owner has nothing to do with.
    public var purchaseInvoiceNote: String? {
        if let invoice = purchaseInvoice { return invoice.note }
        if purchaseInvoiceSkipped == "duplicate" { return "ostolaskua ei luotu, sama lasku on jo ostolaskuissa" }
        return nil
    }

    /// What the AI's reading made of the document, for the queue row's "Kuitti ⇄ Ostolasku": an
    /// ostolasku when one was filed, else a kuitti. Nil for a credit note, which is no payable to switch.
    public var filedKind: ReceiptDocumentKind? {
        guard let invoice = purchaseInvoice else { return .receipt }
        return invoice.isCreditNote == true ? nil : .invoice
    }
}
