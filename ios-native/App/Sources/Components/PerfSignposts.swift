import SwiftUI
import os

/// What the owner waits for, as os_signpost intervals (subsystem `fi.lashkirja.perf`, category
/// `Waits`), from the tap to the first real data on screen: `launch` (app start to Koti's data),
/// `tab` (a tab item tapped to its content) and `open` (a pushed screen or a sheet asked for to
/// its content). The message names the row ("koti", "kuitit"). Each finished interval is also
/// one log line, `perf <kind> <row> <ms>`, so a simulator walk reads the figures with `log show`
/// instead of an Instruments trace.
@MainActor
enum Perf {
    enum Kind: String { case launch, tab, open }

    private static let signposter = OSSignposter(subsystem: "fi.lashkirja.perf", category: "Waits")
    private static let logger = Logger(subsystem: "fi.lashkirja.perf", category: "Waits")
    private static var running: [String: (kind: Kind, row: String, state: OSSignpostIntervalState, start: ContinuousClock.Instant)] = [:]

    static func beginLaunch() { begin(.launch, "koti") }
    static func beginTab(_ row: String) { begin(.tab, row) }
    static func beginOpen(_ row: String) { begin(.open, row) }

    /// A launch that lands on the sign-in screen measures typing, not loading.
    static func dropLaunch() { drop(slot(.launch, "koti")) }

    /// `row` shows real data: ends its open, its tab and (for Koti) the launch. One main-actor
    /// hop later, so the frame with the data is the one committed.
    static func ready(_ row: String) {
        Task { @MainActor in
            for kind in [Kind.launch, .tab, .open] { end(slot(kind, row)) }
        }
    }

    /// The screen went away before its data came: its wait is not a figure.
    static func left(_ row: String) {
        drop(slot(.open, row))
        drop(slot(.tab, row))
    }

    private static func slot(_ kind: Kind, _ row: String) -> String { kind.rawValue + ":" + row }

    private static func begin(_ kind: Kind, _ row: String) {
        let key = slot(kind, row)
        drop(key)
        let id = signposter.makeSignpostID()
        let state: OSSignpostIntervalState
        // The interval name must be a literal.
        switch kind {
        case .launch: state = signposter.beginInterval("launch", id: id, "\(row, privacy: .public)")
        case .tab: state = signposter.beginInterval("tab", id: id, "\(row, privacy: .public)")
        case .open: state = signposter.beginInterval("open", id: id, "\(row, privacy: .public)")
        }
        running[key] = (kind, row, state, .now)
    }

    private static func end(_ key: String) {
        guard let entry = running.removeValue(forKey: key) else { return }
        switch entry.kind {
        case .launch: signposter.endInterval("launch", entry.state)
        case .tab: signposter.endInterval("tab", entry.state)
        case .open: signposter.endInterval("open", entry.state)
        }
        // The revoked-session gate's launch → Koti, on the same clock as its other moments.
        if entry.kind == .launch { UITestHooks.mark("koti") }
        let elapsed = ContinuousClock.now - entry.start
        let ms = Int(elapsed.components.seconds * 1000 + elapsed.components.attoseconds / 1_000_000_000_000_000)
        logger.log("perf \(entry.kind.rawValue, privacy: .public) \(entry.row, privacy: .public) \(ms, privacy: .public)")
    }

    private static func drop(_ key: String) {
        guard let entry = running.removeValue(forKey: key) else { return }
        signposter.emitEvent("dropped", "\(entry.kind.rawValue, privacy: .public) \(entry.row, privacy: .public)")
    }
}

extension View {
    /// Ends the `row`'s wait once `hasData` holds (on appearing again too: a tab's root stays alive
    /// across tab switches), and drops it if the screen goes before then.
    func perfReady(_ row: String, _ hasData: Bool) -> some View {
        onAppear { if hasData { Perf.ready(row) } }
            .onChange(of: hasData) { _, now in if now { Perf.ready(row) } }
            .onDisappear { Perf.left(row) }
    }
}

extension AppTab {
    /// The row a tab's root reports ready under.
    var perfRow: String { String(describing: self) }
}

extension Route {
    /// The measured screens' rows; nil for the rest.
    var perfRow: String? {
        switch self {
        case .receipts, .receiptsFiltered, .receiptsCategory, .receiptsMissingVat: "kuitit"
        case .bankFeed, .bankFeedFiltered: "pankkiFeed"
        case .bankAccounts: "pankkiTilit"
        case .periods, .monthClose: "kaudet"
        case .alv: "alv"
        case .settings: "asetukset"
        case .invoices, .invoicesFiltered: "myynti"
        default: nil
        }
    }
}
