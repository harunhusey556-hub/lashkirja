import SwiftUI
import LashKirjaCore

struct MainTabView: View {
    @State private var tab: AppTab = .koti
    @State private var showAdd = false
    @State private var showSettings = false
    @State private var showAssistant = false
    @State private var showOnboarding = false
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
            // The search role sets "+" apart from the other tabs: on iOS 26 it is its own round
            // button beside the bar. Selecting it never switches tab (see `select`).
            Tab(AppTab.add.title, systemImage: AppTab.add.symbol, value: AppTab.add, role: .search) {
                Color.clear
            }
        }
        .sheet(isPresented: $showAdd) { AddSheet() }
        .sheet(isPresented: $showSettings) { SettingsSheet().presentationDetents([.large]) }
        .sheet(isPresented: $showAssistant) { AssistantView() }
        .fullScreenCover(isPresented: $showOnboarding) { OnboardingView { showOnboarding = false } }
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
            tab = pending.tab
            paths[pending.tab] = NavigationStackRule.collapse((paths[pending.tab] ?? []) + [pending.route])
        }
        .task {
            struct State_: Decodable { let onboarded: Bool }
            if let state: State_ = try? await app.api.get("/api/onboarding"), !state.onboarded { showOnboarding = true }
        }
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
            Haptics.impact()
            showAdd = true
            return
        }
        if next != tab { Haptics.selection() }
        tab = next
    }
}
