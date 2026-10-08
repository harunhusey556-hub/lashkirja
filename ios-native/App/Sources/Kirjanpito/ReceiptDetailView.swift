import SwiftUI
import LashKirjaCore

struct ReceiptDetailView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let receiptId: String
    @State private var state = ScreenLoad<Receipt>()
    @State private var showFile = false
    @State private var editing = false
    @State private var confirmDelete = false
    @State private var failure: String?
    /// Confirm / unlink of the bank match: one at a time, a second tap sends nothing.
    @State private var matchSubmit = SubmitGuard()
    private var matchBusy: Bool { matchSubmit.inFlight }
    @State private var reviewBusy = false
    @State private var prefetched = false
    @State private var ruleActive = false
    @State private var ruleBusy = false
    @State private var toast: Toast?
    @State private var toastAction: (() async -> Void)?
    @State private var toastTask: Task<Void, Never>?

    var body: some View {
        List {
            if let r = state.value {
                if let banner = state.banner {
                    Section { RefreshFailureBanner(failure: banner, retry: load) }
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                }
                Section {
                    VStack(spacing: 6) {
                        if let amount = r.totalAmount { MoneyText(amount: amount).scaledFont(size: 34, weight: .bold, design: .rounded, relativeTo: .largeTitle).moneyHero() }
                        Text(r.title).font(.headline)
                        Text(r.isIncome ? "Tulo" : "Meno").font(.caption).foregroundStyle(Theme.ink2)
                    }
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
                }
                Section {
                    if let date = r.date { LabeledContent("Päivä", value: APIDate.displayDay(date)) }
                    if let category = r.category, !category.isEmpty { LabeledContent("Kategoria", value: ReceiptCategory.label(for: category)) }
                    if let reference = r.reference, !reference.isEmpty { LabeledContent("Viitenumero", value: reference) }
                    if let number = r.invoiceNumber, !number.isEmpty { LabeledContent("Laskun numero", value: number) }
                    ForEach(Array((r.vatDetails ?? []).enumerated()), id: \.offset) { _, row in
                        LabeledContent("ALV \(ReceiptVat.rateLabel(row.rate))") { MoneyText(amount: row.amount) }
                    }
                    if let status = r.reviewStatus { LabeledContent("Tila", value: status == "approved" ? "Hyväksytty" : status == "rejected" ? "Hylätty" : "Odottaa") }
                    if let notes = r.notes, !notes.isEmpty { LabeledContent("Selite", value: notes) }
                }
                vendorRuleSection(r)
                matchSection(r)
                Section {
                    if r.hasOriginalFile {
                        Button { showFile = true } label: { Label("Näytä kuitti", systemImage: "doc.viewfinder") }
                    }
                    Button { editing = true } label: { Label("Muokkaa", systemImage: "pencil") }
                    if r.reviewStatus == "pending" {
                        Button { Task { await review("approved") } } label: { Label("Hyväksy", systemImage: "checkmark.circle") }
                            .disabled(reviewBusy)
                        Button(role: .destructive) { Task { await review("rejected") } } label: { Label("Hylkää", systemImage: "xmark.circle") }
                            .disabled(reviewBusy)
                    }
                    if r.reviewStatus == "rejected" {
                        // Archived (an e-mail attachment that did not read as a bill, or rejected by hand): back to review.
                        Button { Task { await review("pending") } } label: { Label("Palauta tarkistettavaksi", systemImage: "arrow.uturn.backward.circle") }
                            .disabled(reviewBusy)
                    }
                }
                if let failure { Text(failure).foregroundStyle(Theme.danger) }
            } else {
                ScreenStateView(state: state, retry: load) { (_: Receipt) in EmptyView() }.listRowBackground(Color.clear)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .navigationTitle("Kuitti")
        .refreshable { await load() }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if state.value != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button { editing = true } label: { Label("Muokkaa", systemImage: "pencil") }
                        Button(role: .destructive) { confirmDelete = true } label: { Label("Poista kuitti", systemImage: "trash") }
                    } label: { Image(systemName: "ellipsis.circle") }
                    .accessibilityLabel("Toiminnot")
                }
            }
        }
        .overlay(alignment: .bottom) {
            if let toast {
                ToastView(toast: toast) { runToastAction() }.padding(.bottom, 8)
            }
        }
        .sheet(isPresented: $showFile) {
            DocumentPreviewSheet(path: "/api/receipts/\(receiptId)/file", query: Self.fileQuery, fileName: state.value?.fileName ?? "kuitti", cacheKey: Self.fileCacheKey)
        }
        .sheet(isPresented: $editing) {
            if let r = state.value {
                ReceiptEditSheet(receipt: r) { saved, categoryChanged in
                    Task { await afterSave(saved, categoryChanged: categoryChanged) }
                }
            }
        }
        .confirmationDialog("Poistetaanko kuitti?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Poista", role: .destructive) { Task { await delete() } }
        }
        .task { await load() }
        .onDisappear { toastTask?.cancel() }
    }

    // MARK: Vendor rule

    @ViewBuilder private func vendorRuleSection(_ r: Receipt) -> some View {
        if let vendor = r.vendor, !vendor.isEmpty, let category = r.category, !category.isEmpty {
            Section {
                if ruleActive {
                    Button { Task { await undoRule(vendor: vendor) } } label: { Label("Kumoa sääntö", systemImage: "arrow.uturn.backward") }
                        .disabled(ruleBusy)
                } else {
                    Button { Task { await saveRule(vendor: vendor, category: category) } } label: {
                        Label("Käytä tälle myyjälle myöhemmin", systemImage: "wand.and.stars")
                    }
                    .disabled(ruleBusy)
                }
            } footer: {
                let label = ReceiptCategory.label(for: category)
                Text(ruleActive
                     ? String("Uudet kuitit myyjältä \(vendor) saavat kategorian \(label).")
                     : String("Muistaa kategorian \(label) myyjälle \(vendor)."))
            }
        }
    }

    private func loadRule(vendor: String?) async {
        guard let vendor, !vendor.trimmingCharacters(in: .whitespaces).isEmpty else { ruleActive = false; return }
        if let response: VendorRuleResponse = try? await app.api.get("/api/vendor-rules", query: ["vendor": vendor]) {
            ruleActive = response.isActive
        }
    }

    @discardableResult
    private func saveRule(vendor: String, category: String) async -> Bool {
        struct Body: Encodable { let vendor: String; let category: String }
        ruleBusy = true
        defer { ruleBusy = false }
        do {
            let _: Ignored = try await app.api.send("POST", "/api/vendor-rules", body: Body(vendor: vendor, category: category))
            ruleActive = true
            Haptics.success()
            return true
        } catch is CancellationError {
            return false
        } catch {
            failure = error.userMessage
            Haptics.error()
            return false
        }
    }

    private func undoRule(vendor: String) async {
        struct Body: Encodable { let vendor: String }
        ruleBusy = true
        defer { ruleBusy = false }
        do {
            let _: Ignored = try await app.api.send("POST", "/api/vendor-rules/undo", body: Body(vendor: vendor))
            ruleActive = false
            Haptics.success()
            showToast("Sääntö kumottu.", action: nil, run: nil)
        } catch is CancellationError {
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }

    // MARK: Matching

    @ViewBuilder private func matchSection(_ r: Receipt) -> some View {
        Section {
            if let tx = r.linkedTransaction {
                VStack(alignment: .leading, spacing: 4) {
                    if let gap = ReceiptMatchText.amountGap(bank: tx.amount, receiptTotal: r.totalAmount) {
                        Text(ReceiptMatchText.gapTitle(gap))
                            .font(.caption.weight(.semibold)).foregroundStyle(Theme.warning)
                        Text("Pankista maksettiin \(Money.format(abs(tx.amount))), kuitissa on \(Money.format(r.totalAmount ?? 0)). Kirjanpito laskee kuitin summan, joten korjaa summa tai poista kohdistus.")
                            .font(.caption).foregroundStyle(Theme.ink2)
                    } else {
                        Text(ReceiptMatchText.isStrong(score: tx.bestScore, reasons: tx.bestReasons) ? "Kohdistettu, varma osuma" : "Kohdistettu pankkitapahtumaan")
                            .font(.caption.weight(.semibold)).foregroundStyle(Theme.success)
                    }
                    transactionLine(tx)
                    let reasons = ReceiptMatchText.reasons(tx.bestReasons)
                    if !reasons.isEmpty { Text("Peruste: \(reasons)").font(.caption).foregroundStyle(Theme.ink2) }
                }
                Button(role: .destructive) { Task { await unlink(tx.id) } } label: { Label("Poista kohdistus", systemImage: "xmark.circle") }
                    .disabled(matchBusy)
            } else if let suggested = r.match?.suggestedTransaction {
                Button { Task { await confirm(suggested.id) } } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(ReceiptMatchText.isStrong(score: suggested.bestScore, reasons: suggested.bestReasons) ? "Ehdotettu tapahtuma, varma osuma" : "Ehdotettu pankkitapahtuma")
                            .font(.caption.weight(.semibold)).foregroundStyle(Theme.accent)
                        transactionLine(suggested)
                        matchDetail(suggested)
                        Text("Napauta kohdistaaksesi").font(.caption.weight(.medium)).foregroundStyle(Theme.success)
                    }
                }
                .foregroundStyle(Theme.ink)
                .disabled(matchBusy)
            } else if let candidates = r.match?.matchCandidates, !candidates.isEmpty {
                ForEach(candidates) { tx in
                    Button { Task { await confirm(tx.id) } } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            transactionLine(tx)
                            matchDetail(tx)
                        }
                    }
                    .foregroundStyle(Theme.ink)
                    .disabled(matchBusy)
                }
            } else {
                Text("Sopivaa pankkitapahtumaa ei löytynyt.").foregroundStyle(Theme.ink2)
            }
        } header: {
            Text("Pankkitapahtuma")
        } footer: {
            if r.linkedTransaction == nil, r.match?.suggestedTransaction == nil, r.match?.matchCandidates?.isEmpty == false {
                Text("Mahdolliset pankkitapahtumat. Napauta kohdistaaksesi.")
            }
        }
    }

    private func transactionLine(_ tx: Receipt.LinkedTransaction) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(tx.counterparty ?? "Pankkitapahtuma").lineLimitUnlessLarge()
                if let date = tx.date { Text(APIDate.displayDay(date)).font(.caption).foregroundStyle(Theme.ink2) }
            }
            Spacer()
            MoneyText(amount: tx.amount).font(.subheadline.weight(.semibold))
        }
    }

    @ViewBuilder private func matchDetail(_ tx: Receipt.LinkedTransaction) -> some View {
        let reasons = ReceiptMatchText.reasons(tx.bestReasons)
        let percent = ReceiptMatchText.percent(tx.bestScore)
        Text(reasons.isEmpty ? percent : "\(reasons) · \(percent)").font(.caption).foregroundStyle(Theme.ink2)
    }

    private func confirm(_ transactionId: String) async {
        struct Body: Encodable { let transactionId: String; let receiptId: String }
        guard matchSubmit.begin() != nil else { return }
        failure = nil
        var succeeded = false
        defer { matchSubmit.finish(succeeded: succeeded) }
        do {
            let _: Ignored = try await app.api.send("POST", "/api/matching/confirm", body: Body(transactionId: transactionId, receiptId: receiptId))
            succeeded = true
            Haptics.success()
            app.dataVersion += 1
            await load()
        } catch is CancellationError {
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }

    private func unlink(_ transactionId: String) async {
        struct Body: Encodable { let transactionId: String }
        guard matchSubmit.begin() != nil else { return }
        failure = nil
        var succeeded = false
        defer { matchSubmit.finish(succeeded: succeeded) }
        do {
            let _: Ignored = try await app.api.send("POST", "/api/matching/unlink", body: Body(transactionId: transactionId))
            succeeded = true
            Haptics.success()
            app.dataVersion += 1
            await load()
        } catch is CancellationError {
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }

    // MARK: Toast

    private func showToast(_ text: String, action: String?, run: (() async -> Void)?) {
        toastTask?.cancel()
        toastAction = run
        withMotion(.snappy) { toast = Toast(text: text, actionLabel: action) }
        toastTask = Task {
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            guard !Task.isCancelled else { return }
            withMotion { toast = nil }
            toastAction = nil
        }
    }

    private func runToastAction() {
        let action = toastAction
        toastTask?.cancel()
        toastAction = nil
        withMotion { toast = nil }
        if let action { Task { await action() } }
    }

    // MARK: Load and save

    /// The stored file of a receipt never changes, so one key serves every visit.
    /// `preview=1` makes the server send a large photo as a ≤1600 px JPEG.
    private static let fileCacheKey = "receipt-file-preview"
    private static let fileQuery = ["preview": "1"]

    private func load() async {
        state.begin()
        do {
            let r: ReceiptResponse = try await app.api.get("/api/receipts/\(receiptId)")
            state.succeed(r.receipt)
            if r.receipt.hasOriginalFile && !prefetched {
                prefetched = true
                DocumentCache.shared.prefetch(app, path: "/api/receipts/\(receiptId)/file", query: Self.fileQuery, fileName: r.receipt.fileName ?? "kuitti", key: Self.fileCacheKey)
            }
            await loadRule(vendor: r.receipt.vendor)
        } catch is CancellationError {
        } catch {
            state.fail(error)
        }
    }

    /// After an edit: reload (matching ran again on the server), and when the
    /// category changed offer to remember it for the vendor, with undo.
    private func afterSave(_ saved: Receipt, categoryChanged: Bool) async {
        app.dataVersion += 1
        failure = nil
        await load()
        guard categoryChanged, let vendor = saved.vendor, !vendor.isEmpty,
              let category = saved.category, !category.isEmpty, !ruleActive else { return }
        showToast("Käytetäänkö kategoriaa \(ReceiptCategory.label(for: category)) myyjälle \(vendor) myöhemmin?", action: "Muista") {
            guard await saveRule(vendor: vendor, category: category) else { return }
            showToast("Sääntö tallennettu.", action: "Kumoa") { await undoRule(vendor: vendor) }
        }
    }

    private func review(_ status: String) async {
        struct Body: Encodable { let reviewStatus: String }
        guard !reviewBusy else { return }
        reviewBusy = true
        failure = nil
        defer { reviewBusy = false }
        do {
            let _: Ignored = try await app.api.send("PATCH", "/api/receipts/\(receiptId)/review", body: Body(reviewStatus: status))
            Haptics.success()
            await load()
        } catch is CancellationError {
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }

    private func delete() async {
        let api = app.api, id = receiptId
        app.removeInBackground([id]) {
            let _: Ignored = try await api.send("DELETE", "/api/receipts/\(id)", body: Optional<EmptyBody>.none)
        }
        dismiss()
    }
}

/// Muokkaa kuittia: every field of the web editor, saved with `PATCH
/// /api/receipts/[id]` carrying only the changed fields and the version that
/// was opened, so a newer save elsewhere is never overwritten.
struct ReceiptEditSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var receipt: Receipt
    @State private var baseline: ReceiptForm
    @State private var form: ReceiptForm
    @State private var errors: [String: String] = [:]
    @State private var failure: ReceiptSaveFailure?
    @State private var busy = false
    @State private var customCategory: Bool
    @State private var confirmDiscard = false
    let saved: (Receipt, Bool) -> Void

    init(receipt: Receipt, saved: @escaping (Receipt, Bool) -> Void) {
        let form = ReceiptForm(receipt: receipt)
        _receipt = State(initialValue: receipt)
        _baseline = State(initialValue: form)
        _form = State(initialValue: form)
        _customCategory = State(initialValue: !form.category.isEmpty && !form.isKnownCategory)
        self.saved = saved
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Tyyppi", selection: $form.type) {
                        Text("Meno").tag("meno")
                        Text("Tulo").tag("tulo")
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }
                Section {
                    TextField("Myyjä", text: $form.vendor).textContentType(.organizationName)
                    fieldError("vendor")
                    DatePicker("Päivä", selection: dateBinding, displayedComponents: .date)
                    fieldError("date")
                    TextField("Summa €", text: Binding(get: { form.totalText }, set: { form.setTotal($0) }))
                        .moneyInput()
                    fieldError("totalAmount")
                } header: {
                    Text("Kuitin tiedot")
                }
                Section {
                    ReceiptCategoryField(category: $form.category, custom: $customCategory)
                    fieldError("category")
                } header: {
                    Text("Kategoria")
                }
                if form.type == "meno" { foreignPurchaseSection }
                vatSection
                Section {
                    TextField("Viitenumero", text: $form.reference)
                    fieldError("reference")
                    TextField("Laskun numero", text: $form.invoiceNumber)
                    fieldError("invoiceNumber")
                    TextField("Selite", text: $form.notes, axis: .vertical)
                    fieldError("notes")
                } header: {
                    Text("Lisätiedot")
                }
                if let failure {
                    Section {
                        Text(failure.message).foregroundStyle(Theme.danger)
                        if case .versionConflict = failure {
                            Button { Task { await reload() } } label: { Label("Lataa uudelleen", systemImage: "arrow.clockwise") }
                                .disabled(busy)
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.canvas)
            .formKeyboard()
            .navigationTitle("Muokkaa kuittia")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Peruuta") { if dirty { confirmDiscard = true } else { dismiss() } }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if busy { ProgressView() } else { Button("Tallenna") { Task { await save() } }.bold() }
                }
            }
            .discardGuard(dirty: dirty, busy: busy, asking: $confirmDiscard) { dismiss() }
            .onAppear {
                if form.date.isEmpty { form.date = APIDate.dayString(Date()) }
            }
        }
    }

    private var dateBinding: Binding<Date> {
        Binding(get: { APIDate.day(form.date) ?? Date() }, set: { form.setDate(APIDate.dayString($0)) })
    }

    /// Anything typed that a save would send. The date filled in on open does not count.
    private var dirty: Bool {
        var opened = baseline
        if opened.date.isEmpty { opened.date = form.date }
        return form != opened
    }

    @ViewBuilder private func fieldError(_ key: String) -> some View {
        if let message = errors[key] {
            Text(message).font(.caption).foregroundStyle(Theme.danger)
        }
    }

    /// How the purchase's VAT reaches the return, and the document's currency (web "ALV-käsittely").
    private var foreignPurchaseSection: some View {
        Section {
            Picker("ALV-käsittely", selection: $form.vatTreatment) {
                ForEach(PurchaseVatTreatment.allCases) { treatment in
                    Text(treatment.label).tag(treatment)
                }
            }
            .pickerStyle(.navigationLink)
            TextField("Valuutta", text: $form.currency)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
        } header: {
            Text("ALV-käsittely")
        } footer: {
            if !form.vatTreatment.hint.isEmpty { Text(form.vatTreatment.hint) }
        }
    }

    private var vatSection: some View {
        Section {
            if form.vatRows.isEmpty {
                Text("Ei ALV-erittelyä").foregroundStyle(Theme.ink2)
            }
            ForEach(Array(form.vatRows.enumerated()), id: \.element.id) { index, row in
                HStack {
                    Picker("ALV", selection: Binding(get: { row.rate }, set: { form.setRate($0, at: index) })) {
                        ForEach(ReceiptVat.rateChoices(forDate: form.date, including: row.rate), id: \.self) { rate in
                            Text(ReceiptVat.rateLabel(rate)).tag(rate)
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .fixedSize()
                    TextField("ALV €", text: Binding(get: { row.amountText }, set: { form.setVatAmount($0, at: index) }))
                        .moneyInput()
                        .multilineTextAlignment(.trailing)
                    Button(role: .destructive) { form.removeVatRow(at: index) } label: { Image(systemName: "minus.circle").tapTarget() }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Poista ALV-rivi")
                }
                fieldError("vat-\(index)")
            }
            Button { form.addVatRow() } label: { Label("Lisää ALV-rivi", systemImage: "plus.circle") }
        } header: {
            Text("ALV")
        } footer: {
            if form.vatRows.count == 1 && form.vatRows[0].auto {
                Text("ALV lasketaan summasta ja ALV-kannasta.")
            }
        }
    }

    private func save() async {
        failure = nil
        switch form.makePatch(baseline: baseline, expectedUpdatedAt: receipt.updatedAt) {
        case .unchanged:
            dismiss()
        case .invalid(let found):
            errors = found
            Haptics.error()
        case .patch(let patch):
            errors = [:]
            busy = true
            defer { busy = false }
            do {
                let response: ReceiptResponse = try await app.api.send("PATCH", "/api/receipts/\(receipt.id)", body: patch)
                Haptics.success()
                saved(response.receipt, patch.changes("category"))
                dismiss()
            } catch is CancellationError {
            } catch let error as LKError {
                let kind = ReceiptSaveFailure(error)
                if case .fields(let named, _) = kind { errors = named }
                failure = kind
                Haptics.error()
            } catch {
                failure = .other(error.userMessage)
                Haptics.error()
            }
        }
    }

    /// After a version conflict: the newest copy replaces the form (as the web's "Lataa uudelleen").
    private func reload() async {
        busy = true
        defer { busy = false }
        do {
            let fresh: ReceiptResponse = try await app.api.get("/api/receipts/\(receipt.id)")
            let next = ReceiptForm(receipt: fresh.receipt)
            receipt = fresh.receipt
            baseline = next
            form = next
            customCategory = !next.category.isEmpty && !next.isKnownCategory
            errors = [:]
            failure = nil
        } catch is CancellationError {
        } catch {
            failure = .other(error.userMessage)
        }
    }
}

/// The category of a receipt: one of the known categories, or "Muu kategoria…" typed by hand.
struct ReceiptCategoryField: View {
    @Binding var category: String
    @Binding var custom: Bool

    var body: some View {
        Picker("Kategoria", selection: pickerBinding) {
            Text("Valitse").tag("")
            ForEach(ReceiptCategory.all) { item in Text(item.label).tag(item.id) }
            Text("Muu kategoria…").tag(Self.customTag)
        }
        .pickerStyle(.menu)
        if custom {
            TextField("Oma kategoria", text: $category)
        }
    }

    private static let customTag = "\u{1}custom"

    private var pickerBinding: Binding<String> {
        Binding(
            get: { custom ? Self.customTag : (ReceiptCategory.isKnown(category) ? category : "") },
            set: { value in
                if value == Self.customTag {
                    custom = true
                    if ReceiptCategory.isKnown(category) { category = "" }
                } else {
                    custom = false
                    category = value
                }
            }
        )
    }
}
