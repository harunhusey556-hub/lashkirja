import SwiftUI
import LashKirjaCore

struct ReceiptDetailView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let receiptId: String
    @State private var state: Loadable<Receipt> = .idle
    @State private var showFile = false
    @State private var editing = false
    @State private var confirmDelete = false
    @State private var failure: String?

    var body: some View {
        List {
            if let r = state.value {
                Section {
                    VStack(spacing: 6) {
                        if let amount = r.totalAmount { MoneyText(amount: amount).font(.system(size: 34, weight: .bold, design: .rounded)) }
                        Text(r.title).font(.headline)
                        Text(r.isIncome ? "Tulo" : "Meno").font(.caption).foregroundStyle(Theme.ink2)
                    }
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
                }
                Section {
                    if let date = r.date { LabeledContent("Päivä", value: APIDate.displayDay(date)) }
                    if let category = r.category { LabeledContent("Luokka", value: category) }
                    if let reference = r.reference { LabeledContent("Viite", value: reference) }
                    if let status = r.reviewStatus { LabeledContent("Tila", value: status == "approved" ? "Hyväksytty" : status == "rejected" ? "Hylätty" : "Odottaa") }
                    if let notes = r.notes, !notes.isEmpty { LabeledContent("Muistiinpano", value: notes) }
                }
                if let tx = r.linkedTransaction {
                    Section("Pankkitapahtuma") {
                        LabeledContent(tx.counterparty ?? "Tapahtuma") { MoneyText(amount: tx.amount) }
                    }
                }
                Section {
                    if r.fileName != nil {
                        Button { showFile = true } label: { Label("Näytä kuitti", systemImage: "doc.viewfinder") }
                    }
                    if r.reviewStatus == "pending" {
                        Button { Task { await review("approved") } } label: { Label("Hyväksy", systemImage: "checkmark.circle") }
                        Button(role: .destructive) { Task { await review("rejected") } } label: { Label("Hylkää", systemImage: "xmark.circle") }
                    }
                }
                if let failure { Text(failure).foregroundStyle(Theme.danger) }
            } else {
                LoadState(state: state, retry: load) { (_: Receipt) in EmptyView() }.listRowBackground(Color.clear)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .navigationTitle("Kuitti")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if state.value != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button(role: .destructive) { confirmDelete = true } label: { Label("Poista kuitti", systemImage: "trash") }
                    } label: { Image(systemName: "ellipsis.circle") }
                }
            }
        }
        .sheet(isPresented: $showFile) { DocumentPreviewSheet(path: "/api/receipts/\(receiptId)/file", fileName: state.value?.fileName ?? "kuitti") }
        .confirmationDialog("Poistetaanko kuitti?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Poista", role: .destructive) { Task { await delete() } }
        }
        .task { await load() }
    }

    private func load() async {
        if state.value == nil { state = .loading }
        do {
            let r: ReceiptResponse = try await app.api.get("/api/receipts/\(receiptId)")
            state = .loaded(r.receipt)
        } catch is CancellationError {
        } catch {
            if state.value == nil { state = .failed(error.userMessage) }
        }
    }

    private func review(_ status: String) async {
        struct Body: Encodable { let reviewStatus: String }
        do {
            let _: Ignored = try await app.api.send("PATCH", "/api/receipts/\(receiptId)/review", body: Body(reviewStatus: status))
            Haptics.success()
            await load()
        } catch {
            failure = error.userMessage
        }
    }

    private func delete() async {
        do {
            let _: Ignored = try await app.api.send("DELETE", "/api/receipts/\(receiptId)", body: Optional<EmptyBody>.none)
            Haptics.success()
            dismiss()
        } catch {
            failure = error.userMessage
        }
    }
}
