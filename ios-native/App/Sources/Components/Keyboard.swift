import UIKit

/// Ends editing wherever it is. A focused field left on screen when its view goes away (signing in,
/// pushing a page from the chat) keeps the keyboard; UIKit then restores it on return, after
/// SwiftUI has laid the screen out, and the field ends up behind the keyboard.
@MainActor
enum Keyboard {
    static func dismiss() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }
}
