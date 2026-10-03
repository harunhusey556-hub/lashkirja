import Testing
@testable import LashKirjaCore

@Test func theDueLineSaysWhereTheInvoiceStands() {
    let today = "2026-10-03"
    #expect(InvoiceDetailLayout.dueLine(status: .sent, dueDate: "2026-10-08", paidAt: nil, today: today) == "Erääntyy 5 päivän päästä")
    #expect(InvoiceDetailLayout.dueLine(status: .sent, dueDate: "2026-10-04", paidAt: nil, today: today) == "Erääntyy huomenna")
    #expect(InvoiceDetailLayout.dueLine(status: .sent, dueDate: "2026-10-03", paidAt: nil, today: today) == "Erääntyy tänään")
    #expect(InvoiceDetailLayout.dueLine(status: .overdue, dueDate: "2026-09-30", paidAt: nil, today: today) == "Myöhässä 3 päivää")
    #expect(InvoiceDetailLayout.dueLine(status: .overdue, dueDate: "2026-10-02", paidAt: nil, today: today) == "Myöhässä 1 päivän")
    #expect(InvoiceDetailLayout.dueLine(status: .paid, dueDate: "2026-09-30", paidAt: "2026-09-28T10:00:00.000Z", today: today) == "Maksettu 28.9.2026")
    #expect(InvoiceDetailLayout.dueLine(status: .draft, dueDate: "2026-10-17", paidAt: nil, today: today) == "Luonnos · eräpäivä 17.10.2026")
    #expect(InvoiceDetailLayout.dueLine(status: .credited, dueDate: "2026-10-17", paidAt: nil, today: today) == "Hyvitetty")
}

@Test func aPartPaymentShowsHowFarAlongItIs() {
    #expect(InvoiceDetailLayout.paidFraction(gross: 200, paid: 50) == 0.25)
    #expect(InvoiceDetailLayout.paidFraction(gross: 200, paid: 0) == nil)
    #expect(InvoiceDetailLayout.paidFraction(gross: 200, paid: 200) == nil)
}

@Test func theTabsShowOnlyWhatTheInvoiceHas() {
    #expect(InvoiceDetailLayout.tabs(payments: 0, activity: 0, overdue: false).map(\.title) == ["Rivit", "Maksut"])
    #expect(InvoiceDetailLayout.tabs(payments: 2, activity: 4, overdue: true).map(\.title) == ["Rivit", "Maksut 2", "Muistutus", "Historia 4"])
    // An overdue invoice opens on the reminder: that is the next thing to do.
    #expect(InvoiceDetailLayout.initialTab(overdue: true) == .reminder)
    #expect(InvoiceDetailLayout.initialTab(overdue: false) == .lines)
}
