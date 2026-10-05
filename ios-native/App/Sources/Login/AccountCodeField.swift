import SwiftUI
import UIKit
import LashKirjaCore

/// The emailed 6-digit code (sign-up and password reset). Six boxes are drawn over one hidden
/// text field, so typing, the keyboard's one-time-code suggestion and a long-press paste all
/// land in the same `code`. Whatever lands there is cut to the code: Gmail copies the whole
/// subject or sentence ("…vahvistuskoodi on 123456. Koodi on voimassa 15 minuuttia."), and the
/// AutoFill sometimes inserts the code twice. "Avaa sähköposti" sits under the boxes.
struct AccountCodeField: View {
    @Binding var code: String
    var focus: FocusState<Bool>.Binding
    /// Called each time the field becomes a whole code (typed, suggested or pasted).
    let onComplete: (String) -> Void
    /// Pasted text with letters and no code in it, offered to the screen (the reset takes a
    /// link too); true when the screen used it, and the field keeps what it had.
    var onPasteOther: ((String) -> Bool)? = nil

    @Environment(\.openURL) private var openURL
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var note: String?
    /// Decides what each change does (write back, complete); see `AccountCodeGate`.
    @State private var gate = AccountCodeGate()

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            boxes
            if let note {
                Label(note, systemImage: "exclamationmark.circle")
                    .font(.footnote)
                    .foregroundStyle(Theme.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button { openMail() } label: {
                Label("Avaa sähköposti", systemImage: "envelope")
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(OutlineButtonStyle())
        }
    }

    private var boxes: some View {
        ZStack {
            // No placeholder: it would show between the boxes.
            TextField("", text: $code)
                .textContentType(.oneTimeCode)
                .keyboardType(.numberPad)
                .focused(focus)
                // The boxes show the digits; the field itself stays invisible but keeps the
                // keyboard, the code suggestion and the long-press paste menu.
                .foregroundStyle(.clear)
                .tint(.clear)
                .frame(maxWidth: .infinity, minHeight: 56)
                .accessibilityLabel("Vahvistuskoodi")
                .accessibilityValue(code.isEmpty ? "Tyhjä" : code.map(String.init).joined(separator: " "))
                .accessibilityHint("Kuusi numeroa sähköpostista")
            HStack(spacing: 8) {
                ForEach(0..<AccountCode.length, id: \.self) { box($0) }
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
        .contentShape(Rectangle())
        .onTapGesture { focus.wrappedValue = true }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: code)
        .onChange(of: code) { old, new in
            // The decision lives in `AccountCodeGate` (tested in core); a write-back runs this
            // again with the kept value, and only then can it complete.
            switch gate.change(to: new, from: old, onPasteOther: onPasteOther) {
            case .writeBack(let value):
                code = value
            case .accepted(let complete):
                note = nil
                if let complete { onComplete(complete) }
            }
        }
    }

    private func box(_ index: Int) -> some View {
        let digits = Array(code)
        let active = focus.wrappedValue && index == min(digits.count, AccountCode.length - 1)
        return Text(index < digits.count ? String(digits[index]) : " ")
            .font(.title2.monospacedDigit().weight(.semibold))
            .foregroundStyle(Theme.ink)
            .frame(maxWidth: .infinity, minHeight: 56)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(active ? Theme.accent : Theme.line, lineWidth: active ? 2 : 1))
    }

    /// Gmail when it is installed (the code mails are read there most often), otherwise Mail.
    private func openMail() {
        note = nil
        guard let gmail = URL(string: "googlegmail://"), let mail = URL(string: "message://") else { return }
        openURL(UIApplication.shared.canOpenURL(gmail) ? gmail : mail) { opened in
            if !opened { note = "Sähköpostisovellusta ei voitu avata. Avaa viesti itse ja kopioi koodi." }
        }
    }
}
