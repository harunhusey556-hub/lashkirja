import Foundation

/// Which readings need no human: the app's copy of the web's `lib/auto-accept.ts`. The upload
/// queue uses it to decide whether a finished file is saved at once or opens the form; the server
/// runs the same rule on the stored row when `autoApprove` is sent, and its answer
/// (`autoApproved`) is the one that counts.
public enum AutoAccept {
    /// `LOW_CONFIDENCE` of `lib/receipt-confidence.ts`: a score below it is uncertain.
    public static let confidenceFloor = 0.55

    /// Why a reading must wait for the owner (the web's `AutoAcceptBlock`).
    public enum Block: String, Sendable, Equatable {
        case unreadable, amount, vendor, date, notAReceipt, lowConfidence, duplicate
    }

    /// Why this reading must wait for the owner; nil = it may be accepted automatically.
    /// `duplicate`: the same vendor, date and sum is already on file (only the server knows).
    public static func block(_ reading: Extracted, duplicate: Bool = false) -> Block? {
        if reading.unreadable == true || reading.source == "manual" { return .unreadable }
        // A zero or negative "receipt" is a misread or a credit, never something to book blind.
        // The web rounds to whole cents first, so a sum under half a cent counts as zero.
        guard let amount = reading.totalAmount, amount * 100 >= Decimal(5) / Decimal(10) else { return .amount }
        guard let vendor = reading.vendor, !vendor.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return .vendor }
        guard let date = reading.date, !date.isEmpty else { return .date }
        if reading.documentType == "marketing" || reading.documentType == "other" { return .notAReceipt }
        guard let confidence = reading.confidence, confidence.isFinite, confidence >= confidenceFloor else { return .lowConfidence }
        if let fields = reading.fieldConfidence {
            for score in [fields.vendor, fields.date, fields.totalAmount] {
                if let score, score.isFinite, score < confidenceFloor { return .lowConfidence }
            }
        }
        if duplicate { return .duplicate }
        return nil
    }

    /// True when nothing about the reading needs a human.
    public static func isComplete(_ reading: Extracted?) -> Bool {
        guard let reading else { return false }
        return block(reading) == nil
    }

    /// Which way a finished upload goes (the web's `takesAutoSavePath`): in a pick of several files
    /// every reading is saved straight away (complete ones approved by the server, the rest left
    /// pending for review); a single file is saved only when complete, otherwise the form opens.
    public static func takesAutoSavePath(several: Bool, reading: Extracted?) -> Bool {
        several || isComplete(reading)
    }
}
