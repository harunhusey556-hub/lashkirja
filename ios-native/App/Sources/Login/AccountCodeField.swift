import SwiftUI
import UIKit
import LashKirjaCore

/// The emailed 6-digit code (sign-up and password reset). Six boxes are drawn over one hidden
/// text field, so typing, the keyboard's one-time-code suggestion and a long-press paste all
/// land in the same `code`. Whatever lands there is cut to the code: Gmail copies the whole
/// subject or sentence ("…vahvistuskoodi on 123456. Koodi on voimassa 15 minuuttia."), and a
/// number pad has no paste key, so "Liitä" and "Avaa sähköposti" sit under the boxes.
struct AccountCodeField: View {
    @Binding var code: String
    var focus: FocusState<Bool>.Binding
    /// Called each time the field becomes a whole code (typed, suggested or pasted).
    let onComplete: (String) -> Void
    /// Pasted text with no code in it, offered first to the screen (the reset takes a link
    /// too); true when the screen used it.
    var onPasteOther: ((String) -> Bool)? = nil

    @Environment(\.openURL) private var openURL
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var note: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            boxes
            if let note {
                Label(note, systemImage: "exclamationmark.circle")
                    .font(.footnote)
                    .foregroundStyle(Theme.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 8) {
                // The system's paste button reads the clipboard without the "Allow Paste" prompt.
                PasteButton(payloadType: String.self) { strings in
                    let text = strings.first ?? ""
                    Task { @MainActor in paste(text) }
                }
                .buttonBorderShape(.capsule)
                .tint(Theme.ink)
                .frame(minHeight: 44)
                Button { openMail() } label: {
                    Label("Avaa sähköposti", systemImage: "envelope")
                        .font(.subheadline.weight(.semibold))
                }
                .buttonStyle(OutlineButtonStyle())
            }
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
            let kept = AccountCode.input(new, previous: old)
            // Setting the kept value runs this again with it, and only then can it complete.
            guard kept == new else {
                code = kept
                return
            }
            note = nil
            if kept.count == AccountCode.length { onComplete(kept) }
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

    private func paste(_ text: String) {
        if let found = AccountCode.extract(text) {
            note = nil
            // The same code again does not change the field, so it would not complete by itself.
            if code == found { onComplete(found) } else { code = found }
        } else if onPasteOther?(text) == true {
            note = nil
        } else {
            note = "Leikepöydällä ei ole 6-numeroista koodia."
            Haptics.error()
        }
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
