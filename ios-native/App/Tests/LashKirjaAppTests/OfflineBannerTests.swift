import XCTest
import SwiftUI
import LashKirjaCore
@testable import LashKirja

/// M085 (B4): the offline pill keeps its frame when the notice changes. Swapped as one label it was
/// 242 pt wide for "Palvelimeen ei saada yhteyttä" and 163 pt for "Ei verkkoyhteyttä", and shrank
/// and re-centred between them while the network path flapped.
@MainActor
final class OfflineBannerTests: XCTestCase {
    func testThePillKeepsItsFrameWhenTheNoticeChanges() {
        let unreachable = size(.serverUnreachable)
        let offline = size(.offline)
        XCTAssertGreaterThan(unreachable.width, 0, "the pill has no width")
        XCTAssertEqual(unreachable.width, offline.width, accuracy: 0.5,
                       "the pill is \(unreachable.width) pt wide for the server and \(offline.width) pt for the network")
        XCTAssertEqual(unreachable.height, offline.height, accuracy: 0.5,
                       "the pill is \(unreachable.height) pt tall for the server and \(offline.height) pt for the network")
    }

    /// The pill's size on a 402 pt phone; it is centred, so one size is one frame.
    private func size(_ notice: ReachabilityState.Notice) -> CGSize {
        UIHostingController(rootView: OfflinePill(notice: notice)).sizeThatFits(in: CGSize(width: 402, height: 100))
    }
}
