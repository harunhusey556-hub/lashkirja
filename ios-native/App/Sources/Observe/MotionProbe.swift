import SwiftUI
import UIKit
import os

/// The in-app half of the simulator motion audit (LashKirjaUITests/MotionAuditTests,
/// scripts/sim/motion-audit.sh), switched on by the launch argument `-LKMotionAudit` in Debug
/// builds only. The simulator on the iMac records video at ~4 fps, too slow to see a row that
/// jumps for one frame; this sees every layout change instead.
///
/// Ten times a second it reads the on-screen (presentation) frame of every visible layer in the
/// key window, measured in its nearest scroll view's content (so scrolling is not movement), and
/// appends to the file in `LK_MOTION_LOG` (one line each, epoch seconds, so the analyzer can line
/// them up with the walk):
///   SCREEN <t> <name>                          a tab or pushed screen appeared
///   ROOT <t> <name> <w>x<h>                    the screen's root changed size (GeometryReader)
///   MOVE <t> <screen> n=<count> max=<pt> ...   layers moved more than 2 pt since the last tick
///   SCROLLJUMP <t> <screen> dy=<pt>            a scroll offset changed with no finger on it
///   QUIET <t> <screen>                         nothing moved for 0.4 s of ticks: the layout settled
/// scripts/sim/motion-audit.py calls a MOVE after the step's motion went quiet a late layout shift.
/// Signposts (category `Motion`) mark each screen and how long it took to stop moving.
@MainActor
final class MotionProbe: NSObject {
    static let shared = MotionProbe()
    #if DEBUG
    nonisolated static let active = ProcessInfo.processInfo.arguments.contains("-LKMotionAudit")
    #else
    nonisolated static let active = false
    #endif

    private static let signposter = OSSignposter(subsystem: "fi.tiyouba.lashkirja", category: "Motion")
    /// Smaller moves are antialiasing and text re-measuring, not a shift anyone sees.
    private static let threshold: CGFloat = 2
    private static let quiet: CFTimeInterval = 0.4
    /// Ticks come every 0.1–0.2 s (5–10 fps); a longer gap is the main thread held.
    private static let stall: CFTimeInterval = 0.25

    private var link: CADisplayLink?
    private var handle: FileHandle?
    private var frames: [ObjectIdentifier: CGRect] = [:]
    private var offsets: [ObjectIdentifier: CGPoint] = [:]
    private var screen = "launch"
    private var lastMove: CFTimeInterval = 0
    private var moving: OSSignpostIntervalState?
    private var lastTick: CFTimeInterval = 0
    private var windowCount = 0
    private var presented: ObjectIdentifier?

    func start() {
        guard Self.active, link == nil else { return }
        let path = ProcessInfo.processInfo.environment["LK_MOTION_LOG"] ?? NSTemporaryDirectory() + "motion-probe.log"
        if !FileManager.default.fileExists(atPath: path) { FileManager.default.createFile(atPath: path, contents: nil) }
        handle = FileHandle(forWritingAtPath: path)
        handle?.seekToEndOfFile()
        let link = CADisplayLink(target: self, selector: #selector(tick))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 5, maximum: 10, preferred: 10)
        link.add(to: .main, forMode: .common)
        self.link = link
        write("START \(Self.now) \(path)")
    }

    func screen(_ name: String) {
        guard Self.active else { return }
        screen = name.replacingOccurrences(of: " ", with: "_")
        Self.signposter.emitEvent("screen", "\(name, privacy: .public)")
        write("SCREEN \(Self.now) \(screen)")
    }

    func root(_ name: String, _ size: CGSize) {
        guard Self.active else { return }
        write("ROOT \(Self.now) \(name.replacingOccurrences(of: " ", with: "_")) \(Int(size.width))x\(Int(size.height))")
    }

    /// A moment the audit's reader wants on the timeline (a tap handled, a copy freed). These never
    /// count as motion (the analyzer counts MOVE and SCROLLJUMP); of the MARK lines it reads only
    /// 'MARK presented', to place a sheet's settle point.
    func mark(_ name: String) {
        guard Self.active else { return }
        write("MARK \(Self.now) \(name.replacingOccurrences(of: " ", with: "_"))")
    }

    private static var now: String { String(format: "%.3f", Date().timeIntervalSince1970) }

    private func write(_ line: String) {
        handle?.write((line + "\n").data(using: .utf8)!)
    }

    @objc private func tick() {
        // A tick that comes late is a main thread that was busy: the gap is written, so a late
        // change can be told apart from one that waited for nothing (w65, koti-add-sheet).
        let now = CACurrentMediaTime()
        if lastTick > 0, now - lastTick > Self.stall {
            write("STALL \(Self.now) \(screen) ms=\(Int((now - lastTick) * 1000))")
        }
        lastTick = now
        let windows = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).flatMap(\.windows)
        if windows.count != windowCount {
            windowCount = windows.count
            write("MARK \(Self.now) windows=\(windows.count)")
        }
        guard let window = windows.first(where: \.isKeyWindow) else { return }
        // When a presentation is asked for: its animation starts with the commit of this turn.
        var front = window.rootViewController
        while let next = front?.presentedViewController { front = next }
        let presented = front === window.rootViewController ? nil : front.map { ObjectIdentifier($0) }
        if presented != self.presented {
            self.presented = presented
            if presented != nil { write("MARK \(Self.now) presented") }
        }
        var seen: [ObjectIdentifier: CGRect] = [:]
        var moved: [(delta: CGFloat, dx: CGFloat, dy: CGFloat, what: String)] = []
        var budget = 4000
        walk(window.layer, space: window.layer, seen: &seen, moved: &moved, budget: &budget)
        // Layers that left are not movement; new ones are measured from the next tick on.
        frames = seen
        let t = CACurrentMediaTime()
        if moved.isEmpty {
            if let state = moving, t - lastMove > Self.quiet {
                Self.signposter.endInterval("settle", state)
                moving = nil
                // Written only after ticks that really ran: a main thread that stalls mid-animation
                // on a loaded Mac is not "quiet".
                write("QUIET \(Self.now) \(screen)")
            }
            return
        }
        if moving == nil { moving = Self.signposter.beginInterval("settle", id: Self.signposter.makeSignpostID(), "\(self.screen, privacy: .public)") }
        lastMove = t
        let top = moved.sorted { $0.delta > $1.delta }.prefix(3)
            .map { "\($0.what):\(Int($0.dx)),\(Int($0.dy))" }.joined(separator: " ")
        write("MOVE \(Self.now) \(screen) n=\(moved.count) max=\(Int(top.isEmpty ? 0 : moved.map(\.delta).max()!)) \(top)")
    }

