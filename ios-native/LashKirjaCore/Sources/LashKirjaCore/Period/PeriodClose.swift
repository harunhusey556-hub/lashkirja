import Foundation

/// `GET /api/dashboard/month?month=YYYY-MM`: the month close checklist.
public struct PeriodMonthStatus: Decodable, Sendable {
    public struct Progress: Decodable, Sendable { public let matchable: Int; public let matched: Int; public let suggested: Int }

    public let month: String
    public let ended: Bool
    public let locked: Bool
    public let lockedThrough: String?
    public let items: [DashboardItem]
    public let totals: [String: Int]
    public let blockingTotal: Int
    public let progress: Progress
    public let hasStatement: Bool
    public let receiptCount: Int
    public let invoiceCount: Int
    public let hasContent: Bool
    public let vatRegistered: Bool
    public let vatPeriod: String

    enum CodingKeys: String, CodingKey {
        case month, ended, locked, lockedThrough, items, totals, blockingTotal, progress, hasStatement
        case receiptCount, invoiceCount, hasContent, vatRegistered, vatPeriod
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        month = try c.decode(String.self, forKey: .month)
        ended = try c.decodeIfPresent(Bool.self, forKey: .ended) ?? false
        locked = try c.decodeIfPresent(Bool.self, forKey: .locked) ?? false
        lockedThrough = try c.decodeIfPresent(String.self, forKey: .lockedThrough)
        items = try c.decodeIfPresent([DashboardItem].self, forKey: .items) ?? []
        totals = try c.decodeIfPresent([String: Int].self, forKey: .totals) ?? [:]
        blockingTotal = try c.decodeIfPresent(Int.self, forKey: .blockingTotal) ?? 0
        progress = try c.decodeIfPresent(Progress.self, forKey: .progress) ?? Progress(matchable: 0, matched: 0, suggested: 0)
        hasStatement = try c.decodeIfPresent(Bool.self, forKey: .hasStatement) ?? false
        receiptCount = try c.decodeIfPresent(Int.self, forKey: .receiptCount) ?? 0
        invoiceCount = try c.decodeIfPresent(Int.self, forKey: .invoiceCount) ?? 0
        hasContent = try c.decodeIfPresent(Bool.self, forKey: .hasContent) ?? false
        vatRegistered = try c.decodeIfPresent(Bool.self, forKey: .vatRegistered) ?? false
        vatPeriod = try c.decodeIfPresent(String.self, forKey: .vatPeriod) ?? "month"
    }

    public func count(_ kinds: [String]) -> Int { kinds.reduce(0) { $0 + (totals[$1] ?? 0) } }
    public func items(_ kinds: [String]) -> [DashboardItem] { items.filter { kinds.contains($0.kind.rawValue) } }
}

/// The month close screen's words and verdicts (lib/month-close.ts and the kuukausi page).
public enum PeriodClose {
    public enum StepState: Equatable, Sendable { case done, open, none }

    public struct Step: Identifiable, Sendable {
        public let key: String
        public let title: String
        public let symbol: String
        public let state: StepState
        public let text: String
        public let items: [DashboardItem]
        public var id: String { key }
    }

    public enum VatState: Equatable, Sendable { case open, filed, paid }

    public struct Vat: Equatable, Sendable {
        public var state: VatState
        public var done: Bool
        public var changedSinceFiling: Bool
        public var nothingToPay: Bool
        public init(state: VatState, done: Bool, changedSinceFiling: Bool, nothingToPay: Bool) {
            self.state = state
            self.done = done
            self.changedSinceFiling = changedSinceFiling
            self.nothingToPay = nothingToPay
        }
    }

    public struct Facts: Equatable, Sendable {
        public var ended: Bool
        public var locked: Bool
        public var blocking: Int
        public var hasContent: Bool
        public var hasStatement: Bool
        public var vat: Vat?
        public init(ended: Bool, locked: Bool, blocking: Int, hasContent: Bool, hasStatement: Bool, vat: Vat?) {
            self.ended = ended
            self.locked = locked
            self.blocking = blocking
            self.hasContent = hasContent
            self.hasStatement = hasStatement
            self.vat = vat
        }
    }

    public static let receiptKinds = ["pending_receipt"]
    public static let vatGapKinds = ["vat_gap"]
    public static let bankKinds = ["missing_receipt", "receipt_match", "invoice_match", "payment_duplicate"]
    public static let invoiceKinds = ["draft_invoice"]

    static func plural(_ count: Int, _ one: String, _ many: String) -> String { "\(count) \(count == 1 ? one : many)" }

