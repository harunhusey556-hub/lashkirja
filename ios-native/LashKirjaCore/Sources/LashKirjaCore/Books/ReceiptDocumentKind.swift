import Foundation

/// What the owner says a saved document is (`PATCH /api/receipts/[id]` with `documentType`):
/// "invoice" files (or reopens) the ostolasku, "receipt" cancels it.
public enum ReceiptDocumentKind: String, Sendable, Equatable {
    case invoice, receipt
}

/// The body of that PATCH; nothing else is sent, so no field of the receipt is touched.
public struct ReceiptDocumentKindBody: Encodable, Sendable, Equatable {
    public let documentType: String
    public init(_ kind: ReceiptDocumentKind) { documentType = kind.rawValue }
}

/// The answer to that PATCH: what happened to the ostolasku, and why none was filed.
public struct ReceiptDocumentKindResult: Decodable, Sendable, Equatable {
    public let purchaseInvoiceAction: String?
    public let purchaseInvoiceSkipped: String?

    enum CodingKeys: String, CodingKey { case purchaseInvoiceAction, purchaseInvoiceSkipped }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        purchaseInvoiceAction = try c.decodeIfPresent(String.self, forKey: .purchaseInvoiceAction)
        purchaseInvoiceSkipped = try c.decodeIfPresent(String.self, forKey: .purchaseInvoiceSkipped)
    }

    /// Why no ostolasku could be filed, in the owner's words (the web's `SKIP_TEXT`).
    static let skipText: [String: String] = [
        "sales_document": "Myyntitositteesta ei tehdä ostolaskua.",
        "no_supplier": "Lisää myyjä ja tallenna, niin ostolasku voidaan luoda.",
        "no_date": "Lisää päivämäärä ja tallenna, niin ostolasku voidaan luoda.",
        "no_amount": "Lisää summa ja tallenna, niin ostolasku voidaan luoda.",
        "duplicate": "Sama lasku on jo ostolaskuissa.",
        "already_filed": "Ostolasku on peruttu Ostolaskut-näkymässä. Avaa se sieltä.",
    ]

    /// The line to show after the change: the reason when nothing was filed, else what was done.
    /// `credit`: the receipt is a credit note, which the server files as an ostolasku's credit.
    public func message(for kind: ReceiptDocumentKind, credit: Bool = false) -> String {
        if purchaseInvoiceAction == "none", let reason = purchaseInvoiceSkipped, let text = Self.skipText[reason] {
            return text
        }
        guard kind == .invoice else { return "Merkitty kuitiksi, ostolasku peruttiin" }
        return credit ? "Tallennettu ostolaskun hyvitykseksi" : "Tallennettu ostolaskuksi"
    }
}

extension ReceiptDocumentKind {
    /// What the upload screen's row calls the document.
    public var title: String { self == .invoice ? "Ostolasku" : "Kuitti" }
    /// The kind one tap of "Kuitti ⇄ Ostolasku" asks for.
    public var other: ReceiptDocumentKind { self == .invoice ? .receipt : .invoice }
    /// The row's switch, named for what it does.
    public var switchTitle: String { self == .invoice ? "Muuta kuitiksi" : "Muuta ostolaskuksi" }
}

/// The body of `POST /api/receipts/[id]/kind`, the upload screen's "Kuitti ⇄ Ostolasku" right after a
/// save. Unlike the receipt screen's PATCH (which cancels the ostolasku and keeps it), "receipt" here
/// removes the ostolasku the AI filed a moment ago; the server refuses (409) once it has payments.
public struct ReceiptKindBody: Encodable, Sendable, Equatable {
    public let kind: String
    public init(_ kind: ReceiptDocumentKind) { self.kind = kind.rawValue }
}

/// The answer to that POST: the ostolasku the receipt is filed as afterwards (nil for a kuitti), and
/// why none was filed when one was asked for.
public struct ReceiptKindChange: Decodable, Sendable, Equatable {
    public let purchaseInvoiceAction: String?
    public let purchaseInvoiceSkipped: String?
    public let purchaseInvoice: ReceiptSaveResult.Filed?

    enum CodingKeys: String, CodingKey { case purchaseInvoiceAction, purchaseInvoiceSkipped, purchaseInvoice }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        purchaseInvoiceAction = try c.decodeIfPresent(String.self, forKey: .purchaseInvoiceAction)
        purchaseInvoiceSkipped = try c.decodeIfPresent(String.self, forKey: .purchaseInvoiceSkipped)
        purchaseInvoice = try c.decodeIfPresent(ReceiptSaveResult.Filed.self, forKey: .purchaseInvoice)
    }

    /// What the document is now: an ostolasku while one is filed from it. A refused filing leaves a kuitti.
    public var kind: ReceiptDocumentKind { purchaseInvoice == nil ? .receipt : .invoice }

    /// The row's note, in the words of a save ("ostolasku luotu, eräpäivä 14.10.2026"); nil for a kuitti.
    public var invoiceNote: String? { purchaseInvoice?.note }

    /// Said after the tap: what was done, or why no ostolasku could be filed.
    public func message(asked: ReceiptDocumentKind) -> String {
        switch asked {
        case .invoice where purchaseInvoice != nil:
            return "Muutettu ostolaskuksi"
        case .invoice:
            if let reason = purchaseInvoiceSkipped, let text = ReceiptDocumentKindResult.skipText[reason] { return text }
            return "Ostolaskua ei voitu luoda."
        case .receipt:
            return purchaseInvoiceAction == "removed" ? "Muutettu kuitiksi, ostolasku poistettiin" : "Muutettu kuitiksi"
        }
    }
}

