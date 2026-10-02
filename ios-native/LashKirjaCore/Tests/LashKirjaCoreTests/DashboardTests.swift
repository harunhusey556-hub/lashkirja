import Testing
import Foundation
@testable import LashKirjaCore

private func fixture(_ name: String) throws -> Data {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/\(name)")
    return try Data(contentsOf: url)
}

@Test func decodesRealEmptyDashboard() throws {
    let d = try JSONDecoder().decode(Dashboard.self, from: fixture("dashboard-empty.json"))
    #expect(d.month == "2026-10")
    #expect(d.items.isEmpty)
    #expect(d.cashflow.count == 6)
    #expect(d.setup?.empty == true)
    #expect(d.bank?.state == "none")
}

@Test func decodesEveryItemKind() throws {
    let json = #"""
    {"month":"2026-10","income":427.68,"expenses":0,"source":"tiliote","txCount":3,"receiptCount":1,"invoiceCount":1,
     "pendingReceiptsCount":2,"matching":{"matchable":2,"matched":0,"suggested":1},"events":{"done":0,"total":2},
     "vat":{"registered":true,"entityType":"toiminimi","ytdRevenue":3592.51,"threshold":20000},"hasImap":true,
     "cashflow":[],"items":[
      {"id":"r1","kind":"pending_receipt","action":"approve","receiptId":"R1","party":"MobilePay Myyntitilitys","amount":8.5,"type":"tulo","date":"2026-10-01","category":"myynti","vatRate":25.5,"gaps":[],"fromBank":true},
      {"id":"m1","kind":"missing_receipt","action":"add_photo","transactionId":"T1","party":"KANSANELÄKELAITOS","amount":401.27,"date":"2026-10-02"},
      {"id":"o1","kind":"overdue_invoice","action":"remind","invoiceId":"I1","customerId":"C1","number":2,"party":"Harun","amount":81.58,"dueDate":"2026-10-01","daysLate":1,"nextReminderAt":null},
      {"id":"x1","kind":"something_new","action":"open","party":"?"}
     ],"blockingTotal":33,"previousMonth":{"month":"2026-09","open":31},
     "bankTrend":{"points":[{"month":"2026-09","balance":1.5},{"month":"2026-10","balance":403.13}]}}
    """#
    let d = try JSONDecoder().decode(Dashboard.self, from: Data(json.utf8))
    #expect(d.items.map(\.kind) == [.pendingReceipt, .missingReceipt, .overdueInvoice, .unknown])
    #expect(d.items[0].receiptId == "R1")
    #expect(d.items[0].fromBank == true)
    #expect(Money.format(d.items[1].amount!) == "401,27\u{00A0}€")
    #expect(d.items[2].daysLate == 1)
    #expect(d.blockingTotal == 33)
    #expect(d.bankTrend?.points.last?.balance == Decimal(string: "403.13"))
    #expect(Money.format(d.income) == "427,68\u{00A0}€")
}

@Test func monthKeys() {
    #expect(MonthKey.shift("2026-10", by: -1) == "2026-09")
    #expect(MonthKey.shift("2026-01", by: -1) == "2025-12")
    #expect(MonthKey.shift("2026-12", by: 1) == "2027-01")
    #expect(MonthKey.name("2026-10") == "Lokakuu")
    #expect(MonthKey.title("2026-10", currentYear: "2026") == "Lokakuu")
    #expect(MonthKey.title("2025-03", currentYear: "2026") == "Maaliskuu 2025")
    #expect(MonthKey.short("2026-10") == "Lok")
}

@Test func kotiHeadline() {
    #expect(Koti.headline(blocking: 0) == "Kaikki kunnossa")
    #expect(Koti.headline(blocking: 1) == "1 asia ennen kuun loppua")
    #expect(Koti.headline(blocking: 33) == "33 asiaa ennen kuun loppua")
}
