import XCTest
import UIKit
@testable import LashKirja

/// R5-COPY: the motion probe wrote `SCROLLJUMP invoice dy=-46` on the first tick after Lasku > Kopioi
/// luonnokseksi pushed its page, while every frame of both videos showed the page still (gate
/// 39890783874). The page's list had not been seen before; its address had: a list the probe saw
/// earlier was freed, and the offset kept under that address was compared with the new list's first.
@MainActor
final class ScrollOffsetsTests: XCTestCase {
    func testAViewSeenBeforeReportsWhereItWas() {
        var offsets = ScrollOffsets()
        let scroll = UIScrollView()
        XCTAssertNil(offsets.last(of: scroll), "a view the probe has not seen has no earlier offset")
        offsets.record(scroll, at: CGPoint(x: 0, y: -106))
        XCTAssertEqual(offsets.last(of: scroll)?.y, -106)
        offsets.record(scroll, at: CGPoint(x: 0, y: -60))
        XCTAssertEqual(offsets.last(of: scroll)?.y, -60, "the latest tick's offset is the one compared with")
    }

    func testAViewAtAFreedViewsAddressIsNotCompared() {
        var offsets = ScrollOffsets()
        var gone: UIScrollView? = UIScrollView()
        let address = ObjectIdentifier(gone!)
        offsets.record(gone!, at: CGPoint(x: 0, y: -60), key: address)
        gone = nil
        // What the allocator does to the probe: a new view under the freed one's identifier.
        let page = UIScrollView()
        XCTAssertNil(offsets.last(of: page, key: address), "the new list was read against a list that is gone")
        offsets.record(page, at: CGPoint(x: 0, y: -106), key: address)
        XCTAssertEqual(offsets.last(of: page, key: address)?.y, -106, "once seen, the new list is compared with its own offset")
    }

    func testAnotherLiveViewUnderTheSameIdentifierIsNotCompared() {
        var offsets = ScrollOffsets()
        let first = UIScrollView(), second = UIScrollView()
        let address = ObjectIdentifier(first)
        offsets.record(first, at: CGPoint(x: 0, y: 373), key: address)
        XCTAssertNil(offsets.last(of: second, key: address))
        XCTAssertEqual(offsets.last(of: first, key: address)?.y, 373)
    }
}
