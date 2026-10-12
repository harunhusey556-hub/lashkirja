import os

/// Signposts around a screen's load, for Instruments (os_signpost, subsystem
/// `fi.tiyouba.lashkirja`, category `Screens`): `first-paint` runs from the start of the load to
/// the first real content on screen (the cached answer, or the server's when nothing was cached),
/// `data-ready` to the server's answer on screen. The message names the screen ("Kuitit", "Koti").
@MainActor
final class ScreenTiming {
    private static let signposter = OSSignposter(subsystem: "fi.tiyouba.lashkirja", category: "Screens")
    private var paintState: OSSignpostIntervalState?
    private var readyState: OSSignpostIntervalState?

    init(_ screen: String) {
        let id = Self.signposter.makeSignpostID()
        paintState = Self.signposter.beginInterval("first-paint", id: id, "\(screen, privacy: .public)")
        readyState = Self.signposter.beginInterval("data-ready", id: id, "\(screen, privacy: .public)")
    }

    /// Something real is on screen; `fromCache` tells a cached paint from the server's.
    func painted(fromCache: Bool) {
        guard let state = paintState else { return }
        paintState = nil
        Self.signposter.endInterval("first-paint", state, "\(fromCache ? "cache" : "server", privacy: .public)")
    }

    /// The server's answer is on screen (it is also the first paint when nothing was cached).
    func dataReady() {
        painted(fromCache: false)
        guard let state = readyState else { return }
        readyState = nil
        Self.signposter.endInterval("data-ready", state)
    }
}
