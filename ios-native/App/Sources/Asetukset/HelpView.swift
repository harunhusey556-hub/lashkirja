import SwiftUI
import UIKit
import LashKirjaCore

/// Ohje ja tuki (/asetukset/ohje): how the app works, a problem report with a
/// support code, the build, and the way to Huomioitavat.
struct HelpView: View {
    @State private var reference = HelpContent.reference(build: HelpView.build)
    @State private var copied = false

    /// "1.0.0 (7)" from the bundle.
    static var build: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "?"
        let number = info?["CFBundleVersion"] as? String ?? "?"
        return "\(version) (\(number))"
    }

    var body: some View {
        List {
            Section {
                Text(HelpContent.intro)
                    .font(.subheadline)
                    .foregroundStyle(Theme.ink)
                    .padding(.vertical, 4)
                ShareLink(item: HelpContent.reportText(reference: reference), subject: Text("LashKirja-ongelma")) {
                    Label("Ilmoita ongelmasta", systemImage: "exclamationmark.bubble")
                }
                Button {
                    UIPasteboard.general.string = reference
                    Haptics.success()
                    copied = true
                } label: {
                    Label(copied ? "Tukikoodi kopioitu" : "Kopioi tukikoodi", systemImage: copied ? "checkmark" : "doc.on.doc")
                }
            } footer: {
                Text(HelpContent.supportLine(nil))
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
                        Text("Huomioitavat").foregroundStyle(Theme.ink)
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
