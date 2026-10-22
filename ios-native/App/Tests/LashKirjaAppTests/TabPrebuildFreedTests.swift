import XCTest
import SwiftUI
import LashKirjaCore
@testable import LashKirja

/// The tab copies TabPrebuild builds after launch (M086, M032) are thrown away in the turn they are
/// laid out, and nothing of them may outlive that: CI's motion walks found the Myynti copy's window
/// still alive 2 s later in every launch. UIKit and SwiftUI autorelease references to a copy's
/// controller and window while they lay it out, and a caller's autorelease pool that does not drain
/// (a test method's, until it returns) held both for seconds. These tests call `render` from the
/// test method, so that pool is not drained: the copy must not depend on it. (A main queue kept
/// busy did not hold a copy in the simulator here, so this covers the pool and no other holder.)
@MainActor
final class TabPrebuildFreedTests: XCTestCase {
    /// The roots MainTabView hands the prebuild for the tabs it builds at launch.
    private func roots(_ app: AppModel) -> [(name: String, root: AnyView)] {
        [("Myynti", AnyView(NavigationStack { MyyntiView(preview: nil) }.listSectionSpacing(.compact).environment(app))),
         ("Kirjanpito", AnyView(NavigationStack { KirjanpitoView() }.listSectionSpacing(.compact).environment(app))),
         ("Raportit", AnyView(NavigationStack { RaportitView(preview: nil) }.listSectionSpacing(.compact).environment(app))),
         ("Lisää", AnyView(AddSheet().environment(app)))]
    }

    private func spin(until done: () -> Bool, timeout: TimeInterval) {
        let end = Date().addingTimeInterval(timeout)
        while !done(), Date() < end { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
    }

    func testEveryTabCopyIsReleasedWithinTheProbesTwoSeconds() throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        // No session and an address nothing answers: the copies' own loads fail behind what they show.
        let app = AppModel(baseURL: URL(string: "http://127.0.0.1:9")!, store: InMemoryTokenStore(), resources: ResourceCache())
        for (name, root) in roots(app) {
            let copy = TabPrebuild.Coordinator.render(root, size: CGSize(width: 402, height: 874), in: scene)
            // A copy that built nothing would be released trivially.
            XCTAssertGreaterThan(copy.views, 20, "\(name): the copy built nothing")
            spin(until: { copy.host == nil && copy.window == nil }, timeout: 2)
            // The retain count says whether something holds it besides a pool (a pool leaves 1).
            XCTAssertNil(copy.host, "\(name): the hosting controller of the copy is alive 2 s after it was thrown away, retain count \(copy.host.map { CFGetRetainCount($0) } ?? 0)")
            XCTAssertNil(copy.window, "\(name): the window of the copy is alive 2 s after it was thrown away, retain count \(copy.window.map { CFGetRetainCount($0) } ?? 0)")
        }
    }
}
