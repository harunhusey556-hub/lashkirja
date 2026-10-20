import SwiftUI
import LashKirjaCore

/// New invoice, or edit of a draft (`existing`).
struct InvoiceFormView: View {
    @Environment(AppModel.self) private var app
    /// The sheet's dismiss action, kept out of `body`'s dependencies (`SheetDismiss`).
    @State private var dismiss = SheetDismiss()
    let existing: Invoice?
    let presetCustomerId: String?
    /// Called with the new invoice's id after a create, before the sheet closes: the presenter
    /// opens the invoice once the sheet is gone (the web replaces the form with the invoice).
    let onCreated: ((String) -> Void)?

    @State private var draft = InvoiceDraft(customerId: "", issueDate: APIDate.dayString(Date()), paymentTermDays: 14)
    /// The picked day as the DatePicker draws it (`APIDate.pickerDate`), in any device zone: Helsinki
    /// midnight drew as the day before west of Helsinki, and a picked day saved one day late.
    @State private var issueDate = APIDate.pickerDate(APIDate.dayString(Date())) ?? Date()
    @State private var customers: [Customer] = []
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
    /// UI tests only (`-LKUITest`): whether the form was finished when it first appeared.
    @State private var openedFinished: Bool?

    /// `preview` (`AppModel.invoiceFormPreview`) opens the form finished in its first frame: line,
    /// customers, catalog and a kept draft in place. Without it `.task` fills them in after the
    /// first frame (the "Lisää → Uusi lasku" flash, w44).
    init(existing: Invoice?, presetCustomerId: String? = nil, preview: InvoiceFormPreview? = nil, onCreated: ((String) -> Void)? = nil) {
        self.existing = existing
        self.presetCustomerId = presetCustomerId
        self.onCreated = onCreated
        guard let preview else { return }
        let opening = InvoiceForm.opening(existing: existing, presetCustomerId: presetCustomerId, customers: preview.customers,
                                          sellerRegistered: preview.sellerRegistered, kept: preview.kept,
                                          today: APIDate.dayString(Date()))
        _draft = State(initialValue: opening.draft)
        _issueDate = State(initialValue: APIDate.pickerDate(opening.draft.issueDate) ?? Date())
        _baseline = State(initialValue: opening.baseline)
        _priceTexts = State(initialValue: opening.priceTexts)
        _restored = State(initialValue: opening.restored)
        _showDetails = State(initialValue: !opening.draft.notes.isEmpty)
        _customers = State(initialValue: preview.customers)
        _catalog = State(initialValue: preview.catalog)
        _sellerRegistered = State(initialValue: preview.sellerRegistered)
    }

    #if DEBUG
    /// Tests only (SheetDismissTests): how many times the body has run.
    static var builds = 0
    #endif