    public static func stepState(open: Int, hasItems: Bool) -> StepState {
        if open > 0 { return .open }
        return hasItems ? .done : .none
    }

    public static func steps(_ s: PeriodMonthStatus) -> [Step] {
        func make(_ key: String, _ title: String, _ symbol: String, _ state: StepState, done: String, open: String, none: String, _ kinds: [String]) -> Step {
            Step(key: key, title: title, symbol: symbol, state: state,
                 text: state == .done ? done : state == .open ? open : none, items: s.items(kinds))
        }
        var steps: [Step] = []
        let receipts = s.count(receiptKinds)
        steps.append(make("receipts", "Kuitit", "tag", stepState(open: receipts, hasItems: s.receiptCount > 0),
                          done: "Kaikki kuitit on hyväksytty",
                          open: "\(plural(receipts, "kuitti odottaa", "kuittia odottaa")) hyväksyntää",
                          none: "Ei kuitteja tässä kuussa", receiptKinds))
        let gaps = s.count(vatGapKinds)
        if gaps > 0 {
            steps.append(make("vat", "ALV-erittely", "percent", .open, done: "",
                              open: "\(plural(gaps, "kuitti", "kuittia")) ilman ALV-erittelyä", none: "", vatGapKinds))
        }
        let bank = s.count(bankKinds)
        steps.append(make("bank", "Pankkitapahtumat", "arrow.left.arrow.right",
                          stepState(open: bank, hasItems: s.hasStatement && s.progress.matchable > 0),
                          done: "\(s.progress.matched) / \(s.progress.matchable) pankkitapahtumaa kunnossa",
                          open: "\(plural(bank, "pankkitapahtuma", "pankkitapahtumaa")) kesken",
                          none: s.hasStatement ? "Tiliotteella ei ole kirjattavia tapahtumia" : "Tiliotetta ei ole tuotu", bankKinds))
        let invoices = s.count(invoiceKinds)
        steps.append(make("invoices", "Myyntilaskut", "doc.badge.ellipsis", stepState(open: invoices, hasItems: s.invoiceCount > 0),
                          done: "Ei lähettämättömiä laskuja",
                          open: "\(plural(invoices, "lasku", "laskua")) lähettämättä",
                          none: "Ei laskuja tässä kuussa", invoiceKinds))
        return steps
    }

    /// The checklist row's second line, as on the web.
    public static func secondary(_ item: DashboardItem) -> String {
        let number = item.number.map(String.init) ?? ""
        switch item.kind {
        case .pendingReceipt:
            if item.gaps.contains("amount") && item.gaps.contains("vendor") { return "Lisää summa ja myyjä" }
            if item.gaps.contains("amount") { return "Lisää summa" }
            if item.gaps.contains("vendor") { return "Lisää myyjä" }
            return "Odottaa hyväksyntää"
        case .vatGap:
            return item.type == "meno" ? "ALV-erittely puuttuu · vähennys jää pois" : "ALV-erittely puuttuu · ei mukana ALV:ssa"
        case .missingReceipt:
            guard let date = item.date, let day = APIDate.day(String(date.prefix(10))) else { return "Kuitti puuttuu" }
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = TimeZone(identifier: "Europe/Helsinki")!
            let parts = calendar.dateComponents([.day, .month], from: day)
            return "Kuitti puuttuu · \(parts.day ?? 0).\(parts.month ?? 0)."
        case .receiptMatch: return "Kohdistusehdotus · tarkista"
        case .invoiceMatch: return "Maksu laskulle \(number)? Kohdista"
        case .paymentDuplicate: return "Sama tulo kahdesti? Lasku \(number)"
        case .draftInvoice: return "Lasku \(number) · lähettämättä"
        case .overdueInvoice, .unknown: return ""
        }
    }

    /// The VAT step from the return's filing marks (lib/vat-due.ts). `filedAmount` is field 308 as
    /// it was filed, signed (negative = refund): once filed, it decides what is owed, and a live figure
    /// that moved away from it means the return may need correcting, so the step is not done (F66).
    public static func vat(filedAt: String?, paidAt: String?, filedAmount: Decimal? = nil, amount: Decimal, isRefund: Bool) -> Vat {
        let state: VatState = paidAt != nil ? .paid : filedAt != nil ? .filed : .open
        let filed = filedAt != nil ? filedAmount : nil
        let nothingToPay = filed.map { $0 <= 0 } ?? (isRefund || amount <= 0)
        let changed = changedSinceFiling(filed: filed, amount: amount, isRefund: isRefund)
        let done = !changed && (state == .paid || (state == .filed && nothingToPay))
        return Vat(state: state, done: done, changedSinceFiling: changed, nothingToPay: nothingToPay)
    }

