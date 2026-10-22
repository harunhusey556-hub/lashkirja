/// A block of list rows that a swap makes shorter at the end of a page. The List clamps its scroll
/// offset to the shorter content, and everything above the block slides down under the finger
/// (F012: Raportit's Luokittain, Menot 3 rows to Tulot 2, 66 pt). The height the page cannot give
/// back from the room it still has below is held as clear space under the block instead, and goes
/// once that space is off screen below. Away from the end nothing is held: what is below the block
/// follows it up, with no blank gap.
public enum ListEndHold {
    /// A row's content as measured on screen: its top, in any one coordinate space, and its height.
    public struct Frame: Equatable, Sendable {
        public var top: Double
        public var height: Double

        public init(top: Double, height: Double) {
            self.top = top
            self.height = height
        }
    }

    /// One row's height: from a row's top to the next one's, for the first two neighbours both on
    /// screen (nil = not on screen). Rows of one template are one height. Nil when no two are: the
    /// block then starts below the screen, and the page has all of it as room.
    public static func rowHeight(_ rows: [Frame?]) -> Double? {
        for (upper, lower) in zip(rows, rows.dropFirst()) {
            if let upper, let lower, lower.top > upper.top { return lower.top - upper.top }
        }
        return nil
    }

    /// The "Näytä enemmän" row's height, from where its content sits under the block's last row:
    /// the last row's cell ends as far under its content as it starts above it, and the button's
    /// content is centred in its own cell, however tall the List makes it. Without both on screen,
    /// a row's height, which the one-line button row does not exceed.
    public static func buttonHeight(_ button: Frame?, under last: Frame?, rowHeight: Double) -> Double {
        guard let button, let last else { return rowHeight }
        let edge = last.top + last.height + (rowHeight - last.height) / 2
        let height = 2 * (button.top - edge) + button.height
        return height > 0 ? height : rowHeight
    }

    /// `rows` rows, and the button row when the block shows one.
    public static func blockHeight(rows: Int, button: Bool, rowHeight: Double, buttonHeight: Double) -> Double {
        Double(rows) * rowHeight + (button ? buttonHeight : 0)
    }

    /// The space to hold under the block after a swap from `before` to `after` points (the block
    /// alone), with `held` points held under it already and the page able to scroll `room` points
    /// further down: only the part of the shrink that room cannot take. A longer block takes back
    /// what was held first, so the page keeps its height.
    public static func held(before: Double, after: Double, held: Double, room: Double) -> Double {
        max(0, before + held - after - max(room, 0))
    }

    /// Held space can go when the view that carries it is off screen and the page has at least that
    /// much room below: the content shrinks under the screen and nothing on it moves.
    public static func canRelease(held: Double, carrierShown: Bool, room: Double) -> Bool {
        held > 0 && !carrierShown && room >= held
    }
}
