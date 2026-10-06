import XCTest

/// P2 additions: Spotlight routes, receipt thumbnails, next invoice number.
final class P2Tests: WalkTestCase {
    /// Reads ids from the demo API the app uses (through the walk proxy), with the demo-seed login.
    func demoJSON(_ path: String) -> [String: Any] {
        func call(_ req: URLRequest) -> [String: Any] {
            var out: [String: Any] = [:]
            let done = expectation(description: path)
            URLSession.shared.dataTask(with: req) { data, _, _ in
                out = (data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
                done.fulfill()
            }.resume()
            wait(for: [done], timeout: 30)
            return out
        }
        let base = "http://127.0.0.1:3998"
        var login = URLRequest(url: URL(string: base + "/api/auth/token")!)
        login.httpMethod = "POST"
        login.setValue("application/json", forHTTPHeaderField: "content-type")
        login.httpBody = #"{"email":"demo@lashkirja.fi","password":"demo123"}"#.data(using: .utf8)
        let token = call(login)["token"] as? String ?? ""
        var get = URLRequest(url: URL(string: base + path)!)
        get.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return call(get)
    }

    func testA_SpotlightInvoiceRoute() {
        let invoices = demoJSON("/api/invoices")["invoices"] as? [[String: Any]] ?? []
        guard let sent = invoices.first(where: { $0["status"] as? String == "sent" }), let id = sent["id"] as? String,
              let number = sent["invoiceNumber"] else { check("P2 demo API lists a sent invoice", false); return }
        openURL("lashkirja://invoice/\(id)")
        let ok = app.staticTexts["Lasku \(number)"].waitForExistence(timeout: 20)
        shot("p2-spotlight-invoice"); check("P2 Spotlight invoice link opens Lasku \(number)", ok)
    }
    func testB_SpotlightCustomerRoute() {
        let customers = demoJSON("/api/customers")["customers"] as? [[String: Any]] ?? []
        guard let anna = customers.first(where: { $0["name"] as? String == "Anna Asiakas" }), let id = anna["id"] as? String
        else { check("P2 demo API lists Anna Asiakas", false); return }
        openURL("lashkirja://customer/\(id)")
        let ok = app.staticTexts["Anna Asiakas"].waitForExistence(timeout: 20)
        shot("p2-spotlight-customer"); check("P2 Spotlight customer link opens Anna Asiakas", ok)
    }
    func testC_ReceiptThumbnails() {
        tab("Kirjanpito"); tap("Kuitit"); sleep(6)
        shot("p2-receipts"); dump(app, "p2-receipts")
        check("P2 Kuitit list shows image thumbnails", app.images.count > 0)
    }
    func testD_NextInvoiceNumber() {
        tab("Myynti"); tap("Uusi lasku"); sleep(4)
        let caption = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Seuraava laskunumero'")).firstMatch
        shot("p2-next-number"); check("P2 new invoice shows \(caption.exists ? caption.label : "no next number")", caption.exists)
    }
}