    private func walk(_ layer: CALayer, space: CALayer, seen: inout [ObjectIdentifier: CGRect],
                      moved: inout [(delta: CGFloat, dx: CGFloat, dy: CGFloat, what: String)], budget: inout Int) {
        // A model layer jumps to its end when an animation is committed, so a slide or push wrote
        // one MOVE at the commit and none while it ran (M097); the presentation copy is what is on
        // screen. Copies are new objects every tick, so a layer is known by its model layer.
        let shown = layer.presentation() ?? layer
        guard budget > 0, !shown.isHidden, shown.opacity > 0.01 else { return }
        budget -= 1
        let id = ObjectIdentifier(layer)
        let frame = shown.convert(shown.bounds, to: space.presentation() ?? space)
        if shown.bounds.width >= 4, shown.bounds.height >= 4 {
            seen[id] = frame
            if let old = frames[id] {
                let dx = frame.minX - old.minX, dy = frame.minY - old.minY
                let delta = max(abs(dx), abs(dy))
                if delta > Self.threshold {
                    let name = (layer.delegate.map { String(describing: type(of: $0)) } ?? String(describing: type(of: layer)))
                    moved.append((delta, dx, dy, "\(name)@\(Int(frame.minX)),\(Int(frame.minY)),\(Int(frame.width))x\(Int(frame.height))"))
                }
            }
        }
        var inner = space
        if let scroll = layer.delegate as? UIScrollView {
            // The children are measured in content coordinates: scrolling does not move them.
            inner = layer
            let key = ObjectIdentifier(scroll)
            let offset = scroll.contentOffset
            if let old = offsets[key], abs(offset.y - old.y) > Self.threshold,
               !scroll.isTracking, !scroll.isDragging, !scroll.isDecelerating {
                write("SCROLLJUMP \(Self.now) \(screen) dy=\(Int(offset.y - old.y))")
            }
            offsets[key] = offset
        }
        for sub in layer.sublayers ?? [] { walk(sub, space: inner, seen: &seen, moved: &moved, budget: &budget) }
    }
}

private struct MotionRootSize: PreferenceKey {
    static let defaultValue = CGSize.zero
    // The screen's own subtree reports zero; the GeometryReader's size must win whatever the order.
    static func reduce(value: inout CGSize, nextValue: () -> CGSize) {
        let next = nextValue()
        value = CGSize(width: max(value.width, next.width), height: max(value.height, next.height))
    }
}

extension View {
    /// Names the screen for the motion audit and reports its root size (a GeometryReader
    /// preference); nothing at all unless MotionProbe is active.
    @ViewBuilder func motionProbe(_ screen: String) -> some View {
        if MotionProbe.active {
            background(GeometryReader { proxy in Color.clear.preference(key: MotionRootSize.self, value: proxy.size) })
                .onPreferenceChange(MotionRootSize.self) { size in
                    MainActor.assumeIsolated { MotionProbe.shared.root(screen, size) }
                }
                .onAppear { MotionProbe.shared.screen(screen) }
        } else {
            self
        }
    }
}
