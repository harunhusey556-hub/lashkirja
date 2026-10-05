import SwiftUI
import LashKirjaCore

/// Where a save-then-fetch sheet is: choosing, saving the choice, fetching rows, or done.
private enum FetchPhase: Equatable {
    case editing, saving, syncing
    case done(String)

    var busy: Bool { self == .saving || self == .syncing }
}

/// The progress or result line under a sheet's main button.
private struct FetchProgress: View {
    let phase: FetchPhase
    var body: some View {
        switch phase {
        case .editing:
            EmptyView()
        case .saving:
            HStack(spacing: 8) { ProgressView(); Text("Tallennetaan…").foregroundStyle(Theme.ink2) }
        case .syncing:
            HStack(spacing: 8) { ProgressView(); Text("Haetaan tapahtumia pankista…").foregroundStyle(Theme.ink2) }
        case .done(let summary):
            Label(summary, systemImage: "checkmark.circle.fill").foregroundStyle(Theme.success)
        }
    }
}

/// `POST /api/bank/connections/[id]/sync` with the result line; nil on a connection that cannot fetch now.
@MainActor
private func fetchNow(_ connection: BankConnection, app: AppModel) async throws -> BankSyncResult? {
    guard connection.status == "active" else { return nil }
    let result: BankSyncResult = try await app.api.send("POST", "/api/bank/connections/\(connection.id)/sync", body: EmptyBody())
    app.dataVersion += 1
    return result
}

/// "Kirjanpitoon kuuluvat tilit": which of a connection's accounts the books use, then a fetch.
struct BankScopeSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let connection: BankConnection
    /// After a save, with the line for the accounts screen.
    let onSaved: (String?) -> Void
    @State private var selected: Set<String> = []
    @State private var filled = false
    @State private var phase: FetchPhase = .editing
    @State private var failure: String?
    /// The selection the server holds now, so a failed fetch can be retried without saving again.
    @State private var savedSelection: Set<String>?

    private var accounts: [BankConnection.Account] { BankScope.accounts(connection) }
    private var problem: String? { BankScope.problem(selected: selected, in: connection) }
    private var done: Bool { if case .done = phase { true } else { false } }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Valitse tilit, joiden tapahtumat haetaan kirjanpitoon. Uudet tilit eivät tule mukaan automaattisesti.")
                        .font(.subheadline)
                        .foregroundStyle(Theme.ink2)
                }
                Section {
                    ForEach(accounts) { account in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(alignment: .firstTextBaseline) {
                                Text(BankScope.title(account)).foregroundStyle(Theme.ink)
                                Spacer()
                                if let balance = account.balance {
                                    MoneyText(amount: balance).foregroundStyle(Theme.ink)
                                }
                            }
                            if let iban = BankScope.iban(account) {
                                Text(iban).font(.caption.monospaced()).foregroundStyle(Theme.ink2).textSelection(.enabled)
                            }
                            Toggle("Mukana kirjanpidossa", isOn: binding(for: account.id))
                                .tint(Theme.accentFill)
                                .disabled(phase.busy || done)
                        }
                        .padding(.vertical, 2)
                    }
                } header: {
                    Text(connection.aspspName)
                }
                Section {
                    if let problem, !done {
                        Text(problem).font(.caption).foregroundStyle(Theme.warning)
                    }
                    if let failure { Text(failure).foregroundStyle(Theme.danger) }
                    FetchProgress(phase: phase)
                    if done {
                        Button("Valmis") { finish() }
                            .buttonStyle(.primary)
                            .frame(maxWidth: .infinity)
                    } else {
                        Button(mainTitle) { Task { await save() } }
                            .buttonStyle(.primary)
                            .frame(maxWidth: .infinity)
                            .disabled(problem != nil || phase.busy)
                    }
                }
                .listRowBackground(Color.clear)
            }
            .scrollContentBackground(.hidden)
            .background(Theme.canvas)
            .navigationTitle("Kirjanpitoon kuuluvat tilit")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if !done { Button("Peruuta") { finish() }.disabled(phase.busy) }
                }
            }
            .interactiveDismissDisabled(phase.busy)
            .onAppear(perform: fill)
        }
    }

    private var mainTitle: String {
        if savedSelection == selected { return "Hae tapahtumat uudelleen" }
        return connection.status == "active" ? "Tallenna ja hae tapahtumat" : "Tallenna"
    }

    private func binding(for id: String) -> Binding<Bool> {
        Binding(
            get: { selected.contains(id) },
            set: { on in
                Haptics.selection()
                if on { selected.insert(id) } else { selected.remove(id) }
            }
        )
    }

    private func fill() {
        guard !filled else { return }
        filled = true
        selected = BankScope.inScopeIDs(connection)
    }

    /// A save that already went through still reaches the accounts screen, even when the fetch failed.
    private func finish() {
        if case .done(let summary) = phase {
            onSaved(summary)
        } else if savedSelection != nil {
            onSaved("Tilit tallennettiin.")
        }
        dismiss()
    }

    private func save() async {
        if let problem {
            failure = problem
            Haptics.error()
            return
        }
        failure = nil
        if savedSelection != selected {
            phase = .saving
            do {
                let _: Ignored = try await app.api.send("PATCH", "/api/bank/connections/\(connection.id)", body: BankScope.body(selected: selected, in: connection))
                savedSelection = selected
                app.dataVersion += 1
            } catch is CancellationError {
                phase = .editing
                return
            } catch {
                failure = error.userMessage
                phase = .editing
                Haptics.error()
                return
            }
        }
        phase = .syncing
        do {
            let result = try await fetchNow(connection, app: app)
            Haptics.success()
            phase = .done(result?.summary ?? "Tilit tallennettiin. Tapahtumat haetaan, kun pankkiyhteys on taas voimassa.")
        } catch is CancellationError {
            phase = .editing
        } catch {
            failure = "Tilit tallennettiin, mutta tapahtumien haku epäonnistui: \(error.userMessage)"
            phase = .editing
            Haptics.error()
        }
    }
}

