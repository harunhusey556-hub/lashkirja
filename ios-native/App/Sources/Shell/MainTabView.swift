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
            ForEach(Self.places, id: \.self) { item in
                Tab(item.title, systemImage: item.symbol, value: item) {
                    NavigationStack(path: path(item)) {
                        root(item)
                            .motionProbe("tab.\(item)")
                            .toolbar {
                                ToolbarItemGroup(placement: .topBarTrailing) {
                                    // On Koti only (Q2, M035): on every root it was one more icon beside
                                    // each tab's own primary. From another tab it is two taps away.
                                    if item == .koti {
                                        Button { Perf.beginOpen("chat"); app.prepareChat(); showAssistant = true } label: { Image(systemName: "bubble.left") }
                                            .accessibilityLabel("Avustaja")
                                    }
                                    Button { Perf.beginOpen("asetukset"); showSettings = true } label: { Image(systemName: "person.crop.circle") }
                                        .accessibilityLabel("Asetukset")
                                }
                            }
                            .appDestinations()
                    }
                    .environment(\.openRoute, openRoute(item))
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
        .background(AddTabGuard { select(.add) })
        .background(TabPrebuild(
            ready: Self.places.map { item -> @MainActor () -> Bool in { hasFirstFrame(item) } } + [{ @MainActor () -> Bool in true }],
            // Without `motionProbe`: the copy is not on screen, so its layers are not the audit's.
            // "+" last: the Lisää sheet's first opening built its list, symbols and pickers between
            // the tap and the sheet rising, which then rose late (w65 motion gate, koti-add-sheet).
            roots: Self.places.map { item -> @MainActor () -> AnyView in
                { AnyView(NavigationStack { root(item) }.listSectionSpacing(.compact).environment(app)) }
            } + [{ @MainActor () -> AnyView in AnyView(AddSheet().environment(app)) }]))
        .sheet(isPresented: $showAdd) { AddSheet().motionProbe("add-sheet") }
        .sheet(isPresented: $showSettings) { SettingsSheet().presentationDetents([.large]).motionProbe("settings-sheet") }
        .sheet(isPresented: $showAssistant) { AssistantView().motionProbe("assistant") }
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
            // Behind a cover (the capture's "Näytä tarkistettavat") the push would be a second
            // movement after the cover's own: the screen is simply there when the cover goes.
            // Another tab likewise: switch and push in one unanimated step, so a closing sheet
            // reveals the destination itself, not the tab's root and then a push (motion audit
            // bad-link-over-sheet). On the same tab an animated route pushes as usual.
            var placing = Transaction()
            placing.disablesAnimations = !pending.animated || pending.tab != tab
            if let row = pending.route.perfRow { Perf.beginOpen(row) }
            withTransaction(placing) {
                tab = pending.tab
                paths[pending.tab] = NavigationStackRule.collapse((paths[pending.tab] ?? []) + [pending.route])
            }
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
            case .newInvoice:
                Perf.beginOpen("laskuUusi")
                showNewInvoice = true
            case .assistant:
                Perf.beginOpen("chat")
                app.prepareChat()
                showAssistant = true
            }
        }
        .sheet(isPresented: $showNewInvoice) {
            InvoiceFormView(existing: nil, preview: app.invoiceFormPreview(), onCreated: { id in
                app.pendingRoute = PendingRoute(tab: .myynti, route: .invoice(id))
            })
        }
        .task { await OnboardingGate.shared.check(app) }
        // Receipts photographed offline go out as soon as the app runs, not only once Kuitit opens.
        .task { OfflineReceiptQueueModel.shared.start(app: app) }
    }

    /// The tabs that are places, in the tab bar's order ("+" comes after them).
    private static let places: [AppTab] = [.koti, .myynti, .kirjanpito, .raportit]

    /// Whether the tab's root, built now, would open on its data (`root` reads these previews once).
    private func hasFirstFrame(_ item: AppTab) -> Bool {
        switch item {
        case .myynti: app.salesPreview() != nil
        case .raportit: app.raportitPreview() != nil
        default: true
        }
    }

    @ViewBuilder private func root(_ item: AppTab) -> some View {
        switch item {
        case .koti: KotiView(app: app)
        case .myynti: MyyntiRoot()
        case .kirjanpito: KirjanpitoView()
        case .raportit: RaportitRoot()
        default: PlaceholderScreen(title: item.title)
        }
    }

    // The previews are read in these bodies, not in `MainTabView`'s: `lastPainted` changes with
    // every load, and read here each change ran the whole tab container again (its toolbars too),
    // also while a tab was building its first frame (w60 motion gate, offline-tab-myynti). Built
    // when the tab is first shown, so the root carries the data as painted by then.
    private struct MyyntiRoot: View {
        @Environment(AppModel.self) private var app
        var body: some View { MyyntiView(preview: app.salesPreview()) }
    }

    private struct RaportitRoot: View {
        @Environment(AppModel.self) private var app
        var body: some View { RaportitView(preview: app.raportitPreview()) }
    }

    private func path(_ item: AppTab) -> Binding<[Route]> {
        // A link to a screen already open further back returns to it instead of stacking a copy.
        Binding(get: { paths[item] ?? [] }, set: { next in
            if next.count > (paths[item] ?? []).count, let row = next.last?.perfRow { Perf.beginOpen(row) }
            paths[item] = NavigationStackRule.collapse(next)
        })
    }

    /// A screen of this tab opening a route from code: onto the tab's path, by a link's rules.
    private func openRoute(_ item: AppTab) -> OpenRouteAction {
        OpenRouteAction(stack: "tab.\(item)") { route in
            let tabPath = path(item)
            tabPath.wrappedValue += [route]
        }
    }

    /// "Lisää" is an action, not a place: it opens the add sheet and stays on the current tab.
    private func select(_ next: AppTab) {
        if next == .add {
            MotionProbe.shared.mark("add-tap")
            EventLog.shared.log(.screen("add-sheet"))
            Haptics.impact()
            showAdd = true
            return
        }
        if next != tab {
            Haptics.selection()
            Perf.beginTab(next.perfRow)
            app.warmNext(from: next)
        }
        EventLog.shared.log(.screen("tab.\(next)"))
        tab = next
    }
}
