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

/// The "Ehdotus kohdistukseksi" card under an assistant reply: what it shows and how a decision
/// is applied before the server has answered.
public enum ChatProposalCard {
    public static let title = "Ehdotus kohdistukseksi"
    public static let acceptedLabel = "Kohdistus hyväksytty"
    public static let rejectedLabel = "Ehdotus hylätty"

    public enum Phase: Equatable, Sendable {
        /// Buttons on.
        case open
        /// A decision is on its way: the card already reads as decided, with a spinner.
        case saving(ChatProposalDecision)
        case accepted
        case rejected
    }

    /// A proposal is only shown when it names both the bank row and the receipt (as the web does).
    public static func isShown(_ proposal: ChatMatchProposal?) -> Bool {
        guard let proposal else { return false }
        return !proposal.transactionId.isEmpty && !proposal.receiptId.isEmpty
    }

    public static func phase(_ proposal: ChatMatchProposal, saving: ChatProposalDecision?) -> Phase {
        if let saving { return .saving(saving) }
        switch proposal.status {
        case "accepted": return .accepted
        case "rejected": return .rejected
        default: return .open
        }
    }

    public static func canDecide(_ proposal: ChatMatchProposal?, saving: ChatProposalDecision?) -> Bool {
        guard let proposal, isShown(proposal) else { return false }
        return phase(proposal, saving: saving) == .open
    }

    /// The line a decided (or deciding) card shows instead of its buttons.
    public static func statusLabel(_ phase: Phase) -> String? {
        switch phase {
        case .open: nil
        case .saving(.accepted), .accepted: acceptedLabel
        case .saving(.rejected), .rejected: rejectedLabel
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
