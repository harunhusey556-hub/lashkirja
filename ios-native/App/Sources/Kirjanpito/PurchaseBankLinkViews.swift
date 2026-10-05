import SwiftUI
import LashKirjaCore

/// One purchase invoice and one bank row about to be joined: what the confirm step shows.
struct PurchaseLinkPair: Hashable {
    let invoiceId: String
    let supplierName: String
    let invoiceNumber: String?
    let open: Decimal
    let transactionId: String
    let bankTitle: String
    let bankDate: String?
    /// What the row paid, positive.
    let bankAmount: Decimal
    let why: String?

    init(invoice: PurchaseInvoice, row: PurchaseBankCandidate) {
        invoiceId = invoice.id
        supplierName = invoice.supplierName
        invoiceNumber = invoice.invoiceNumber
        open = invoice.open
        transactionId = row.transactionId
        bankTitle = row.title
        bankDate = row.date
        bankAmount = row.amount
        why = row.why
    }

    init(candidate: PurchaseInvoiceCandidate, row: BankTransaction) {
        invoiceId = candidate.invoice.id
        supplierName = candidate.title
        invoiceNumber = candidate.invoice.invoiceNumber
        open = candidate.invoice.open
        transactionId = row.id
        bankTitle = row.title
        bankDate = row.date
        bankAmount = abs(row.amount)
        why = candidate.why
    }
}

/// The confirm step of "Kohdista": the pair, the amount to record (editable for a partial payment), and "Kohdista".
struct PurchaseLinkConfirmView: View {
    @Environment(AppModel.self) private var app
    let pair: PurchaseLinkPair
    let onDone: (PurchaseInvoice) -> Void

    @State private var amountText = ""
    @State private var busy = false
    @State private var failure: String?
    @State private var key = UUID().uuidString

    var body: some View {
        Form {
            Section("Ostolasku") {
                LabeledContent("Toimittaja", value: pair.supplierName)
                if let number = pair.invoiceNumber, !number.isEmpty {
                    LabeledContent("Laskun numero", value: number)
                }
                LabeledContent("Avoinna") { MoneyText(amount: pair.open) }
            }
            Section {
                LabeledContent("Saaja", value: pair.bankTitle)
                if let date = pair.bankDate {
                    LabeledContent("Päivä", value: APIDate.displayDay(date))
                }
                LabeledContent("Summa") { MoneyText(amount: pair.bankAmount) }
                if let why = pair.why {
                    Text(why).font(.caption).foregroundStyle(Theme.ink2)
                }
            } header: {
                Text("Pankkitapahtuma")
            } footer: {
                if let note = PurchaseBankLink.differenceNote(bankAmount: pair.bankAmount, open: pair.open) {
                    Text(note)
                }
            }
            Section {
                LabeledContent("Kirjattava summa (€)") {
                    TextField("124,00", text: $amountText)
                        .moneyInput()
                        .multilineTextAlignment(.trailing)
                }
            } footer: {
                if let amount = Money.parse(amountText), amount > 0 {
                    Text(PurchaseBankLink.outcome(amount: amount, open: pair.open))
                }
            }
            if let failure {
                Section { Text(failure).foregroundStyle(Theme.danger) }
            }
            Section {
                Button { Task { await save() } } label: {
                    if busy { ProgressView() } else { Text("Kohdista") }
                }
                .buttonStyle(.primary)
                .disabled(busy)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            }
        }
        .formKeyboard()
        .navigationTitle("Vahvista kohdistus")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            if amountText.isEmpty {
                amountText = PurchaseInvoiceForm.amountText(PurchaseBankLink.defaultAmount(bankAmount: pair.bankAmount, open: pair.open))
            }
        }
    }

    private func save() async {
        if let problem = PurchaseBankLink.problem(amountText: amountText, bankAmount: pair.bankAmount) {
            failure = problem
            Haptics.error()
            return
        }
        guard !busy, let amount = Money.parse(amountText) else { return }
        busy = true
        failure = nil
        defer { busy = false }
        do {
            // The payment is dated as the bank dated the row.
            let body = PurchasePaymentBody(
                amount: amount,
                paidDate: pair.bankDate ?? APIDate.dayString(Date()),
                transactionId: pair.transactionId
            )
            let response: PurchaseInvoiceResponse = try await app.api.send(
                "POST", "/api/purchase-invoices/\(pair.invoiceId)/payments", body: body, idempotencyKey: key
            )
            Haptics.success()
            app.dataVersion += 1
            onDone(response.invoice)
        } catch is CancellationError {
        } catch {
            Haptics.error()
            failure = error.userMessage
        }
    }
}