    static func changedSinceFiling(filed: Decimal?, amount: Decimal, isRefund: Bool) -> Bool {
        guard let filed else { return false }
        return cents(isRefund ? -amount : amount) != cents(filed)
    }

    private static func cents(_ value: Decimal) -> Decimal {
        var scaled = value * 100
        var rounded = Decimal()
        NSDecimalRound(&rounded, &scaled, 0, .plain)
        return rounded
    }

    /// "Luvut ovat muuttuneet ilmoituksen jälkeen: ilmoitettu 159,38 €, nyt 170,00 €."
    public static func vatChangedNote(filedAmount: Decimal, amount: Decimal, isRefund: Bool) -> String {
        func signed(_ value: Decimal) -> String { value < 0 ? "palautus \(Money.format(-value))" : Money.format(value) }
        return "Luvut ovat muuttuneet ilmoituksen jälkeen: ilmoitettu \(signed(filedAmount)), nyt \(signed(isRefund ? -amount : amount))."
    }

    /// The VAT period key that ends with `month`, or nil when the month closes none.
    public static func vatPeriodEnding(in month: String, kind: String?) -> String? {
        let m = Int(month.suffix(2)) ?? 0
        switch kind {
        case "quarter": return m % 3 == 0 ? VatPeriod.key(for: month, kind: "quarter") : nil
        case "year": return m == 12 ? String(month.prefix(4)) : nil
        default: return month
        }
    }

    public static func defaultMonth(current: String) -> String { MonthKey.shift(current, by: -1) }

    public static func subtitle(_ f: Facts) -> String {
        if f.locked { return "Kuukausi on suljettu." }
        if !f.ended { return "Kuukausi on vielä kesken." }
        if f.blocking > 0 { return "\(plural(f.blocking, "asia", "asiaa")) kesken" }
        if !f.hasContent { return "Ei kirjattavaa tässä kuussa." }
        if f.vat?.changedSinceFiling == true { return "ALV-luvut ovat muuttuneet ilmoituksen jälkeen. Tarkista ne." }
        if !f.hasStatement { return "Tiliote puuttuu. Tuo se ennen sulkemista." }
        if let vat = f.vat, !vat.done {
            return vat.state == .filed
                ? "Kirjaukset on tehty. ALV on ilmoitettu, mutta ei vielä maksettu."
                : "Kirjaukset on tehty. ALV-ilmoitus on vielä tekemättä."
        }
        return "Kaikki kirjattu. Voit sulkea kuukauden."
    }

    /// Why the close button is disabled, or nil when it is enabled.
    public static func button(_ f: Facts) -> String? {
        if !f.ended { return "Kuukauden voi sulkea, kun se on päättynyt." }
        if !f.hasContent && f.blocking == 0 { return "Tässä kuussa ei ole kirjattavaa." }
        return nil
    }

    public static func warnings(_ f: Facts) -> [String] {
        var lines: [String] = []
        if f.blocking > 0 { lines.append("\(plural(f.blocking, "asia", "asiaa")) on vielä kesken.") }
        if !f.hasStatement && f.hasContent { lines.append("Tiliotetta ei ole tuotu.") }
        if f.vat?.changedSinceFiling == true { lines.append("ALV-luvut ovat muuttuneet ilmoituksen jälkeen.") }
        else if let vat = f.vat, !vat.done {
            lines.append(vat.state == .filed ? "ALV:ta ei ole merkitty maksetuksi." : "ALV-ilmoitusta ei ole merkitty annetuksi.")
        }
        return lines
    }

    /// The calm "{Kuukausi} on valmis." moment: closed and every part in order.
    public static func complete(_ f: Facts) -> Bool {
        guard f.locked, f.ended else { return false }
        if f.blocking > 0 || !f.hasContent || !f.hasStatement { return false }
        if let vat = f.vat, vat.changedSinceFiling || !vat.done { return false }
        return true
    }

    /// The confirm dialog text for closing `month` (lock through it).
    public static func confirmMessage(_ f: Facts, earlierOpen: Bool) -> String {
        var lines = warnings(f)
        lines.append("Kuukausi suljetaan: sen kuitteja, laskuja ja pankkitapahtumia ei voi enää muuttaa.")
        if earlierOpen { lines.append("Myös aiemmat sulkemattomat kuukaudet suljetaan.") }
        return lines.joined(separator: " ")
    }
}
