import SwiftUI

/// Shared keyboard behaviour for forms (P0.4). Number pads have no return key, so every form that
/// edits text gets one "Valmis" button above the keyboard, and scrolling drags the keyboard away.
/// Apply `formKeyboard()` once per form (not per field).
struct FormKeyboard: ViewModifier {
    func body(content: Content) -> some View {
        content
            .scrollDismissesKeyboard(.interactively)
            .toolbar {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Valmis") { Keyboard.dismiss() }.fontWeight(.semibold)
                }
            }
    }
}

extension View {
    /// "Valmis" above the keyboard + interactive dismiss on scroll. Once per form.
    func formKeyboard() -> some View { modifier(FormKeyboard()) }

    /// Email addresses: email keyboard, no capital, no autocorrect, AutoFill hint.
    func emailInput() -> some View {
        keyboardType(.emailAddress)
            .textContentType(.emailAddress)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
    }

    /// Euro amounts and quantities. The decimal pad shows a comma in the Finnish locale;
    /// `Money.parse` also accepts a point and spaces.
    func moneyInput() -> some View {
        keyboardType(.decimalPad).autocorrectionDisabled()
    }

    /// IBAN, BIC, Y-tunnus and similar codes: no autocorrect, capitalisation as given.
    func codeInput(_ capitalization: TextInputAutocapitalization = .characters) -> some View {
        textInputAutocapitalization(capitalization).autocorrectionDisabled()
    }

    /// Phone numbers.
    func phoneInput() -> some View {
        keyboardType(.phonePad).textContentType(.telephoneNumber)
    }

    /// A tap anywhere in a named field's row, the name included, puts the cursor in the field. In a
    /// LabeledContent the name is its own text drawn over the left of the field's frame, and a tap on
    /// it reached nothing; a long name covered the row's middle too (F004). Put it on the row, with
    /// the same `focused(_:equals:)` value on the field; for a name above its field, on the
    /// name alone, so a multi-line text view keeps its own touches.
    func tapFocuses<Value: Hashable>(_ focus: FocusState<Value?>.Binding, equals value: Value) -> some View {
        contentShape(Rectangle()).onTapGesture { focus.wrappedValue = value }
    }
}