    var body: some View {
        #if DEBUG
        let _ = (Self.builds += 1)
        #endif
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
                .scrollContentBackground(.hidden)
                .background(Theme.canvas)
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
                if existing == nil {
                    ToolbarItem(placement: .principal) { InvoiceFormTitle(nextNumber: nextNumber) }
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
            // Own sheet (three choices for a new invoice); the swipe hook is the shared one.
            .background(SwipeAttemptObserver { if dirty && !busy { confirmDiscard = true } })
            .confirmSheet(
                isPresented: $confirmDiscard,
                title: "Hylätäänkö muutokset?",
                message: existing == nil ? "Laskua ei ole vielä luotu." : "Muutoksia ei ole tallennettu.",
                confirmTitle: "Hylkää muutokset",
                // Kept in memory: "Uusi lasku" opens with it again.
                secondary: existing == nil ? ConfirmRequest.Action(title: "Säilytä luonnos ja sulje", run: { dismiss() }) : nil,
                cancelTitle: "Jatka muokkausta"
            ) {
                if existing == nil, let owner { SalesDraftStore.shared.clear(owner: owner) }
                dismiss()
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
                draft.lines.adjustVatRates(issueDate: APIDate.pickerDay(date))
            }
            .onChange(of: snapshot) { _, current in keepDraft(current) }
            .perfReady("laskuUusi", baseline != nil)
            .onAppear { if UITestHooks.active, openedFinished == nil { openedFinished = baseline != nil && !draft.lines.isEmpty } }
            // OwnerScreensTests.testE: a first frame without the line is the "Lisää → Uusi lasku" flash.
            .overlay(alignment: .topLeading) {
                if let openedFinished {
                    Text(openedFinished ? "valmis" : "kesken").font(.caption2).opacity(0.01)
                        .accessibilityIdentifier("invoice-form-opening")
                }
            }
            .task { await prepare() }
            .interactiveDismissDisabled(busy || dirty)
        }
        .sheetDismiss(dismiss)
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
                // One row (X141): the picker it opens has its own "Uusi asiakas" on top. Offered here
                // too, it was a second accent row of the same weight.
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

    private var issueDay: String { APIDate.pickerDay(issueDate) }

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
            get: { APIDate.pickerDate(InvoiceForm.dueDate(issueDate: issueDay, termDays: draft.paymentTermDays) ?? "") ?? issueDate },
            set: { date in
                if let days = InvoiceForm.termDays(issueDate: issueDay, dueDate: APIDate.pickerDay(date)) {
                    draft.paymentTermDays = days
                }
            }
        )
    }

    private var dueRange: ClosedRange<Date> {
        let start = Calendar.current.startOfDay(for: issueDate)
        let end = APIDate.pickerDate(InvoiceForm.dueDate(issueDate: issueDay, termDays: InvoiceForm.maxPaymentTermDays) ?? "") ?? start
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
        current.issueDate = APIDate.pickerDay(issueDate)
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
        issueDate = APIDate.pickerDate(baseline.issueDate) ?? Date()
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
        // Customers and catalog load side by side: the form is ready after one round trip, none
        // when Myynti already warmed them in the app's cache.
        // Tasks, not `async let`: finishing these four async lets aborted the app in the Swift
        // runtime (swift_task_dealloc from asyncLet_finish_after_task_completion) every time the
        // form opened in the simulator motion audit (2026-10-15, two crash reports).
        let app = self.app
        let customerList = Task { try? await app.cachedGet("/api/customers") as CustomerList }
        let catalogList = Task { try? await app.cachedGet("/api/catalog") as CatalogList }
        let number = Task { await fetchNextNumber() }
        // Opened from a preview, the form is finished already (`init`). Without one (the profile or
        // the lists not in memory yet) it opens once they are here, by the same rules.
        if baseline == nil {
            let registered = await app.cachedProfile()?.vatRegistered ?? true
            let active = await customerList.value?.customers.filter { $0.archivedAt == nil } ?? []
            let items = await catalogList.value?.items ?? []
            let opening = InvoiceForm.opening(existing: existing, presetCustomerId: presetCustomerId, customers: active,
                                              sellerRegistered: registered, kept: keptDraft, today: APIDate.dayString(Date()))
            sellerRegistered = registered
            customers = active
            catalog = items
            draft = opening.draft
            issueDate = APIDate.pickerDate(opening.draft.issueDate) ?? Date()
            priceTexts = opening.priceTexts
            restored = opening.restored
            showDetails = !opening.draft.notes.isEmpty
            baseline = opening.baseline
        }
        // A customer or product added since the lists were painted: replaced in place.
        if let list = await customerList.value {
            customers = list.customers.filter { $0.archivedAt == nil }
            app.rememberPainted(list, "/api/customers")
        }
        // The form works without the catalog; "Lisää tuotteista" just stays hidden.
        if let list = await catalogList.value {
            catalog = list.items
            app.rememberPainted(list, "/api/catalog")
        }
        // Only a hint, and the form does not wait for it: a failed read leaves the title as it was.
        nextNumber = await number.value
    }

    /// The unsaved new invoice kept for this owner, if any.
    private var keptDraft: InvoiceDraft? {
        guard existing == nil, let owner else { return nil }
        return SalesDraftStore.shared.entry(owner: owner)?.draft
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
        draft.issueDate = APIDate.pickerDay(issueDate)
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

/// "Uusi lasku" over the number the server will give it.
struct InvoiceFormTitle: View {
    let nextNumber: Int?

    var body: some View {
        VStack(spacing: 0) {
            Text("Uusi lasku").font(.headline).foregroundStyle(Theme.ink)
            // The number's line is there from the first frame and fades in once the server names it:
            // swapping the plain title for this one moved the title up. It is as wide as a four-digit
            // number from the start, since the bar re-centres a title whose width changes: it jumped
            // 25 pt left and eased back when the number came (M092).
            ZStack {
                Text("Seuraava laskunumero: 0000").hidden().accessibilityHidden(true)
                Text(InvoiceSequence.label(nextNumber) ?? " ")
                    .opacity(nextNumber == nil ? 0 : 1)
                    .motion(.easeOut(duration: 0.2), value: nextNumber)
            }
            .font(.caption2)
            .foregroundStyle(Theme.ink2)
        }
        .accessibilityElement(children: .combine)
    }
}

/// What the invoice form opens on before any await: the seller's VAT status, the active customers,
/// the catalog and the kept unsaved new invoice, all from memory.
struct InvoiceFormPreview {
    let sellerRegistered: Bool
    let customers: [Customer]
    let catalog: [CatalogItem]
    let kept: InvoiceDraft?
}

extension AppModel {
    /// Nil until the seller's VAT status and both lists are in memory (the profile, or before it
    /// loads Koti's dashboard read at launch, as Koti itself does; the warm after Koti and Myynti's
    /// fill the lists): the form then opens after its loads, as before.
    func invoiceFormPreview() -> InvoiceFormPreview? {
        guard case .signedIn(let user) = phase,
              let registered = profile?.vatRegistered ?? kotiPreview()?.vat?.registered,
              let customers: CustomerList = lastPainted("/api/customers"),
              let catalog: CatalogList = lastPainted("/api/catalog") else { return nil }
        return InvoiceFormPreview(sellerRegistered: registered,
                                  customers: customers.customers.filter { $0.archivedAt == nil },
                                  catalog: catalog.items,
                                  kept: SalesDraftStore.shared.entry(owner: user.userId)?.draft)
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
                .transition(.opacity)
            } else if let failure {
                ContentUnavailableView {
                    Label(failure, systemImage: "exclamationmark.triangle")
                } actions: {
                    Button("Yritä uudelleen") { Task { await load() } }.buttonStyle(.primary)
                }
                .transition(.opacity)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                    .transition(.opacity)
            }
        }
        // Loading, failure and the form cross-fade instead of cutting (same .snappy as
        // ScreenStateView), so opening the seller details never flashes.
        .motion(.snappy, value: phase)
        .background(Theme.canvas)
        .navigationTitle("Laskuttajan tiedot")
        .navigationBarTitleDisplayMode(.inline)
        .task { if profile == nil { await load() } }
    }

    /// Only what the body switches on; the animation key must be Equatable and cheap.
    private var phase: Int { profile != nil ? 2 : (failure != nil ? 1 : 0) }

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
