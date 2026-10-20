import SwiftUI
import LashKirjaCore

struct KirjanpitoView: View {
    @Environment(AppModel.self) private var app
    @State private var counts: ReceiptCounts.Counts?
    @State private var pending = 0
    @State private var openRows = 0
    /// Coming back to the screen does not ask the server again unless something changed.
    @State private var gate = ReloadGate()

    var body: some View {
        List {
            // Pankki opens the bank rows themselves (O2: a hub between them was one tap more);
            // Tiliotteet and Pankkiyhteys open from there. Its row carries the open count.
            Section("Joka viikko") {
                NavigationLink(value: Route.bankFeed) {
                    HubRow(title: "Pankki", subtitle: openRows > 0 ? "\(openRows) tapahtumaa vaatii toimia" : "Tapahtumat, saldot ja tiliotteet", symbol: "building.columns.fill")
                }
                NavigationLink(value: Route.receipts) {
                    HubRow(title: "Kuitit", subtitle: counts.map { "\($0.all) kuittia" + (pending > 0 ? " · \(pending) odottaa" : "") } ?? "Kaikki kuitit ja niiden tila", symbol: "doc.text")
                }
                NavigationLink(value: Route.emailInbox) {
                    HubRow(title: "Sähköposti", subtitle: "Sähköpostista haetut laskut ja arkisto", symbol: "envelope")
                }
                NavigationLink(value: Route.purchaseInvoices) {
                    HubRow(title: "Ostolaskut", subtitle: "Saapuneet laskut ja niiden maksut", symbol: "tray.full")
                }
            }
            // The two matchings the web reaches from its tabs: receipts to bank rows, and bank
            // payments to purchase invoices (its own screen, as the web's kohdistus page).
            Section("Kohdistus") {
                NavigationLink(value: Route.bankFeedFiltered(month: nil, onlyOpen: true, focus: nil)) {
                    HubRow(title: "Kohdista kuitit", subtitle: "Pankkitapahtumat, joille puuttuu kuitti", symbol: "link")
                }
                NavigationLink(value: Route.purchaseMatch) {
                    HubRow(title: "Kohdista ostolaskujen maksut", subtitle: "Pankkimaksut ostolaskuille", symbol: "creditcard")
                }
            }
            Section("Kuun lopussa") {
                NavigationLink(value: Route.periods) {
                    HubRow(title: "Kuukauden sulku", subtitle: "Tarkista ja lukitse valmiit kuukaudet", symbol: "lock.rectangle.stack")
                }
                NavigationLink(value: Route.alv("")) {
                    HubRow(title: "ALV-ilmoitus", subtitle: "Kauden arvonlisävero", symbol: "percent")
                }
                NavigationLink(value: Route.ledger) {
                    // Not "Kirjanpito": that is this tab's own name (X180).
                    HubRow(title: "Tulos ja tase", subtitle: "Tuloslaskelma, tase ja päiväkirja", symbol: "book.closed")
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .navigationTitle("Kirjanpito")
        .refreshable {
            // Pull-to-refresh asks every screen again; this one's own load stands for the bump.
            gate.mark(version: app.refreshEverything())
            await load()
        }
        .perfReady("kirjanpito", counts != nil)
        .task(id: app.dataVersion) {
            // Kuukauden sulku's, ALV-ilmoitus's and Ostolaskut's first screens, warmed so they open on their content.
            let app = self.app
            Task {
                let month = PeriodClose.startMonth(nil, current: MonthKey.current())
                _ = try? await app.cachedGet("/api/dashboard/month", query: ["month": month]) as PeriodMonthStatus
                _ = try? await app.cachedGet("/api/period-lock") as PeriodLockState
                // The return AlvView opens on with no period given (its F13 rule).
                let vatKind = VatKind(profile: await app.cachedProfile()?.vatPeriod)
                let vatPeriod = VatDue.nextDueKey(today: APIDate.dayString(Date()), kind: vatKind)
                _ = try? await app.cachedGet("/api/alv", query: ["period": vatPeriod]) as AlvReport
                // Ostolaskut's first screen (no chip): the rows above its list first, so a cached
                // list always has them (Ostolaskut paints from the cache only with them).
                _ = try? await app.cachedGet("/api/purchase-invoices/counts") as PurchaseInvoiceCountsResponse
                _ = try? await app.cachedGet("/api/recurring-purchases") as RecurringPurchaseList
                _ = try? await app.cachedGet("/api/purchase-invoices/match") as PurchaseSuggestionList
                _ = try? await app.cachedGet("/api/purchase-invoices", persist: true) as PurchaseInvoiceTaggedList
            }
            guard counts == nil || gate.isDue(version: app.dataVersion) else { return }
            // Marked only after a load that finished: a cancelled one must not count as fresh.
            let version = app.dataVersion
            await load()
            if !Task.isCancelled { gate.mark(version: version) }
        }
    }

    /// The three hub figures load side by side; the pending figure is a count query, not the receipt list.
    /// Through the app's cache, which the launch prefetch filled: the last figures at once, the
    /// server's in place when they are stale.
    private func load() async {
        let api = app.api
        // Kuitit only: a bill filed as an ostolasku is counted under Ostolaskut.
        let allQuery = ReceiptListQuery().countsQuery()
        if counts == nil {
            if let c: ReceiptCounts = await app.cachedValue("/api/receipts/counts", query: allQuery) { counts = c.counts }
            if let p: ReceiptCounts = await app.cachedValue("/api/receipts/counts", query: ReceiptListQuery.pendingCountQuery) { pending = p.counts.all }
            if let o: StatementOpenCount = await app.cachedValue("/api/statements/counts") { openRows = o.open }
        }
        async let all: ReceiptCounts? = try? app.cachedGet("/api/receipts/counts", query: allQuery)
        async let waiting: ReceiptCounts? = try? app.cachedGet("/api/receipts/counts", query: ReceiptListQuery.pendingCountQuery)
        async let open: StatementOpenCount? = try? app.cachedGet("/api/statements/counts")
        if let c = await all { counts = c.counts }
        if let p = await waiting { pending = p.counts.all }
        if let o = await open {
            openRows = o.open
        } else if let s: StatementList = try? await api.get("/api/statements") {
            // A server without the count route: the full feed, as before.
            openRows = BankFeed.months(s.statements).reduce(0) { $0 + $1.open }
        }
    }
}

struct HubRow: View {
    let title: String
    let subtitle: String
    let symbol: String
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .foregroundStyle(Theme.accent)
                .frame(width: 34, height: 34)
                .background(Theme.accentSoft, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).foregroundStyle(Theme.ink)
                Text(subtitle).font(.caption).foregroundStyle(Theme.ink2)
            }
        }
        .padding(.vertical, 2)
    }
}

/// One chip of a "one group at a time" row (months, statuses, checklist steps), styled as Myynti's chips.
struct SectionChip: View {
    let title: String
    var count: Int? = nil
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button {
            action()
            Haptics.selection()
        } label: {
            HStack(spacing: 4) {
                Text(title)
                if let count {
                    Text("\(count)").monospacedDigit().foregroundStyle(selected ? Theme.onInk.opacity(0.8) : Theme.ink2)
                }
            }
            .font(.subheadline.weight(selected ? .semibold : .regular))
            .foregroundStyle(selected ? Theme.onInk : Theme.ink)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(selected ? Theme.ink : Theme.surface, in: Capsule())
            .overlay(Capsule().stroke(Theme.line, lineWidth: selected ? 0 : 1))
        }
        .buttonStyle(.pressable)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
