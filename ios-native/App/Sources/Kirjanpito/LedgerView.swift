import SwiftUI
import LashKirjaCore

/// Kirjanpito: tuloslaskelma, tase, saldoluettelo and päiväkirja of one fiscal year, read from
/// `/api/ledger` (the books derived from the documents). Read only, like the web page.
struct LedgerView: View {
    @Environment(AppModel.self) private var app
    @State private var year = Calendar.current.component(.year, from: Date())
    @State private var part: Part = .income
    @State private var state = ScreenLoad<LedgerBooks>()
    @State private var loadGeneration = 0

    enum Part: String, CaseIterable, Identifiable {
        case income = "Tulos", sheet = "Tase", trial = "Saldot", journal = "Päiväkirja"
        var id: String { rawValue }
    }

    var body: some View {
        List {
            Section {
                Picker("Tilikausi", selection: $year) {
                    ForEach(yearChoices, id: \.self) { Text(String($0)).tag($0) }
                }
                Picker("Näkymä", selection: $part) {
                    ForEach(Part.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
            }
            if let books = state.value {
                if let banner = state.banner {
                    Section { RefreshFailureBanner(failure: banner, retry: load) }
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                }
                notes(books)
                switch part {
                case .income: income(books.incomeStatement)
                case .sheet: sheet(books.balanceSheet)
                case .trial: trial(books.trialBalance)
                case .journal: journal(books.journal)
                }
            } else {
                Section { ScreenStateView(state: state, retry: load) { _ in EmptyView() } }
                    .listRowBackground(Color.clear)
            }
        }
        .navigationTitle("Kirjanpito")
        .refreshable { await load() }
        .task(id: year) {
            state.restart()
            await load()
        }
    }

    private var yearChoices: [Int] {
        let now = Calendar.current.component(.year, from: Date())
        return [now, now - 1, now - 2]
    }

    @ViewBuilder private func notes(_ books: LedgerBooks) -> some View {
        Section {
            if !books.notes.balances {
                Text("Tase ei täsmää. Ilmoita tästä tukeen.").foregroundStyle(Theme.danger)
            }
            if books.notes.openingBalanceMissing {
                Text("Kirjanpito alkaa ensimmäisestä tositteesta: avaavaa tasetta ei ole vielä kirjattu.")
                    .font(.footnote).foregroundStyle(Theme.ink2)
            }
            if books.notes.suspenseCents > 0 {
                Text("\(Money.format(LedgerBooks.euros(books.notes.suspenseCents))) ostoja ei ole maksettu yritystililtä (selvittelytili 2990).")
                    .font(.footnote).foregroundStyle(Theme.warning)
            }
        }
    }

    private func row(_ line: LedgerBooks.Line) -> some View {
        LabeledContent { MoneyText(amount: LedgerBooks.euros(line.cents)) } label: {
            Text("\(line.code) \(line.name)")
        }
        .font(.subheadline)
    }

    private func total(_ title: String, _ cents: Int) -> some View {
        LabeledContent(title) { MoneyText(amount: LedgerBooks.euros(cents)) }.font(.subheadline.weight(.semibold))
    }

    @ViewBuilder private func income(_ statement: LedgerBooks.Income) -> some View {
        Section("Tuotot") {
            ForEach(statement.revenue) { row($0) }
            total("Tuotot yhteensä", statement.revenueCents)
        }
        Section("Kulut") {
            ForEach(statement.expenses) { row($0) }
            total("Kulut yhteensä", statement.expensesCents)
        }
        Section { total("Tilikauden tulos", statement.resultCents) }
    }

    @ViewBuilder private func sheet(_ sheet: LedgerBooks.Sheet) -> some View {
        Section("Vastaavaa") {
            ForEach(sheet.assets) { row($0) }
            total("Vastaavaa yhteensä", sheet.assetsCents)
        }
        Section("Vastattavaa") {
            ForEach(sheet.equity) { row($0) }
            ForEach(sheet.liabilities) { row($0) }
            total("Vastattavaa yhteensä", sheet.liabilitiesAndEquityCents)
        }
    }

    @ViewBuilder private func trial(_ rows: [LedgerBooks.TrialRow]) -> some View {
        Section {
            ForEach(rows) { row in
                LabeledContent { MoneyText(amount: LedgerBooks.euros(row.balanceCents), signed: true) } label: {
                    Text("\(row.code) \(row.name)")
                }
                .font(.subheadline)
            }
        } footer: {
            Text("Saldo = debet − kredit.")
        }
    }

    @ViewBuilder private func journal(_ entries: [LedgerBooks.Entry]) -> some View {
        Section {
            if entries.isEmpty { Text("Ei tositteita tällä tilikaudella.").foregroundStyle(Theme.ink2) }
            ForEach(entries) { entry in
                VStack(alignment: .leading, spacing: 4) {
                    Text(LedgerBooks.voucherTitle(entry)).font(.caption).foregroundStyle(Theme.ink2)
                    Text(entry.description).font(.subheadline)
                    ForEach(entry.lines, id: \.account) { line in
                        HStack {
                            Text(line.account).monospacedDigit()
                            Spacer()
                            Text(line.debitCents > 0 ? "Debet \(Money.format(LedgerBooks.euros(line.debitCents)))"
                                                     : "Kredit \(Money.format(LedgerBooks.euros(line.creditCents)))")
                                .monospacedDigit()
                        }
                        .font(.caption).foregroundStyle(Theme.ink2)
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    private func load() async {
        let asked = year
        loadGeneration += 1
        let mine = loadGeneration
        state.begin()
        do {
            let books: LedgerBooks = try await app.api.get("/api/ledger", query: ["year": String(asked)])
            guard asked == year, mine == loadGeneration else { return }
            state.succeed(books)
        } catch is CancellationError {
        } catch {
            guard asked == year, mine == loadGeneration else { return }
            state.fail(error)
        }
    }
}
