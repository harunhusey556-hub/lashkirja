import XCTest
import SwiftUI
@testable import LashKirja

/// Kuitit under an open receipt (OPEN-ISSUES row 18): a queue change that lands while the list is
/// hidden takes its place without animation, so the owner comes back to a list that is already
/// still. The probe stands for a Kuitit section: its own implicit motion, read from the
/// environment as `ReviewQueueSection` and `QueuedReceiptsCard` do, under the list's
/// `.transaction` as `ReceiptsView` sets it.
@MainActor
final class HiddenListMotionTests: XCTestCase {
    func testHiddenListTakesNoAnimation() {
        let hidden = HiddenListMotion(onScreen: false)
        XCTAssertNil(hidden.animation(.snappy))
        var transaction = Transaction(animation: .snappy)
        hidden.settle(&transaction)
        XCTAssertNil(transaction.animation)
        XCTAssertTrue(transaction.disablesAnimations)
    }

    func testListOnScreenKeepsItsMotion() {
        let shown = HiddenListMotion(onScreen: true)
        XCTAssertEqual(shown.animation(.snappy), .snappy)
        var transaction = Transaction(animation: .snappy)
        shown.settle(&transaction)
        XCTAssertEqual(transaction.animation, .snappy)
        XCTAssertFalse(transaction.disablesAnimations)
    }

    func testQueueChangedUnderAnOpenReceiptIsSettledOnReturn() {
        let model = ProbeModel()
        let seen = Seen()
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.rootViewController = UIHostingController(rootView: ProbeList(model: model, seen: seen))
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        render(window)

        // On screen: a new row eases in (the probe sees the section's own motion).
        seen.animations = []
        model.count = 2
        render(window)
        XCTAssertFalse(seen.animations.isEmpty, "the probe saw no update")
        XCTAssertTrue(seen.animations.contains { $0 != nil }, "on screen the section animates its rows")

        // A receipt opens over Kuitit; the queue changes under it, also from an animated call
        // elsewhere (the receipt's own delete).
        model.onScreen = false
        render(window)
        seen.animations = []
        model.count = 3
        render(window)
        withAnimation(.snappy) { model.count = 1 }
        render(window)
        XCTAssertFalse(seen.animations.isEmpty, "the probe saw no update")
        XCTAssertEqual(seen.animations.compactMap { $0 }, [], "a hidden list changes without animation")

        // Back on Kuitit: nothing is left to animate.
        seen.animations = []
        model.onScreen = true
        render(window)
        XCTAssertEqual(seen.animations.compactMap { $0 }, [], "the list is already in its final state")
    }

    private func render(_ window: UIWindow) {
        window.rootViewController?.view.setNeedsLayout()
        window.rootViewController?.view.layoutIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    }
}

@Observable private final class ProbeModel {
    var count = 1
    var onScreen = true
}

private final class Seen {
    var animations: [Animation?] = []
}

/// Stands for a Kuitit section with its own implicit motion.
private struct ProbeRows: View {
    @Environment(\.listMotion) private var listMotion
    let count: Int
    let seen: Seen

    var body: some View {
        VStack {
            ForEach(0..<count, id: \.self) { Text("Kuitti \($0)") }
        }
        .transaction { seen.animations.append($0.animation) }
        .motion(listMotion.animation(.snappy), value: count)
    }
}

/// Stands for `ReceiptsView`'s list: what it sets on the sections inside it.
private struct ProbeList: View {
    let model: ProbeModel
    let seen: Seen

    var body: some View {
        let visibility = HiddenListMotion(onScreen: model.onScreen)
        ProbeRows(count: model.count, seen: seen)
            .transaction { visibility.settle(&$0) }
            .environment(\.listMotion, visibility)
    }
}
