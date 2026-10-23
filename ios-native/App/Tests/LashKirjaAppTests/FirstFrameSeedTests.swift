import XCTest
import LashKirjaCore
@testable import LashKirja

/// F011: three screens opened on a spinner page and had their rows a moment later. What each opens on
/// is read before any await, from what a screen or a warm-up kept in the app.
@MainActor
final class FirstFrameSeedTests: XCTestCase {
    private func signedInApp() async -> AppModel {
        let tokens = InMemoryTokenStore()
        await tokens.save(StoredToken(token: "t", expiresAt: Date().addingTimeInterval(3600), issuedAt: Date(), userId: "first-frame-seed"))
        let app = AppModel(baseURL: URL(string: "http://127.0.0.1:9")!, store: tokens, resources: ResourceCache())
        await app.start()
        return app
    }

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    /// Lasku > Kopioi luonnokseksi (motion lasku-copy): the copy's answer is the invoice the new page
    /// opens on, rows and all, instead of a spinner page while it is fetched again.
    func testACopysAnswerIsWhatTheNewInvoiceOpensOn() async throws {
        let app = await signedInApp()
        guard case .signedIn = app.phase else { return XCTFail("the stored session did not open the app") }
        let answer = try decode(InvoiceDetailResponse.self, """
        {"invoice":{"id":"copy-1","number":5,"reference":"0055","status":"draft","displayStatus":"draft","issueDate":"2026-10-22",
         "dueDate":"2026-11-05","sentAt":null,"paidAt":null,"notes":null,"currency":"EUR","net":65,"vat":16.58,"gross":81.58,
         "paid":0,"open":81.58,"closedReason":null,"updatedAt":"2026-10-22T12:00:00.000Z","documentKind":"invoice",
         "customer":{"id":"c1","name":"Anna Asiakas","email":null,"businessId":null},
         "lines":[{"id":"l1","description":"Huoltokäynti","quantity":1,"unit":"kpl","unitPrice":65,"vatRate":25.5,"net":65}],
         "payments":[],"sends":[],"activity":[]},
         "barcode":"421123456000007850000815800000000000000000000039261101","barcodeIssue":null}
        """)
        XCTAssertNil(app.invoicePreview("copy-1"), "the copy was known before it was made")
        app.rememberInvoiceDetail(answer, reminder: nil)
        let preview = try XCTUnwrap(app.invoicePreview("copy-1"), "the copy's page has nothing to open on")
        XCTAssertEqual(preview.detail.invoice.number, 5)
        XCTAssertEqual(preview.detail.invoice.lines.map(\.description), ["Huoltokäynti"])
        XCTAssertEqual(preview.detail.invoice.barcode, "421123456000007850000815800000000000000000000039261101",
                       "the copy opens without the barcode its detail will show")
        XCTAssertNil(preview.reminder, "a new draft is never overdue")
        XCTAssertNil(app.invoicePreview("other"))
    }

    /// Kirjanpito > Kohdista ostolaskujen maksut (motion kirjanpito-match-open): the rows come from the
    /// proposals and the open ostolaskut, both kept by Kirjanpito's warm-up or the screen's last visit.
    func testKohdistaOpensOnTheProposalsAndTheOpenOstolaskutKeptBeforeIt() async throws {
        let app = await signedInApp()
        guard case .signedIn = app.phase else { return XCTFail("the stored session did not open the app") }
        func purchase(_ id: String, due: String) -> String {
            """
            {"id":"\(id)","supplierName":"Tukku \(id)","invoiceNumber":null,"issueDate":"2026-09-01","dueDate":"\(due)",
             "status":"open","displayStatus":"open","gross":124,"vat":0,"net":124,"paid":0,"open":124,"payments":[]}
            """
        }
        let list = try decode(PurchaseInvoiceList.self, #"{"invoices":[\#(purchase("b", due: "2026-09-30")),\#(purchase("a", due: "2026-09-10"))]}"#)
        let pending = try decode(PurchaseSuggestionList.self, """
        {"suggestions":[{"invoiceId":"b","supplierName":"Tukku","invoiceNumber":"A-12","open":124,"transactionId":"t1",
         "amount":124,"paidDate":"2026-01-25","counterparty":"Tukku Oy","reasons":["summa sama","nimi vastaa"],"score":0.9}]}
        """)
        XCTAssertNil(app.purchaseMatchPreview(), "Kohdista had rows before anything was kept")
        app.rememberPainted(pending, PurchaseMatchView.suggestionsPath)
        XCTAssertNil(app.purchaseMatchPreview(), "the proposals alone make no row")
        app.rememberPainted(list, PurchaseMatchView.listPath, query: PurchaseMatchView.openQuery)
        let data = try XCTUnwrap(app.purchaseMatchPreview(), "Kohdista has no rows to open on")
        // The proposal leads; the other waits for a payment.
        XCTAssertEqual(data.rows.map(\.id), ["b", "a"])
        XCTAssertEqual(data.proposed.map(\.id), ["b"])
        XCTAssertEqual(data.waiting.map(\.id), ["a"])
    }
}
