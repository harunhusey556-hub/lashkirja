import Foundation

/// `POST /api/receipts/save` against both servers the app meets. The current one takes
/// `autoApprove` and answers `autoApproved`. The one before wave 2 has a strict body without the
/// flag: it answers 400 "Tarkista lomakkeen tiedot" to it, and approves every receipt it saves
/// (`reviewStatus` defaults to approved there). So a 400 to a body carrying the flag sends the same
/// save again without it, once, and the caller stops sending the flag for the rest of the run.
/// A 400 is the schema refusing the body before anything is written, so the second try is safe.
public enum ReceiptSaving {
    /// What the app knows about the server's `autoApprove`; kept for the app run.
    public enum FlagSupport: Sendable, Equatable { case unknown, supported, unsupported }

    public struct Outcome: Sendable, Equatable {
        public let receiptId: String
        /// The server's `autoApproved`; nil when the flag was not sent (a server without it says nothing).
        public let approved: Bool?
        /// Saved with `forceDuplicate`: the same vendor, date and sum is already on file.
        public let duplicate: Bool
        /// What this save taught about the flag; the caller keeps it for the next saves.
        public let support: FlagSupport
        /// What the server did with a bill ("ostolasku luotu, eräpäivä 14.10.2026"); nil for a plain receipt.
        public let invoiceNote: String?
        /// Kuitti or ostolasku, as the server filed it; nil for a sale and a credit note (no switch).
        public let kind: ReceiptDocumentKind?

        public init(receiptId: String, approved: Bool?, duplicate: Bool, support: FlagSupport, invoiceNote: String? = nil,
                    kind: ReceiptDocumentKind? = nil) {
            self.receiptId = receiptId
            self.approved = approved
            self.duplicate = duplicate
            self.support = support
            self.invoiceNote = invoiceNote
            self.kind = kind
        }
    }

    public static func sendsFlag(_ support: FlagSupport) -> Bool { support != .unsupported }

    /// The look-alike question's other answer (W27: the form only offered "Tallenna silti").
    public static let skipDuplicateTitle = "Älä tallenna"

    /// "Älä tallenna": the staged upload is deleted on the server (`DELETE /api/receipts/staged/{id}`).
    /// One already gone (expired, or dropped on another device) is the same outcome, so a 404 is not
    /// an error; anything else is thrown as it came and the row keeps its reading.
    public static func discardDuplicate(uploadId: String, delete: (String) async throws -> Void) async throws {
        do {
            try await delete("/api/receipts/staged/\(uploadId)")
        } catch let error as LKError where error.status == 404 {
            return
        }
    }

    /// A 400 to a body that carried `autoApprove`: tried once more without the flag.
    public static func retriesWithoutFlag(_ error: Error, flagSent: Bool) -> Bool {
        guard flagSent, let error = error as? LKError else { return false }
        return error.status == 400
    }

    /// Saves `draft`, asking for the approval unless the server is known not to take the flag.
    /// `saveDuplicateAnyway`: a 409 look-alike is saved again with `forceDuplicate` (the queue does
    /// this, as the web; the form asks the owner instead). Any other error is thrown as it came,
    /// and then the caller's `support` stays as it was. At most three requests.
    public static func save(
        _ draft: ReceiptDraft,
        support: FlagSupport,
        saveDuplicateAnyway: Bool,
        post: (ReceiptDraft) async throws -> ReceiptSaveResult
    ) async throws -> Outcome {
        var body = draft
        body.autoApprove = sendsFlag(support)
        var refused = false
        var duplicate = draft.forceDuplicate
        while true {
            do {
                let result = try await post(body)
                let learned: FlagSupport = refused ? .unsupported : (body.autoApprove ? .supported : support)
                return Outcome(receiptId: result.receipt.id,
                               approved: body.autoApprove ? result.approved : nil,
                               duplicate: duplicate,
                               support: learned,
                               invoiceNote: result.purchaseInvoiceNote,
                               // A sale is never an ostolasku: it gets no switch.
                               kind: draft.type == "tulo" ? nil : result.filedKind)
            } catch let error as LKError where saveDuplicateAnyway && error.isDuplicate && !body.forceDuplicate {
                duplicate = true
                body.forceDuplicate = true
            } catch let error where retriesWithoutFlag(error, flagSent: body.autoApprove) {
                refused = true
                body.autoApprove = false
            }
        }
    }
}
