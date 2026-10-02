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
            Section("Saapuneet") {
                NavigationLink(value: Route.bankHub) {
                    HubRow(title: "Pankki", subtitle: "Saldot, tulot ja menot yhdellä silmäyksellä", symbol: "building.columns.fill")
                }
                NavigationLink(value: Route.emailInbox) {
                    HubRow(title: "Sähköposti", subtitle: "Sähköpostista haetut laskut ja arkisto", symbol: "envelope")
                }
            }
            Section("Joka viikko") {
                NavigationLink(value: Route.receipts) {
                    HubRow(title: "Kuitit", subtitle: counts.map { "\($0.all) kuittia" + (pending > 0 ? " · \(pending) odottaa" : "") } ?? "Kaikki kuitit ja niiden tila", symbol: "doc.text")
                }
                NavigationLink(value: Route.bankFeed) {
                    HubRow(title: "Pankkitapahtumat", subtitle: openRows > 0 ? "\(openRows) tapahtumaa vaatii toimia" : "Kohdista kuitit ja maksut", symbol: "list.bullet.rectangle")
                }
                NavigationLink(value: Route.purchaseInvoices) {
                    HubRow(title: "Ostolaskut", subtitle: "Saapuneet laskut ja niiden maksut", symbol: "tray.full")
                }
            }
            Section("Kuun lopussa") {
                NavigationLink(value: Route.periods) {
                    HubRow(title: "Kuukauden sulku", subtitle: "Tarkista ja lukitse valmiit kuukaudet", symbol: "lock.rectangle.stack")
                }
                NavigationLink(value: Route.alv("")) {
                    HubRow(title: "ALV-ilmoitus", subtitle: "Kauden arvonlisävero", symbol: "percent")
                }
            }
            Section("Pankki ja tiliotteet") {
                NavigationLink(value: Route.statements) {
                    HubRow(title: "Tiliotteet", subtitle: "Tuo tiliote ja selaa tiedostoja", symbol: "doc.plaintext")
                }
                NavigationLink(value: Route.bankAccounts) {
                    HubRow(title: "Pankkiyhteys ja tilit", subtitle: "Tilit, saldot ja pankkiyhteys", symbol: "building.columns")
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .navigationTitle("Kirjanpito")
        .refreshable { await load() }
        .task(id: app.dataVersion) {
            guard counts == nil || gate.isDue(version: app.dataVersion) else { return }
            // Marked only after a load that finished: a cancelled one must not count as fresh.
            let version = app.dataVersion
            await load()
            if !Task.isCancelled { gate.mark(version: version) }
        }
    }

    /// The three hub figures load side by side; the pending figure is a count query, not the receipt list.
    private func load() async {
        let api = app.api
        async let all: ReceiptCounts? = try? api.get("/api/receipts/counts")
        async let waiting: ReceiptCounts? = try? api.get("/api/receipts/counts", query: ["reviewStatus": "pending"])
        async let open: StatementOpenCount? = try? api.get("/api/statements/counts")
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
            VStack(alignment: .leading, spacing: 2) {
                Text(title).foregroundStyle(Theme.ink)
                Text(subtitle).font(.caption).foregroundStyle(Theme.ink2)
            }
        }
        .padding(.vertical, 2)
    }
}
