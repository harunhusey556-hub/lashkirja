import Testing
@testable import LashKirjaCore

/// Plays the field the way SwiftUI drives it: every change calls the gate with (new, old), and a
/// write-back is itself reported as one more change.
private struct FieldSim {
    var gate = AccountCodeGate()
    var text = ""
    var completions: [String] = []
    var pasteOther: ((String) -> Bool)?

    mutating func set(_ new: String) {
        var pending: (old: String, new: String)? = (text, new)
        text = new
        var rounds = 0
        while let change = pending, rounds < 10 {
            rounds += 1
            pending = nil
            switch gate.change(to: change.new, from: change.old, onPasteOther: pasteOther) {
            case .writeBack(let value):
                let before = text
                text = value
                if value != before { pending = (before, value) }
            case .accepted(let complete):
                if let complete { completions.append(complete) }
            }
        }
    }

    /// The screen clears the field after a wrong code.
    mutating func clear() { set("") }
}

@Test func gateTypingSixDigitsCompletesOnce() {
    var f = FieldSim()
    for d in "123456" { f.set(f.text + String(d)) }
    #expect(f.completions == ["123456"])
    #expect(f.text == "123456")
}

@Test func gateAutoFillDoubleInsertCompletesOnce() {
    var f = FieldSim()
    f.set("123456123456")
    #expect(f.completions == ["123456"])
    #expect(f.text == "123456")
}

@Test func gateSuggestionAfterTypedDigitsCompletesOnce() {
    for typed in ["1", "12"] {
        var f = FieldSim()
        for d in typed { f.set(f.text + String(d)) }
        f.set("123456")
        #expect(f.completions == ["123456"])
        #expect(f.text == "123456")
    }
}

@Test func gateSeventhDigitIsRejectedWithoutSecondCompletion() {
    var f = FieldSim()
    f.set("123456")
    f.set("1234567")
    #expect(f.text == "123456")
    #expect(f.completions == ["123456"])
}

@Test func gateRetypingSameCodeAfterClearCompletesAgain() {
    var f = FieldSim()
    f.set("123456")
    f.clear()
    f.set("123456")
    #expect(f.completions == ["123456", "123456"])
}

@Test func gateLongPressPasteOfSubjectCompletesOnce() {
    var f = FieldSim()
    f.set("LashKirja-vahvistuskoodi: 123 456")
    #expect(f.completions == ["123456"])
    #expect(f.text == "123456")
}

@Test func gateSevenDigitsFromEmptyDoesNotComplete() {
    var f = FieldSim()
    f.set("1234567")
    #expect(f.completions.isEmpty)
    #expect(f.text == "")
}
