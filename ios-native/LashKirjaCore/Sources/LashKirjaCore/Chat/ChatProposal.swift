import Foundation

public enum ChatProposalDecision: String, Codable, Sendable {
    case accepted, rejected
}

/// `PATCH /api/ai/chat` body: the assistant message whose proposal is decided.
public struct ChatDecisionRequest: Encodable, Sendable, Equatable {
    public let id: String
    public let decision: ChatProposalDecision

    public init(id: String, decision: ChatProposalDecision) {
        self.id = id
        self.decision = decision
    }
}

/// The proposal card under an assistant reply ("Ehdotus kohdistukseksi", "Laskuluonnos",
/// "Kuitin korjaus"): what it shows and how a decision is applied before the server has answered.
public enum ChatProposalCard {
    public static let title = "Ehdotus kohdistukseksi"
    /// Shown while a decision is on its way: nothing reads as done before the server says so.
    public static let savingLabel = "Tallennetaan…"
    public static let acceptedLabel = "Kohdistus hyväksytty"
    public static let rejectedLabel = "Ehdotus hylätty"
    public static let invoiceDraftTitle = "Laskuluonnos"
    public static let invoiceDraftAcceptedLabel = "Luonnos tehty"
    public static let receiptUpdateTitle = "Kuitin korjaus"
    public static let receiptUpdateAcceptedLabel = "Kuitti korjattu"

    public enum Phase: Equatable, Sendable {
        /// Buttons on.
        case open
        /// A decision is on its way: the card already reads as decided, with a spinner.
        case saving(ChatProposalDecision)
        case accepted
        case rejected
    }

    /// A match is only shown when it names both the bank row and the receipt (as the web does); a
    /// draft needs a customer and a line, a receipt fix at least one change.
    public static func isShown(_ proposal: ChatProposal?) -> Bool {
        guard let proposal else { return false }
        switch proposal.kind {
        case .match:
            return !proposal.transactionId.isEmpty && !proposal.receiptId.isEmpty
        case .invoiceDraft:
            guard let draft = proposal.invoiceDraft else { return false }
            return !draft.customerName.isEmpty && !draft.lines.isEmpty
        case .receiptUpdate:
            return !(proposal.receiptUpdate?.changes.isEmpty ?? true)
        }
    }

    public static func title(_ proposal: ChatProposal) -> String {
        switch proposal.kind {
        case .match: title
        case .invoiceDraft: invoiceDraftTitle
        case .receiptUpdate: receiptUpdateTitle
        }
    }

    /// The decided line for this kind of proposal.
    public static func statusLabel(_ phase: Phase, for proposal: ChatProposal) -> String? {
        switch phase {
        case .open: return nil
        case .saving: return savingLabel
        case .rejected: return rejectedLabel
        case .accepted:
            switch proposal.kind {
            case .match: return acceptedLabel
            case .invoiceDraft: return invoiceDraftAcceptedLabel
            case .receiptUpdate: return receiptUpdateAcceptedLabel
            }
        }
    }

    /// After Hyväksy: where the created draft or the corrected receipt opens. Nil before, or for a match.
    public static func resultLink(_ proposal: ChatProposal) -> (label: String, href: String)? {
        guard proposal.status == "accepted", let href = proposal.href, href.hasPrefix("/") else { return nil }
        switch proposal.kind {
        case .match: return nil
        case .invoiceDraft:
            if let number = proposal.invoiceDraft?.invoiceNumber { return ("Avaa lasku \(number)", href) }
            return ("Avaa lasku", href)
        case .receiptUpdate: return ("Avaa kuitti", href)
        }
    }

    /// "2 × 25,50 €" for a draft line (net unit price); just the quantity when the price is missing.
    public static func lineDetail(_ line: ChatInvoiceDraft.Line) -> String {
        let quantity = NSDecimalNumber(decimal: line.quantity).stringValue.replacingOccurrences(of: ".", with: ",")
        guard let price = line.unitPrice else { return quantity }
        return "\(quantity) × \(Money.format(price))"
    }

    /// "Yhteensä 164,41 €" with "sis. ALV 33,41 €" under it.
    public static func draftTotals(_ draft: ChatInvoiceDraft) -> (total: String, vat: String?)? {
        guard let gross = draft.gross else { return nil }
        return ("Yhteensä \(Money.format(gross))", draft.vat.map { "sis. ALV \(Money.format($0))" })
    }

    public static func phase(_ proposal: ChatProposal, saving: ChatProposalDecision?) -> Phase {
        if let saving { return .saving(saving) }
        switch proposal.status {
        case "accepted": return .accepted
        case "rejected": return .rejected
        default: return .open
        }
    }

    public static func canDecide(_ proposal: ChatProposal?, saving: ChatProposalDecision?) -> Bool {
        guard let proposal, isShown(proposal) else { return false }
        return phase(proposal, saving: saving) == .open
    }

    /// The line a decided (or deciding) card shows instead of its buttons.
    public static func statusLabel(_ phase: Phase) -> String? {
        switch phase {
        case .open: nil
        case .saving: savingLabel
        case .accepted: acceptedLabel
        case .rejected: rejectedLabel
        }
    }

    /// "Varmuus 92 %". The server scores 0–1; a score above 1 is read as a percentage already.
    public static func confidenceLabel(_ score: Double?) -> String? {
        guard let score, score.isFinite, score > 0 else { return nil }
        let percent = score <= 1 ? score * 100 : score
        return "Varmuus \(Int(min(percent, 100).rounded()))\u{00A0}%"
    }

    /// "Kauppa — 12.50 € (1.10.2026)": a no-break space keeps the euro sign on the amount's line.
    public static func summary(_ text: String) -> String {
        text.replacingOccurrences(of: " €", with: "\u{00A0}€")
    }

    /// The message as it reads once `decision` is taken, shown while the server stores it.
    public static func decided(_ message: ChatMessage, _ decision: ChatProposalDecision) -> ChatMessage {
        var copy = message
        copy.proposal?.status = decision.rawValue
        return copy
    }

    /// Puts back the proposal's earlier status after a decision the server refused.
    public static func reverted(_ message: ChatMessage, to status: String?) -> ChatMessage {
        var copy = message
        copy.proposal?.status = status
        return copy
    }
}
