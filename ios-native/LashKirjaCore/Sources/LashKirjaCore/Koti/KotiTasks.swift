import Foundation

// MARK: Tarvitaan sinulta: each row's button and second line (web DashboardClient `itemTask`)

extension Koti {
    public enum TaskAction: Equatable, Sendable {
        /// One-tap Hyväksy, with the undo toast.
        case approve
        /// Täydennä: the approval sheet asks for what is missing first (FP-6).
        case complete
        case match
        case capture
        /// Muistuta: the reminder sheet of the invoice.
        case remind
        /// A label only: the row itself opens what it is about.
        case open(String)
        case none

        public var label: String? {
            switch self {
            case .approve: "Hyväksy"
            case .complete: "Täydennä"
            case .match: "Kohdista"
            case .capture: "Kuvaa kuitti"
            case .remind: "Muistuta"
            case .open(let label): label
            case .none: nil
            }
        }
    }

    public static func taskAction(_ item: DashboardItem, now: Date = Date()) -> TaskAction {
        switch item.kind {
        case .pendingReceipt: item.gaps.isEmpty ? .approve : .complete
        case .invoiceMatch: .match
        case .missingReceipt: .capture
        // A reminder certain to be refused is not offered: the invoice says when one may go.
        case .overdueInvoice: reminderWaits(item, now: now) ? .open("Avaa") : .remind
        case .vatGap: .open("Täydennä")
        default: .none
        }
    }

    /// The last reminder's term still runs (`nextReminderAt` is in the future).
    public static func reminderWaits(_ item: DashboardItem, now: Date = Date()) -> Bool {
        guard let at = item.nextReminderAt, let date = APIDate.instant(at) else { return false }
        return date > now
    }

    /// "Lasku 2 · myöhässä 3 päivää", with "· muistutettu" while a reminder's term runs.
    public static func overdueSubtitle(_ item: DashboardItem, now: Date = Date()) -> String {
        let days = item.daysLate ?? 0
        let base = "Lasku \(item.number ?? 0) · myöhässä \(days) \(days == 1 ? "päivä" : "päivää")"
        return reminderWaits(item, now: now) ? "\(base) · muistutettu" : base
    }

    /// What is missing, or the category and VAT the approval books; a credit note says it is one.
    public static func pendingSubtitle(_ item: DashboardItem) -> String {
        let credit: String? = (item.amount ?? 0) < 0 ? CreditNoteText.label : nil
        let rest: String
        if !item.gaps.isEmpty {
            rest = KotiApproval.gapText(item.gaps)
        } else {
            let rate = item.vatRate.map { "ALV \(ReceiptVat.rateLabel($0))" }
            // The label the Kuitit rows show ("Tarvikkeet & ostot"), not the stored id (X081).
            let parts = [item.category.map(ReceiptCategory.label(for:)), rate].compactMap { $0 }
            rest = parts.isEmpty ? "Tarkista luokka ja ALV" : parts.joined(separator: " · ")
        }
        return [credit, rest].compactMap { $0 }.joined(separator: " · ")
    }

    /// The row's figure: a receipt's total with its cash sign (`MoneyDirection`), a bank row's
    /// signed amount and an invoice's sum as the server sends them.
    public static func taskAmount(_ item: DashboardItem) -> Decimal? {
        guard let amount = item.amount else { return nil }
        switch item.kind {
        case .pendingReceipt, .vatGap: return MoneyDirection.receiptAmount(amount, isIncome: item.type == "tulo")
        default: return amount
        }
    }
}

// MARK: Tarvitaan sinulta beyond the server's rows (web DashboardClient `moreRows`, `buildAccountTasks`)

extension Koti {
    /// One row of the task list, in the list's order.
    public enum TaskEntry: Equatable, Sendable, Identifiable {
        case item(DashboardItem)
        /// "Näytä kaikki (N)": the server sends three of a kind; the rest are on the kind's own list.
        case showAll(DashboardItem.Kind, total: Int)
        /// "Pankkitilin saldo ei täsmää · Tarkista tiliotteet": accounts whose balance does not
        /// reconcile. Not one of the month's blocking tasks.
        case bankMismatch(accounts: Int)

