import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        Group {
            switch app.phase {
            case .launching:
                Theme.canvas.ignoresSafeArea()
            case .signedOut(let notice):
                LoginView(notice: notice)
            case .signedIn:
                MainTabView()
            }
        }
        .animation(.default, value: app.phase)
    }
}
