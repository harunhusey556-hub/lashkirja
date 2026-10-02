import SwiftUI

enum Theme {
    static let canvas = Color(hex: 0xF6F3EF)
    static let surface = Color(hex: 0xFFFDFB)
    static let line = Color(hex: 0xE7E1DA)
    static let ink = Color(hex: 0x26221F)
    static let ink2 = Color(hex: 0x6A645F)
    static let accent = Color(hex: 0x9A5650)
    static let accentDark = Color(hex: 0x7F413C)
    static let accentSoft = Color(hex: 0xF3E6E3)
    static let success = Color(hex: 0x477455)
    static let warning = Color(hex: 0x8A691E)
    static let danger = Color(hex: 0xA83232)
    static let cardRadius: CGFloat = 14
}

extension Color {
    init(hex: UInt32) {
        self.init(.sRGB,
                  red: Double((hex >> 16) & 0xFF) / 255,
                  green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255,
                  opacity: 1)
    }
}