/// Ostolasku → "Kohdista pankkitapahtumaan": the bank rows that may have paid it, best first.
struct PurchaseBankLinkSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let invoice: PurchaseInvoice
    var onLinked: (PurchaseInvoice) -> Void = { _ in }

    @State private var state = ScreenLoad<PurchaseBankCandidateList>()
    @State private var search = ""
    @State private var month: String?
    @State private var limit = ShowMore()
    @State private var target: PurchaseLinkPair?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    LabeledContent(invoice.supplierName) { MoneyText(amount: invoice.open).fontWeight(.semibold) }
                } footer: {
                    Text("Valitse pankkitapahtuma, jolla tämä ostolasku maksettiin. Parhaat osumat ovat ylimpänä.")
                }
                switch state.display {
                case .content(let list):
                    if let banner = state.banner {
                        Section { RefreshFailureBanner(failure: banner, retry: load) }
                            .listRowBackground(Color.clear)
                            .listRowInsets(EdgeInsets())
                    }
                    content(list)
                case .failed(let failure):
                    Section { LoadFailureView(failure: failure, retry: load) }
                        .listRowBackground(Color.clear)
                case .loading:
                    ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.canvas)
            .searchable(text: $search, prompt: "Nimi, viesti tai summa")
            .navigationTitle("Kohdista pankkitapahtumaan")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Sulje") { dismiss() } }
            }
            .task(id: "\(search)|\(month ?? "")") {
                // Typing settles before the server is asked again.
                if !search.isEmpty { try? await Task.sleep(nanoseconds: 350_000_000) }
                guard !Task.isCancelled else { return }
                await load()
            }
            .navigationDestination(item: $target) { pair in
                PurchaseLinkConfirmView(pair: pair) { updated in
                    onLinked(updated)
                    dismiss()
                }
            }
        }
        .presentationDetents([.large])
    }

    @ViewBuilder
    private func content(_ list: PurchaseBankCandidateList) -> some View {
        if list.showsMonthChips || month != nil {
            Section {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        SectionChip(title: "Kaikki", selected: month == nil) { pick(nil) }
                        ForEach(list.months) { option in
                            SectionChip(title: monthTitle(option.month), count: option.count, selected: month == option.month) {
                                pick(option.month)
                            }
                        }
                    }
                    .padding(.vertical, 4)
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            }
        }
        if list.candidates.isEmpty {
            Section {
                ContentUnavailableView {
                    Label(search.isEmpty ? "Ei sopivia pankkitapahtumia" : "Ei osumia", systemImage: "building.columns")
                } description: {
                    Text(search.isEmpty
                         ? "Lähteviä maksuja, joita ei ole vielä kohdistettu, ei löytynyt laskun ajalta. Hae nimellä tai summalla."
                         : "Kokeile toista hakusanaa tai summaa.")
                }
            }
            .listRowBackground(Color.clear)
        } else {
            Section {
                ForEach(list.candidates.prefix(limit.visible(list.candidates.count))) { candidate in
                    Button { target = PurchaseLinkPair(invoice: invoice, row: candidate) } label: {
                        PurchaseBankCandidateRow(candidate: candidate)
                    }
                    .buttonStyle(.pressable)
                    .accessibilityHint("Avaa vahvistus")
                }
                ShowMoreButton(limit: $limit, total: list.candidates.count)
            } header: {
                Text("Pankkitapahtumat · \(list.total)")
            } footer: {
                if let note = list.cappedNote { Text(note) }
            }
        }
    }

    private func pick(_ next: String?) {
        month = next
        limit.reset()
    }

    private func monthTitle(_ key: String) -> String {
        MonthKey.title(key, currentYear: String(MonthKey.current().prefix(4)))
    }

    private func load() async {
        state.begin()
        var query: [String: String] = [:]
        let q = search.trimmingCharacters(in: .whitespaces)
        if !q.isEmpty { query["q"] = q }
        if let month { query["month"] = month }
        do {
            let list: PurchaseBankCandidateList = try await app.api.get(
                "/api/purchase-invoices/\(invoice.id)/payments/candidates", query: query
            )
            state.succeed(list)
            limit.reset()
        } catch is CancellationError {
        } catch {
            state.fail(error)
        }
    }
}