        public var id: String {
            switch self {
            case .item(let item): item.id
            case .showAll(let kind, _): "more:\(kind.rawValue)"
            case .bankMismatch: "bank-mismatch"
            }
        }
    }

    /// The server's order of kinds (`api/dashboard/items.ts`): documents, then matches, then drafts,
    /// the non-blocking overdue invoices last.
    static let taskKinds: [DashboardItem.Kind] = [
        .pendingReceipt, .vatGap, .missingReceipt, .invoiceMatch, .receiptMatch, .paymentDuplicate, .draftInvoice, .overdueInvoice,
    ]

    /// The rows of Tarvitaan sinulta: each kind's rows followed by its "Näytä kaikki (N)" when the
    /// kind has more than is shown, then the bank-mismatch task (the current month only). `visible`
    /// is the server's rows less those the owner just acted on; those leave the totals too.
    public static func taskEntries(_ d: Dashboard, visible: [DashboardItem], atCurrentMonth: Bool) -> [TaskEntry] {
        var entries: [TaskEntry] = []
        for kind in taskKinds {
            let shown = visible.filter { $0.kind == kind }
            entries += shown.map(TaskEntry.item)
            let hidden = d.items.filter { $0.kind == kind }.count - shown.count
            let total = (d.itemTotals?[kind.rawValue] ?? 0) - hidden
            if total > shown.count { entries.append(.showAll(kind, total: total)) }
        }
        // A kind this app does not know yet keeps its rows, after the known ones.
        entries += visible.filter { !taskKinds.contains($0.kind) }.map(TaskEntry.item)
        if atCurrentMonth, let accounts = d.bank?.needsAttention, accounts > 0 {
            entries.append(.bankMismatch(accounts: accounts))
        }
        return entries
    }

    public static func showAllTitle(total: Int) -> String { "Näytä kaikki (\(total))" }

    /// What a kind's full list holds (web `KIND_LIST`).
    public static func showAllLabel(_ kind: DashboardItem.Kind) -> String {
        switch kind {
        case .overdueInvoice: "Myöhässä olevat laskut"
        case .pendingReceipt: "Hyväksyntää odottavat kuitit"
        case .vatGap: "Kuitit ilman ALV-erittelyä"
        case .missingReceipt: "Pankkitapahtumat ilman kuittia"
        case .invoiceMatch: "Laskujen maksut tiliotteella"
        case .receiptMatch: "Kohdistusehdotukset"
        case .paymentDuplicate: "Mahdolliset kaksoiskirjaukset"
        case .draftInvoice: "Lähettämättömät laskut"
        case .unknown: ""
        }
    }

    public static func bankMismatchTitle(accounts: Int) -> String {
        accounts == 1 ? "Pankkitilin saldo ei täsmää" : "\(accounts) pankkitilin saldo ei täsmää"
    }

    public static let bankMismatchSubtitle = "Tarkista tiliotteet"
    /// The pill: a label only, the row opens the accounts.
    public static let bankMismatchAction = "Tarkista"
}

// MARK: The approval sheet (web `ReceiptApprovalSheet`, `lib/receipt-approval.ts`)

public enum KotiApproval {
    /// The fields the sheet asks for, in the order it shows them.
    public enum Field: String, Sendable, CaseIterable { case vendor, amount, date, category, vat }

    /// "Lisää summa ja myyjä": the row's second line.
    public static func gapText(_ gaps: [String]) -> String {
        switch (gaps.contains("amount"), gaps.contains("vendor")) {
        case (true, true): "Lisää summa ja myyjä"
        case (true, false): "Lisää summa"
        case (false, true): "Lisää myyjä"
        case (false, false): ""
        }
    }

    public static func gapNote(_ gaps: [String]) -> String {
        "\(gapText(gaps)), ennen kuin kuitin voi hyväksyä."
    }

    public static func subtitle(type: String?, fromBank: Bool) -> String {
        if fromBank { return "Tunnistettu myynti pankkitililtä" }
        return type == "tulo" ? "Tulokuitti odottaa hyväksyntää" : "Kuitti odottaa hyväksyntää"
    }

