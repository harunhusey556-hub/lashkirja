import SwiftUI
import UIKit
import os

/// The in-app half of the simulator motion audit (LashKirjaUITests/MotionAuditTests,
/// scripts/sim/motion-audit.sh), switched on by the launch argument `-LKMotionAudit` in Debug
/// builds only. The simulator on the iMac records video at ~4 fps, too slow to see a row that
/// jumps for one frame; this sees every layout change instead.
///
/// Ten times a second it reads the frame of every visible layer in the key window, measured in
/// its nearest scroll view's content (so scrolling is not movement), and appends to the file in
/// `LK_MOTION_LOG` (one line each, epoch seconds, so the analyzer can line them up with the walk):
///   SCREEN <t> <name>                          a tab or pushed screen appeared
///   ROOT <t> <name> <w>x<h>                    the screen's root changed size (GeometryReader)
///   MOVE <t> <screen> n=<count> max=<pt> ...   layers moved more than 2 pt since the last tick
///   SCROLLJUMP <t> <screen> dy=<pt> from=<pt> x=<pt>
///                                              a scroll offset changed with no finger on it, and
///                                              the rows on screen did not move with it; `from` is
///                                              the offset before, `x` the list's place in the window
///   QUIET <t> <screen>                         nothing moved for 0.4 s of ticks: the layout settled
///   STALL <t> <screen> ms=<ms>                 the main thread held the ticks back this long
///   TOUCH <t> <screen>                         a finger came down in the key window (its own time)
///   LENS <t> <screen> <key> <from> -> <to>     the tab bar's selection lens changed position or size
/// scripts/sim/motion-audit.py calls a MOVE after the step's motion went quiet a late layout shift.
/// Signposts (category `Motion`) mark each screen and how long it took to stop moving.
@MainActor
final class MotionProbe: NSObject, UIGestureRecognizerDelegate {
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
    private var offsets = ScrollOffsets()
    private var screen = "launch"
    private var lastMove: CFTimeInterval = 0
    private var moving: OSSignpostIntervalState?
    private var lastTick: CFTimeInterval = 0
    private var windowCount = 0
    private var presented: ObjectIdentifier?
    /// Windows that carry the touch listener (`shouldReceive`), so each gets one.
    private var listened: Set<ObjectIdentifier> = []
    private weak var lensLayer: CALayer?
    private var lensWatch: [NSKeyValueObservation] = []

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

    /// A moment the audit's reader wants on the timeline (a tap handled, a copy freed); the
    /// analyzer reads only MOVE, SCROLLJUMP and QUIET, so these never count as motion.
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
        watchLens(in: window)
        if listened.insert(ObjectIdentifier(window)).inserted {
            // Never takes a touch (`shouldReceive` says no), so no gesture of the app waits on it.
            let listener = UIGestureRecognizer(target: nil, action: nil)
            listener.cancelsTouchesInView = false
            listener.delaysTouchesEnded = false
            listener.delegate = self
            window.addGestureRecognizer(listener)
        }
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