struct PurchaseBankCandidateRow: View {
    let candidate: PurchaseBankCandidate

    var body: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 2) {
                Text(candidate.title).foregroundStyle(Theme.ink).lineLimit(1)
                if !candidate.detail.isEmpty {
                    Text(candidate.detail).font(.caption).foregroundStyle(Theme.ink2).lineLimit(1)
                }
                if let why = candidate.why {
                    Text(why).font(.caption).foregroundStyle(candidate.amountDiff != nil ? Theme.warning : Theme.ink2).lineLimit(3)
                }
            }
            Spacer()
            MoneyText(amount: candidate.amount).font(.subheadline.weight(.semibold))
        }
        .contentShape(Rectangle())
    }
}

/// Pankkitapahtuma → "Kohdista ostolaskuun": open purchase invoices this payment may be for, best first.
/// Pushed inside the bank row sheet; `onLinked` closes the sheet.
struct PurchaseRowLinkView: View {
    @Environment(AppModel.self) private var app
    let row: BankTransaction
    let onLinked: () -> Void

    @State private var state = ScreenLoad<PurchaseInvoiceCandidateList>()
    @State private var search = ""
    @State private var limit = ShowMore()
    @State private var target: PurchaseLinkPair?

    var body: some View {
        List {
            Section {
                LabeledContent(row.title) { MoneyText(amount: abs(row.amount)).fontWeight(.semibold) }
            } footer: {
                Text("Valitse ostolasku, jonka tämä maksu maksoi. Parhaat osumat ovat ylimpänä.")
            }
            switch state.display {
            case .content(let list):
                if let banner = state.banner {
                    Section { RefreshFailureBanner(failure: banner, retry: load) }
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                }
                if list.candidates.isEmpty {
                    Section {
                        ContentUnavailableView {
                            Label(search.isEmpty ? "Ei avoimia ostolaskuja" : "Ei osumia", systemImage: "doc.text")
                        } description: {
                            Text(search.isEmpty
                                 ? "Lisää ostolasku ensin Ostolaskut-näkymässä."
                                 : "Kokeile toista hakusanaa tai summaa.")
                        }
                    }
                    .listRowBackground(Color.clear)
                } else {
                    Section {
                        ForEach(list.candidates.prefix(limit.visible(list.candidates.count))) { candidate in
                            Button { target = PurchaseLinkPair(candidate: candidate, row: row) } label: {
                                PurchaseInvoiceCandidateRow(candidate: candidate)
                            }
                            .buttonStyle(.pressable)
                            .accessibilityHint("Avaa vahvistus")
                        }
                        ShowMoreButton(limit: $limit, total: list.candidates.count)
                    } header: {
                        Text("Avoimet ostolaskut · \(list.total)")
                    }
                }
            case .failed(let failure):
                Section { LoadFailureView(failure: failure, retry: load) }
                    .listRowBackground(Color.clear)
            case .loading:
                ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
            }
        }
        .searchable(text: $search, prompt: "Toimittaja, numero tai summa")
        .navigationTitle("Kohdista ostolaskuun")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: search) {
            if !search.isEmpty { try? await Task.sleep(nanoseconds: 350_000_000) }
            guard !Task.isCancelled else { return }
            await load()
        }
        .navigationDestination(item: $target) { pair in
            PurchaseLinkConfirmView(pair: pair) { _ in onLinked() }
        }
    }

    private func load() async {
        state.begin()
        var query = ["transactionId": row.id]
        let q = search.trimmingCharacters(in: .whitespaces)
        if !q.isEmpty { query["q"] = q }
        do {
            let list: PurchaseInvoiceCandidateList = try await app.api.get("/api/matching/purchase-candidates", query: query)
            state.succeed(list)
            limit.reset()
        } catch is CancellationError {
        } catch {
            state.fail(error)
        }
    }
}

