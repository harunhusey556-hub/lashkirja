import SwiftUI

/// A real list screen until its plan lands: proves the native push, back swipe and large title.
struct PlaceholderScreen: View {
    let title: String

    var body: some View {
        List {
            Section {
                ForEach(1...12, id: \.self) { i in
                    NavigationLink(value: Route.placeholder("\(title) \(i)")) {
                        Label("\(title) \(i)", systemImage: "doc")
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .navigationTitle(title)
    }
}
