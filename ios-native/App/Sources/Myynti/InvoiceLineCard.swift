import SwiftUI
import LashKirjaCore

/// One line of a new or edited invoice as a compact card: description, quantity stepper and
/// unit, price, VAT and the line's total, with its actions in one menu.
struct InvoiceLineCard: View {
    @Binding var line: InvoiceDraft.Line
    /// The price as typed; the form owns it so an empty field is "Hinta puuttuu.", not 0 €.
    @Binding var priceText: String
    let number: Int
    let issueDate: String
    let showsVat: Bool
    let catalog: [CatalogItem]
    /// Errors are shown once a save has been tried; the form passes this line's.
    let errors: [InvoiceFormField: String]
    var focus: FocusState<InvoiceFormField?>.Binding
    let canMoveUp: Bool
    let canMoveDown: Bool
    let canDelete: Bool
    let onAction: (Action) -> Void

    enum Action { case copy, moveUp, moveDown, delete, saveProduct, pick(CatalogItem) }

    @State private var quantityText = ""
    @State private var askUnit = false
    @State private var customUnit = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text("Rivi \(number)").font(.caption.weight(.semibold)).foregroundStyle(Theme.ink2)
                Spacer()
                MoneyText(amount: InvoiceForm.lineGross(line, vatRegistered: showsVat))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.ink)
                    .accessibilityLabel("Rivin \(number) summa \(Money.format(InvoiceForm.lineGross(line, vatRegistered: showsVat)))")
                actions
            }
            TextField("Kuvaus", text: $line.description, axis: .vertical)
                .lineLimit(1...4)
                .textInputAutocapitalization(.sentences)
                .focused(focus, equals: InvoiceFormField.description(line.id))
                .accessibilityLabel("Rivin \(number) kuvaus")
            fieldError(.description(line.id))
            HStack(spacing: 10) {
                quantityControl
                unitMenu
                Spacer(minLength: 4)
                priceField
            }
            fieldError(.quantity(line.id))
            fieldError(.unitPrice(line.id))
            if showsVat { vatRow }
        }
        .padding(.vertical, 4)
        .onAppear { if quantityText.isEmpty { quantityText = InvoiceForm.quantityText(line.quantity) } }
        // The stepper and a catalog product change the quantity from outside the text field.
        .onChange(of: line.quantity) { _, value in
            if (Money.parse(quantityText) ?? 0) != value { quantityText = InvoiceForm.quantityText(value) }
        }
        .alert("Yksikkö", isPresented: $askUnit) {
            TextField("esim. paketti", text: $customUnit)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Käytä") {
                let unit = String(customUnit.trimmingCharacters(in: .whitespaces).prefix(InvoiceForm.maxUnitLength))
                if !unit.isEmpty { line.unit = unit }
            }
            Button("Peruuta", role: .cancel) {}
        } message: {
            Text("Enintään \(InvoiceForm.maxUnitLength) merkkiä.")
        }
    }

    private var actions: some View {
        Menu {
            if !catalog.isEmpty {
                Menu {
                    ForEach(catalog) { item in
                        Button("\(item.name) · \(Money.format(item.unitPrice))") { onAction(.pick(item)) }
                    }
                } label: { Label("Valitse tuote", systemImage: "shippingbox") }
            }
            Button { onAction(.copy) } label: { Label("Kopioi rivi", systemImage: "plus.square.on.square") }
            if canMoveUp { Button { onAction(.moveUp) } label: { Label("Siirrä ylös", systemImage: "arrow.up") } }
            if canMoveDown { Button { onAction(.moveDown) } label: { Label("Siirrä alas", systemImage: "arrow.down") } }
            Button { onAction(.saveProduct) } label: { Label("Tallenna tuotteeksi", systemImage: "square.and.arrow.down") }
            if canDelete {
                Divider()
                Button(role: .destructive) { onAction(.delete) } label: { Label("Poista rivi", systemImage: "trash") }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
                .font(.body)
                .foregroundStyle(Theme.accent)
                .frame(minWidth: 32, minHeight: 32)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .accessibilityLabel("Rivin \(number) toiminnot")
    }

    private var quantityControl: some View {
        HStack(spacing: 2) {
            Button { step(-1) } label: { Image(systemName: "minus.circle").font(.title3) }
                .disabled(line.quantity <= 1)
                .accessibilityLabel("Vähennä määrää")
            TextField("Määrä", text: $quantityText)
                .keyboardType(.decimalPad)
                .multilineTextAlignment(.center)
                .monospacedDigit()
                .frame(width: 48)
                .focused(focus, equals: InvoiceFormField.quantity(line.id))
                .onChange(of: quantityText) { _, text in line.quantity = Money.parse(text) ?? 0 }
                .accessibilityLabel("Rivin \(number) määrä")
            Button { step(1) } label: { Image(systemName: "plus.circle").font(.title3) }
                .accessibilityLabel("Lisää määrää")
        }
        .buttonStyle(.borderless)
        .foregroundStyle(Theme.accent)
    }

    private var unitMenu: some View {
        Menu {
            ForEach(InvoiceForm.unitOptions(current: line.unit), id: \.self) { unit in
                Button {
                    line.unit = unit
                    Haptics.selection()
                } label: {
                    if unit == line.unit { Label(unit, systemImage: "checkmark") } else { Text(unit) }
                }
            }
            Divider()
            Button("Muu yksikkö…") {
                customUnit = InvoiceForm.units.contains(line.unit) ? "" : line.unit
                askUnit = true
            }
        } label: {
            HStack(spacing: 2) {
                Text(line.unit.isEmpty ? "kpl" : line.unit)
                Image(systemName: "chevron.up.chevron.down").font(.caption2)
            }
            .foregroundStyle(Theme.ink)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(Theme.accentSoft, in: Capsule())
        }
        .buttonStyle(.borderless)
        .accessibilityLabel("Yksikkö \(line.unit)")
    }

    private var priceField: some View {
        HStack(spacing: 4) {
            TextField("0,00", text: $priceText)
                .keyboardType(.decimalPad)
                .multilineTextAlignment(.trailing)
                .monospacedDigit()
                .frame(minWidth: 70, maxWidth: 110)
                .focused(focus, equals: InvoiceFormField.unitPrice(line.id))
                .accessibilityLabel("Rivin \(number) à-hinta euroina")
            Text("€ / \(line.unit.isEmpty ? "kpl" : line.unit)").font(.caption).foregroundStyle(Theme.ink2)
        }
    }

    private var vatRow: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("ALV").font(.subheadline).foregroundStyle(Theme.ink2)
                Spacer()
                // The rates valid on the invoice date (web `vatRateOptions`), plus the line's own
                // rate when it is no longer one of them, with the reason underneath.
                Picker("ALV", selection: $line.vatRate) {
                    ForEach(SalesVat.rateOptions(current: line.vatRate, issueDate: issueDate), id: \.self) { rate in
                        Text("\(SalesVat.label(rate)) %").tag(rate)
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .tint(Theme.accentDark)
            }
            if let note = errors[.vatRate(line.id)] ?? SalesVat.dateNote(line.vatRate, issueDate: issueDate) {
                Text(note).font(.caption).foregroundStyle(Theme.danger)
            }
        }
    }

    private func fieldError(_ field: InvoiceFormField) -> some View {
        InvoiceFieldError(message: errors[field])
    }

    private func step(_ by: Int) {
        line.quantity = InvoiceForm.steppedQuantity(line.quantity, by: by)
        Haptics.selection()
    }
}

/// A validation message under its field.
struct InvoiceFieldError: View {
    let message: String?

    var body: some View {
        if let message {
            Label(message, systemImage: "exclamationmark.circle")
                .font(.caption)
                .foregroundStyle(Theme.danger)
        }
    }
}
