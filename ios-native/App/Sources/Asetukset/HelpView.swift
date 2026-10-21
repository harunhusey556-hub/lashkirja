import SwiftUI
import LashKirjaCore

/// Ohje ja tuki (/asetukset/ohje): how the app works, the way to Ilmoita ongelmasta, the build,
/// and the way to Tuonnit ja virheet.
struct HelpView: View {
    @State private var reference = HelpContent.reference(build: HelpView.build)

    /// "1.0.0 (7)" from the bundle.
    static var build: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "?"
        let number = info?["CFBundleVersion"] as? String ?? "?"
        return "\(version) (\(number))"
    }

    /// A support address, when a build names one (Info.plist LKSupportEmail). None does yet, and the
    /// footer then stays away rather than telling the owner that it is missing (X150).
    static var supportAddress: String? {
        (Bundle.main.object(forInfoDictionaryKey: "LKSupportEmail") as? String).flatMap { $0.isEmpty ? nil : $0 }
    }

    var body: some View {
        List {
            Section {
                Text(HelpContent.intro)
                    .font(.subheadline)
                    .foregroundStyle(Theme.ink)
                    .padding(.vertical, 4)
                // The screen the Asetukset row opens, which sends the event log and gives a code: the
                // share sheet here sent a message nobody could trace, beside a second accent action (X151).
                NavigationLink { ReportProblemView() } label: {
                    Label("Ilmoita ongelmasta", systemImage: "ladybug")
                }
            } footer: {
                if let address = Self.supportAddress { Text(HelpContent.supportLine(address)) }
            }

            ForEach(HelpContent.sections) { section in
                Section {
                    ForEach(section.topics) { topic in
                        DisclosureGroup {
                            Text(topic.body)
                                .font(.subheadline)
                                .foregroundStyle(Theme.ink2)
                                .padding(.vertical, 4)
                        } label: {
                            Text(topic.title).foregroundStyle(Theme.ink)
                        }
                    }
                } header: {
                    Text(section.title)
                }
            }

            Section {
                NavigationLink(value: Route.workQueue) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Tuonnit ja virheet").foregroundStyle(Theme.ink)
                        Text("Tuonnit, haut ja niiden virheet").font(.caption).foregroundStyle(Theme.ink2)
                    }
                }
            }

            Section {
                LabeledContent("Versio", value: Self.build)
                LabeledContent("Tukikoodi", value: reference)
                    .textSelection(.enabled)
            } header: {
                Text("Sovellus")
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .navigationTitle("Ohje ja tuki")
        .navigationBarTitleDisplayMode(.inline)
    }
}
