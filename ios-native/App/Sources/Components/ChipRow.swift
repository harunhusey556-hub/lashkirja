import SwiftUI

/// A horizontal chip row in a List or Form section (filters, tabs, placeholders). It scrolls from the
/// screen's edges and starts its first chip 16 pt in, where the cards start: inside the margin a
/// list gives each section, a long row was cut mid-word at the card's edge (U031 X132 X147).
enum ChipRow {
    /// The side margin the row's section gives up (`chipRowSection`), given back as the chips' own
    /// inset and to the section's other rows, header and footer. iOS 18 has no section margins to
    /// set: the section keeps its own, and the row draws past its frame instead (`chipRowScroll`).
    static var inset: CGFloat {
        // Swift 6.2 is Xcode 26, the first SDK with listSectionMargins.
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) { return 16 }
        #endif
        return 0
    }
}

extension View {
    /// On the List or Form section that holds a chip row: on iOS 26 the section reaches the screen's edges.
    @ViewBuilder func chipRowSection() -> some View {
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) {
            listSectionMargins(.horizontal, 0)
        } else {
            self
        }
        #else
        self
        #endif
    }

    /// On the chip row's horizontal ScrollView: where the section keeps its margin (iOS 18), the
    /// chips are drawn on past the card's edge to the screen's.
    @ViewBuilder func chipRowScroll() -> some View {
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) {
            self
        } else {
            scrollClipDisabled()
        }
        #else
        scrollClipDisabled()
        #endif
    }

    /// A chip label's subheadline font, semibold while selected. The label always takes its semibold
    /// width (a hidden semibold copy under it), so picking a chip moves none beside it (X025). The
    /// chips draw their outline inside the edge (`strokeBorder`): a centred `stroke` reached 0.5 pt
    /// past an unselected chip only, which made it 1 pt wider than when selected.
    func chipFont(selected: Bool) -> some View {
        ZStack {
            self.font(.subheadline.weight(.semibold)).hidden().accessibilityHidden(true)
            self.font(.subheadline.weight(selected ? .semibold : .regular))
        }
    }
}
