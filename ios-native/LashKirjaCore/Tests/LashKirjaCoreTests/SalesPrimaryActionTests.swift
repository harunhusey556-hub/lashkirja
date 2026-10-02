import Testing
import Foundation
@testable import LashKirjaCore

@Test func salesPrimaryActionDraftIsSend() {
    let action = InvoicePrimaryAction.for(status: .draft, open: 100, isCreditNote: false, reminderReady: false)
    #expect(action == .send)
    #expect(action?.title == "Lähetä lasku")
}

@Test func salesPrimaryActionSentAndOpenIsPayment() {
    let action = InvoicePrimaryAction.for(status: .sent, open: 50, isCreditNote: false, reminderReady: false)
    #expect(action == .payment)
    #expect(action?.title == "Kirjaa maksu")
}

@Test func salesPrimaryActionOverdueWithReminderReadyIsReminder() {
    let action = InvoicePrimaryAction.for(status: .overdue, open: 50, isCreditNote: false, reminderReady: true)
    #expect(action == .reminder)
    #expect(action?.title == "Lähetä maksumuistutus")
}

@Test func salesPrimaryActionOverdueWithoutReminderFallsBackToPayment() {
    #expect(InvoicePrimaryAction.for(status: .overdue, open: 50, isCreditNote: false, reminderReady: false) == .payment)
}

@Test func salesPrimaryActionNoneWhenSettledOrCreditNote() {
    #expect(InvoicePrimaryAction.for(status: .paid, open: 0, isCreditNote: false, reminderReady: false) == nil)
    #expect(InvoicePrimaryAction.for(status: .credited, open: 0, isCreditNote: false, reminderReady: false) == nil)
    #expect(InvoicePrimaryAction.for(status: .sent, open: 0, isCreditNote: false, reminderReady: false) == nil)
    #expect(InvoicePrimaryAction.for(status: .draft, open: -20, isCreditNote: true, reminderReady: false) == nil)
    #expect(InvoicePrimaryAction.for(status: .sent, open: -20, isCreditNote: true, reminderReady: false) == nil)
}
