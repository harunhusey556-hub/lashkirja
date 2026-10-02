import SwiftUI
import UIKit

/// Every colour has a light and a dark value, so the palette follows the system appearance
/// together with the system colours (large titles, list rows) it sits next to.
enum Theme {
    static let canvas = Color(light: 0xF6F3EF, dark: 0x0F0D0C)
    static let surface = Color(light: 0xFFFDFB, dark: 0x1D1A18)
    static let line = Color(light: 0xE7E1DA, dark: 0x37302C)
    static let ink = Color(light: 0x26221F, dark: 0xF2ECE6)
    static let ink2 = Color(light: 0x6A645F, dark: 0xA9A09A)
    /// Text and icons on an `ink` fill (dark buttons in light mode, light ones in dark mode).
    static let onInk = Color(light: 0xFFFFFF, dark: 0x1A1614)
    static let accent = Color(light: 0x9A5650, dark: 0xC97F77)
    static let accentDark = Color(light: 0x7F413C, dark: 0xF0B3AB)
    static let accentSoft = Color(light: 0xF3E6E3, dark: 0x3A2522)
    static let success = Color(light: 0x477455, dark: 0x7DB38E)
    static let warning = Color(light: 0x8A691E, dark: 0xD9B45A)
    static let danger = Color(light: 0xA83232, dark: 0xEF6F6C)
    /// Fills under white system labels (swipe actions, the app mark): the light values in both
    /// appearances, since the dark-mode accent and success are too pale for white text.
    static let accentFill = Color(hex: 0x9A5650)
    static let successFill = Color(hex: 0x477455)
    static let neutralFill = Color(hex: 0x6A645F)
    static let cardRadius: CGFloat = 14
}

extension Color {
    init(hex: UInt32) {
        self.init(uiColor: UIColor(hex: hex))
    }

    init(light: UInt32, dark: UInt32) {
        self.init(uiColor: UIColor { traits in
            UIColor(hex: traits.userInterfaceStyle == .dark ? dark : light)
        })
    }
}

extension UIColor {
    convenience init(hex: UInt32) {
        self.init(red: CGFloat((hex >> 16) & 0xFF) / 255,
                  green: CGFloat((hex >> 8) & 0xFF) / 255,
                  blue: CGFloat(hex & 0xFF) / 255,
                  alpha: 1)
    }
}

/// The app's filled button: `ink` fill with `onInk` text, so it reads in both appearances
/// (a bordered-prominent button keeps white text even when its tint turns light).
struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(Theme.onInk)
            .padding(.horizontal, 18)
            .frame(minHeight: 44)
            .background(Theme.ink.opacity(isEnabled ? (configuration.isPressed ? 0.8 : 1) : 0.35), in: Capsule())
            .contentShape(Capsule())
    }
}

extension ButtonStyle where Self == PrimaryButtonStyle {
    static var primary: PrimaryButtonStyle { PrimaryButtonStyle() }
}
