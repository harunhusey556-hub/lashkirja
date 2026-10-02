import Testing
import Foundation
@testable import LashKirjaCore

private func fixture(_ name: String) throws -> Data {
    try Data(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/\(name)"))
}

@Test func displayDayAcceptsTimestamps() {
    #expect(APIDate.displayDay("2026-10-02T00:00:00.000Z") == "2.10.2026")
    #expect(APIDate.monthOf("2026-10-02T00:00:00.000Z") == "2026-10")
}

@Test func decodesRealStatements() throws {
    let list = try JSONDecoder().decode(StatementList.self, from: fixture("statements.json"))
    let s = try #require(list.statements.first)
    #expect(s.transactions.count == 5)
    #expect(s.totals?.income == Decimal(string: "436.18"))
    let sale = try #require(s.transactions.first { $0.counterparty == "MobilePay Myyntitilitys" })
    #expect(sale.amount == Decimal(string: "8.5"))
    #expect(BankFeed.state(of: sale) == .sale)
    let market = try #require(s.transactions.first { $0.counterparty == "K-Market Kamppi" })
    #expect(BankFeed.state(of: market) == .missing)
    #expect(BankFeed.needsAction(market))
}

@Test func feedGroupsByMonthNewestFirst() throws {
    let list = try JSONDecoder().decode(StatementList.self, from: fixture("statements.json"))
    let months = BankFeed.months(list.statements)
    #expect(months.count == 1)
    #expect(months[0].month == "2026-10")
    #expect(months[0].rows.first?.date?.hasPrefix("2026-10-03") == true)
    #expect(months[0].open == 5)
}

@Test func decodesRealPendingReceipt() throws {
    let list = try JSONDecoder().decode(ReceiptList.self, from: fixture("receipts-pending.json"))
    let r = try #require(list.receipts.first)
    #expect(r.vendor == "MobilePay Myyntitilitys")
    #expect(r.totalAmount == Decimal(string: "8.5"))
    #expect(r.source == "auto_income")
    #expect(r.match?.suggestedTransaction?.counterparty == "MobilePay Myyntitilitys")
    let counts = try JSONDecoder().decode(ReceiptCounts.self, from: fixture("receipt-counts.json"))
    #expect(counts.counts.all == 0)
}

@Test func decodesDashboardWithRealItems() throws {
    let d = try JSONDecoder().decode(Dashboard.self, from: fixture("dashboard-items.json"))
    #expect(d.items.map(\.kind).contains(.missingReceipt))
    #expect(d.items.first?.kind == .pendingReceipt)
}

@Test func decodesBankAndProfile() throws {
    let accounts = try JSONDecoder().decode(BankAccountsOverview.self, from: fixture("bank-accounts.json"))
    #expect(accounts.accounts.isEmpty)
    let connections = try JSONDecoder().decode(BankConnections.self, from: fixture("bank-connections.json"))
    #expect(connections.enabled == false)
    let profile = try JSONDecoder().decode(ProfileResponse.self, from: fixture("profile.json"))
    #expect(profile.profile.firstName == "Liisa")
    #expect(profile.profile.vatRegistered == true)
}

@Test func bankSearch() {
    #expect(BankSearch.matches("Säästöpankki", "saasto"))
    #expect(BankSearch.matches("Danske Bank", "bank"))
    #expect(!BankSearch.matches("Danske Bank", "a"))
    #expect(BankSearch.matches("S-Pankki", "spankki"))
    #expect(BankSearch.matches("Nordea", " "))
}