    /// The audit's t = 0: when a step's finger reached the app, not when XCUITest was asked for it,
    /// which can be 1–4 s earlier while it resolves the element (M046, M056). The touch's own time,
    /// so a main thread busy when it came does not move it later.
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        let age = ProcessInfo.processInfo.systemUptime - touch.timestamp
        let at = Date().timeIntervalSince1970 - (age >= 0 && age < 30 ? age : 0)
        write("TOUCH \(String(format: "%.3f", at)) \(screen)")
        return false
    }

    /// The tab bar's selection lens, by KVO: a tick shows only where it is when it lands, and the lens
    /// lifts, goes and settles again inside the main thread's held turn of a sheet's presentation (M015).
    private func watchLens(in window: UIWindow) {
        guard lensLayer?.superlayer == nil, let layer = Self.lens(in: window)?.layer else { return }
        lensLayer = layer
        lensWatch = [
            layer.observe(\.position, options: [.old, .new]) { [weak self] _, change in
                guard let old = change.oldValue, let new = change.newValue, old != new else { return }
                MainActor.assumeIsolated { self?.write("LENS \(Self.now) \(self?.screen ?? "-") position \(old) -> \(new)") }
            },
            layer.observe(\.bounds, options: [.old, .new]) { [weak self] _, change in
                guard let old = change.oldValue, let new = change.newValue, old != new else { return }
                MainActor.assumeIsolated { self?.write("LENS \(Self.now) \(self?.screen ?? "-") bounds \(old) -> \(new)") }
            },
        ]
    }

    /// UIKit's own view for it, found by name inside the tab bar: it has no public type.
    private static func lens(in view: UIView, inBar: Bool = false) -> UIView? {
        let inBar = inBar || view is UITabBar
        if inBar, String(describing: type(of: view)).contains("LiquidLens") { return view }
        for sub in view.subviews { if let found = lens(in: sub, inBar: inBar) { return found } }
        return nil
    }

    private func walk(_ layer: CALayer, space: CALayer, seen: inout [ObjectIdentifier: CGRect],
                      moved: inout [(delta: CGFloat, dx: CGFloat, dy: CGFloat, what: String)], budget: inout Int) {
        guard budget > 0, !layer.isHidden, layer.opacity > 0.01 else { return }
        budget -= 1
        let id = ObjectIdentifier(layer)
        let frame = layer.convert(layer.bounds, to: space)
        if layer.bounds.width >= 4, layer.bounds.height >= 4 {
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
            let offset = scroll.contentOffset
            if let old = offsets.last(of: scroll), abs(offset.y - old.y) > Self.threshold,
               !scroll.isTracking, !scroll.isDragging, !scroll.isDecelerating,
               !rebased(layer, by: offset.y - old.y) {
                write("SCROLLJUMP \(Self.now) \(screen) dy=\(Int(offset.y - old.y)) from=\(Int(old.y)) x=\(Int(scroll.convert(CGPoint.zero, to: nil).x))")
            }
            offsets.record(scroll, at: offset)
        }
        for sub in layer.sublayers ?? [] { walk(sub, space: inner, seen: &seen, moved: &moved, budget: &budget) }
    }

    /// The list moved its rows in its content by the offset's own change, so on screen nothing
    /// moved: the content above the screen got shorter and UIKit moved the offset with it. F012's
    /// gate (run 39659357338) read such a swap as SCROLLJUMP dy=-44 while every frame of both PR
    /// videos showed the rows, the segment and Lataa zip in place, and the segment's own layers had
    /// moved -44 in the content in the same tick. Told by the topmost row that kept its size: a row
    /// reused or resized where the list changed says nothing about the screen. An offset that moves
    /// under rows staying in the content (native's -66 jump, its top rows at dy 0) is not this, and
    /// neither is a list with no row seen in both ticks.
    private func rebased(_ scroll: CALayer, by dy: CGFloat) -> Bool {
        var top: CGRect?
        var moved: CGFloat = 0
        for sub in scroll.sublayers ?? [] where !sub.isHidden && sub.opacity > 0.01 {
            guard sub.delegate is UICollectionViewCell || sub.delegate is UITableViewCell,
                  let old = frames[ObjectIdentifier(sub)] else { continue }
            let frame = sub.convert(sub.bounds, to: scroll)
            guard abs(frame.width - old.width) <= Self.threshold, abs(frame.height - old.height) <= Self.threshold else { continue }
            if let top, top.minY <= frame.minY { continue }
            top = frame
            moved = frame.minY - old.minY
        }
        return top != nil && abs(moved - dy) <= Self.threshold
    }
}

/// Each scroll view's offset as the tick before saw it, kept with the view itself, weakly. Kept under
/// its address alone, a freed list's last offset came back as the first one of the next scroll view
/// allocated at that address, and the difference was written as a SCROLLJUMP no frame ever showed:
/// on the first tick after a push, whose page the probe had not seen before (R5-COPY: invoice
/// dy=-46 on a copy that every frame of both videos shows still; the same tick of emailInbox,
/// dy=-479, the offset a scrolled Pankki feed was left at).
@MainActor
struct ScrollOffsets {
    private struct Seen {
        weak var scroll: UIScrollView?
        let offset: CGPoint
    }
    private var seen: [ObjectIdentifier: Seen] = [:]

    /// Where the tick before saw this very view; nil for one the probe meets now, whatever stood at its
    /// address. `key` is the view's identity; a test hands in the one a freed view had.
    func last(of scroll: UIScrollView, key: ObjectIdentifier? = nil) -> CGPoint? {
        guard let old = seen[key ?? ObjectIdentifier(scroll)], old.scroll === scroll else { return nil }
        return old.offset
    }

    mutating func record(_ scroll: UIScrollView, at offset: CGPoint, key: ObjectIdentifier? = nil) {
        seen[key ?? ObjectIdentifier(scroll)] = Seen(scroll: scroll, offset: offset)
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
