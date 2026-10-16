import Foundation

extension InvoiceForm {
    /// What the invoice form shows when it opens: the draft (a kept one restored), the draft it
    /// compares against for unsaved changes, and each line's price as text.
    public struct Opening: Equatable, Sendable {
        public var draft: InvoiceDraft
        public var baseline: InvoiceDraft
        public var priceTexts: [UUID: String]
        /// A kept, unsaved new invoice came back ("Palautettiin tallentamaton luonnos.").
        public var restored: Bool
    }

    /// The form's opening from what is already known, without a server call, so its first frame is
    /// the finished form (w44: the line, the bottom bar and the restore note came in one frame
    /// after the sheet, the "Lisää → Uusi lasku" flash). `customers` are the active ones; a kept
    /// draft for a customer no longer among them falls back to the baseline's customer.
    public static func opening(existing: Invoice?, presetCustomerId: String?, customers: [Customer],
                               sellerRegistered: Bool, kept: InvoiceDraft?, today: String) -> Opening {
        var draft = InvoiceDraft(customerId: "", issueDate: today, paymentTermDays: 14)
        var priceTexts: [UUID: String] = [:]
        // Lines the owner did not type here (an edited invoice, a restored draft) show their
        // amount; a fresh 0 € line starts empty.
        func seedPriceTexts(blankZero: Bool) {
            for line in draft.lines where priceTexts[line.id] == nil {
                priceTexts[line.id] = blankZero && line.unitPrice == 0 ? "" : priceText(line.unitPrice)
            }
        }
        if let existing {
            draft.customerId = existing.customer.id
            draft.issueDate = existing.issueDate
            if let term = termDays(issueDate: existing.issueDate, dueDate: existing.dueDate) {
                draft.paymentTermDays = term
            }
            draft.notes = existing.notes ?? ""
            draft.lines = existing.lines.map {
                .init(description: $0.description, quantity: $0.quantity, unit: $0.unit, unitPrice: $0.unitPrice, vatRate: $0.vatRate)
            }
            seedPriceTexts(blankZero: false)
        } else {
            draft.lines = [.new(sellerRegistered: sellerRegistered)]
            if let presetCustomerId {
                // A customer picked for a new invoice brings their payment term along.
                draft.customerId = presetCustomerId
                if let customer = customers.first(where: { $0.id == presetCustomerId }) {
                    draft.paymentTermDays = customer.defaultPaymentTermDays
                }
            }
            seedPriceTexts(blankZero: true)
        }
        draft.followSellerVat(registered: sellerRegistered)
        // What a date change would do anyway, done before the baseline so it does not count as the
        // owner's change (a 14 % draft line dated in 2026 can only be 13,5 %).
        draft.lines.adjustVatRates(issueDate: draft.issueDate)
        let baseline = draft
        // "Uusi lasku" again after closing an unsaved one: the owner continues where they left off.
        // Not when the form was opened for another customer than the kept draft's.
        guard existing == nil, var restoredDraft = kept,
              presetCustomerId == nil || restoredDraft.customerId == presetCustomerId else {
            return Opening(draft: draft, baseline: baseline, priceTexts: priceTexts, restored: false)
        }
        // The VAT status may have changed since; the kept customer may since have been archived.
        restoredDraft.followSellerVat(registered: sellerRegistered)
        if !restoredDraft.customerId.isEmpty, !customers.contains(where: { $0.id == restoredDraft.customerId }) {
            restoredDraft.customerId = baseline.customerId
        }
        restoredDraft.lines.adjustVatRates(issueDate: restoredDraft.issueDate)
        draft = restoredDraft
        priceTexts = [:]
        seedPriceTexts(blankZero: true)
        return Opening(draft: draft, baseline: baseline, priceTexts: priceTexts, restored: true)
    }
}
