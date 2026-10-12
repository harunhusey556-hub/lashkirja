import SwiftUI
import LashKirjaCore

struct MainTabView: View {
    @State private var tab: AppTab = .koti
    @State private var showAdd = false
    @State private var showSettings = false
    @State private var showAssistant = false
    @State private var showNewInvoice = false
    /// Each tab's pushed screens, so a screen can be opened from outside its tab (AppModel.pendingRoute).
    @State private var paths: [AppTab: [Route]] = [:]
    @Environment(AppModel.self) private var app

    var body: some View {
        TabView(selection: Binding(get: { tab }, set: select)) {
            ForEach([AppTab.koti, .myynti, .kirjanpito, .raportit], id: \.self) { item in
                Tab(item.title, systemImage: item.symbol, value: item) {
                    NavigationStack(path: path(item)) {
                        root(item)
                            .toolbar {
                                ToolbarItemGroup(placement: .topBarTrailing) {
                                    Button { showAssistant = true } label: { Image(systemName: "bubble.left") }
                                        .accessibilityLabel("Avustaja")
                                    Button { showSettings = true } label: { Image(systemName: "person.crop.circle") }
                                        .accessibilityLabel("Asetukset")
                                }
                            }
                            .appDestinations()
                    }
                }
            }
            // "+" is a plain tab item that opens the Lisää sheet; selecting it never switches tab
            // (see `select`). Not the search role: that told the system (and VoiceOver) "+" was search.
            Tab(AppTab.add.title, systemImage: AppTab.add.symbol, value: AppTab.add) {
                Color.clear
            }
        }
        // Less gap between sections, so more fits on a phone. Rows keep the system's 44 pt minimum,
        // the smallest comfortable touch target.
        .listSectionSpacing(.compact)
        .sheet(isPresented: $showAdd) { AddSheet() }
        .sheet(isPresented: $showSettings) { SettingsSheet().presentationDetents([.large]) }
        .sheet(isPresented: $showAssistant) { AssistantView() }
        // Skipping ("Ohita nyt") keeps them away for a day; Koti then offers to resume them.
        .fullScreenCover(isPresented: Bindable(OnboardingGate.shared).isPresented) { OnboardingView() }
        // "Kuvaa kuitti" on a notification: the camera for that bank row, whatever tab is showing.
        .fullScreenCover(item: Bindable(app).pendingCapture) { capture in CaptureFlow(transactionId: capture.transactionId) }
        .overlay(alignment: .top) { OfflineBanner() }
        .alert("Poisto epäonnistui", isPresented: Binding(get: { app.removalFailure != nil }, set: { if !$0 { app.removalFailure = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(app.removalFailure ?? "")
        }
        // A screen asked for from elsewhere (a new invoice made from "+"): its tab, then the screen.
        .onChange(of: app.pendingRoute, initial: true) { _, pending in
            guard let pending else { return }
            app.pendingRoute = nil
            // A notification tap or a sheet's hand-off: the screen must not open under a sheet.
            showSettings = false
            showAssistant = false
            showAdd = false
            showNewInvoice = false
            tab = pending.tab
            paths[pending.tab] = NavigationStackRule.collapse((paths[pending.tab] ?? []) + [pending.route])
        }
        // A Home Screen quick action or App Intent: the same sheets the "+" tab and the assistant
        // button open. `initial` catches one that arrived before the tabs were on screen.
        .onChange(of: app.pendingQuickAction, initial: true) { _, action in
            guard let action else { return }
            app.pendingQuickAction = nil
            showSettings = false
            showAdd = false
            showAssistant = false
            showNewInvoice = false
            switch action {
            case .capture: app.pendingCapture = PendingCapture(transactionId: nil)
            case .newInvoice: showNewInvoice = true
            case .assistant: showAssistant = true
            }
        }
        .sheet(isPresented: $showNewInvoice) {
            InvoiceFormView(existing: nil, onCreated: { id in
                app.pendingRoute = PendingRoute(tab: .myynti, route: .invoice(id))
            })
        }
        .task { await OnboardingGate.shared.check(app) }
        // Receipts photographed offline go out as soon as the app runs, not only once Kuitit opens.
        .task { OfflineReceiptQueueModel.shared.start(app: app) }
    }

    @ViewBuilder private func root(_ item: AppTab) -> some View {
        switch item {
        case .koti: KotiView()
        case .myynti: MyyntiView()
        case .kirjanpito: KirjanpitoView()
        case .raportit: RaportitView()
        default: PlaceholderScreen(title: item.title)
        }
    }

    private func path(_ item: AppTab) -> Binding<[Route]> {
        // A link to a screen already open further back returns to it instead of stacking a copy.
        Binding(get: { paths[item] ?? [] }, set: { paths[item] = NavigationStackRule.collapse($0) })
    }

    /// "Lisää" is an action, not a place: it opens the add sheet and stays on the current tab.
    private func select(_ next: AppTab) {
        if next == .add {
            EventLog.shared.log(.screen("add-sheet"))
            Haptics.impact()
            showAdd = true
            return
        }
        if next != tab { Haptics.selection() }
        EventLog.shared.log(.screen("tab.\(next)"))
        tab = next
    }
}
