import Testing
@testable import LashKirjaCore

private func category(_ name: String) -> ProfitLoss.Category {
    ProfitLoss.Category(category: name, gross: 0, vat: 0, net: 0, count: 1)
}

private func period(income: [String], expense: [String]) -> ProfitLoss.Period {
    ProfitLoss.Period(month: nil, incomeNet: 0, incomeVat: 0, incomeGross: 0, expenseNet: 0, expenseVat: 0, expenseGross: 0,
                      profitNet: 0, incomeByCategory: income.map(category), expenseByCategory: expense.map(category),
                      receiptCount: 0, invoiceCount: 0, creditNoteCount: 0)
}

@Test func reportCategoriesOpenOnExpensesAndKeepTheChoice() {
    let both = period(income: ["Myynti"], expense: ["Tarvikkeet", "Vuokra"])
    #expect(ReportCategoryKind.available(both) == [.income, .expense])
    #expect(ReportCategoryKind.resolve(nil, in: both) == .expense)
    #expect(ReportCategoryKind.resolve(.income, in: both) == .income)
    #expect(ReportCategoryKind.expense.rows(both).map(\.category) == ["Tarvikkeet", "Vuokra"])
}

@Test func reportCategoriesFallBackToTheKindWithRows() {
    let incomeOnly = period(income: ["Myynti"], expense: [])
    #expect(ReportCategoryKind.available(incomeOnly) == [.income])
    // A year without expenses: the kept "Menot" choice falls back to Tulot.
    #expect(ReportCategoryKind.resolve(.expense, in: incomeOnly) == .income)
    #expect(ReportCategoryKind.resolve(nil, in: period(income: [], expense: [])) == nil)
}

@Test func conversationPageQueryPagesFromTheLastRow() {
    #expect(ConversationPaging.query(archived: false, search: "") == [:])
    #expect(ConversationPaging.query(archived: true, search: "alv") == ["archived": "1", "q": "alv"])
    let last = Conversation(id: "c9", title: "ALV", archivedAt: nil, updatedAt: "2026-09-01T10:00:00.000Z", createdAt: nil)
    #expect(ConversationPaging.query(archived: false, search: "", after: last)
            == ["before": "2026-09-01T10:00:00.000Z", "beforeId": "c9"])
    let undated = Conversation(id: "c1", title: "x", archivedAt: nil, updatedAt: nil, createdAt: nil)
    #expect(ConversationPaging.query(archived: false, search: "", after: undated) == nil)
}

@Test func thisDeviceComesFirst() {
    let rows = [
        DeviceSession(id: "a", label: "iPad", createdAt: "", lastSeenAt: nil, current: false),
        DeviceSession(id: "b", label: "iPhone", createdAt: "", lastSeenAt: nil, current: true),
        DeviceSession(id: "c", label: "Mac", createdAt: "", lastSeenAt: nil, current: false),
    ]
    #expect(DeviceSession.currentFirst(rows).map(\.id) == ["b", "a", "c"])
}