/// "Hae vanhempia tapahtumia": moves the fetch window's start earlier, then fetches.
struct BankHistorySheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let connection: BankConnection
    let onSaved: (String?) -> Void
    @State private var choiceKey: String?
    @State private var customDate = Date()
    @State private var filled = false
    @State private var phase: FetchPhase = .editing
    @State private var failure: String?

    private static let customKey = "custom"
    private var choices: [BankHistory.Choice] {
        BankHistory.backfillChoices(current: connection.historyFrom, limitDays: connection.historyLimitDays)
    }
    private var done: Bool { if case .done = phase { true } else { false } }

    /// The DatePicker's bounds: inside the bank's limit, before the current start.
    private var range: ClosedRange<Date> {
        let calendar = Calendar.current
        let upper = connection.historyFrom.flatMap(APIDate.day).flatMap { calendar.date(byAdding: .day, value: -1, to: $0) } ?? Date()
        let lower = BankHistory.earliest(limitDays: connection.historyLimitDays).flatMap(APIDate.day)
            ?? calendar.date(byAdding: .year, value: -10, to: upper) ?? upper
        return min(lower, upper)...upper
    }

    private var chosenFrom: String? {
        if choiceKey == Self.customKey { return APIDate.dayString(customDate) }
        return choices.first { $0.key == choiceKey }?.from
    }

    private var problem: String? {
        guard let from = chosenFrom else { return "Valitse, mistä lähtien tapahtumat haetaan." }
        return BankHistory.backfillProblem(from: from, current: connection.historyFrom, limitDays: connection.historyLimitDays)
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(BankHistory.rangeLabel(connection.historyFrom)).foregroundStyle(Theme.ink)
                    if let limit = connection.historyLimitDays, limit > 0 {
                        Text("\(connection.aspspName) antaa tapahtumat enintään \(BankHistory.limitText(limit)) ajalta.")
                            .font(.caption)
                            .foregroundStyle(Theme.ink2)
                    }
                }
                Section {
                    ForEach(choices) { choice in
                        radio(key: choice.key, label: choice.label, hint: choice.hint ?? choice.from.map { "\(APIDate.displayDay($0)) alkaen" })
                    }
                    radio(key: Self.customKey, label: "Muu päivä", hint: nil)
                    if choiceKey == Self.customKey {
                        DatePicker("Alkaen", selection: $customDate, in: range, displayedComponents: .date)
                    }
                } header: {
                    Text("Mistä lähtien haetaan?")
                } footer: {
                    Text("Jo haetut tapahtumat säilyvät, eikä samaa tapahtumaa tuoda kahdesti.")
                }
                .disabled(phase.busy || done)
                Section {
                    if let failure { Text(failure).foregroundStyle(Theme.danger) }
                    FetchProgress(phase: phase)
                    if done {
                        Button("Valmis") { finish() }.buttonStyle(.primary).frame(maxWidth: .infinity)
                    } else {
                        Button("Hae tapahtumat") { Task { await save() } }
                            .buttonStyle(.primary)
                            .frame(maxWidth: .infinity)
                            .disabled(chosenFrom == nil || phase.busy)
                    }
                }
                .listRowBackground(Color.clear)
            }
            .scrollContentBackground(.hidden)
            .background(Theme.canvas)
            .navigationTitle("Hae vanhempia tapahtumia")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if !done { Button("Peruuta") { dismiss() }.disabled(phase.busy) }
                }
            }
            .interactiveDismissDisabled(phase.busy)
            .onAppear(perform: fill)
        }
    }

    private func radio(key: String, label: String, hint: String?) -> some View {
        Button {
            Haptics.selection()
            choiceKey = key
            failure = nil
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(label).foregroundStyle(Theme.ink)
                    if let hint { Text(hint).font(.caption).foregroundStyle(Theme.ink2) }
                }
                Spacer()
                Image(systemName: choiceKey == key ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(choiceKey == key ? Theme.ink : Theme.line)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        .accessibilityAddTraits(choiceKey == key ? .isSelected : [])
    }

    private func fill() {
        guard !filled else { return }
        filled = true
        choiceKey = choices.first?.key ?? Self.customKey
        customDate = range.upperBound
    }

    private func finish() {
        if case .done(let summary) = phase { onSaved(summary) }
        dismiss()
    }

    private func save() async {
        struct Body: Encodable { let historyFrom: String }
        guard let from = chosenFrom else { return }
        if let problem {
            failure = problem
            Haptics.error()
            return
        }
        failure = nil
        phase = .saving
        do {
            let _: Ignored = try await app.api.send("PATCH", "/api/bank/connections/\(connection.id)", body: Body(historyFrom: from))
            app.dataVersion += 1
        } catch is CancellationError {
            phase = .editing
            return
        } catch {
            failure = error.userMessage
            phase = .editing
            Haptics.error()
            return
        }
        phase = .syncing
        do {
            let result = try await fetchNow(connection, app: app)
            Haptics.success()
            phase = .done(result?.summary ?? "Hakuväli tallennettiin.")
        } catch is CancellationError {
            phase = .editing
        } catch {
            // The window is saved; the next sync (automatic or "Päivitä") fetches the older rows.
            failure = "Hakuväli tallennettiin, mutta haku epäonnistui: \(error.userMessage)"
            phase = .editing
            Haptics.error()
        }
    }
}
