import XCTest
import SwiftUI
import LashKirjaCore
@testable import LashKirja

/// Uusi lasku (w47): SwiftUI hands a sheet a new `dismiss` twice while the sheet comes in, and the
/// form, which read `@Environment(\.dismiss)`, ran its whole body each time: three builds of the
/// form on the main thread before it could appear. On `SheetDismiss` it is built once, and the
/// handle still closes its sheet.
@MainActor
final class SheetDismissTests: XCTestCase {
    private struct Presenter<Content: View>: View {
        let content: Content
        @State private var shown = false
        var body: some View {
            Color.clear
                .sheet(isPresented: $shown) { content }
                .task { shown = true }
        }
    }

    private final class Closed { var value = false }

    private struct Closable: View {
        let handle: SheetDismiss
        let closed: Closed
        var body: some View {
            Text("Uusi lasku")
                .sheetDismiss(handle)
                .onDisappear { closed.value = true }
        }
    }

    private var window: UIWindow?

    override func tearDown() {
        window?.isHidden = true
        window = nil
        super.tearDown()
    }

    private func present<Content: View>(_ content: Content) throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.rootViewController = UIHostingController(rootView: Presenter(content: content))
        window.makeKeyAndVisible()
        self.window = window
    }

    private func spin(until done: () -> Bool, timeout: TimeInterval = 10) {
        let end = Date().addingTimeInterval(timeout)
        while !done(), Date() < end { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
    }

    func testTheNewInvoiceFormIsBuiltOnceWhileItsSheetComesIn() throws {
        let app = AppModel(baseURL: URL(string: "http://127.0.0.1:9")!, store: InMemoryTokenStore(), resources: ResourceCache())
        let preview = InvoiceFormPreview(sellerRegistered: true, customers: [], catalog: [], kept: nil)
        InvoiceFormView.builds = 0
        try present(InvoiceFormView(existing: nil, preview: preview).environment(app))
        spin(until: { InvoiceFormView.builds > 0 })
        // The presentation's own changes (its dismiss action among them) come within this time.
        RunLoop.main.run(until: Date().addingTimeInterval(2))
        XCTAssertEqual(InvoiceFormView.builds, 1)
    }

    func testTheHandleClosesItsSheet() throws {
        let handle = SheetDismiss()
        let closed = Closed()
        try present(Closable(handle: handle, closed: closed))
        RunLoop.main.run(until: Date().addingTimeInterval(1.5))
        handle()
        spin(until: { closed.value })
        XCTAssertTrue(closed.value)
    }

    func testAHandleWithNoSheetDoesNothing() {
        SheetDismiss()()
    }
}
