import XCTest
import SwiftUI
import LashKirjaCore
@testable import LashKirja

/// U009: a name is not a word to correct. 'Testi Oy' in Uusi asiakas came up underlined in red, and
/// autocorrect may change a name the owner typed; the e-mail, money and code fields already had it off.
@MainActor
final class NameFieldAutocorrectTests: XCTestCase {
    private var window: UIWindow?
    private var model: AppModel?

    override func tearDown() {
        window?.isHidden = true
        window = nil
        model = nil
        super.tearDown()
    }

    func testProfileNamesAreNotCorrected() throws {
        let profile = try JSONDecoder().decode(Profile.self, from: Data(#"{"firstName":"Liisa","lastName":"Demo","email":"demo@lashkirja.fi","entityType":"toiminimi","vatRegistered":true,"businessName":"Liisan Ripsistudio"}"#.utf8))
        assertNotCorrected(try fields(NavigationStack { ProfileForm(original: profile, section: .person) { _ in } }), ["Liisa", "Demo"])
        assertNotCorrected(try fields(NavigationStack { ProfileForm(original: profile, section: .seller) { _ in } }), ["Liisan Ripsistudio"])
    }

    func testCustomerNamesAreNotCorrected() throws {
        let customer = try JSONDecoder().decode(Customer.self, from: Data(#"{"id":"c1","name":"Testi Oy","contactPerson":"Anna Asiakas","defaultPaymentTermDays":14,"updatedAt":"2026-10-01T00:00:00.000Z"}"#.utf8))
        assertNotCorrected(try fields(CustomerFormSheet(existing: customer) { _ in }), ["Testi Oy", "Anna Asiakas"])
    }

    func testReceiptVendorsAreNotCorrected() throws {
        var draft = ReceiptDraft(uploadId: "u1")
        draft.vendor = "Testikauppa Oy"
        let queue = CaptureQueueModel()
        assertNotCorrected(try fields(NavigationStack {
            ReceiptEditor(model: queue, rowId: "row1", draft: draft, preview: nil, dirty: .constant(false)) { _ in }
        }), ["Testikauppa Oy"])
        let receipt = try JSONDecoder().decode(Receipt.self, from: Data(#"{"id":"r1","vendor":"Kauppa Testinen","date":"2026-10-01","type":"meno","totalAmount":12.4,"createdAt":"2026-10-01T00:00:00.000Z","updatedAt":"2026-10-01T00:00:00.000Z"}"#.utf8))
        assertNotCorrected(try fields(ReceiptEditSheet(receipt: receipt) { _, _ in }), ["Kauppa Testinen"])
    }

    private func assertNotCorrected(_ fields: [UITextField], _ names: [String], file: StaticString = #filePath, line: UInt = #line) {
        for name in names {
            guard let field = fields.first(where: { $0.text == name }) else {
                XCTFail("no field shows '\(name)' (fields: \(fields.map { $0.text ?? "" }))", file: file, line: line)
                continue
            }
            XCTAssertEqual(field.autocorrectionType, .no, "'\(name)' is corrected as it is typed", file: file, line: line)
        }
    }

    /// The text fields the form draws once it has taken its values (`onAppear`).
    private func fields<Content: View>(_ form: Content) throws -> [UITextField] {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        // No session and an address nothing answers: nothing here is sent.
        let app = AppModel(baseURL: URL(string: "http://127.0.0.1:9")!, store: InMemoryTokenStore(),
                           resources: ResourceCache(), signer: nil, lastActive: nil)
        model = app
        window?.isHidden = true
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
        window.rootViewController = UIHostingController(rootView: form.environment(app))
        window.makeKeyAndVisible()
        self.window = window
        for _ in 0..<3 {
            window.rootViewController?.view.setNeedsLayout()
            window.rootViewController?.view.layoutIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        }
        var found: [UITextField] = []
        collect(window, into: &found)
        return found
    }

    private func collect(_ view: UIView, into found: inout [UITextField]) {
        if let field = view as? UITextField { found.append(field) }
        for subview in view.subviews { collect(subview, into: &found) }
    }
}
