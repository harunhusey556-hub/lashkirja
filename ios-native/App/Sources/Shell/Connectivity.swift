import SwiftUI
import Network

/// Whether the phone has a network path, for the offline banner.
@MainActor
@Observable
final class Connectivity {
    static let shared = Connectivity()
    private(set) var online = true
    private let monitor = NWPathMonitor()

    private init() {
        monitor.pathUpdateHandler = { path in
            Task { @MainActor in Connectivity.shared.online = path.status == .satisfied }
        }
        monitor.start(queue: DispatchQueue(label: "fi.tiyouba.lashkirja.network"))
    }
}

struct OfflineBanner: View {
    @State private var connectivity = Connectivity.shared
    var body: some View {
        if !connectivity.online {
            Label("Ei verkkoyhteyttä", systemImage: "wifi.slash")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 14).padding(.vertical, 8)
                .background(Theme.ink.opacity(0.9), in: Capsule())
                .padding(.top, 4)
                .transition(.move(edge: .top).combined(with: .opacity))
        }
    }
}
