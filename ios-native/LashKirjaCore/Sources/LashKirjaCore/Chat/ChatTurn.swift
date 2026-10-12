import Foundation

/// Where one question-and-answer exchange stands. The model drives it; what the screen
/// offers (stop, retry, the error line) follows from it alone.
public enum ChatTurn: Equatable, Sendable {
    case idle
    /// Sent, no word back yet.
    case waiting
    case streaming
    /// The answer did not arrive: `text` is the owner's message, which a retry sends again.
    case failed(message: String, text: String)

    public var isBusy: Bool { self == .waiting || self == .streaming }

    public var canStop: Bool { isBusy }

    /// The message to send again, only while a failed answer is showing.
    public var retryText: String? {
        if case .failed(_, let text) = self { return text }
        return nil
    }

    public var failureMessage: String? {
        if case .failed(let message, _) = self { return message }
        return nil
    }

    public func sent() -> ChatTurn { .waiting }

    public func received(_ piece: String) -> ChatTurn {
        guard isBusy, !piece.isEmpty else { return self }
        return .streaming
    }

    public func finished() -> ChatTurn { isBusy ? .idle : self }

    /// A stopped answer is the owner's choice, not an error: nothing to retry.
    public func stopped() -> ChatTurn { isBusy ? .idle : self }

    public func failed(_ message: String, text: String) -> ChatTurn {
        isBusy ? .failed(message: message, text: text) : self
    }

    /// Retry starts a new wait, and only from a failed turn.
    public func retried() -> ChatTurn { retryText == nil ? self : .waiting }
}