    /// What the receipt lacks as loaded (the server's gaps included), plus any field a save
    /// refused. Decided from the loaded receipt, so a field does not vanish while it is typed in.
    public static func fields(baseline f: ReceiptForm, gaps: [String], errors: [String: String]) -> [Field] {
        func blank(_ s: String) -> Bool { s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        var wanted: Set<Field> = []
        if gaps.contains("vendor") || blank(f.vendor) || errors["vendor"] != nil { wanted.insert(.vendor) }
        if gaps.contains("amount") || blank(f.totalText) || errors["totalAmount"] != nil { wanted.insert(.amount) }
        if blank(f.date) || errors["date"] != nil { wanted.insert(.date) }
        if blank(f.category) || errors["category"] != nil { wanted.insert(.category) }
        if f.vatRows.isEmpty || errors.keys.contains(where: { $0.hasPrefix("vat-") }) { wanted.insert(.vat) }
        return Field.allCases.filter(wanted.contains)
    }
}

// MARK: ALV-raja (web :1118-1137)

extension Koti {
    public struct VatThresholdNotice: Equatable, Sendable {
        public let title: String
        public let body: String
        /// Over the threshold: the danger colour, not the warning one.
        public let exceeded: Bool
    }

    /// An owner outside the VAT register nearing (75 %) or past the registration threshold.
    public static func vatThreshold(_ d: Dashboard) -> VatThresholdNotice? {
        guard d.sectionErrors?["threshold"] == nil, let vat = d.vat, !vat.registered,
              vat.ytdRevenue >= vat.threshold * Decimal(string: "0.75")! else { return nil }
        let exceeded = vat.ytdRevenue >= vat.threshold
        let body = "Liikevaihtosi tänä vuonna on \(Money.format(vat.ytdRevenue)). Raja on \(Money.format(vat.threshold))."
            + (exceeded ? " Rekisteröidy OmaVerossa heti." : " Rekisteröidy hyvissä ajoin.")
        return VatThresholdNotice(title: exceeded ? "ALV-raja ylittynyt" : "ALV-raja lähestyy", body: body, exceeded: exceeded)
    }
}

// MARK: ALV-ilmoitus row of the status card (web `lib/vat-due.ts`, FP-4)

extension Koti {
    public static let vatDueTitle = "ALV-ilmoitus"

    /// The return the status card names: the next one due on the current month; on a past month
    /// the period that month closes (none for a quarterly filer's July). A period that ended
    /// before the account was opened (`accountCreatedMonth`) is not the owner's to file here.
    public static func vatDue(registered: Bool, atCurrentMonth: Bool, month: String, today: String, kind: String?,
                              accountCreatedMonth: String? = nil) -> KotiVatDue? {
        guard registered else { return nil }
        let key = atCurrentMonth
            ? VatDue.nextDueKey(today: today, kind: VatKind(profile: kind))
            : PeriodClose.vatPeriodEnding(in: month, kind: VatKind(profile: kind).rawValue)
        guard let due = key.flatMap(KotiVatDue.init(key:)) else { return nil }
        if let created = accountCreatedMonth, due.lastMonth < created { return nil }
        return due
    }

    /// "Elokuu 2026 · eräpäivä 12.10. · Ilmoittamatta"; without figures the state is left out.
    public static func vatDueSecondary(_ due: KotiVatDue, _ figures: VatDueFigures?) -> String {
        var parts = [due.label]
        if figures?.isRefund == true { parts.append("palautus") }
        parts.append("eräpäivä \(VatDue.dueDateText(due.dueIso, periodYear: due.periodYear))")
        if let vat = figures?.vat {
            parts.append(VatFiling.stateLabel(vat.state, nothingToPay: vat.nothingToPay))
            if vat.changedSinceFiling { parts.append("muuttunut ilmoituksen jälkeen") }
        }
        return parts.joined(separator: " · ")
    }

    /// The warnings under the row: figures moved after filing (F66), receipts still pending (TF-11).
    public static func vatDueNotes(_ figures: VatDueFigures?) -> [String] {
        guard let figures else { return [] }
        var notes: [String] = []
        if figures.vat.changedSinceFiling, let filed = figures.filedAmount {
            notes.append(PeriodClose.vatChangedNote(filedAmount: filed, amount: figures.amount, isRefund: figures.isRefund))
        }
        if let pending = VatFiling.pendingNote(figures.pendingReceiptCount) { notes.append(pending) }
        return notes
    }
}
