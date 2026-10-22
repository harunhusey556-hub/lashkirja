import SwiftUI
import LashKirjaCore

/// "Liitä kuitti" straight from an ostolasku row: the receipts that could be the same purchase
/// (`GET /api/purchase-invoices/[id]/receipts`), one tap each to link (`PATCH` with `receiptId`),
/// so VAT is not counted twice. The web opens the same list in a sheet from the row's pill.
struct PurchaseReceiptLinkSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let invoice: PurchaseInvoice
    /// Called after a receipt was linked, before the sheet closes.
    var onLinked: () -> Void = {}

    @State private var state = ScreenLoad<PurchaseReceiptLinks>()
    @State private var busyId: String?
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(PurchaseReceiptLinkText.intro(invoice)).font(.subheadline).foregroundStyle(Theme.ink2)
                }
                switch state.display {
                case .content(let links):
                    if let banner = state.banner {
                        Section { RefreshFailureBanner(failure: banner, retry: load) }
                            .listRowBackground(Color.clear)
                            .listRowInsets(EdgeInsets())
                    }
                    if links.candidates.isEmpty {
                        Section { Text(PurchaseReceiptLinkText.empty).font(.subheadline).foregroundStyle(Theme.ink) }
                    } else {
                        Section {
                            ForEach(links.candidates) { receipt in candidateRow(receipt) }
                        } header: {
                            Text("Kuitit")
                        }
                    }
                case .failed(let loadFailure):
                    Section { LoadFailureView(failure: loadFailure, retry: load) }
                        .listRowBackground(Color.clear)
                case .loading:
                    ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.canvas)
            .failureToast($failure)
            .navigationTitle(PurchaseReceiptLinkText.title(invoice))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Sulje") { dismiss() } }
            }
            .task { await load() }
        }
        .presentationDetents([.medium, .large])
    }

    private func candidateRow(_ receipt: PurchaseReceiptCandidate) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(receipt.text).font(.subheadline).lineLimit(2)
                if receipt.sameAmount {
                    Text("Sama summa").font(.caption).foregroundStyle(Theme.success)
                }
            }
            Spacer()
            Button {
                Task { await link(receipt) }
            } label: {
                if busyId == receipt.id { ProgressView() } else { Text("Liitä") }
            }
            .buttonStyle(.bordered)
            .tint(Theme.accent)
            .disabled(busyId != nil)
            .accessibilityLabel("Liitä kuitti \(receipt.text)")
        }
    }

    private func load() async {
        state.begin()
        do {
            let links: PurchaseReceiptLinks = try await app.api.get("/api/purchase-invoices/\(invoice.id)/receipts")
            state.succeed(links)
        } catch is CancellationError {
        } catch {
            state.fail(error)
        }
    }

    private func link(_ receipt: PurchaseReceiptCandidate) async {
        guard busyId == nil else { return }
        busyId = receipt.id
        failure = nil
        defer { busyId = nil }
        do {
            let _: PurchaseInvoiceResponse = try await app.api.send(
                "PATCH", "/api/purchase-invoices/\(invoice.id)", body: PurchaseReceiptLink(receiptId: receipt.id)
            )
            Haptics.success()
            app.dataVersion += 1
            onLinked()
            dismiss()
        } catch is CancellationError {
        } catch {
            Haptics.error()
            failure = error.userMessage
        }
    }
}