/// `GET /api/receipts/[id]/purchase-invoice`: the ostolasku a receipt is filed as, if any.
public struct ReceiptPurchaseInvoiceView: Decodable, Sendable, Equatable {
    public struct Invoice: Decodable, Sendable, Equatable {
        public let id: String
        public let status: PurchaseStatus
        public let displayStatus: PurchaseDisplayStatus
        public let dueDate: String
        /// The due date is still the 14-day default, not one printed on the bill.
        public let dueDateAssumed: Bool

        enum CodingKeys: String, CodingKey { case id, status, displayStatus, dueDate, dueDateAssumed }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            status = try c.decodeIfPresent(PurchaseStatus.self, forKey: .status) ?? .open
            displayStatus = try c.decodeIfPresent(PurchaseDisplayStatus.self, forKey: .displayStatus) ?? .open
            dueDate = try c.decodeIfPresent(String.self, forKey: .dueDate) ?? ""
            dueDateAssumed = try c.decodeIfPresent(Bool.self, forKey: .dueDateAssumed) ?? false
        }
    }

    /// What the stored reading called the document ("invoice", "receipt"), when there is a reading.
    public let documentType: String?
    public let purchaseInvoice: Invoice?

    enum CodingKeys: String, CodingKey { case documentType, purchaseInvoice }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        documentType = try c.decodeIfPresent(String.self, forKey: .documentType)
        purchaseInvoice = try c.decodeIfPresent(Invoice.self, forKey: .purchaseInvoice)
    }
}

/// The receipt screen's "Tämä on ostolasku" banner (web `OstolaskuNotice`): one document, one home.
public enum ReceiptOstolaskuNotice: Sendable, Equatable {
    /// Filed as an ostolasku: the line to read, where to go, and whether "Ei ole lasku" is offered.
    case filed(invoiceId: String, headline: String, canMarkAsReceipt: Bool)
    /// Not filed (or the ostolasku was cancelled): the question and the "Merkitse ostolaskuksi" offer.
    case offer(text: String, action: String = "Merkitse ostolaskuksi")

    /// A credit note is filed as an ostolasku's credit (X072): it is never asked whether it is a
    /// bill to be paid later.
    public static let creditAction = "Merkitse ostolaskun hyvitykseksi"

    /// nil until the view is known, and for a sale (`tulo`) that is no ostolasku: nothing to say.
    /// `total`: the receipt's booked total; a negative one is a credit note.
    public static func make(view: ReceiptPurchaseInvoiceView?, receiptType: String, total: Decimal? = nil) -> ReceiptOstolaskuNotice? {
        guard let view else { return nil }
        let invoice = view.purchaseInvoice
        if receiptType == "tulo" && invoice == nil { return nil }
        guard let invoice, invoice.status != .cancelled else {
            let text = invoice != nil ? "Ostolasku on peruttu, tämä on kuitti." : "Onko tämä lasku, joka maksetaan myöhemmin?"
            guard (total ?? 0) < 0 else { return .offer(text: text) }
            return .offer(text: invoice != nil ? text : "Onko tämä ostolaskun hyvitys?", action: creditAction)
        }
        var headline = "Tämä on ostolasku · Eräpäivä \(APIDate.displayDay(invoice.dueDate))"
        if invoice.dueDateAssumed { headline += " (oletus)" }
        switch (invoice.status, invoice.displayStatus) {
        case (.paid, _): headline += " · Maksettu"
        case (.credited, _): headline += " · Hyvitetty"
        case (_, .overdue): headline += " · Myöhässä"
        default: break
        }
        return .filed(invoiceId: invoice.id, headline: headline, canMarkAsReceipt: invoice.status == .open)
    }
}

/// The line under the euro amount that says which rate priced a non-EUR document
/// (web `fxRateLine`): "Kurssi 1 USD = 0,8749 EUR (EKP 10.7.2026)".
public enum ReceiptFx {
    /// A recorded rate outside this range is a misread, not a rate (web `isUsableRate`).
    static func isUsable(_ rate: Double?) -> Bool {
        guard let rate, rate.isFinite else { return false }
        return rate > 1e-6 && rate < 1e6
    }

    /// Four decimals; a small unit value (JPY, KRW) gets up to six so the rate still says something.
    static func rateText(_ rate: Double) -> String {
        var text = String(format: rate < 0.1 ? "%.6f" : "%.4f", rate)
        while text.hasSuffix("0"), let dot = text.firstIndex(of: "."), text.distance(from: dot, to: text.endIndex) - 1 > 4 {
            text.removeLast()
        }
        return text.replacingOccurrences(of: ".", with: ",")
    }

    /// nil for euros and when no usable rate was recorded. A rate the document itself printed says
    /// "laskulla"; every other rate is the ECB's.
    public static func line(currency: String?, rate: Double?, date: String?, source: String?) -> String? {
        guard let currency, !currency.isEmpty, currency != "EUR", isUsable(rate), let rate else { return nil }
        let origin = source == "document" ? "laskulla" : "EKP"
        var when = origin
        if let date, APIDate.day(String(date.prefix(10))) != nil { when += " \(APIDate.displayDay(date))" }
        return "Kurssi 1 \(currency) = \(rateText(rate)) EUR (\(when))"
    }
}

extension Receipt {
    /// "Kurssi 1 USD = 0,8749 EUR (EKP 10.7.2026)", nil for a euro receipt or one without a rate.
    public var fxRateLine: String? {
        ReceiptFx.line(currency: currency, rate: fxRate, date: fxRateDate, source: fxSource)
    }
}
