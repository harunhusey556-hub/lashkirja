import XCTest
import SwiftUI
import LashKirjaCore
@testable import LashKirja

/// Asetukset's pushed screens (M053 M054 M057): built with what Asetukset warmed, Laitteet,
/// Sähköpostimallit and Pääsyavaimet draw their rows in the first layout. They slid in a spinner
/// ('Ladataan', a running activity indicator) that the list replaced up to a second later. Read off
/// the UIKit list SwiftUI draws; P0Tests.testJ reads the same screens' words in the running app.
@MainActor
final class SeededSettingsScreensTests: XCTestCase {
    private var window: UIWindow?
    private var model: AppModel?

    override func tearDown() {
        window?.isHidden = true
        window = nil
        model = nil
        super.tearDown()
    }

    func testDevicesDrawTheirRowsInTheFirstLayout() throws {
        let sessions = try JSONDecoder().decode(DeviceSessions.self, from: Data(#"{"sessions":[{"id":"s1","label":"iPhone · LashKirja-sovellus","createdAt":"2026-10-01T08:00:00.000Z","lastSeenAt":"2026-10-19T08:00:00.000Z","current":true},{"id":"s2","label":"Selain","createdAt":"2026-10-02T08:00:00.000Z","lastSeenAt":null,"current":false}]}"#.utf8)).sessions
        // The two devices and "Kirjaa ulos kaikki muut laitteet"; the spinner page is one row.
        try assertDrawn(DevicesView(preview: sessions), rows: 3, "Laitteet")
    }

    func testTemplatesDrawTheirListInTheFirstLayout() throws {
        let list = try JSONDecoder().decode(EmailTemplateList.self, from: Data(#"{"templates":[{"id":"t1","name":"Perusmalli","subject":"Lasku {laskunumero}","body":"Hei {asiakas},","kind":"invoice","isDefault":true}],"placeholders":null}"#.utf8))
        // The template and Paikkamerkit's "Näin malli täyttyy laskulle"; the spinner page is one row.
        try assertDrawn(EmailTemplatesView(preview: list), rows: 2, "Sähköpostimallit")
    }

    func testPasskeysDrawTheListAndTheCreateRowTogether() throws {
        let keys = try JSONDecoder().decode(PasskeyList.self, from: Data(#"{"passkeys":[{"id":"k1","deviceName":"iPhone","createdAt":"2026-09-01T10:00:00.000Z","lastUsedAt":null}]}"#.utf8)).passkeys
        // The intro, the passkey and "Luo pääsyavain" (M057: it came in a moment after the list);
        // the spinner page is the intro and the spinner.
        try assertDrawn(PasskeysView(preview: PasskeyScreen(passkeys: keys, canCreate: true)), rows: 3, "Pääsyavaimet")
    }

    /// After the first layout: no spinner running, and the list holds at least `rows` rows.
    private func assertDrawn<Content: View>(_ screen: Content, rows: Int, _ name: String,
                                            file: StaticString = #filePath, line: UInt = #line) throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        // No session and an address nothing answers: the screen's own refresh fails behind what it shows.
        let app = AppModel(baseURL: URL(string: "http://127.0.0.1:9")!, store: InMemoryTokenStore(),
                           resources: ResourceCache(), signer: nil, lastActive: nil)
        model = app
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
        window.rootViewController = UIHostingController(rootView: NavigationStack { screen }.environment(app))
        window.makeKeyAndVisible()
        self.window = window
        window.rootViewController?.view.setNeedsLayout()
        window.rootViewController?.view.layoutIfNeeded()
        // One turn for SwiftUI to hand its rows to the list; the refresh behind them is not answered yet.
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))

        var lists: [UICollectionView] = []
        var spinners: [UIActivityIndicatorView] = []
        collect(window, lists: &lists, spinners: &spinners)
        let running = spinners.filter { $0.isAnimating && !$0.isHidden && $0.alpha > 0 }
        XCTAssertTrue(running.isEmpty, "\(name)'s first layout is a spinner", file: file, line: line)
        // The screen's own list: the largest one (a bar may draw its items in one of its own).
        let list = try XCTUnwrap(lists.max { $0.bounds.width * $0.bounds.height < $1.bounds.width * $1.bounds.height },
                                 "\(name) drew no list", file: file, line: line)
        let drawn = (0..<list.numberOfSections).reduce(0) { $0 + list.numberOfItems(inSection: $1) }
        XCTAssertGreaterThanOrEqual(drawn, rows, "\(name)'s first layout has \(drawn) rows, not its content", file: file, line: line)
    }

    private func collect(_ view: UIView, lists: inout [UICollectionView], spinners: inout [UIActivityIndicatorView]) {
        if let list = view as? UICollectionView { lists.append(list) }
        if let spinner = view as? UIActivityIndicatorView { spinners.append(spinner) }
        for subview in view.subviews { collect(subview, lists: &lists, spinners: &spinners) }
    }
}
