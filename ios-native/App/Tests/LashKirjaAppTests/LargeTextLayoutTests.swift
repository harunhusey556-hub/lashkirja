import XCTest
import SwiftUI
import LashKirjaCore
@testable import LashKirja

/// B5: an amount and a status badge each keep to one line at the largest text size, and a badge
/// beside other text keeps its whole width. At AX5 Myynti's '146,84 €' broke after its comma
/// ('146,8/4 €', U068), Lasku 2's late tag broke to 'Myöhäs/sä' (U069), and a row's badge was
/// squeezed to 'Luon-/nos' beside a long name.
@MainActor
final class LargeTextLayoutTests: XCTestCase {
    func testTheAmountKeepsToOneLineAtTheLargestSize() {
        let amount = MoneyText(amount: Decimal(14684) / 100).font(.subheadline.weight(.semibold))
            .dynamicTypeSize(.accessibility5)
        let size = fitted(amount, width: 150)
        XCTAssertLessThanOrEqual(size.height, largestLine(.subheadline) * 1.3, "'146,84 €' takes \(size.height) pt in a 150 pt column")
    }

    func testTheLateTagKeepsToOneLineAtTheLargestSize() {
        let tag = StatusBadge(status: .overdue, text: "Myöhässä 15 päivää").dynamicTypeSize(.accessibility5)
        let size = fitted(tag, width: 300)
        XCTAssertLessThanOrEqual(size.height, largestLine(.caption2) * 1.3, "the tag takes \(size.height) pt in a 300 pt card")
        XCTAssertLessThanOrEqual(size.width, 300.5, "the tag runs \(size.width) pt, past its 300 pt card")
    }

    func testTheBadgeKeepsItsWidthBesideOtherText() {
        let badge = StatusBadge(status: .draft).dynamicTypeSize(.large)
        let whole = fitted(badge, width: nil)
        let squeezed = fitted(badge, width: 20)
        XCTAssertGreaterThan(whole.width, 20, "'Luonnos' has no width of its own")
        XCTAssertEqual(squeezed.width, whole.width, accuracy: 0.5, "offered 20 pt, the badge took \(squeezed.width) of its \(whole.width)")
        XCTAssertEqual(squeezed.height, whole.height, accuracy: 0.5, "offered 20 pt, the badge wrapped to \(squeezed.height) pt")
    }

    /// The size SwiftUI gives `view` in a column `width` wide (nil: as wide as it likes).
    private func fitted<Content: View>(_ view: Content, width: CGFloat?) -> CGSize {
        UIHostingController(rootView: view)
            .sizeThatFits(in: CGSize(width: width ?? .greatestFiniteMagnitude, height: .greatestFiniteMagnitude))
    }

    /// One line of `style` at AX5.
    private func largestLine(_ style: UIFont.TextStyle) -> CGFloat {
        UIFont.preferredFont(forTextStyle: style,
                             compatibleWith: UITraitCollection(preferredContentSizeCategory: .accessibilityExtraExtraExtraLarge)).lineHeight
    }
}
