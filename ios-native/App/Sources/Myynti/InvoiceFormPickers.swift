import SwiftUI
import LashKirjaCore

/// The picked customer on the invoice form: name, Y-tunnus and email at a glance, "Vaihda" to pick another.
struct InvoiceCustomerCard: View {
    let name: String
    let detail: String?
    let onChange: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: "person.crop.circle.fill")
                .font(.title2)
                .foregroundStyle(Theme.accent)
            VStack(alignment: .leading, spacing: 2) {
                Text(name).font(.body.weight(.semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                if let detail { Text(detail).font(.caption).foregroundStyle(Theme.ink2).lineLimit(1) }
            }
            Spacer(minLength: 8)
            Button("Vaihda", action: onChange)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.accentDark)
                .buttonStyle(.borderless)
        }
        .accessibilityElement(children: .combine)
    }
}

/// Searchable customer list for the invoice form, with "Uusi asiakas" at the top.
struct CustomerPickerSheet: View {
    @Environment(\.dismiss) private var dismiss
    let customers: [Customer]
    let selectedId: String
    let onPick: (Customer) -> Void
    /// A customer added from here is picked at once.
    let onCreated: (Customer) -> Void
    @State private var search = ""
    @State private var limit = ShowMore()
    @State private var showNew = false

    var body: some View {
        NavigationStack {
            List {
                if search.isEmpty {
                    Button { showNew = true } label: {
                        Label("Uusi asiakas", systemImage: "person.badge.plus").foregroundStyle(Theme.accentDark)
                    }
                }
                let rows = InvoiceForm.customers(customers, matching: search)
                Section {
                    ForEach(rows.prefix(limit.visible(rows.count))) { customer in
                        Button {
                            Haptics.selection()
                            onPick(customer)
                            dismiss()
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(customer.name).foregroundStyle(Theme.ink)
                                    Text(InvoiceForm.customerDetail(customer)).font(.caption).foregroundStyle(Theme.ink2)
                                }
                                Spacer()
                                if customer.id == selectedId {
                                    Image(systemName: "checkmark").foregroundStyle(Theme.accent)
                                }
                            }
                            .contentShape(Rectangle())
                        }
                    }
                    ShowMoreButton(limit: $limit, total: rows.count)
                } footer: {
                    if rows.isEmpty && !search.isEmpty { Text("Ei asiakkaita haulla \u{201C}\(search)\u{201D}.") }
                }
            }
            .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .always), prompt: "Nimi, Y-tunnus tai sähköposti")
            .onChange(of: search) { limit.reset() }
            .navigationTitle("Valitse asiakas")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Sulje") { dismiss() } }
            }
            .sheet(isPresented: $showNew) {
                CustomerFormSheet(existing: nil) { created in
                    onCreated(created)
                    dismiss()
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

/// "Lisää tuotteista": saved products to add as a line; swipe removes one from the list.
struct CatalogPickerSheet: View {
    @Environment(\.dismiss) private var dismiss
    let catalog: [CatalogItem]
    let showsVat: Bool
    let onPick: (CatalogItem) -> Void
    let onDelete: (CatalogItem) -> Void
    @State private var search = ""
    @State private var limit = ShowMore()

    var body: some View {
        NavigationStack {
            List {
                let rows = search.isEmpty ? catalog : catalog.filter { $0.name.localizedCaseInsensitiveContains(search) }
                Section {
                    ForEach(rows.prefix(limit.visible(rows.count))) { item in
                        Button {
                            Haptics.selection()
                            onPick(item)
                            dismiss()
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(item.name).foregroundStyle(Theme.ink)
                                    Text(showsVat ? "\(item.unit) · ALV \(SalesVat.label(item.vatRate)) %" : item.unit)
                                        .font(.caption).foregroundStyle(Theme.ink2)
                                }
                                Spacer()
                                MoneyText(amount: item.unitPrice).foregroundStyle(Theme.ink2)
                            }
                            .contentShape(Rectangle())
                        }
                        .swipeActions {
                            Button("Poista", role: .destructive) { onDelete(item) }
                        }
                    }
                    ShowMoreButton(limit: $limit, total: rows.count)
                } footer: {
                    Text("Pyyhkäise tuotetta vasemmalle poistaaksesi sen valikosta. Laskut, joilla sitä on käytetty, eivät muutu.")
                }
            }
            .searchable(text: $search, prompt: "Hae tuotetta")
            .onChange(of: search) { limit.reset() }
            .navigationTitle("Lisää tuotteista")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Sulje") { dismiss() } }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
