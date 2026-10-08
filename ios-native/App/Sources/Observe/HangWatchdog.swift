import Foundation
import LashKirjaCore

/// Writes a "hang" event when the main thread stops answering for 3 s, and "hang_end" with the
/// duration once it answers again. A frozen app is usually killed (by iOS or by the owner)
/// before anything else is saved; this is written from a background queue, so the trail shows
/// which screen froze and for how long. MetricKit's own hang report only arrives a day later.
final class HangWatchdog: @unchecked Sendable {
    static let shared = HangWatchdog()

    private static let threshold: TimeInterval = 3
    // Everything below is touched only on `queue`.
    private let queue = DispatchQueue(label: "lashkirja.hang-watchdog", qos: .utility)
    private var timer: DispatchSourceTimer?
    private var lastPong = Date()
    private var hangStarted: Date?

    private init() {}

    func start() {
        queue.async { [self] in
            guard timer == nil else { return }
            lastPong = Date()
            hangStarted = nil
            let source = DispatchSource.makeTimerSource(queue: queue)
            source.schedule(deadline: .now() + 1, repeating: 1)
            source.setEventHandler { [weak self] in self?.tick() }
            source.resume()
            timer = source
        }
    }

    /// In the background the process is suspended: a gap then is not a freeze.
    func pause() {
        queue.async { [self] in
            timer?.cancel()
            timer = nil
        }
    }

    private func tick() {
        let now = Date()
        if let started = hangStarted {
            if lastPong > started {
                hangStarted = nil
                let ms = Int(lastPong.timeIntervalSince(started) * 1000)
                Task { await EventLog.shared.record(AppEvent(kind: "hang_end", durationMs: ms, message: "Sovellus vastasi taas")) }
            }
        } else if now.timeIntervalSince(lastPong) > Self.threshold {
            hangStarted = lastPong
            Task {
                let screen = await EventLog.shared.lastScreen
                await EventLog.shared.record(AppEvent(kind: "hang", screen: screen, message: "Pääsäie ei vastannut yli 3 s"))
            }
        }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.queue.async { self.lastPong = Date() }
        }
    }
}
