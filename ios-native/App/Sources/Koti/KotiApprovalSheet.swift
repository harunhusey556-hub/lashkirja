import SwiftUI
import LashKirjaCore

/// Täydennä (web `ReceiptApprovalSheet`, FP-6): what a pending receipt lacks is filled in here
/// and the receipt approved in one go, instead of a trip through the full receipt editor.
/// The filled fields are saved first (`PATCH /api/receipts/[id]`); the approval itself goes
/// through Koti's undo toast like the one-tap Hyväksy.
struct KotiApprovalSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let item: DashboardItem
    let approve: () -> Void
    let openReceipt: () -> Void
    @State private var state: Loadable<Receipt> = .idle

    var body: some View {
        NavigationStack {
            Group {
                if let receipt = state.value {
                    KotiApprovalForm(item: item, receipt: receipt, approve: approve, openReceipt: openReceipt)
                } else {
                    ScrollView { LoadState(state: state, retry: load) { (_: Receipt) in EmptyView() } }
                        .toolbar {
                            ToolbarItem(placement: .cancellationAction) { Button("Peruuta") { dismiss() } }
                        }
                }
            }
            .background(Theme.canvas)
            .navigationTitle(item.party)
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium, .large])
        .task { await load() }
    }

    private func load() async {
        guard let id = item.receiptId else { return }
        if state.value == nil { state = .loading }
        do {
            let response: ReceiptResponse = try await app.api.get("/api/receipts/\(id)")
            state = .loaded(response.receipt)
        } catch is CancellationError {
        } catch {
            state = .failed(error.userMessage)
        }
    }
}

