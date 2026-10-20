import XCTest
import SwiftUI
@testable import LashKirja

/// M092: the bar centres the "Uusi lasku" title by its width. The title was as wide as "Uusi lasku"
/// (about 81 pt) until the server named the next number, then as wide as "Seuraava laskunumero: 5"
/// (about 132 pt), so it jumped 25 pt left and eased back while the number faded in. It now keeps
/// one width from the first frame.
@MainActor
final class InvoiceFormTitleTests: XCTestCase {
    func testTheTitleKeepsItsWidthWhenTheNumberArrives() {
        let waiting = width(InvoiceFormTitle(nextNumber: nil))
        let named = width(InvoiceFormTitle(nextNumber: 5))
        XCTAssertGreaterThan(waiting, 0, "the title has no width")
        XCTAssertEqual(waiting, named, accuracy: 0.5, "the title is \(waiting) pt wide before the number and \(named) pt after it")
    }

    /// The width the title takes in a bar as wide as a 402 pt phone.
    private func width(_ title: InvoiceFormTitle) -> CGFloat {
        UIHostingController(rootView: title).sizeThatFits(in: CGSize(width: 402, height: 100)).width
    }
}
