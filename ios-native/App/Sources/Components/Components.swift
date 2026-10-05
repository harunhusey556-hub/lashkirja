import SwiftUI
import LashKirjaCore

/// A rounded surface card, the app's basic container.
struct Card<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 8) { content }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
    }
}

/// Loading, error and empty states shared by every screen.
struct LoadState<Value, Content: View>: View {
    let state: Loadable<Value>
    let retry: () async -> Void
    @ViewBuilder var content: (Value) -> Content

    var body: some View {
        switch state {
        case .idle, .loading:
            ProgressView().frame(maxWidth: .infinity, minHeight: 200)
        case .failed(let message):
            ContentUnavailableView {
                Label("Lataus epäonnistui", systemImage: "wifi.exclamationmark")
            } description: {
                Text(message)
            } actions: {
                Button("Yritä uudelleen") { Task { await retry() } }
                    .buttonStyle(.primary)
            }
        case .loaded(let value):
            content(value)
        }
    }
}

enum Loadable<Value> {
    case idle
    case loading
    case loaded(Value)
    case failed(String)

    var value: Value? { if case .loaded(let v) = self { v } else { nil } }
}

extension Error {
    /// The Finnish message to show for any failure.
    var userMessage: String { (self as? LKError)?.message ?? LKError.unreachable }
}

/// A brief message with an optional action ("Kumoa"), shown above the tab bar.
struct Toast: Equatable, Identifiable {
    let id = UUID()
    let text: String
    let actionLabel: String?
    static func == (a: Toast, b: Toast) -> Bool { a.id == b.id }
}

struct ToastView: View {
    let toast: Toast
    let action: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "checkmark.circle")
            Text(toast.text).font(.subheadline).lineLimit(2)
            Spacer(minLength: 8)
            if let label = toast.actionLabel {
                Button(label, action: action).font(.subheadline.bold())
            }
        }
        .foregroundStyle(Theme.onInk)
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(Theme.ink.opacity(0.94), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .padding(.horizontal, 16)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}

/// Money text in the app's Finnish format.
struct MoneyText: View {
    let amount: Decimal
    var signed = false
    var body: some View { Text(Money.format(amount, signed: signed)).monospacedDigit() }
}

/// The label of a button whose request is in flight (`SubmitGuard.inFlight`): the title keeps its
/// place and a spinner sits on it, so the bar neither jumps nor blanks while the server answers.
struct InFlightLabel: View {
    let title: String
    let inFlight: Bool

    init(_ title: String, inFlight: Bool) {
        self.title = title
        self.inFlight = inFlight
    }

    var body: some View {
        Text(title)
            .opacity(inFlight ? 0 : 1)
            .overlay { if inFlight { ProgressView() } }
            .accessibilityLabel(inFlight ? "\(title), lähetetään" : title)
    }
}