private struct KotiApprovalForm: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let item: DashboardItem
    let receipt: Receipt
    let approve: () -> Void
    let openReceipt: () -> Void
    @State private var baseline: ReceiptForm
    @State private var form: ReceiptForm
    @State private var customCategory: Bool
    @State private var errors: [String: String] = [:]
    @State private var failure: String?
    @State private var busy = false
    @State private var confirmDiscard = false

    init(item: DashboardItem, receipt: Receipt, approve: @escaping () -> Void, openReceipt: @escaping () -> Void) {
        self.item = item
        self.receipt = receipt
        self.approve = approve
        self.openReceipt = openReceipt
        let loaded = ReceiptForm(receipt: receipt)
        var form = loaded
        // A missing date is asked with today's date ready in the picker.
        if form.date.isEmpty { form.date = APIDate.dayString(Date()) }
        _baseline = State(initialValue: loaded)
        _form = State(initialValue: form)
        _customCategory = State(initialValue: !loaded.category.isEmpty && !loaded.isKnownCategory)
    }

    private var fields: [KotiApproval.Field] { KotiApproval.fields(baseline: baseline, gaps: item.gaps, errors: errors) }

    var body: some View {
        Form {
            Section {
                Text(KotiApproval.subtitle(type: receipt.type, fromBank: item.fromBank))
                    .font(.subheadline).foregroundStyle(Theme.ink2)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 0, leading: 4, bottom: 0, trailing: 4))
            }
            if !fields.isEmpty {
                Section {
                    ForEach(fields, id: \.self) { field in editor(field) }
                } header: {
                    Text("Täydennä")
                } footer: {
                    if !item.gaps.isEmpty {
                        Text(KotiApproval.gapNote(item.gaps)).foregroundStyle(Theme.warning)
                    }
                }
            }
            let known = summary
            if !known.isEmpty {
                Section {
                    ForEach(known) { row in LabeledContent(row.label, value: row.value) }
                } footer: {
                    Text(item.fromBank
                         ? "Tiedot tulevat pankkitapahtumasta. Hyväksy, jos tämä on myyntiä."
                         : "Tiedot on luettu kuitista. Tarkista ne ennen hyväksyntää.")
                }
            }
            if let failure {
                Section { Text(failure).foregroundStyle(Theme.danger) }
            }
            Section {
                Button { Task { await save() } } label: {
                    Group {
                        if busy { ProgressView() } else { Text("Hyväksy") }
                    }
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .font(.headline)
                }
                .buttonStyle(.primary)
                .disabled(busy)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
                Button("Avaa kuitti") { openReceipt(); dismiss() }
                    .frame(maxWidth: .infinity)
                    .disabled(busy)
                    .listRowBackground(Color.clear)
            }
        }
        .scrollContentBackground(.hidden)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Peruuta") { if dirty { confirmDiscard = true } else { dismiss() } }
            }
        }
        .discardGuard(dirty: dirty, busy: busy, asking: $confirmDiscard) { dismiss() }
    }

    /// Anything typed; the date filled in on open does not count.
    private var dirty: Bool {
        var opened = baseline
        if opened.date.isEmpty { opened.date = form.date }
        return form != opened
    }

    @ViewBuilder private func editor(_ field: KotiApproval.Field) -> some View {
        switch field {
        case .vendor:
            TextField("Myyjä", text: $form.vendor).textContentType(.organizationName)
            fieldError("vendor")
        case .amount:
            TextField("Summa €", text: Binding(get: { form.totalText }, set: { form.setTotal($0) }))
                .keyboardType(.decimalPad)
            fieldError("totalAmount")
        case .date:
            DatePicker("Päivä", selection: Binding(get: { APIDate.day(form.date) ?? Date() },
                                                    set: { form.setDate(APIDate.dayString($0)) }),
                       displayedComponents: .date)
            fieldError("date")
        case .category:
            ReceiptCategoryField(category: $form.category, custom: $customCategory)
            fieldError("category")
        case .vat:
            Picker("ALV", selection: vatRate) {
                Text("Ei eritelty").tag(Decimal?.none)
                ForEach(ReceiptVat.rateChoices(forDate: form.date, including: form.vatRows.first?.rate), id: \.self) { rate in
                    Text(ReceiptVat.rateLabel(rate)).tag(Decimal?.some(rate))
                }
            }
            .pickerStyle(.menu)
            if form.vatRows.count == 1, let amount = ReceiptAmount.parse(form.vatRows[0].amountText) {
                LabeledContent("ALV €") { MoneyText(amount: amount) }
            }
            ForEach(Array(form.vatRows.indices), id: \.self) { index in fieldError("vat-\(index)") }
        }
    }

    /// One VAT row at the picked rate, its amount computed from the total; none when "Ei eritelty".
    /// A receipt saved with several rows is left to the full editor.
    private var vatRate: Binding<Decimal?> {
        Binding(
            get: { form.vatRows.count == 1 ? form.vatRows[0].rate : nil },
            set: { rate in
                guard let rate else {
                    while !form.vatRows.isEmpty { form.removeVatRow(at: 0) }
                    return
                }
                if form.vatRows.isEmpty { form.addVatRow() }
                form.setRate(rate, at: 0)
            }
        )
    }

    @ViewBuilder private func fieldError(_ key: String) -> some View {
        if let message = errors[key] {
            Text(message).font(.caption).foregroundStyle(Theme.danger)
        }
    }

    /// What the receipt already has, read-only (the web sheet's Summa / Päivä / Luokka / ALV).
    private struct SummaryRow: Identifiable {
        let label: String
        let value: String
        var id: String { label }
    }

    private var summary: [SummaryRow] {
        let shown = Set(fields)
        var rows: [SummaryRow] = []
        if !shown.contains(.vendor), !baseline.vendor.isEmpty { rows.append(.init(label: "Myyjä", value: baseline.vendor)) }
        if !shown.contains(.amount), let total = ReceiptAmount.parse(baseline.totalText) {
            rows.append(.init(label: "Summa", value: Money.format(total)))
        }
        if !shown.contains(.date), !baseline.date.isEmpty { rows.append(.init(label: "Päivä", value: APIDate.displayDay(baseline.date))) }
        if !shown.contains(.category), !baseline.category.isEmpty {
            rows.append(.init(label: "Luokka", value: ReceiptCategory.label(for: baseline.category)))
        }
        if !shown.contains(.vat), !baseline.vatRows.isEmpty {
            rows.append(.init(label: "ALV", value: baseline.vatRows.map { ReceiptVat.rateLabel($0.rate) }.joined(separator: ", ")))
        }
        return rows
    }

    private static let fieldKeys: Set<String> = ["vendor", "totalAmount", "date", "category"]

    private func save() async {
        failure = nil
        switch form.makePatch(baseline: baseline, expectedUpdatedAt: receipt.updatedAt) {
        case .unchanged:
            finish()
        case .invalid(let found):
            show(found)
            Haptics.error()
        case .patch(let patch):
            errors = [:]
            busy = true
            defer { busy = false }
            do {
                let _: ReceiptResponse = try await app.api.send("PATCH", "/api/receipts/\(receipt.id)", body: patch)
                finish()
            } catch is CancellationError {
            } catch let error as LKError {
                let kind = ReceiptSaveFailure(error)
                if case .fields(let named, _) = kind { show(named) }
                failure = kind.message
                Haptics.error()
            } catch {
                failure = error.userMessage
                Haptics.error()
            }
        }
    }

    /// Field errors go under their fields; one about a field this sheet does not edit is said below.
    private func show(_ found: [String: String]) {
        errors = found
        let elsewhere = found.filter { !Self.fieldKeys.contains($0.key) && !$0.key.hasPrefix("vat-") }
        if !elsewhere.isEmpty {
            failure = elsewhere.sorted { $0.key < $1.key }.map(\.value).joined(separator: " ") + " Avaa kuitti korjataksesi."
        }
    }

    private func finish() {
        approve()
        dismiss()
    }
}
