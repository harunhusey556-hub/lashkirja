import SwiftUI
import UIKit
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

/// A `ScreenLoad` on screen: the spinner only before anything has loaded, the failure with a retry
/// when nothing could be shown, otherwise the content, with a banner above it when the latest
/// refresh failed. A List screen that draws its own sections puts this in its no-data branch and
/// a `RefreshFailureBanner` at the top of its data branch.
struct ScreenStateView<Value, Content: View>: View {
    let state: ScreenLoad<Value>
    let retry: () async -> Void
    @ViewBuilder var content: (Value) -> Content

    var body: some View {
        switch state.display {
        case .loading:
            ProgressView().frame(maxWidth: .infinity, minHeight: 200)
                .accessibilityLabel("Ladataan")
        case .failed(let failure):
            LoadFailureView(failure: failure, retry: retry)
        case .content(let value):
            VStack(alignment: .leading, spacing: 12) {
                if let banner = state.banner {
                    RefreshFailureBanner(failure: banner, retry: retry)
                        .padding(.horizontal, 16)
                        .padding(.top, 8)
                }
                content(value)
            }
        }
    }
}

/// A failed first load: what failed, what to do next, and a retry (none for an ended session —
/// the app is already returning to sign-in).
struct LoadFailureView: View {
    let failure: LoadFailure
    let retry: () async -> Void

    var body: some View {
        ContentUnavailableView {
            Label(failure.title, systemImage: failure.symbol)
        } description: {
            Text(failure.message)
        } actions: {
            if failure.canRetry {
                Button("Yritä uudelleen") { Task { await retry() } }
                    .buttonStyle(.primary)
            }
        }
        .retryWhenBackOnline(failure, retry)
    }
}

/// A failed refresh over data still shown: the data stays, this says it may be out of date.
struct RefreshFailureBanner: View {
    let failure: LoadFailure
    let retry: () async -> Void
    @State private var retrying = false

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: failure.symbol)
                .foregroundStyle(Theme.danger)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(failure.title).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                Text(failure.canRetry ? LoadFailure.staleNote : failure.message)
                    .font(.caption).foregroundStyle(Theme.ink2)
            }
            Spacer(minLength: 8)
            if failure.canRetry {
                Button {
                    guard !retrying else { return }
                    retrying = true
                    Task { await retry(); retrying = false }
                } label: {
                    InFlightLabel("Yritä uudelleen", inFlight: retrying)
                }
                .font(.caption.weight(.semibold))
                .buttonStyle(.borderless)
            }
        }
        .retryWhenBackOnline(failure, retry)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

extension View {
    /// A load that failed for want of a connection runs again on its own when the connection is
    /// back, so the owner is not left looking at "no connection" after it has returned.
    func retryWhenBackOnline(_ failure: LoadFailure, _ retry: @escaping () async -> Void) -> some View {
        modifier(RetryWhenBackOnline(failure: failure, retry: retry))
    }
}

private struct RetryWhenBackOnline: ViewModifier {
    let failure: LoadFailure
    let retry: () async -> Void
    @State private var connectivity = Connectivity.shared

    func body(content: Content) -> some View {
        content.onChange(of: connectivity.backOnline) {
            guard failure.canRetry, [.offline, .timeout, .unavailable].contains(failure.kind) else { return }
            Task { await retry() }
        }
    }
}

extension LoadFailure {
    var symbol: String {
        switch kind {
        case .offline: "wifi.slash"
        case .timeout: "clock.badge.exclamationmark"
        case .unavailable: "icloud.slash"
        case .sessionExpired: "person.crop.circle.badge.exclamationmark"
        case .unreadable, .server: "exclamationmark.triangle"
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
            Image(systemName: "checkmark.circle").accessibilityHidden(true)
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

/// Pressed state for tappable cards and rows that are not system list rows: the label dims at
/// touch-down, and shrinks a hair unless Reduce Motion is on (then opacity alone). Replaces
/// `.plain`, which gives a custom card no visible answer to the finger.
struct PressableButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.6 : 1)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.98 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

extension ButtonStyle where Self == PressableButtonStyle {
    static var pressable: PressableButtonStyle { PressableButtonStyle() }
}

// MARK: Accessibility helpers

/// `withMotion` that does nothing visible when Reduce Motion is on, for call sites that have no
/// view environment at hand (models, closures).
@MainActor
func withMotion<Result>(_ animation: Animation? = .default, _ body: () throws -> Result) rethrows -> Result {
    // withAnimation, not withMotion: a rename once turned this into a call to itself, an endless
    // loop that froze every "Näytä enemmän" (2026-10-08; RecursionGuardTests).
    try withAnimation(UIAccessibility.isReduceMotionEnabled ? nil : animation, body)
}

private struct MotionModifier<Value: Equatable>: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let animation: Animation?
    let value: Value

    func body(content: Content) -> some View {
        content.animation(reduceMotion ? nil : animation, value: value)
    }
}

private struct LineLimitUnlessLargeModifier: ViewModifier {
    @Environment(\.dynamicTypeSize) private var typeSize

    func body(content: Content) -> some View {
        content.lineLimit(typeSize.isAccessibilitySize ? nil : 1)
    }
}

private struct ScaledFontModifier: ViewModifier {
    @ScaledMetric private var size: CGFloat
    let weight: Font.Weight
    let design: Font.Design

    init(size: CGFloat, weight: Font.Weight, design: Font.Design, style: Font.TextStyle) {
        _size = ScaledMetric(wrappedValue: size, relativeTo: style)
        self.weight = weight
        self.design = design
    }

    func body(content: Content) -> some View {
        content.font(.system(size: size, weight: weight, design: design))
    }
}

extension View {
    /// `.animation(_:value:)` that is skipped when Reduce Motion is on.
    func motion<Value: Equatable>(_ animation: Animation?, value: Value) -> some View {
        modifier(MotionModifier(animation: animation, value: value))
    }

    /// A custom-size system font that still follows Dynamic Type, scaled relative to `style`.
    func scaledFont(size: CGFloat, weight: Font.Weight = .regular, design: Font.Design = .default,
                    relativeTo style: Font.TextStyle = .body) -> some View {
        modifier(ScaledFontModifier(size: size, weight: weight, design: design, style: style))
    }

    /// A 44pt hit area for a small icon control. Uses the content shape, never a visible background.
    func tapTarget() -> some View {
        frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
    }

    /// One line of a list row, but free to wrap at accessibility text sizes so names are not cut.
    func lineLimitUnlessLarge() -> some View {
        modifier(LineLimitUnlessLargeModifier())
    }

    /// A headline figure: one line, shrinking only as a last resort at the largest text sizes.
    func moneyHero() -> some View {
        lineLimit(1).minimumScaleFactor(0.5)
    }
}
