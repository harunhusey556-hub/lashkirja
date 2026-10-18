import XCTest
import SwiftUI
import LashKirjaCore
@testable import LashKirja

/// X122 (P0): "Unohditko PIN-koodin? Kirjaudu ulos" took the lock off and signed out at the tap,
/// which deletes the receipts still on the phone, without a word. It now asks first, with the same
/// question as Asetukset; until the owner confirms, the lock and the session stay.
@MainActor
final class ForgotPINSignOutTests: XCTestCase {
    private var window: UIWindow?
    private var savedDefaults: [String: Any?] = [:]
    private let keys = ["lock.enabled", "lock.biometrics"]

    override func setUp() {
        for key in keys { savedDefaults[key] = UserDefaults.standard.object(forKey: key) }
        // A PIN lock that is on, without the Keychain: `AppLock.isEnabled` reads this flag first.
        UserDefaults.standard.set(true, forKey: "lock.enabled")
        // No Face ID button and no Face ID prompt when the screen appears.
        UserDefaults.standard.set(false, forKey: "lock.biometrics")
    }

    override func tearDown() {
        window?.isHidden = true
        window = nil
        for key in keys {
            if let value = savedDefaults[key] ?? nil { UserDefaults.standard.set(value, forKey: key) }
            else { UserDefaults.standard.removeObject(forKey: key) }
        }
        super.tearDown()
    }

    private func spin(until done: () -> Bool, timeout: TimeInterval = 10) {
        let end = Date().addingTimeInterval(timeout)
        while !done(), Date() < end { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
    }

    func testForgotPINAsksBeforeSigningOutAndPeruutaKeepsTheLock() throws {
        let app = AppModel(baseURL: URL(string: "http://127.0.0.1:9")!, store: InMemoryTokenStore(), resources: ResourceCache())
        let buttons = PressedButtons()
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        let host = UIHostingController(rootView: LockScreen().buttonStyle(Pressing(buttons: buttons)).environment(app))
        window.rootViewController = host
        window.makeKeyAndVisible()
        self.window = window

        spin(until: { buttons.destructive != nil })
        let forgot = try XCTUnwrap(buttons.destructive, "the lock screen shows no Unohditko PIN-koodin? Kirjaudu ulos")
        forgot()
        spin(until: { host.presentedViewController != nil })
        // A sign-out started by the tap runs in a task: it is given the moment it would take.
        RunLoop.main.run(until: Date().addingTimeInterval(0.5))
        XCTAssertTrue(AppLock.shared.isEnabled, "the lock came off at the tap, before the owner answered")
        XCTAssertEqual(app.phase, .launching, "the tap signed out before the owner answered")
        let question = try XCTUnwrap(host.presentedViewController, "Unohditko PIN-koodin? did not ask before signing out")

        // Peruuta, or a swipe down, which the sheet takes as the same answer: the question goes and
        // nothing else does. Dismissed as a swipe ends, so SwiftUI hears that its sheet went.
        let presentation = question.presentationController
        question.dismiss(animated: false)
        spin(until: { host.presentedViewController == nil })
        XCTAssertNil(host.presentedViewController, "the question did not go")
        if let presentation { presentation.delegate?.presentationControllerDidDismiss?(presentation) }
        RunLoop.main.run(until: Date().addingTimeInterval(0.5))
        XCTAssertTrue(AppLock.shared.isEnabled, "the lock came off although the owner answered Peruuta")
        XCTAssertEqual(app.phase, .launching, "Peruuta signed out")
    }
}

/// The actions of the buttons that take their style from the screen, run as a tap runs them.
private final class PressedButtons {
    var found: [(role: ButtonRole?, press: () -> Void)] = []
    var destructive: (() -> Void)? { found.first { $0.role == ButtonRole.destructive }?.press }
}

/// The lock screen's own styled button ("Avaa") keeps its style; the forgot-PIN button has none, so
/// it takes this one, which hands its action to the test.
private struct Pressing: PrimitiveButtonStyle {
    let buttons: PressedButtons

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .onAppear { buttons.found.append((role: configuration.role, press: { configuration.trigger() })) }
    }
}
