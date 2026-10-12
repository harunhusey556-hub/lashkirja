import Foundation

/// What a purchase row is tagged with besides its status (`statusTagOf` on the web's ostolaskut page).
public enum PurchaseCreditTag: Sendable, Equatable {
    case creditNote
    case partlyCredited

    public var label: String {
        switch self {
        case .creditNote: "Hyvityslasku"
        case .partlyCredited: "Osittain hyvitetty"
        }
    }
}

extension PurchaseInvoice {
    /// What can still be credited: the gross less the credit notes so far (never below zero).
    public var creditable: Decimal { max(0, gross - credited) }

    /// "Hyvitä" is offered on an open or paid invoice with something left to credit; never on a credit note.
    public var canCredit: Bool {
        !isCreditNote && (status == .open || status == .paid) && creditable > 0
    }

    /// A credit note says so; an open or paid invoice with a part credit says "Osittain hyvitetty" (an overdue one keeps saying so).
    public var creditTag: PurchaseCreditTag? {
        if isCreditNote && displayStatus != .cancelled { return .creditNote }
        if credited > 0 && (displayStatus == .open || displayStatus == .paid) { return .partlyCredited }
        return nil
    }

    /// The credit notes against this invoice, newest first.
    public var creditNotesNewestFirst: [CreditNoteRef] {
        creditNotes.sorted { $0.issueDate > $1.issueDate }
    }
}

extension PurchaseInvoice.CreditNoteRef {
    /// The supplier's number on it, or "Hyvityslasku" when it has none.
    public var title: String {
        guard let number = invoiceNumber?.trimmingCharacters(in: .whitespaces), !number.isEmpty else { return "Hyvityslasku" }
        return number
    }
}

/// `POST /api/purchase-invoices/{id}/credit` -> 201 `{ creditNote, invoice }`.
public struct PurchaseCreditResponse: Decodable, Sendable {
    public let creditNote: PurchaseInvoice
    public let invoice: PurchaseInvoice
}

/// The body of that request. `vat` and `supplierNumber` are left out when empty (the server then
/// takes the invoice's VAT pro rata and no number); `amount`, `date` and `reason` are always sent.
public struct PurchaseCreditBody: Encodable, Sendable, Equatable {
    public let amount: Decimal
    public let vat: Decimal?
    public let date: String
    public let reason: String
    public let supplierNumber: String?
}

/// The "Hyvitä ostolasku" sheet's fields and the web's checks on them (`submitCredit`).
public struct PurchaseCreditForm: Sendable, Equatable {
    public static let createdMessage = "Hyvityslasku luotu"
    public static let reasonMax = 300
    public static let numberMax = 40

    public var amount: String
    public var vat = ""
    public var date: String
    public var reason = ""
    public var number = ""

    /// The amount starts at everything that is left to credit.
    public init(invoice: PurchaseInvoice, today: String) {
        amount = PurchaseInvoiceForm.amountText(invoice.creditable)
        date = today
    }

    public enum Outcome: Equatable, Sendable {
        case body(PurchaseCreditBody)
        case invalid(String)
    }

    /// The checks in the web's order, with its wording; the server stays the authority.
    public func body(for invoice: PurchaseInvoice) -> Outcome {
        guard let amountValue = Money.parse(amount), amountValue > 0 else {
            return .invalid("Anna hyvityksen summa, esim. 62,00.")
        }
        if let problem = PurchaseInvoiceForm.moneyProblem(amountValue) { return .invalid(problem) }
        if amountValue > invoice.creditable {
            return .invalid("Hyvitettävissä on enintään \(Money.format(invoice.creditable)).")
        }
        var vatValue: Decimal?
        let vatText = vat.trimmingCharacters(in: .whitespaces)
        if !vatText.isEmpty {
            guard let parsed = Money.parse(vatText), parsed >= 0, parsed <= amountValue,
                  PurchaseInvoiceForm.moneyProblem(parsed) == nil else {
                return .invalid("ALV on virheellinen.")
            }
            vatValue = parsed
        }
        let reasonText = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        if reasonText.count < 3 { return .invalid("Kirjoita hyvityksen syy.") }
        if reasonText.count > Self.reasonMax { return .invalid("Syy saa olla enintään \(Self.reasonMax) merkkiä.") }
        if date < invoice.issueDate { return .invalid("Hyvityksen päivä ei voi olla ennen laskun päivää.") }
        let numberText = number.trimmingCharacters(in: .whitespacesAndNewlines)
        if numberText.count > Self.numberMax { return .invalid("Numero saa olla enintään \(Self.numberMax) merkkiä.") }
        return .body(PurchaseCreditBody(
            amount: amountValue,
            vat: vatValue,
            date: date,
            reason: reasonText,
            supplierNumber: numberText.isEmpty ? nil : numberText
        ))
    }
}
