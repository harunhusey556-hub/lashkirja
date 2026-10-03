import SwiftUI
import LashKirjaCore

/// "Korttimaksu": charge the invoice's open amount (or part of it) with Tap to Pay on this iPhone.
/// The invoice changes only after the server has verified the payment with Stripe.
struct POSPaymentSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let invoice: Invoice
    /// "Lähetä lasku sähköpostilla" after a card the phone cannot charge.
    let onSendInvoice: () -> Void
    @State private var pos = POSCoordinator.shared
    @State private var status: POSStatus?
    @State private var amountText = ""
    @State private var amountProblem: String?
    @State private var showSettings = false

    var body: some View {
        NavigationStack {
            Group {
                if let status {
                    let missing = POSReadiness.missing(status: status, device: POSDevice.capability)
                    if missing.isEmpty && status.ready {
                        paymentView
                    } else {
                        notReady(missing.isEmpty ? [.posDisabled] : missing)
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .background(Theme.canvas)
            .navigationTitle("Korttimaksu")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(pos.machine.isFinished ? "Valmis" : "Sulje") { close() }
                        .disabled(pos.phase.isBusy && !pos.machine.canCancel)
                }
            }
            .navigationDestination(isPresented: $showSettings) { PaymentsSettingsView() }
        }
        // Mid-payment the sheet stays: the money may be on its way.
        .interactiveDismissDisabled(pos.phase.isBusy)
        .task { await prepare() }
        .onChange(of: pos.phase) { _, phase in
            switch phase {
            case .accountingRecorded: Haptics.success()
            case .failed(let failure) where failure.kind != .canceled: Haptics.error()
            default: break
            }
        }
    }

    // MARK: Ready

    private var paymentView: some View {
        ScrollView {
            VStack(spacing: 20) {
                VStack(spacing: 4) {
                    Text("Lasku \(invoice.number) · \(invoice.customer.name)")
                        .font(.subheadline).foregroundStyle(Theme.ink2)
                        .lineLimit(1)
                    Text("Avoinna \(Money.format(invoice.open))").font(.caption).foregroundStyle(Theme.ink2)
                }
                amountSection
                stateSection
                actions
            }
            .padding(16)
        }
    }

    @ViewBuilder
    private var amountSection: some View {
        if pos.machine.amountEditable {
            VStack(alignment: .leading, spacing: 6) {
                Text("Summa").font(.caption).foregroundStyle(Theme.ink2)
                HStack {
                    TextField("0,00", text: $amountText)
                        .keyboardType(.decimalPad)
                        .font(.system(size: 34, weight: .bold, design: .rounded))
                        .onChange(of: amountText) { _, _ in amountProblem = nil }
                    Text("€").font(.title.weight(.semibold)).foregroundStyle(Theme.ink2)
                }
                Text(amountProblem ?? "Voit veloittaa osan avoimesta summasta.")
                    .font(.caption)
                    .foregroundStyle(amountProblem == nil ? Theme.ink2 : Theme.danger)
            }
            .padding(16)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
        } else if let amount = pos.machine.amount ?? pos.machine.payment?.amount {
            MoneyText(amount: amount).font(.system(size: 40, weight: .bold, design: .rounded))
        }
    }

    @ViewBuilder
    private var stateSection: some View {
        switch pos.phase {
        case .idle:
            if let notice = pos.notice {
                Text(notice).font(.footnote).foregroundStyle(Theme.ink2).multilineTextAlignment(.center)
            }
        case .accountingRecorded:
            VStack(spacing: 8) {
                Image(systemName: "checkmark.circle.fill").font(.system(size: 56)).foregroundStyle(Theme.success)
                Text(pos.phase.title).font(.title3.weight(.semibold)).multilineTextAlignment(.center)
            }
        case .succeeded:
            VStack(spacing: 8) {
                Image(systemName: "checkmark.circle").font(.system(size: 56)).foregroundStyle(Theme.success)
                Text(pos.phase.title).font(.headline).multilineTextAlignment(.center)
                Text("Stripe veloitti kortin. Lasku päivittyy, kun palvelin on vahvistanut maksun.")
                    .font(.footnote).foregroundStyle(Theme.ink2).multilineTextAlignment(.center)
            }
        case .failed(let failure):
            VStack(spacing: 6) {
                Image(systemName: failure.kind == .canceled ? "xmark.circle" : "exclamationmark.triangle.fill")
                    .font(.system(size: 40))
                    .foregroundStyle(failure.kind == .canceled ? Theme.ink2 : Theme.danger)
                Text(failure.title).font(.headline).multilineTextAlignment(.center)
                if !failure.message.isEmpty {
                    Text(failure.message).font(.footnote).foregroundStyle(Theme.ink2).multilineTextAlignment(.center)
                }
            }
        default:
            VStack(spacing: 10) {
                if pos.phase == .waitingForCard {
                    Image(systemName: "wave.3.right.circle").font(.system(size: 56)).foregroundStyle(Theme.accent)
                        .symbolEffect(.pulse)
                } else if let progress = pos.updateProgress {
                    ProgressView(value: progress).tint(Theme.accent).frame(maxWidth: 220)
                } else {
                    ProgressView().controlSize(.large)
                }
                Text(pos.phase.title).font(.title3.weight(.semibold)).multilineTextAlignment(.center)
                if let message = pos.readerMessage {
                    Text(message).font(.footnote).foregroundStyle(Theme.ink2).multilineTextAlignment(.center)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
        }
    }

    @ViewBuilder
    private var actions: some View {
        switch pos.phase {
        case .idle:
            payButton
        case .accountingRecorded:
            Button { close() } label: { Text("Valmis").frame(maxWidth: .infinity) }
                .buttonStyle(.primary)
        case .succeeded:
            Button { close() } label: { Text("Valmis").frame(maxWidth: .infinity) }
                .buttonStyle(.primary)
            Button("Tarkista uudelleen") { pos.retry() }
                .buttonStyle(.borderless)
                .foregroundStyle(Theme.accentDark)
        case .failed(let failure):
            if pos.machine.amountEditable {
                payButton
            }
            // With the amount open again, "Maksa" starts over; a bare retry would resend the refused request.
            let shown = failure.actions.filter { !(pos.machine.amountEditable && $0 == .retry) }
            ForEach(Array(shown.enumerated()), id: \.offset) { index, action in
                failureButton(action, primary: index == 0 && !pos.machine.amountEditable)
            }
        default:
            if pos.machine.canCancel {
                Button("Peruuta maksu", role: .cancel) { pos.cancel() }
                    .frame(minHeight: 44)
                    .foregroundStyle(Theme.accentDark)
            }
        }
    }

    private var payButton: some View {
        let parsed = POSAmount.validate(amountText, open: invoice.open)
        let label: String = if case .success(let amount) = parsed { POSAmount.payLabel(amount) } else { "Maksa" }
        return Button { startPayment() } label: {
            Text(label).font(.title3.weight(.bold)).frame(maxWidth: .infinity, minHeight: 56)
        }
        .buttonStyle(.primary)
    }

    @ViewBuilder
    private func failureButton(_ action: POSFailureAction, primary: Bool) -> some View {
        let run = { perform(action) }
        if primary {
            Button(action: run) { Text(action.title).frame(maxWidth: .infinity) }.buttonStyle(.primary)
        } else {
            Button(action.title, action: run)
                .frame(minHeight: 44)
                .buttonStyle(.borderless)
                .foregroundStyle(Theme.accentDark)
        }
    }

    private func perform(_ action: POSFailureAction) {
        switch action {
        case .retry, .tryAnotherCard: pos.retry()
        case .sendInvoiceByEmail:
            pos.abandonIfUncharged()
            pos.endIfSettled()
            dismiss()
            onSendInvoice()
        case .openSettings: showSettings = true
        }
    }

    private func startPayment() {
        switch POSAmount.validate(amountText, open: invoice.open) {
        case .success(let amount):
            Keyboard.dismiss()
            pos.pay(amount: amount)
        case .failure(let problem):
            amountProblem = problem.message
            Haptics.error()
        }
    }

    // MARK: Not ready

    private func notReady(_ missing: [POSMissing]) -> some View {
        List {
            Section {
                ForEach(missing, id: \.self) { item in
                    VStack(alignment: .leading, spacing: 4) {
                        Label(item.title, systemImage: "exclamationmark.circle").font(.subheadline.weight(.semibold))
                        Text(item.detail).font(.caption).foregroundStyle(Theme.ink2)
                    }
                    .padding(.vertical, 2)
                }
            } header: {
                Text("Korttimaksu ei ole vielä valmis")
            }
            if missing.contains(where: \.fixInSettings) {
                Section {
                    Button { showSettings = true } label: {
                        Label("Avaa maksuasetukset", systemImage: "creditcard")
                    }
                }
            }
            Section {
                Button { Task { status = await pos.refreshStatus() } } label: {
                    Label("Tarkista uudelleen", systemImage: "arrow.clockwise")
                }
            }
        }
        .scrollContentBackground(.hidden)
    }

    // MARK: Lifecycle

    private func prepare() async {
        pos.bind(app)
        pos.begin(invoiceId: invoice.id)
        if amountText.isEmpty {
            amountText = POSAmount.editText(pos.machine.amount ?? invoice.open)
        }
        let fresh = await pos.refreshStatus()
        status = fresh
        // Apple's "How to Tap" before the owner's first payment on this device.
        if POSReadiness.canTakePayments(status: fresh, device: POSDevice.capability), case .signedIn(let user) = app.phase {
            await TapToPayEducation.showIfFirstUse(userId: user.userId)
        }
    }

    private func close() {
        if pos.machine.canCancel { pos.cancel() } else { pos.abandonIfUncharged() }
        pos.endIfSettled()
        dismiss()
    }
}
