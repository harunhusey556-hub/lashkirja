import SwiftUI

struct MainTabView: View {
    @State private var tab: AppTab = .koti
    @State private var showAdd = false
    @State private var showProfile = false
    @State private var showAssistant = false

    var body: some View {
        TabView(selection: Binding(get: { tab }, set: select)) {
            ForEach([AppTab.koti, .myynti, .kirjanpito, .raportit], id: \.self) { item in
                NavigationStack {
                    root(item)
                        .toolbar {
                            ToolbarItemGroup(placement: .topBarTrailing) {
                                Button { showAssistant = true } label: { Image(systemName: "bubble.left") }
                                    .accessibilityLabel("Avustaja")
                                Button { showProfile = true } label: { Image(systemName: "person.crop.circle") }
                                    .accessibilityLabel("Profiili")
                            }
                        }
                        .appDestinations()
                }
                .tabItem { Label(item.title, systemImage: item.symbol) }
                .tag(item)
            }
            Color.clear
                .tabItem { Label(AppTab.add.title, systemImage: AppTab.add.symbol) }
                .tag(AppTab.add)
        }
        .sheet(isPresented: $showAdd) { AddSheet().presentationDetents([.medium]) }
        .sheet(isPresented: $showProfile) { ProfileSheet().presentationDetents([.medium, .large]) }
        .sheet(isPresented: $showAssistant) { AssistantView() }
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
