import SwiftUI
import LashKirjaCore

/// New invoice, or edit of a draft (`existing`).
struct InvoiceFormView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let existing: Invoice?
    var presetCustomerId: String? = nil
    /// Called with the new invoice's id after a create, before the sheet closes: the presenter
    /// opens the invoice once the sheet is gone (the web replaces the form with the invoice).
    var onCreated: ((String) -> Void)? = nil

    @State private var draft = InvoiceDraft(customerId: "", issueDate: APIDate.dayString(Date()), paymentTermDays: 14)
    @State private var issueDate = Date()
    @State private var customers: [Customer] = []
    @State private var showNewCustomer = false
    @State private var showCustomerPicker = false
    @State private var showCatalog = false
    /// One key per invoice being created: a retry after a lost answer gets the same invoice back.
    @State private var submit = SubmitGuard()
    private var busy: Bool { submit.inFlight }
    @State private var failure: String?
    @State private var loaded = false
    @State private var sellerRegistered = true
    @State private var catalog: [CatalogItem] = []
    @State private var productNotice: String?
    /// The form as it was when it opened; anything else is an unsaved change.
    @State private var baseline: InvoiceDraft?
    @State private var restored = false
    @State private var confirmDiscard = false
    /// Each line's price as typed, so an empty field reads "Hinta puuttuu." instead of 0 €.
    @State private var priceTexts: [UUID: String] = [:]
    /// "Muu" picked: the due date picker shows even when the days match a preset.
    @State private var customTerm = false
    /// Field errors appear after the first save attempt and then follow the typing.
    @State private var showErrors = false
    @State private var showDetails = false
    /// The number the server will give this invoice; shown under the title, read-only.
    @State private var nextNumber: Int?
    @State private var scrollTarget: InvoiceFormField?
    @FocusState private var focus: InvoiceFormField?

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                Form {
                    if restored {
                        Section {
                            HStack {
                                Label("Palautettiin tallentamaton luonnos.", systemImage: "clock.arrow.circlepath")
                                    .font(.subheadline)
                                    .foregroundStyle(Theme.ink)
                                Spacer(minLength: 8)
                                Button("Aloita tyhjästä", role: .destructive) { startOver() }
                                    .font(.subheadline)
                                    .buttonStyle(.borderless)
                            }
                        }
                    }
                    // F22: what a send will need, said before the invoice exists. Never blocks a draft.
                    if existing == nil, let note = SellerPreflight.note(profile: app.profile) {
                        Section {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(note.title).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                                Text(note.body).font(.caption).foregroundStyle(Theme.ink2)
                            }
                            NavigationLink { SellerDetailsScreen() } label: {
                                Text("Täydennä tiedot").foregroundStyle(Theme.accentDark)
                            }
                        }
                        .listRowBackground(Theme.warning.opacity(0.10))
                    }
                    customerSection
                    datesSection
                    linesSection
                    detailsSection
                }
                .onChange(of: scrollTarget) { _, target in
                    guard let target else { return }
                    withMotion { proxy.scrollTo(rowId(target), anchor: .center) }
                    scrollTarget = nil
                }
            }
            .scrollDismissesKeyboard(.interactively)
            // While typing, the keyboard's own bar (Seuraava · total · Valmis) takes this bar's place:
            // both at once overlapped above the keyboard.
            .safeAreaInset(edge: .bottom, spacing: 0) { if focus == nil { bottomBar } }
            .navigationTitle(existing == nil ? "Uusi lasku" : "Muokkaa laskua")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if existing == nil, let label = InvoiceSequence.label(nextNumber) {
                    ToolbarItem(placement: .principal) {
                        VStack(spacing: 0) {
                            Text("Uusi lasku").font(.headline).foregroundStyle(Theme.ink)
                            Text(label).font(.caption2).foregroundStyle(Theme.ink2)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Peruuta") { if dirty { confirmDiscard = true } else { dismiss() } }.disabled(busy)
                }
                ToolbarItemGroup(placement: .keyboard) {
                    // Navigation only: the total is in the bar under the form, and a long amount or a
                    // large text size must not squeeze these buttons.
                    Button("Seuraava") { focusNext() }
                        .disabled(InvoiceForm.field(after: focus, lines: draft.lines) == nil)
                    Spacer()
                    Button("Valmis") { focus = nil }.fontWeight(.semibold)
                }
            }
            // Own alert (three choices for a new invoice); the swipe hook is the shared one.
            .background(SwipeAttemptObserver { if dirty && !busy { confirmDiscard = true } })
            .alert("Hylätäänkö muutokset?", isPresented: $confirmDiscard) {
                Button("Hylkää muutokset", role: .destructive) {
                    if existing == nil, let owner { SalesDraftStore.shared.clear(owner: owner) }
                    dismiss()
                }
                if existing == nil {
                    // Kept in memory: "Uusi lasku" opens with it again.
                    Button("Säilytä luonnos ja sulje") { dismiss() }
                }
                Button("Jatka muokkausta", role: .cancel) {}
            } message: {
                Text(existing == nil ? "Laskua ei ole vielä luotu." : "Muutoksia ei ole tallennettu.")
            }
            .sheet(isPresented: $showNewCustomer) {
                CustomerFormSheet(existing: nil) { created in addCreatedCustomer(created) }
            }
            .sheet(isPresented: $showCustomerPicker) {
                CustomerPickerSheet(customers: customers, selectedId: draft.customerId,
                                    onPick: { pickCustomer($0.id) },
                                    onCreated: { addCreatedCustomer($0) })
            }
            .sheet(isPresented: $showCatalog) {
                CatalogPickerSheet(catalog: catalog, showsVat: sellerRegistered,
                                   onPick: { addFromCatalog($0) },
                                   onDelete: { item in Task { await deleteProduct(item) } })
            }
            // A date moved into 2026 turns old 14 % lines into 13,5 % (as the web form does).
            .onChange(of: issueDate) { _, date in
                draft.lines.adjustVatRates(issueDate: APIDate.dayString(date))
            }
            .onChange(of: snapshot) { _, current in keepDraft(current) }
            .task { await prepare() }
            .interactiveDismissDisabled(busy || dirty)
        }
    }

    // MARK: Sections

    private var selectedCustomer: Customer? { customers.first { $0.id == draft.customerId } }

    private var customerSection: some View {
        Section {
            if let customer = selectedCustomer {
                InvoiceCustomerCard(name: customer.name, detail: InvoiceForm.customerDetail(customer)) { showCustomerPicker = true }
                    .id(rowId(.customer))
            } else if let existing, existing.customer.id == draft.customerId {
                // An edited invoice whose customer has since been archived: shown, not offered in the list.
                InvoiceCustomerCard(name: existing.customer.name, detail: InvoiceForm.customerDetail(existing.customer)) { showCustomerPicker = true }
                    .id(rowId(.customer))
            } else {
                Button { showCustomerPicker = true } label: {
                    HStack {
                        Label("Valitse asiakas", systemImage: "person.crop.circle")
                        Spacer()
                        Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.ink2).accessibilityHidden(true)
                    }
                    .contentShape(Rectangle())
                }
                .foregroundStyle(Theme.accentDark)
                .id(rowId(.customer))
                Button { showNewCustomer = true } label: { Label("Uusi asiakas", systemImage: "person.badge.plus") }
                    .foregroundStyle(Theme.accentDark)
            }
            if let message = errors[.customer] { InvoiceFieldError(message: message) }
        } header: {
            Text("Asiakas")
        }
    }

    private var datesSection: some View {
        Section {
            DatePicker("Laskun päivä", selection: $issueDate, displayedComponents: .date)
                .id(rowId(.dueDate))
            VStack(alignment: .leading, spacing: 6) {
                Text("Maksuaika").font(.subheadline).foregroundStyle(Theme.ink2)
                Picker("Maksuaika", selection: termBinding) {
                    ForEach(InvoiceForm.paymentTerms, id: \.self) { days in
                        Text(InvoiceForm.TermChoice.days(days).label).tag(InvoiceForm.TermChoice.days(days))
                    }
                    Text(InvoiceForm.TermChoice.other.label).tag(InvoiceForm.TermChoice.other)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }
            if termBinding.wrappedValue == .other {
                DatePicker("Eräpäivä", selection: dueBinding, in: dueRange, displayedComponents: .date)
            }
            if let message = errors[.dueDate] { InvoiceFieldError(message: message) }
        } header: {
            Text("Päivät")
        } footer: {
            if let summary = InvoiceForm.dueSummary(issueDate: issueDay, termDays: draft.paymentTermDays) {
                Text(summary).monospacedDigit()
            }
        }
    }

    private var linesSection: some View {
        Section {
            if !sellerRegistered {
                Text("Et ole ALV-rekisterissä, laskulle ei lisätä ALV:tä.").font(.caption).foregroundStyle(Theme.ink2)
            }
            // Values, not `$draft.lines`: a binding into the array crashed (index out of range) when a
            // line was deleted while its card or a field in it was still on screen.
            ForEach(draft.lines) { line in
                let index = draft.lines.firstIndex { $0.id == line.id } ?? 0
                InvoiceLineCard(
                    line: lineBinding(line),
                    priceText: priceBinding(line.id),
                    number: index + 1,
                    issueDate: issueDay,
                    showsVat: sellerRegistered,
                    catalog: catalog,
                    errors: errors,
                    focus: $focus,
                    canMoveUp: index > 0,
                    canMoveDown: index < draft.lines.count - 1,
                    canDelete: draft.lines.count > 1
                ) { action in handle(action, lineId: line.id) }
                .id(rowId(.description(line.id)))
                .swipeActions(edge: .trailing) {
                    if draft.lines.count > 1 {
                        Button("Poista", role: .destructive) { handle(.delete, lineId: line.id) }
                    }
                }
                .swipeActions(edge: .leading) {
                    Button("Kopioi") { handle(.copy, lineId: line.id) }.tint(Theme.accent)
                }
            }
            HStack(spacing: 10) {
                Button { addLine() } label: {
                    Label("Lisää rivi", systemImage: "plus").frame(maxWidth: .infinity)
                }
                if !catalog.isEmpty {
                    Button { showCatalog = true } label: {
                        Label("Lisää tuotteista", systemImage: "shippingbox").frame(maxWidth: .infinity)
                    }
                }
            }
            .font(.subheadline.weight(.semibold))
            .buttonStyle(.bordered)
            .tint(Theme.accent)
            .id(rowId(.lines))
            if let message = errors[.lines] { InvoiceFieldError(message: message) }
        } header: {
            Text("Rivit")
        } footer: {
            if let productNotice {
                Text(productNotice)
            } else if draft.totals.gross == 0, draft.lines.contains(where: { (priceTexts[$0.id] ?? "x").trimmingCharacters(in: .whitespaces).isEmpty }) {
                Text("Summa päivittyy, kun rivillä on hinta. Tyhjä kenttä ei ole nolla euroa.")
            }
        }
    }

    private var detailsSection: some View {
        Section {
            DisclosureGroup(isExpanded: $showDetails) {
                TextField("Viesti laskulle (valinnainen)", text: $draft.notes, axis: .vertical)
                    .lineLimit(2...5)
                    .focused($focus, equals: InvoiceFormField.notes)
                if let message = errors[.notes] { InvoiceFieldError(message: message) }
            } label: {
                HStack {
                    Text("Lisätiedot").foregroundStyle(Theme.ink)
                    if !showDetails, !draft.notes.isEmpty {
                        Text(draft.notes).font(.caption).foregroundStyle(Theme.ink2).lineLimit(1)
                    }
                }
            }
            .id(rowId(.notes))
        }
    }

    /// Totals and the save button stay above the keyboard and the home indicator.
    @ViewBuilder private var bottomBar: some View {
        let totals = draft.totals
        VStack(spacing: 8) {
            if let message = failure ?? (showErrors ? InvoiceForm.errorSummary(errors) : nil) {
                Label(message, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(Theme.danger)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            // Totals and the button side by side while they fit; stacked at large text sizes.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) {
                    totalsView(totals)
                    Spacer(minLength: 8)
                    saveButton
                }
                VStack(alignment: .leading, spacing: 10) {
                    totalsView(totals)
                    saveButton.frame(maxWidth: .infinity)
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .background(Theme.surface)
        .overlay(alignment: .top) { Divider() }
    }

    private func totalsView(_ totals: (net: Decimal, vat: Decimal, gross: Decimal)) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            if sellerRegistered {
                Text("Veroton \(Money.format(totals.net)) · ALV \(Money.format(totals.vat))")
                    .font(.caption)
                    .foregroundStyle(Theme.ink2)
                    .monospacedDigit()
            }
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("Yhteensä").font(.subheadline).foregroundStyle(Theme.ink2)
                MoneyText(amount: totals.gross).font(.title3.weight(.semibold)).foregroundStyle(Theme.ink)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var saveButton: some View {
        Button { Task { await save() } } label: {
            if busy {
                ProgressView().tint(Theme.onInk)
            } else {
                Text(existing == nil ? "Luo lasku" : "Tallenna").font(.body.weight(.semibold))
            }
        }
        .buttonStyle(.primary)
        .disabled(busy || baseline == nil)
    }

    // MARK: Bindings

    private var issueDay: String { APIDate.dayString(issueDate) }

    private var termBinding: Binding<InvoiceForm.TermChoice> {
        Binding(
            get: { customTerm ? .other : InvoiceForm.termChoice(draft.paymentTermDays) },
            set: { choice in
                switch choice {
                case .days(let days):
                    customTerm = false
                    draft.paymentTermDays = days
                case .other:
                    customTerm = true
                }
                Haptics.selection()
            }
        )
    }

    /// The due date as a picker value; picking one sets the term the create call sends.
    private var dueBinding: Binding<Date> {
        Binding(
            get: { APIDate.day(InvoiceForm.dueDate(issueDate: issueDay, termDays: draft.paymentTermDays) ?? "") ?? issueDate },
            set: { date in
                if let days = InvoiceForm.termDays(issueDate: issueDay, dueDate: APIDate.dayString(date)) {
                    draft.paymentTermDays = days
                }
            }
        )
    }

    private var dueRange: ClosedRange<Date> {
        let start = APIDate.day(issueDay) ?? Calendar.current.startOfDay(for: issueDate)
        let end = APIDate.day(InvoiceForm.dueDate(issueDate: issueDay, termDays: InvoiceForm.maxPaymentTermDays) ?? "") ?? start
        return start...end
    }

    private func priceBinding(_ id: UUID) -> Binding<String> {
        Binding(
            get: { priceTexts[id] ?? "" },
            set: { text in
                priceTexts[id] = text
                if let index = draft.lines.firstIndex(where: { $0.id == id }) {
                    draft.lines[index].unitPrice = Money.parse(text) ?? 0
                }
            }
        )
    }

    private var errors: [InvoiceFormField: String] {
        showErrors ? InvoiceForm.fieldErrors(snapshot, priceTexts: priceTexts, vatRegistered: sellerRegistered) : [:]
    }

    private func rowId(_ field: InvoiceFormField) -> String {
        switch field {
        case .customer: "customer"
        case .dueDate: "dates"
        case .lines: "add-line"
        case .notes: "details"
        case .description(let id), .quantity(let id), .unitPrice(let id), .vatRate(let id): "line-\(id.uuidString)"
        }
    }

    // MARK: Lines

    private func focusNext() {
        guard let next = InvoiceForm.field(after: focus, lines: draft.lines) else { focus = nil; return }
        if next == .notes { showDetails = true }
        focus = next
    }

    private func addLine() {
        let line = InvoiceDraft.Line.new(sellerRegistered: sellerRegistered)
        priceTexts[line.id] = ""
        withMotion { draft.lines.append(line) }
        focus = InvoiceFormField.description(line.id)
    }

    /// A line looked up by id on every read and write: still valid after other lines move or go.
    private func lineBinding(_ line: InvoiceDraft.Line) -> Binding<InvoiceDraft.Line> {
        Binding(
            get: { draft.lines.first { $0.id == line.id } ?? line },
            set: { updated in
                if let i = draft.lines.firstIndex(where: { $0.id == updated.id }) { draft.lines[i] = updated }
            }
        )
    }

    private func handle(_ action: InvoiceLineCard.Action, lineId: UUID) {
        guard let index = draft.lines.firstIndex(where: { $0.id == lineId }) else { return }
        switch action {
        case .copy:
            withMotion {
                if let copy = draft.lines.duplicateLine(at: index) {
                    priceTexts[copy] = priceTexts[lineId] ?? InvoiceForm.priceText(draft.lines[index].unitPrice)
                }
            }
        case .moveUp: withMotion { draft.lines.moveLine(at: index, by: -1) }
        case .moveDown: withMotion { draft.lines.moveLine(at: index, by: 1) }
        case .delete:
            // Any field of this line loses focus first, then the line goes once the swipe has
            // finished, so no view is left editing a line that no longer exists.
            if let focused = focus, focused.lineId == lineId { focus = nil }
            Task { @MainActor in
                guard let current = draft.lines.firstIndex(where: { $0.id == lineId }), draft.lines.count > 1 else { return }
                _ = withMotion { draft.lines.remove(at: current) }
                priceTexts[lineId] = nil
            }
        case .saveProduct:
            let line = draft.lines[index]
            Task { await saveProduct(line) }
            return
        case .pick(let item):
            fill(index, with: item)
        }
        Haptics.selection()
    }

    private func fill(_ index: Int, with item: CatalogItem) {
        draft.lines[index].apply(item, issueDate: issueDay)
        draft.lines.followSellerVat(registered: sellerRegistered)
        priceTexts[draft.lines[index].id] = InvoiceForm.priceText(item.unitPrice)
    }

    /// "Lisää tuotteista": fills the untouched last line, otherwise adds one.
    private func addFromCatalog(_ item: CatalogItem) {
        withMotion {
            if let index = InvoiceForm.lineForCatalogPick(draft.lines, priceTexts: priceTexts) {
                fill(index, with: item)
            } else {
                draft.lines.append(.new(sellerRegistered: sellerRegistered))
                fill(draft.lines.count - 1, with: item)
            }
        }
    }

    /// Lines the owner did not type here (an edited invoice, a restored draft) show their amount;
    /// a fresh 0 € line starts empty.
    private func seedPriceTexts(blankZero: Bool) {
        for line in draft.lines where priceTexts[line.id] == nil {
            priceTexts[line.id] = blankZero && line.unitPrice == 0 ? "" : InvoiceForm.priceText(line.unitPrice)
        }
    }

    // MARK: State

    /// The draft with the picked date, as it would be sent.
    private var snapshot: InvoiceDraft {
        var current = draft
        current.issueDate = APIDate.dayString(issueDate)
        return current
    }

    private var dirty: Bool {
        guard let baseline else { return false }
        return snapshot != baseline
    }

    private var owner: String? {
        if case .signedIn(let user) = app.phase { return user.userId }
        return nil
    }

    /// Picking a customer on a new invoice brings that customer's payment term along.
    private func pickCustomer(_ id: String) {
        draft.customerId = id
        if existing == nil, let c = customers.first(where: { $0.id == id }) {
            draft.paymentTermDays = c.defaultPaymentTermDays
            customTerm = false
        }
    }

    private func addCreatedCustomer(_ created: Customer) {
        customers.append(created)
        customers.sort { $0.name.localizedCompare($1.name) == .orderedAscending }
        draft.customerId = created.id
        draft.paymentTermDays = created.defaultPaymentTermDays
        customTerm = false
    }

    /// A new invoice the owner has typed into is kept in memory until it is created or discarded.
    private func keepDraft(_ current: InvoiceDraft) {
        guard existing == nil, let baseline, let owner, !busy else { return }
        if SalesDraftStore.worthKeeping(current, baseline: baseline) {
            SalesDraftStore.shared.keep(current, owner: owner)
        } else {
            SalesDraftStore.shared.clear(owner: owner)
        }
    }

    private func startOver() {
        guard let baseline else { return }
        draft = baseline
        issueDate = APIDate.day(baseline.issueDate) ?? Date()
        priceTexts = [:]
        seedPriceTexts(blankZero: true)
        customTerm = false
        showErrors = false
        restored = false
        if let owner { SalesDraftStore.shared.clear(owner: owner) }
    }

    private func fetchNextNumber() async -> Int? {
        guard existing == nil else { return nil }
        let sequence: InvoiceSequence? = try? await app.api.get("/api/invoices/sequence")
        return sequence?.nextNumber
    }

    private func prepare() async {
        guard !loaded else { return }
        loaded = true
        // Customers, catalog and profile load side by side: the form is ready after one round trip.
        let api = app.api
        async let customerList: CustomerList? = try? api.get("/api/customers")
        async let catalogList: CatalogList? = try? api.get("/api/catalog")
        async let profile = app.cachedProfile()
        async let number = fetchNextNumber()
        if let list = await customerList { customers = list.customers.filter { $0.archivedAt == nil } }
        // The form works without the catalog; "Lisää tuotteista" just stays hidden.
        if let list = await catalogList { catalog = list.items }
        if let profile = await profile { sellerRegistered = profile.vatRegistered }
        // Only a hint: a failed read leaves the title as it was.
        nextNumber = await number
        if let existing {
            draft.customerId = existing.customer.id
            draft.issueDate = existing.issueDate
            issueDate = APIDate.day(existing.issueDate) ?? Date()
            if let term = InvoiceForm.termDays(issueDate: existing.issueDate, dueDate: existing.dueDate) {
                draft.paymentTermDays = term
            }
            draft.notes = existing.notes ?? ""
            draft.lines = existing.lines.map { .init(description: $0.description, quantity: $0.quantity, unit: $0.unit, unitPrice: $0.unitPrice, vatRate: $0.vatRate) }
            seedPriceTexts(blankZero: false)
        } else {
            if let presetCustomerId { pickCustomer(presetCustomerId) }
            if draft.lines.isEmpty { draft.lines = [.new(sellerRegistered: sellerRegistered)] }
            seedPriceTexts(blankZero: true)
        }
        draft.followSellerVat(registered: sellerRegistered)
        // What the date change below would do anyway, done before the baseline so it does not
        // count as the owner's change (a 14 % draft line dated in 2026 can only be 13,5 %).
        draft.lines.adjustVatRates(issueDate: APIDate.dayString(issueDate))
        baseline = snapshot
        restoreKeptDraft()
        showDetails = !draft.notes.isEmpty
    }

    /// "Uusi lasku" again after closing an unsaved one: the owner continues where they left off.
    /// Not when the form was opened for another customer than the kept draft's.
    private func restoreKeptDraft() {
        guard existing == nil, let owner, let kept = SalesDraftStore.shared.entry(owner: owner) else { return }
        if let presetCustomerId, kept.draft.customerId != presetCustomerId { return }
        var restoredDraft = kept.draft
        // The VAT status may have changed since; the kept customer may since have been archived.
        restoredDraft.followSellerVat(registered: sellerRegistered)
        if !restoredDraft.customerId.isEmpty, !customers.contains(where: { $0.id == restoredDraft.customerId }) {
            restoredDraft.customerId = baseline?.customerId ?? ""
        }
        draft = restoredDraft
        issueDate = APIDate.day(restoredDraft.issueDate) ?? Date()
        draft.lines.adjustVatRates(issueDate: APIDate.dayString(issueDate))
        priceTexts = [:]
        seedPriceTexts(blankZero: true)
        restored = true
    }

    /// "Tallenna tuotteeksi": the line becomes a catalog product for later invoices.
    private func saveProduct(_ line: InvoiceDraft.Line) async {
        let product = CatalogItemDraft(line: line)
        if let problem = product.validationError { productNotice = problem; Haptics.error(); return }
        do {
            let response: CatalogItemResponse = try await app.api.send("POST", "/api/catalog", body: product)
            catalog = (catalog + [response.item]).sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
            productNotice = "Tuote \(response.item.name) tallennettiin."
            Haptics.success()
        } catch {
            productNotice = error.userMessage
            Haptics.error()
        }
    }

    /// Archived on the server: gone from the picker, existing invoice lines are untouched.
    private func deleteProduct(_ item: CatalogItem) async {
        do {
            let _: Ignored = try await app.api.send("DELETE", "/api/catalog/\(item.id)", body: Optional<EmptyBody>.none)
            withMotion { catalog.removeAll { $0.id == item.id } }
            productNotice = "Tuote \(item.name) poistettiin valikosta."
            Haptics.success()
        } catch {
            productNotice = error.userMessage
            Haptics.error()
        }
    }

    private func save() async {
        guard !busy else { return }
        focus = nil
        draft.issueDate = APIDate.dayString(issueDate)
        draft.followSellerVat(registered: sellerRegistered)
        let problems = InvoiceForm.fieldErrors(draft, priceTexts: priceTexts, vatRegistered: sellerRegistered)
        if !problems.isEmpty {
            // Each message sits at its field; the bar says how many, the form goes to the first.
            showErrors = true
            failure = nil
            Haptics.error()
            if let first = InvoiceForm.firstInvalid(problems, lines: draft.lines) {
                if first == .notes { showDetails = true }
                scrollTarget = first
                if InvoiceForm.textFieldOrder(lines: draft.lines).contains(first) { focus = first }
            }
            return
        }
        guard let key = submit.begin() else { return }
        failure = nil
        var succeeded = false
        defer { submit.finish(succeeded: succeeded) }
        do {
            if let existing {
                let _: InvoiceResponse = try await app.api.send("PATCH", "/api/invoices/\(existing.id)", body: InvoicePatch(draft: draft, expectedUpdatedAt: existing.updatedAt))
            } else {
                let response: InvoiceResponse = try await app.api.send("POST", "/api/invoices", body: draft, idempotencyKey: key)
                if let owner { SalesDraftStore.shared.clear(owner: owner) }
                onCreated?(response.invoice.id)
            }
            succeeded = true
            // Saved: nothing left to lose, so the sheet may close without asking.
            baseline = snapshot
            Haptics.success()
            dismiss()
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }
}

/// One invoice line. Shared by the invoice and the recurring invoice forms.
struct LineEditor: View {
    @Binding var line: InvoiceDraft.Line
    var catalog: [CatalogItem] = []
    var issueDate: String = APIDate.dayString(Date())
    /// Off for a seller outside the VAT register: every line is 0 % and the rate is not offered.
    var showsVat = true
    var onSaveProduct: ((InvoiceDraft.Line) -> Void)? = nil
    @State private var priceText = ""
    @State private var quantityText = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !catalog.isEmpty {
                Menu {
                    ForEach(catalog) { item in
                        Button("\(item.name) · \(Money.format(item.unitPrice))") {
                            line.apply(item, issueDate: issueDate)
                            Haptics.selection()
                        }
                    }
                } label: {
                    Label("Valitse tuote", systemImage: "shippingbox")
                }
                .menuStyle(.button)
                .buttonStyle(.borderless)
            }
            TextField("Kuvaus", text: $line.description)
            HStack {
                TextField("Määrä", text: $quantityText).moneyInput().frame(maxWidth: 70)
                    .onChange(of: quantityText) { _, t in line.quantity = Money.parse(t) ?? 0 }
                TextField("Yksikkö", text: $line.unit).frame(maxWidth: 70)
                TextField("À-hinta €", text: $priceText).moneyInput()
                    .onChange(of: priceText) { _, t in line.unitPrice = Money.parse(t) ?? 0 }
            }
            if showsVat {
                // The rates valid on the invoice date (web `vatRateOptions`), plus the line's own
                // rate when it is no longer one of them, with the reason underneath.
                Picker("ALV", selection: $line.vatRate) {
                    ForEach(SalesVat.rateOptions(current: line.vatRate, issueDate: issueDate), id: \.self) { rate in
                        Text("\(Self.text(rate)) %").tag(rate)
                    }
                }
                .pickerStyle(.segmented)
                if let note = SalesVat.dateNote(line.vatRate, issueDate: issueDate) {
                    Text(note).font(.caption).foregroundStyle(Theme.danger)
                }
            }
            if let onSaveProduct {
                Button { onSaveProduct(line) } label: {
                    Label("Tallenna tuotteeksi", systemImage: "square.and.arrow.down").font(.footnote)
                }
                .buttonStyle(.borderless)
            }
        }
        .onAppear {
            if quantityText.isEmpty { quantityText = Self.text(line.quantity) }
            if priceText.isEmpty && line.unitPrice != 0 { priceText = Self.text(line.unitPrice) }
        }
        // A product picked from the catalog changes the line from outside the text fields.
        .onChange(of: line.unitPrice) { _, value in
            if (Money.parse(priceText) ?? 0) != value { priceText = Self.text(value) }
        }
        .onChange(of: line.quantity) { _, value in
            if (Money.parse(quantityText) ?? 0) != value { quantityText = Self.text(value) }
        }
    }

    static func text(_ value: Decimal) -> String {
        NSDecimalNumber(decimal: value).stringValue.replacingOccurrences(of: ".", with: ",")
    }
}

/// "Laskuttajan tiedot" opened straight from a sales screen (the send check, a new invoice):
/// the same form as in Asetukset, saved into the profile the other screens read.
struct SellerDetailsScreen: View {
    @Environment(AppModel.self) private var app
    @State private var profile: Profile?
    @State private var failure: String?

    var body: some View {
        Group {
            if let profile {
                ProfileForm(original: profile, section: .seller) { saved in
                    var merged = saved
                    if merged.imapAccounts == nil { merged.imapAccounts = profile.imapAccounts }
                    app.profileChanged(merged)
                }
            } else if let failure {
                ContentUnavailableView {
                    Label(failure, systemImage: "exclamationmark.triangle")
                } actions: {
                    Button("Yritä uudelleen") { Task { await load() } }.buttonStyle(.primary)
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Theme.canvas)
        .navigationTitle("Laskuttajan tiedot")
        .navigationBarTitleDisplayMode(.inline)
        .task { if profile == nil { await load() } }
    }

    /// Fresh from the server: the form saves only what changed against what it opened with.
    private func load() async {
        failure = nil
        do {
            let response: ProfileResponse = try await app.api.get("/api/profile")
            profile = response.profile
            app.profileChanged(response.profile)
        } catch is CancellationError {
        } catch {
            failure = error.userMessage
        }
    }
}
