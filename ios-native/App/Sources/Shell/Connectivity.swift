import SwiftUI
import Network
import LashKirjaCore

/// Whether the phone has a network path, and whether the server is answering, for the offline
/// banner. The decision lives in `ReachabilityState` (LashKirjaCore, tested).
@MainActor
@Observable
final class Connectivity {
    static let shared = Connectivity()
    /// The network path alone: what the receipt queue waits for.
    private(set) var online = true
    /// What the banner says, nil when all is well.
    private(set) var notice: ReachabilityState.Notice?
    /// Ticks each time the banner goes away: screens that failed for want of a connection reload.
    private(set) var backOnline = 0
    private var state = ReachabilityState()
    private let monitor = NWPathMonitor()
    private var probe: (@Sendable () async -> Void)?
    private var probing: Task<Void, Never>?

    private init() {
        monitor.pathUpdateHandler = { path in
            Task { @MainActor in Connectivity.shared.pathChanged(satisfied: path.status == .satisfied) }
        }
        monitor.start(queue: DispatchQueue(label: "fi.tiyouba.lashkirja.network"))
    }

    /// A cheap request to find out the server is back: nothing else asks while the banner is up
    /// and the person is just reading.
    func attach(probe: @escaping @Sendable () async -> Void) { self.probe = probe }

    func requestFinished(reached: Bool) {
        if reached { state.requestReachedServer() } else { state.requestMissedServer() }
        publish()
    }

    private func pathChanged(satisfied: Bool) {
        online = satisfied
        state.pathChanged(satisfied: satisfied)
        publish()
    }

    private func publish() {
        if notice != state.notice {
            if notice != nil && state.notice == nil { backOnline += 1 }
            withMotion(.easeInOut(duration: 0.25)) { notice = state.notice }
        }
        if state.notice == .serverUnreachable { startProbing() } else { probing?.cancel(); probing = nil }
    }

    private func startProbing() {
        guard probing == nil, let probe else { return }
        probing = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(8))
                if Task.isCancelled { break }
                await probe()
                // The probe's own answer reaches `requestFinished`; stop once the banner is gone.
                if self?.notice == nil { break }
            }
            self?.probing = nil
        }
    }
}

/// The pill over a tab's screens, just above the tab bar. In the navigation bar's row it covered
/// Avustaja, Asetukset and a pushed screen's title (U040 U041 U054). Nothing is reserved for it, so
/// nothing moves when it comes, and it takes no taps: whatever is under it stays usable.
struct OfflineBanner: View {
    @State private var connectivity = Connectivity.shared
    @State private var bottom = BottomClearance.shared
    var body: some View {
        Group {
            if let notice = connectivity.notice {
                OfflinePill(notice: notice)
                    // Fades in where it stays: sliding in moved the pill 17–18 pt after the screen
                    // had settled (motion audit offline-tab-myynti, w47).
                    .transition(.opacity)
            }
        }
        .allowsHitTesting(false)
        // Above a bottom bar or a toast while one is up, never over a primary or a message.
        .padding(.bottom, bottom.height > 0 ? bottom.height + 16 : 8)
        .motion(.snappy, value: bottom.height)
    }
}

/// Both notices in one capsule, the one not said faded out: the capsule keeps the longer one's
/// width, so a change of notice cross-fades in place. Swapped as one label it shrank 242 → 163 pt
/// and re-centred (M085).
struct OfflinePill: View {
    let notice: ReachabilityState.Notice

    var body: some View {
        ZStack {
            label(.serverUnreachable)
            label(.offline)
        }
        .motion(.easeInOut(duration: 0.25), value: notice)
        .font(.footnote.weight(.semibold))
        .foregroundStyle(Theme.onInk)
        .padding(.horizontal, 14).padding(.vertical, 8)
        // Opaque, as the toast and the bulk bar: the rows under it do not read through.
        .background(Theme.ink, in: Capsule())
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("offline-banner")
    }

    private func label(_ shown: ReachabilityState.Notice) -> some View {
        Label(shown.title, systemImage: shown == .offline ? "wifi.slash" : "icloud.slash")
            .opacity(shown == notice ? 1 : 0)
            .accessibilityHidden(shown != notice)
    }
}
