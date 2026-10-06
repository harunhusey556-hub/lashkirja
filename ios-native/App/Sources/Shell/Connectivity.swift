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
        if notice != state.notice { withMotion(.easeInOut(duration: 0.25)) { notice = state.notice } }
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

struct OfflineBanner: View {
    @State private var connectivity = Connectivity.shared
    var body: some View {
        Group {
            if let notice = connectivity.notice {
                Label(notice.title, systemImage: notice == .offline ? "wifi.slash" : "icloud.slash")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.onInk)
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .background(Theme.ink.opacity(0.9), in: Capsule())
                    .padding(.top, 4)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .accessibilityElement(children: .combine)
            }
        }
    }
}
