import Foundation

/// Decides what the code field does with each change SwiftUI reports, so the choice is tested
/// here and the view only applies it. Writing a value back makes SwiftUI report that write as a
/// change too; only that second call (the value now equals what `AccountCode.input` keeps) can
/// complete, and a value equal to the one already settled never completes twice.
public struct AccountCodeGate: Equatable, Sendable {
    /// The last value the field settled on, so a write-back that restores it completes nothing.
    public private(set) var settled = ""

    public init() {}

    public enum Outcome: Equatable, Sendable {
        /// The field must be set to this value; nothing completes until SwiftUI reports it.
        case writeBack(String)
        /// The value is accepted; `complete` is the code to submit, when this made a whole one.
        case accepted(complete: String?)
    }

    /// `onPasteOther` is offered pasted text with letters and no code in it; true means the
    /// screen used it and the field keeps `old`.
    public mutating func change(to new: String, from old: String, onPasteOther: ((String) -> Bool)? = nil) -> Outcome {
        let kept = AccountCode.input(new, previous: old)
        guard kept == new else {
            let added = AccountCode.inserted(new, previous: old)
            if added.contains(where: \.isLetter), AccountCode.extract(added) == nil, onPasteOther?(added) == true {
                return .writeBack(old)
            }
            return .writeBack(kept)
        }
        guard kept != settled else { return .accepted(complete: nil) }
        settled = kept
        return .accepted(complete: kept.count == AccountCode.length ? kept : nil)
    }
}
