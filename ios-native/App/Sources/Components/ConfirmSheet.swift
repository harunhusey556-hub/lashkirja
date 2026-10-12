import SwiftUI
import UIKit
import LashKirjaCore

/// What a confirmation bottom sheet asks. The web's `ConfirmModal` is a bottom sheet, and so is this:
/// a `.confirmationDialog` opened from a toolbar menu floats as a bubble over the screen on iPhone.
struct ConfirmRequest: Identifiable {
    /// A second way forward (e.g. "Säilytä luonnos ja sulje"), shown between the main and cancel buttons.
    struct Action {
        let title: String
        let run: () -> Void
    }

    let id = UUID()
    /// Names the item ("Poistetaanko kuitti · Kesko?").
    var title: String
    var message: String = ""
    /// The main button. Red when `isDestructive`, the app's ink fill otherwise.
    var confirmTitle: String
    var isDestructive = true
    var secondary: Action?
    var cancelTitle = "Peruuta"
    var onConfirm: () -> Void
}

extension View {
    /// Presents `item` as a confirmation sheet until it is answered or swiped away (that is "cancel").
    func confirmSheet(item: Binding<ConfirmRequest?>) -> some View {
        modifier(ConfirmSheetModifier(value: item, make: { $0 }))
    }

    /// For a screen that keeps the thing to confirm in its own state (a row, an enum of choices):
    /// `make` builds the request from it while the sheet is up.
    func confirmSheet<Value>(presenting value: Binding<Value?>, _ make: @escaping (Value) -> ConfirmRequest) -> some View {
        modifier(ConfirmSheetModifier(value: value, make: make))
    }

    /// For a plain yes/no flag, the shape of `.confirmationDialog(_:isPresented:)`.
    func confirmSheet(
        isPresented: Binding<Bool>,
        title: String,
        message: String = "",
        confirmTitle: String,
        isDestructive: Bool = true,
        secondary: ConfirmRequest.Action? = nil,
        cancelTitle: String = "Peruuta",
        onConfirm: @escaping () -> Void
    ) -> some View {
        let flag = Binding<ConfirmFlag?>(
            get: { isPresented.wrappedValue ? ConfirmFlag() : nil },
            set: { if $0 == nil { isPresented.wrappedValue = false } }
        )
        return modifier(ConfirmSheetModifier(value: flag, make: { _ in
            ConfirmRequest(title: title, message: message, confirmTitle: confirmTitle, isDestructive: isDestructive,
                           secondary: secondary, cancelTitle: cancelTitle, onConfirm: onConfirm)
        }))
    }
}

private struct ConfirmFlag {}

/// `sheet(item:)` needs an `Identifiable`; whatever a screen confirms is wrapped under one fixed id.
private struct ConfirmShown<Value>: Identifiable {
    let id = 0
    let value: Value
}

private struct ConfirmSheetModifier<Value>: ViewModifier {
    @Binding var value: Value?
    let make: (Value) -> ConfirmRequest
    /// The chosen action waits here until the sheet has left the screen: a delete that pops the
    /// screen underneath, or closes the sheet that asked, must not do it while this one is still up.
    @State private var pending: (() -> Void)?

    func body(content: Content) -> some View {
        content.sheet(item: shown, onDismiss: runPending) { presented in
            ConfirmSheetContent(request: make(presented.value), pending: $pending)
        }
    }

    private var shown: Binding<ConfirmShown<Value>?> {
        Binding(
            get: { value.map { ConfirmShown(value: $0) } },
            set: { if $0 == nil { value = nil } }
        )
    }

    private func runPending() {
        let action = pending
        pending = nil
        action?()
    }
}

private struct ConfirmSheetContent: View {
    let request: ConfirmRequest
    @Binding var pending: (() -> Void)?
    @Environment(\.dismiss) private var dismiss
    @State private var textHeight: CGFloat = 0
    @State private var buttonsHeight: CGFloat = 0
    /// The sheet takes a moment to leave; a second tap meanwhile must not choose again.
    @State private var chosen = false

    /// The light-mode danger red in both appearances: white text on the paler dark-mode red would not read.
    private static let destructiveFill = Color(hex: 0xA83232)

    var body: some View {
        VStack(spacing: 0) {
            // Text above, buttons below: a long message scrolls and the buttons stay where the thumb is.
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    Text(request.title)
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(Theme.ink)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                    if !request.message.isEmpty {
                        Text(request.message)
                            .font(.subheadline)
                            .foregroundStyle(Theme.ink2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 20)
                .padding(.top, 28)
                .padding(.bottom, 16)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { textHeight = $0 }
            }
            .scrollBounceBehavior(.basedOnSize)
            VStack(spacing: 10) {
                Button(role: request.isDestructive ? .destructive : nil) {
                    choose(request.onConfirm)
                } label: {
                    Text(request.confirmTitle)
                }
                .buttonStyle(ConfirmButtonStyle(fill: request.isDestructive ? Self.destructiveFill : Theme.ink,
                                                text: request.isDestructive ? .white : Theme.onInk,
                                                outlined: false))
                if let secondary = request.secondary {
                    Button {
                        choose(secondary.run)
                    } label: {
                        Text(secondary.title)
                    }
                    .buttonStyle(ConfirmButtonStyle(fill: Theme.surface, text: Theme.ink, outlined: true))
                }
                Button(role: .cancel) {
                    dismiss()
                } label: {
                    Text(request.cancelTitle)
                }
                .buttonStyle(ConfirmButtonStyle(fill: Theme.surface, text: Theme.ink, outlined: true))
            }
            .disabled(chosen)
            .padding(.horizontal, 20)
            .padding(.top, 4)
            .padding(.bottom, 12)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { buttonsHeight = $0 }
        }
        .presentationDetents([.height(detentHeight)])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(24)
        .presentationBackground(Theme.surface)
    }

    private func choose(_ action: @escaping () -> Void) {
        guard !chosen else { return }
        chosen = true
        Haptics.impact(.medium)
        pending = action
        dismiss()
    }

    private var detentHeight: CGFloat {
        let window = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow }
        let measured = textHeight > 0 && buttonsHeight > 0 ? textHeight + buttonsHeight : 0
        return CGFloat(ConfirmSheetLayout.detentHeight(
            content: Double(measured),
            bottomInset: Double(window?.safeAreaInsets.bottom ?? 0),
            screenHeight: Double(window?.bounds.height ?? 0)
        ))
    }
}

/// Full-width pill, as the app's other filled buttons; the cancel button is the outlined variant.
private struct ConfirmButtonStyle: ButtonStyle {
    let fill: Color
    let text: Color
    let outlined: Bool
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .foregroundStyle(text)
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(fill.opacity(isEnabled ? (configuration.isPressed ? 0.8 : 1) : 0.4), in: Capsule())
            .overlay { if outlined { Capsule().strokeBorder(Theme.line, lineWidth: 1) } }
            .contentShape(Capsule())
    }
}