struct PurchaseInvoiceCandidateRow: View {
    let candidate: PurchaseInvoiceCandidate

    var body: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 2) {
                Text(candidate.title).foregroundStyle(Theme.ink).lineLimit(1)
                if !candidate.detail.isEmpty {
                    Text(candidate.detail).font(.caption).foregroundStyle(Theme.ink2).lineLimit(1)
                }
                if let why = candidate.why {
                    Text(why).font(.caption).foregroundStyle(candidate.amountDiff != nil ? Theme.warning : Theme.ink2).lineLimit(3)
                }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                MoneyText(amount: candidate.invoice.open).font(.subheadline.weight(.semibold))
                if candidate.invoice.open != candidate.invoice.gross {
                    Text("avoinna").font(.caption2).foregroundStyle(Theme.ink2)
                }
            }
        }
        .contentShape(Rectangle())
    }
}

/// Ostolaskut → "N ehdotusta": bank rows the matcher thinks paid an invoice. Hyväksy records the payment
/// with the row; Hylkää tells the server not to suggest the pair again.
struct PurchaseSuggestionsSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State var suggestions: [PurchaseMatchResult.Suggestion]
    @State private var busyId: String?
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            List {
                if let failure {
                    Section { Text(failure).foregroundStyle(Theme.danger) }
                }
                Section {
                    ForEach(suggestions) { suggestion in row(suggestion) }
                } footer: {
                    Text("Ehdotus syntyy, kun summa ja toimittajan nimi vastaavat pankkitapahtumaa. Tarkista ennen hyväksymistä.")
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.canvas)
            .navigationTitle("Maksuehdotukset")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Valmis") { dismiss() } } }
            .animation(.snappy, value: suggestions.map(\.id))
        }
        .presentationDetents([.medium, .large])
    }

    private func row(_ suggestion: PurchaseMatchResult.Suggestion) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(suggestion.supplierName).font(.body.weight(.medium)).foregroundStyle(Theme.ink)
                if let number = suggestion.invoiceNumber, !number.isEmpty {
                    Text(number).font(.caption).foregroundStyle(Theme.ink2)
                }
                Spacer()
                if let open = suggestion.open { MoneyText(amount: open).font(.subheadline) }
            }
            Text(suggestion.bankLine).font(.caption).foregroundStyle(Theme.ink2)
            if let why = suggestion.why {
                Text(why).font(.caption).foregroundStyle(Theme.ink2)
            }
            HStack(spacing: 12) {
                Button { Task { await accept(suggestion) } } label: {
                    if busyId == suggestion.id { ProgressView() } else { Text("Hyväksy") }
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.accent)
                .disabled(!suggestion.canAccept || busyId != nil)
                Button("Hylkää") { Task { await reject(suggestion) } }
                    .buttonStyle(.bordered)
                    .disabled(suggestion.transactionId == nil || busyId != nil)
            }
            .padding(.top, 2)
        }
        .padding(.vertical, 4)
    }

    private func accept(_ suggestion: PurchaseMatchResult.Suggestion) async {
        guard let body = suggestion.acceptBody else { return }
        await act(suggestion) {
            let _: PurchaseInvoiceResponse = try await app.api.send(
                "POST", "/api/purchase-invoices/\(suggestion.invoiceId)/payments", body: body, idempotencyKey: UUID().uuidString
            )
        }
    }

    private func reject(_ suggestion: PurchaseMatchResult.Suggestion) async {
        guard let transactionId = suggestion.transactionId else { return }
        await act(suggestion) {
            let _: Ignored = try await app.api.send(
                "POST", "/api/purchase-invoices/match/reject",
                body: PurchaseSuggestionReject(invoiceId: suggestion.invoiceId, transactionId: transactionId)
            )
        }
    }

    private func act(_ suggestion: PurchaseMatchResult.Suggestion, _ work: () async throws -> Void) async {
        busyId = suggestion.id
        failure = nil
        defer { busyId = nil }
        do {
            try await work()
            Haptics.success()
            suggestions.removeAll { $0.id == suggestion.id }
            app.dataVersion += 1
            if suggestions.isEmpty { dismiss() }
        } catch is CancellationError {
        } catch {
            Haptics.error()
            failure = error.userMessage
        }
    }
}
