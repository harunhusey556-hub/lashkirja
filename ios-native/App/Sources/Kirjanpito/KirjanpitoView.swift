import SwiftUI
import LashKirjaCore

struct KirjanpitoView: View {
    @Environment(AppModel.self) private var app
    @State private var counts: ReceiptCounts.Counts?
    @State private var pending = 0
    @State private var openRows = 0

    var body: some View {
        List {
            Section("Tapahtumat ja kuitit") {
                NavigationLink(value: Route.receipts) {
                    HubRow(title: "Kuitit", subtitle: counts.map { "\($0.all) kuittia" + (pending > 0 ? " · \(pending) odottaa" : "") } ?? "Kaikki kuitit ja niiden tila", symbol: "doc.text")
                }
                NavigationLink(value: Route.bankFeed) {
                    HubRow(title: "Pankki", subtitle: openRows > 0 ? "\(openRows) tapahtumaa vaatii toimia" : "Tiliotteet ja pankin tapahtumat", symbol: "list.bullet.rectangle")
                }
            }
            Section("Ostot") {
                NavigationLink(value: Route.purchaseInvoices) {
                    HubRow(title: "Ostolaskut", subtitle: "Saapuneet laskut ja niiden maksut", symbol: "tray.full")
                }
            }
            Section("Pankki") {
                NavigationLink(value: Route.bankAccounts) {
                    HubRow(title: "Pankkiyhteys ja tilit", subtitle: "Tilit, saldot ja pankkiyhteys", symbol: "building.columns")
                }
            }
            Section("Ilmoitukset ja kaudet") {
                NavigationLink(value: Route.alv("")) {
                    HubRow(title: "ALV-ilmoitus", subtitle: "Kuukauden arvonlisävero", symbol: "percent")
                }
                NavigationLink(value: Route.periods) {
                    HubRow(title: "Kaudet ja kuukauden sulku", subtitle: "Tarkista ja lukitse valmiit kaudet", symbol: "lock.rectangle.stack")
                }
                NavigationLink(value: Route.workQueue) {
                    HubRow(title: "Työt", subtitle: "Taustalla käsiteltävät tiedostot", symbol: "gearshape.2")
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .navigationTitle("Kirjanpito")
        .refreshable { await load() }
        .task(id: app.dataVersion) { await load() }
    }

    private func load() async {
        if let c: ReceiptCounts = try? await app.api.get("/api/receipts/counts") { counts = c.counts }
        if let p: ReceiptList = try? await app.api.get("/api/receipts", query: ["reviewStatus": "pending"]) { pending = p.count ?? p.receipts.count }
        if let s: StatementList = try? await app.api.get("/api/statements") {
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
